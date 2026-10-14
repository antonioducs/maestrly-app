import {
  SCREEN_LIMITS,
  ScreenMessageReader,
  decodeClientMessage,
  encodeClipboard,
  encodeCursor,
  encodeFrame,
  encodeHello,
  encodePointer,
  type ScreenMode,
} from '@maestrly/bot-fleet-protocol'
import type { EncoderEvent, ScreenLevel } from './screen-encoder'

/** The encoder commands a session uses; `ScreenEncoder` implements them. */
export interface ScreenEncoderPort {
  keyframe(): void
  invalidate(frameId: number): void
  tune(level: ScreenLevel): void
  pointer(x: number, y: number, buttons: number): void
  wheel(dx: number, dy: number): void
  key(keysym: number, down: boolean): void
  clipboard(text: string): void
  watch(flags: { pointer: boolean; clipboard: boolean }): void
  release(): void
}
/** One screen connection: the control server writes to its socket and destroys it. */
export interface ScreenPeer {
  send(bytes: Uint8Array): void
  close(): void
}
export interface ScreenClientHandle {
  receive(chunk: Uint8Array): void
  detach(): void
}
export interface ScreenSessionDeps {
  now(): number
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
  log(message: string): void
}

/** Quality levels, best first. A session starts at level 1 and moves one level at a time. */
export const SCREEN_LEVELS: readonly ScreenLevel[] = [
  { crf: 25, fps: 60, paintoverCrf: 18, paintoverBurst: 3 },
  { crf: 25, fps: 30, paintoverCrf: 18, paintoverBurst: 3 },
  { crf: 30, fps: 30, paintoverCrf: 18, paintoverBurst: 3 },
  { crf: 34, fps: 20, paintoverCrf: 22, paintoverBurst: 1 },
  { crf: 38, fps: 12, paintoverCrf: 22, paintoverBurst: 1 },
  { crf: 42, fps: 8, paintoverCrf: 22, paintoverBurst: 1 },
]
export const SCREEN_SESSION_LIMITS = {
  startLevel: 1,
  windowStart: 256 * 1024,
  windowMin: 64 * 1024,
  windowMax: 4 * 1024 * 1024,
  /** Delay over the link's minimum round trip that shrinks a window, and the delay under which it grows. */
  shrinkDelayMs: 100,
  growDelayMs: 30,
  shrinkFactor: 0.7,
  rttWindowMs: 10_000,
  heldFrames: 128,
  tickMs: 100,
  ladderEveryMs: 500,
  dropWindowMs: 2_000,
  dropRatioDown: 0.2,
  downEveryMs: 2_000,
  upAfterMs: 5_000,
  upAfterFrames: 60,
  stillMs: 250,
  keyframeEveryMs: 1_000,
  stuckMs: 10_000,
} as const
const L = SCREEN_SESSION_LIMITS

type Client = {
  peer: ScreenPeer
  mode: ScreenMode
  reader: ScreenMessageReader
  closed: boolean
  needsKey: boolean
  stale: boolean
  held: Set<number>
  heldOrder: number[]
  inFlight: Map<number, { bytes: number; sentAt: number }>
  inFlightBytes: number
  window: number
  lastShrinkAt: number
  rtts: { at: number; rtt: number }[]
  outcomes: { at: number; dropped: boolean }[]
}

/**
 * One screen's stream to its clients. Every client acknowledges the frames it draws; a frame that would queue more than
 * the client's window, or that it cannot decode, is dropped for it and invalidated, so the encoder predicts past it and
 * latency never builds up behind the gateway's buffers. Quality and frame rate follow the worst client's drops.
 */
