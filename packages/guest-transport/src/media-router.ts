import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import {
  MEDIA_FRAME,
  MEDIA_INITIAL_CREDIT,
  MEDIA_LANE_STREAMS,
  MEDIA_OPEN_TIMEOUT_MS,
  MEDIA_PAYLOAD_MAX,
  MEDIA_QUEUE_MAX,
  MEDIA_STALL_MS,
  type MediaFrameType,
} from '@maestrly/host-protocol'
import { encodeMediaFrame, MediaFrameDecoder, MediaProtocolError, type MediaFrame } from './media-wire.js'

/** Bytes buffered on the physical channel before the scheduler yields. */
export const MEDIA_LANE_HIGH_WATER = 512 * 1024
const CREDIT_BATCH = 32 * 1024
type Callback = (error?: Error | null) => void
const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'CLOSED'
}
export function mediaError(code: string, message = code) {
  return Object.assign(new Error(message), { code })
}

/**
 * One RFB connection. Each viewer owns a stream: RFB state is never fanned out, and
 * already encoded bytes are never dropped. Credit-based flow control bounds memory
 * on both ends; a stream that cannot move data is closed instead of queuing forever.
 */
export class MediaStream extends Duplex {
  accepted = false
  private outbound: Buffer[] = []
  private queued = 0
  private credit = MEDIA_INITIAL_CREDIT
  private inbound = 0
  private consumed = 0
  private txSequence = 0
  private rxSequence = 0
  private blockedWrite?: Callback
  private pendingFinal?: Callback
  private remoteClosed = false
  private stalledSince?: number
  private settle?: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  constructor(
    readonly id: number,
    private readonly mux: MediaMux
  ) {
    super({ allowHalfOpen: true, highWaterMark: MEDIA_PAYLOAD_MAX })
    this.on('error', () => {})
  }
  get queuedBytes() {
    return this.queued
  }
  get sendCredit() {
    return this.credit
  }
  /** @internal */ nextTx() {
    return this.txSequence++
  }
  /** @internal */ expectRx(sequence: number) {
    if (sequence !== this.rxSequence) throw new MediaProtocolError('Media stream sequence gap')
    this.rxSequence++
  }
  /** @internal */ waitAccepted(timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.destroy(mediaError('OPEN_TIMEOUT')), timeoutMs)
      this.settle = { resolve, reject, timer }
    })
  }
  /** Guest side: authorize the pending stream after validating its grant. */
  accept() {
    if (this.accepted || this.destroyed) return
    this.accepted = true
    this.mux.control(this, MEDIA_FRAME.accept)
  }
  refuse(code: string) {
    this.destroy(mediaError(/^[A-Z_]{1,64}$/.test(code) ? code : 'REFUSED'))
  }
  /** @internal */ remoteAccepted() {
    if (this.accepted) throw new MediaProtocolError('Duplicate accept')
    this.accepted = true
    if (this.settle) {
      clearTimeout(this.settle.timer)
      this.settle.resolve()
      this.settle = undefined
    }
    this.mux.pump()
  }
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const emitted = super.emit(event, ...args)
    // Credit returns only when bytes leave the readable queue, bounding the receiver.
    if (event === 'data' && (Buffer.isBuffer(args[0]) || typeof args[0] === 'string')) {
      const size = Buffer.byteLength(args[0] as Buffer)
      this.consumed += size
      this.inbound -= size
      if (this.consumed >= CREDIT_BATCH || this.inbound === 0) {
        const amount = this.consumed
        this.consumed = 0
        if (amount > 0 && !this.destroyed && !this.remoteClosed) {
          const payload = Buffer.alloc(4)
          payload.writeUInt32BE(amount, 0)
          this.mux.control(this, MEDIA_FRAME.credit, payload)
        }
      }
    }
    return emitted
  }
  override _read() {}
  /** @internal */ receiveData(bytes: Buffer) {
    if (!this.accepted) throw new MediaProtocolError('Data before accept')
    if (this.inbound + bytes.length > MEDIA_INITIAL_CREDIT) {
      this.destroy(mediaError('CREDIT_EXCEEDED'))
      return
    }
    this.inbound += bytes.length
    this.push(bytes)
  }
  /** @internal */ receiveCredit(amount: number) {
    if (this.credit + amount > MEDIA_INITIAL_CREDIT) {
      this.destroy(mediaError('CREDIT_EXCEEDED'))
      return
    }
    this.credit += amount
    this.stalledSince = undefined
    this.mux.pump()
  }
  /** @internal */ receiveEnd() {
    this.push(null)
  }
  /** @internal */ receiveClose(code: string) {
    this.remoteClosed = true
    if (this.settle) {
      clearTimeout(this.settle.timer)
      this.settle.reject(mediaError(code || 'REFUSED'))
      this.settle = undefined
    }
    this.destroy(code && code !== 'CLOSED' ? mediaError(code) : undefined)
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: Callback) {
    if (this.destroyed) return callback(mediaError('CLOSED'))
    if (!chunk.length) return callback()
    this.outbound.push(chunk)
    this.queued += chunk.length
    this.mux.pump()
    if (this.queued < MEDIA_QUEUE_MAX) callback()
    else this.blockedWrite = callback
  }
  /** @internal Takes at most one payload for the fair scheduler. */
  takeChunk(): Buffer | undefined {
    if (!this.accepted || this.destroyed || !this.outbound.length) return undefined
    if (this.credit <= 0) {
      this.stalledSince ??= Date.now()
      return undefined
    }
    const head = this.outbound[0]
    const size = Math.min(MEDIA_PAYLOAD_MAX, this.credit, head.length)
    const bytes = head.subarray(0, size)
    if (size === head.length) this.outbound.shift()
    else this.outbound[0] = head.subarray(size)
    this.queued -= size
    this.credit -= size
    if (this.blockedWrite && this.queued < MEDIA_QUEUE_MAX) {
      const callback = this.blockedWrite
      this.blockedWrite = undefined
      queueMicrotask(() => callback())
    }
    if (!this.queued && this.pendingFinal) queueMicrotask(() => this.finishWrites())
    return bytes
  }
  /** @internal */ stalled(now: number, limitMs = MEDIA_STALL_MS) {
    return this.stalledSince !== undefined && this.queued > 0 && now - this.stalledSince > limitMs
  }
  private finishWrites() {
    const callback = this.pendingFinal
    if (!callback || this.queued) return
    this.pendingFinal = undefined
    if (!this.destroyed) this.mux.control(this, MEDIA_FRAME.end)
    callback()
  }
  override _final(callback: Callback) {
    this.pendingFinal = callback
    if (!this.queued) this.finishWrites()
  }
  override _destroy(error: Error | null, callback: Callback) {
    if (this.settle) {
      clearTimeout(this.settle.timer)
      this.settle.reject(error ?? mediaError('CLOSED'))
      this.settle = undefined
    }
    const blocked = this.blockedWrite
    this.blockedWrite = undefined
    blocked?.(error ?? mediaError('CLOSED'))
    this.pendingFinal = undefined
    this.outbound = []
    this.queued = 0
    if (!this.remoteClosed) this.mux.control(this, MEDIA_FRAME.close, codeOf(error) === 'CLOSED' ? Buffer.alloc(0) : Buffer.from(codeOf(error), 'latin1'))
    this.mux.release(this.id)
    callback(error)
  }
}