export class ScreenSession {
  private readonly clients = new Set<Client>()
  private level: number = L.startLevel
  private levelChangedAt: number
  private framesSinceLevel = 0
  private dropsSinceLevel = 0
  private lastFrameAt: number
  private previousFrame: number | null = null
  private keyframeAt = Number.NEGATIVE_INFINITY
  private ladderAt: number
  private cursor: Uint8Array | null = null
  private watching = { pointer: false, clipboard: false }
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private readonly encoder: ScreenEncoderPort,
    private readonly size: { width: number; height: number },
    private readonly deps: ScreenSessionDeps
  ) {
    const now = deps.now()
    this.levelChangedAt = now
    this.ladderAt = now
    this.lastFrameAt = now
    encoder.tune(SCREEN_LEVELS[this.level])
    this.schedule()
  }

  get clientCount(): number {
    return this.clients.size
  }

  /** The quality level and each client's window and bytes in flight, for diagnostics and tests. */
  stats(): { level: number; clients: { mode: ScreenMode; window: number; inFlight: number }[] } {
    return {
      level: this.level,
      clients: [...this.clients].map((client) => ({
        mode: client.mode,
        window: client.window,
        inFlight: client.inFlightBytes,
      })),
    }
  }

  attach(peer: ScreenPeer, mode: ScreenMode): ScreenClientHandle {
    if (this.closed) {
      peer.close()
      return { receive: () => undefined, detach: () => undefined }
    }
    const client: Client = {
      peer,
      mode,
      reader: new ScreenMessageReader(SCREEN_LIMITS.clientPayloadMax),
      closed: false,
      needsKey: true,
      stale: false,
      held: new Set(),
      heldOrder: [],
      inFlight: new Map(),
      inFlightBytes: 0,
      window: L.windowStart,
      lastShrinkAt: Number.NEGATIVE_INFINITY,
      rtts: [],
      outcomes: [],
    }
    this.clients.add(client)
    peer.send(encodeHello({ version: 1, width: this.size.width, height: this.size.height, mode }))
    if (this.cursor) peer.send(this.cursor)
    this.requestKeyframe(true)
    this.updateWatch()
    return { receive: (chunk) => this.receive(client, chunk), detach: () => this.detach(client) }
  }

  /** The encoder's events, as the display manager forwards them. */
  handle(event: EncoderEvent): void {
    if (this.closed) return
    if (event.type === 'frame') return this.frame(event)
    if (event.type === 'cursor') {
      this.cursor = encodeCursor(event.hotX, event.hotY, event.png)
      for (const client of this.clients) client.peer.send(this.cursor)
    } else if (event.type === 'pointer') {
      const message = encodePointer(event.x, event.y)
      for (const client of this.clients) if (client.mode === 'view') client.peer.send(message)
    } else if (event.type === 'clipboard') {
      const message = encodeClipboard(event.tooLarge ? null : event.text)
      for (const client of this.clients) if (client.mode === 'control') client.peer.send(message)
    } else if (event.type === 'log') this.deps.log(`Screen encoder: ${event.text}`)
  }

  /** Ends every client: the encoder stopped, or the surface went away. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) this.deps.clearTimeout(this.timer)
    const clients = [...this.clients]
    this.clients.clear()
    for (const client of clients) {
      client.closed = true
      client.peer.close()
    }
  }

  private frame(frame: Extract<EncoderEvent, { type: 'frame' }>): void {
    const now = this.deps.now()
    this.lastFrameAt = now
    // -1 decodes on its own; -2 means the encoder does not track references, so it predicts from the previous frame.
    const reference = frame.key || frame.ref === -1 ? null : frame.ref >= 0 ? frame.ref : this.previousFrame
    let invalidated = false
    const drop = (client: Client) => {
      client.stale = true
      client.outcomes.push({ at: now, dropped: true })
      this.dropsSinceLevel++
      if (!invalidated) {
        invalidated = true
        this.encoder.invalidate(frame.id)
      }
    }
    let message: Uint8Array | null = null
    for (const client of this.clients) {
      if (client.needsKey && !frame.key) {
        client.stale = true
        continue
      }
      if (reference !== null && !client.held.has(reference)) {
        drop(client)
        continue
      }
      if (client.inFlight.size > 0 && client.inFlightBytes + frame.data.byteLength > client.window) {
        drop(client)
        continue
      }
      message ??= encodeFrame(frame.id, frame.key, frame.data)
      client.peer.send(message)
      client.inFlight.set(frame.id, { bytes: frame.data.byteLength, sentAt: now })
      client.inFlightBytes += frame.data.byteLength
      client.held.add(frame.id)
      client.heldOrder.push(frame.id)
      if (client.heldOrder.length > L.heldFrames) client.held.delete(client.heldOrder.shift()!)
      if (frame.key) client.needsKey = false
      client.stale = false
      client.outcomes.push({ at: now, dropped: false })
    }
    this.framesSinceLevel++
    this.previousFrame = frame.id
  }

  private receive(client: Client, chunk: Uint8Array): void {
    if (client.closed) return
    try {
      for (const message of client.reader.push(chunk)) {
        const event = decodeClientMessage(message)
        if (event.type === 'ack') this.ack(client, event.id)
        else if (event.type === 'keyframe') {
          client.needsKey = true
          this.requestKeyframe(false)
        } else if (client.mode !== 'control') continue
        else if (event.type === 'pointer') this.encoder.pointer(event.x, event.y, event.buttons)
        else if (event.type === 'wheel') this.encoder.wheel(event.dx, event.dy)
        else if (event.type === 'key') this.encoder.key(event.keysym, event.down)
        else this.encoder.clipboard(event.text)
      }
    } catch {
      this.deps.log('A screen client sent an invalid message; closing it.')
      this.end(client)
    }
  }

  private ack(client: Client, id: number): void {
    const entry = client.inFlight.get(id)
    if (!entry) return
    const now = this.deps.now()
    for (const [frameId, flight] of client.inFlight) {
      client.inFlight.delete(frameId)
      client.inFlightBytes -= flight.bytes
      if (frameId === id) break
    }
    const rtt = now - entry.sentAt
    client.rtts.push({ at: now, rtt })
    while (client.rtts[0].at < now - L.rttWindowMs) client.rtts.shift()
    const base = Math.min(...client.rtts.map((sample) => sample.rtt))
    const queued = rtt - base
    if (queued > L.shrinkDelayMs) {
      if (now - client.lastShrinkAt >= Math.max(base, 50)) {
        client.window = Math.max(L.windowMin, Math.floor(client.window * L.shrinkFactor))
        client.lastShrinkAt = now
      }
    } else if (queued < L.growDelayMs)
      client.window = Math.min(L.windowMax, client.window + Math.floor(entry.bytes / 4))
  }

  private end(client: Client): void {
    this.detach(client)
    client.peer.close()
  }

  private detach(client: Client): void {
    if (!this.clients.delete(client)) return
    client.closed = true
    if (client.mode === 'control') this.encoder.release()
    this.updateWatch()
  }

  private updateWatch(): void {
    const clients = [...this.clients]
    const next = {
      pointer: clients.some((client) => client.mode === 'view'),
      clipboard: clients.some((client) => client.mode === 'control'),
    }
    if (next.pointer === this.watching.pointer && next.clipboard === this.watching.clipboard) return
    this.watching = next
    this.encoder.watch(next)
  }

  private requestKeyframe(force: boolean): void {
    const now = this.deps.now()
    if (!force && now - this.keyframeAt < L.keyframeEveryMs) return
    this.keyframeAt = now
    this.encoder.keyframe()
  }

  private schedule(): void {
    this.timer = this.deps.setTimeout(() => this.tick(), L.tickMs)
    this.timer.unref?.()
  }

  private tick(): void {
    if (this.closed) return
    const now = this.deps.now()
    for (const client of [...this.clients]) {
      const oldest = client.inFlight.values().next().value
      if (oldest && now - oldest.sentAt > L.stuckMs) {
        this.deps.log('A screen client stopped acknowledging frames; closing it.')
        this.end(client)
      }
    }
    const still = now - this.lastFrameAt >= L.stillMs
    if ([...this.clients].some((c) => c.needsKey || (c.stale && still && c.inFlight.size === 0)))
      this.requestKeyframe(false)
    if (now - this.ladderAt >= L.ladderEveryMs) {
      this.ladderAt = now
      this.ladder(now)
    }
    this.schedule()
  }

  private ladder(now: number): void {
    let worst = 0
    for (const client of this.clients) {
      while (client.outcomes.length && client.outcomes[0].at < now - L.dropWindowMs) client.outcomes.shift()
      if (client.outcomes.length < 5) continue
      worst = Math.max(worst, client.outcomes.filter((o) => o.dropped).length / client.outcomes.length)
    }
    const since = now - this.levelChangedAt
    if (worst > L.dropRatioDown && this.level < SCREEN_LEVELS.length - 1 && since >= L.downEveryMs)
      this.setLevel(this.level + 1, now)
    else if (
      this.level > 0 &&
      this.dropsSinceLevel === 0 &&
      this.framesSinceLevel >= L.upAfterFrames &&
      since >= L.upAfterMs
    )
      this.setLevel(this.level - 1, now)
  }

  private setLevel(level: number, now: number): void {
    this.level = level
    this.levelChangedAt = now
    this.framesSinceLevel = 0
    this.dropsSinceLevel = 0
    const { crf, fps } = SCREEN_LEVELS[level]
    this.deps.log(`Screen quality level ${level}: CRF ${crf} at ${fps} fps.`)
    this.encoder.tune(SCREEN_LEVELS[level])
  }
}