/**
 * Binary multiplexer over one private virtio-serial lane. The Host opens streams; the
 * guest accepts only after validating a grant created on the administrative lane.
 * Control frames go first; DATA is scheduled round-robin, one payload per stream per
 * turn, so a slow viewer never starves another or the lane itself.
 */
export class MediaMux extends EventEmitter {
  private decoder = new MediaFrameDecoder()
  private streams = new Map<number, MediaStream>()
  private order: number[] = []
  private cursor = 0
  private nextId = 1
  private closed = false
  private pumping = false
  private watchdog: NodeJS.Timeout
  constructor(
    readonly channel: Duplex,
    readonly role: 'host' | 'guest',
    private readonly options: { maxStreams?: number; stallMs?: number } = {}
  ) {
    super()
    channel.on('data', (chunk: Buffer) => {
      try {
        for (const frame of this.decoder.push(chunk)) this.dispatch(frame)
      } catch (error) {
        this.destroy(error as Error)
      }
    })
    channel.on('drain', () => this.pump())
    channel.on('error', (error) => this.destroy(error))
    channel.on('close', () => this.destroy())
    channel.on('end', () => this.destroy())
    this.watchdog = setInterval(() => {
      const now = Date.now()
      for (const stream of this.streams.values()) if (stream.stalled(now, this.options.stallMs)) stream.destroy(mediaError('STALLED'))
    }, Math.min(1_000, Math.max(20, Math.floor((this.options.stallMs ?? MEDIA_STALL_MS) / 4))))
    this.watchdog.unref?.()
  }
  get alive() {
    return !this.closed
  }
  get size() {
    return this.streams.size
  }
  private write(type: MediaFrameType, streamId: number, sequence: number, payload: Buffer = Buffer.alloc(0)) {
    if (this.closed || this.channel.destroyed) return
    this.channel.write(encodeMediaFrame({ type, streamId, sequence, payload }))
  }
  private json(frame: MediaFrame) {
    try {
      return JSON.parse(frame.payload.toString('utf8')) as unknown
    } catch {
      throw new MediaProtocolError('Invalid control payload')
    }
  }
  /** Guest → Host, once, on stream 0. */
  hello(value: object) {
    if (this.role !== 'guest') throw new Error('Only the guest says hello')
    this.write(MEDIA_FRAME.hello, 0, 0, Buffer.from(JSON.stringify(value)))
  }
  /** Host → guest, once, echoing the guest nonce. */
  welcome(value: object) {
    if (this.role !== 'host') throw new Error('Only the Host welcomes')
    this.write(MEDIA_FRAME.welcome, 0, 0, Buffer.from(JSON.stringify(value)))
  }
  /** @internal */ control(stream: MediaStream, type: MediaFrameType, payload: Buffer = Buffer.alloc(0)) {
    this.write(type, stream.id, stream.nextTx(), payload)
  }
  async open(value: object, timeoutMs = MEDIA_OPEN_TIMEOUT_MS): Promise<MediaStream> {
    if (this.role !== 'host') throw new Error('Only the Host opens media streams')
    if (this.closed) throw mediaError('DESKTOP_UNAVAILABLE', 'Desktop lane closed')
    if (this.streams.size >= (this.options.maxStreams ?? MEDIA_LANE_STREAMS)) throw mediaError('VIEWER_LIMIT', 'Too many desktop viewers')
    if (this.nextId > 0xfffffff0) throw mediaError('DESKTOP_UNAVAILABLE', 'Stream identifiers exhausted; reconnect')
    const stream = this.add(this.nextId++)
    const accepted = stream.waitAccepted(timeoutMs)
    this.control(stream, MEDIA_FRAME.open, Buffer.from(JSON.stringify(value)))
    await accepted
    return stream
  }
  private add(id: number) {
    const stream = new MediaStream(id, this)
    this.streams.set(id, stream)
    this.order.push(id)
    return stream
  }
  /** @internal */ release(id: number) {
    if (!this.streams.delete(id)) return
    this.order = this.order.filter((value) => value !== id)
  }
  private dispatch(frame: MediaFrame) {
    if (frame.type === MEDIA_FRAME.hello) {
      if (this.role !== 'host') throw new MediaProtocolError('Unexpected hello')
      this.emit('hello', this.json(frame))
      return
    }
    if (frame.type === MEDIA_FRAME.welcome) {
      if (this.role !== 'guest') throw new MediaProtocolError('Unexpected welcome')
      this.emit('welcome', this.json(frame))
      return
    }
    if (frame.type === MEDIA_FRAME.open) {
      if (this.role !== 'guest' || this.streams.has(frame.streamId) || frame.sequence !== 0) throw new MediaProtocolError('Unexpected open')
      if (this.streams.size >= (this.options.maxStreams ?? MEDIA_LANE_STREAMS) || !this.listenerCount('open')) {
        this.write(MEDIA_FRAME.close, frame.streamId, 0, Buffer.from('VIEWER_LIMIT', 'latin1'))
        return
      }
      const payload = this.json(frame)
      const stream = this.add(frame.streamId)
      stream.expectRx(0)
      this.emit('open', stream, payload)
      return
    }
    const stream = this.streams.get(frame.streamId)
    // Frames for a stream this side already closed are an expected race; ignore them.
    if (!stream) return
    try {
      stream.expectRx(frame.sequence)
    } catch (error) {
      stream.destroy(mediaError('MEDIA_PROTOCOL', (error as Error).message))
      return
    }
    switch (frame.type) {
      case MEDIA_FRAME.accept:
        if (this.role !== 'host') throw new MediaProtocolError('Unexpected accept')
        stream.remoteAccepted()
        break
      case MEDIA_FRAME.data:
        stream.receiveData(frame.payload)
        break
      case MEDIA_FRAME.credit:
        stream.receiveCredit(frame.payload.readUInt32BE(0))
        break
      case MEDIA_FRAME.end:
        stream.receiveEnd()
        break
      case MEDIA_FRAME.close:
        stream.receiveClose(frame.payload.toString('latin1'))
        break
    }
  }
  /** Fair round-robin: one payload per eligible stream per turn, yielding on lane pressure. */
  pump() {
    if (this.pumping || this.closed) return
    this.pumping = true
    try {
      while (!this.closed && this.channel.writableLength < MEDIA_LANE_HIGH_WATER) {
        let sent = false
        for (let visited = 0; visited < this.order.length; visited++) {
          const id = this.order[(this.cursor + visited) % this.order.length]
          const stream = this.streams.get(id)
          const bytes = stream?.takeChunk()
          if (!stream || !bytes) continue
          this.write(MEDIA_FRAME.data, stream.id, stream.nextTx(), bytes)
          this.cursor = (this.cursor + visited + 1) % Math.max(1, this.order.length)
          sent = true
          break
        }
        if (!sent) break
      }
    } finally {
      this.pumping = false
    }
  }
  close() {
    this.destroy()
  }
  destroy(error?: Error) {
    if (this.closed) return
    this.closed = true
    clearInterval(this.watchdog)
    for (const stream of [...this.streams.values()]) stream.destroy(error ? mediaError('DESKTOP_UNAVAILABLE', error.message) : undefined)
    this.streams.clear()
    this.order = []
    this.channel.destroy()
    this.emit('close', error)
  }
}
