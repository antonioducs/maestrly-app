import { randomBytes, randomUUID } from 'node:crypto'
import { duplexPair, type Duplex } from 'node:stream'
import type { BotTurn, DesktopInput, DesktopOperation, DesktopState } from '@maestrly/host-protocol'
import { HostRequestError } from './host-client'

// Development-only live desktop for UI work: a real read-only RFB 3.8 server over an
// in-memory pipe, and a handoff state machine shaped like the Host's. Never hardware
// evidence; disabled in packaged builds with the rest of the fixture.
const WIDTH = 1280
const HEIGHT = 800
type Rgb = [number, number, number]
type Rect = { x: number; y: number; w: number; h: number }
const union = (a: Rect | undefined, b: Rect): Rect => {
  if (!a) return b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}
/** Framebuffer whose visible changes prove where input landed and when the bot works. */
export class FixtureScreen {
  readonly width = WIDTH
  readonly height = HEIGHT
  private pixels = Buffer.alloc(WIDTH * HEIGHT * 3)
  private listeners = new Set<(rect: Rect) => void>()
  private typed = 0
  private progress = 0
  private timer?: ReturnType<typeof setInterval>
  applied = 0
  constructor() {
    this.fill({ x: 0, y: 0, w: WIDTH, h: HEIGHT }, [40, 44, 52])
    this.fill({ x: 0, y: 0, w: WIDTH, h: 28 }, [26, 28, 34])
    this.fill({ x: 240, y: 180, w: 800, h: 440 }, [236, 238, 242])
    this.fill({ x: 280, y: 260, w: 720, h: 44 }, [255, 255, 255])
    this.fill({ x: 280, y: 540, w: 180, h: 44 }, [81, 73, 189])
  }
  private fill(rect: Rect, color: Rgb) {
    for (let y = Math.max(0, rect.y); y < Math.min(HEIGHT, rect.y + rect.h); y++)
      for (let x = Math.max(0, rect.x); x < Math.min(WIDTH, rect.x + rect.w); x++) {
        const offset = (y * WIDTH + x) * 3
        this.pixels[offset] = color[0]
        this.pixels[offset + 1] = color[1]
        this.pixels[offset + 2] = color[2]
      }
    for (const listener of this.listeners) listener(rect)
  }
  subscribe(listener: (rect: Rect) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** Bot activity animates a progress strip; it stops the moment a person takes over. */
  setActivity(on: boolean) {
    clearInterval(this.timer)
    this.timer = undefined
    if (!on) return this.fill({ x: 0, y: 32, w: WIDTH, h: 6 }, [40, 44, 52])
    this.timer = setInterval(() => {
      this.progress = (this.progress + 24) % WIDTH
      this.fill({ x: 0, y: 32, w: WIDTH, h: 6 }, [40, 44, 52])
      this.fill({ x: this.progress, y: 32, w: 160, h: 6 }, [23, 123, 83])
    }, 66)
    this.timer.unref?.()
  }
  apply(events: DesktopInput[]) {
    for (const event of events) {
      if (event.kind === 'button' && event.down) this.fill({ x: event.x - 6, y: event.y - 6, w: 12, h: 12 }, [255, 173, 181])
      const chars = event.kind === 'text' ? [...event.text].length : event.kind === 'key' && event.down && event.keysym >= 0x20 && event.keysym <= 0x7e ? 1 : 0
      for (let i = 0; i < chars; i++) {
        this.fill({ x: 292 + (this.typed % 60) * 11, y: 272, w: 8, h: 20 }, [38, 37, 33])
        this.typed++
      }
    }
    this.applied += events.length
  }
  /** Encodes a rectangle for the client's true-colour pixel format. */
  encode(rect: Rect, format: { bpp: number; bigEndian: boolean; max: Rgb; shift: Rgb }) {
    const out = Buffer.alloc(rect.w * rect.h * 4)
    let o = 0
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const i = (y * WIDTH + x) * 3
        const value =
          ((Math.round((this.pixels[i] * format.max[0]) / 255) << format.shift[0]) |
            (Math.round((this.pixels[i + 1] * format.max[1]) / 255) << format.shift[1]) |
            (Math.round((this.pixels[i + 2] * format.max[2]) / 255) << format.shift[2])) >>> 0
        if (format.bigEndian) out.writeUInt32BE(value, o)
        else out.writeUInt32LE(value, o)
        o += 4
      }
    return out
  }
  dispose() {
    clearInterval(this.timer)
  }
}
/** Read-only RFB server: key, pointer, clipboard and resize messages are ignored. */
export function serveFixtureRfb(screen: FixtureScreen): Duplex {
  const [client, server] = duplexPair()
  let buffer = Buffer.alloc(0)
  const waiters: { size: number; resolve: (bytes: Buffer) => void }[] = []
  const pump = () => {
    while (waiters.length && buffer.length >= waiters[0].size) {
      const waiter = waiters.shift()!
      waiter.resolve(buffer.subarray(0, waiter.size))
      buffer = buffer.subarray(waiter.size)
    }
  }
  server.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    pump()
  })
  server.on('error', () => {})
  const read = (size: number) => new Promise<Buffer>((resolve) => {
    waiters.push({ size, resolve })
    pump()
  })
  let format = { bpp: 32, bigEndian: false, max: [255, 255, 255] as Rgb, shift: [16, 8, 0] as Rgb }
  let dirty: Rect | undefined = { x: 0, y: 0, w: WIDTH, h: HEIGHT }
  let requested = false
  const unsubscribe = screen.subscribe((rect) => {
    dirty = union(dirty, rect)
  })
  const timer = setInterval(() => {
    if (!requested || !dirty || server.destroyed) return
    const rect = dirty
    dirty = undefined
    requested = false
    const header = Buffer.alloc(16)
    header[0] = 0
    header.writeUInt16BE(1, 2)
    header.writeUInt16BE(rect.x, 4)
    header.writeUInt16BE(rect.y, 6)
    header.writeUInt16BE(rect.w, 8)
    header.writeUInt16BE(rect.h, 10)
    header.writeInt32BE(0, 12)
    server.write(Buffer.concat([header, screen.encode(rect, format)]))
  }, 66)
  const close = () => {
    clearInterval(timer)
    unsubscribe()
    server.destroy()
  }
  server.once('close', close)
  void (async () => {
    server.write('RFB 003.008\n')
    await read(12)
    server.write(Buffer.from([1, 1]))
    if ((await read(1))[0] !== 1) return close()
    server.write(Buffer.from([0, 0, 0, 0]))
    await read(1)
    const name = Buffer.from('Maestrly fixture')
    const init = Buffer.alloc(24)
    init.writeUInt16BE(WIDTH, 0)
    init.writeUInt16BE(HEIGHT, 2)
    init[4] = 32
    init[5] = 24
    init[7] = 1
    init.writeUInt16BE(255, 8)
    init.writeUInt16BE(255, 10)
    init.writeUInt16BE(255, 12)
    init[14] = 16
    init[15] = 8
    init.writeUInt32BE(name.length, 20)
    server.write(Buffer.concat([init, name]))
    for (;;) {
      const type = (await read(1))[0]
      if (type === 0) {
        const body = await read(19)
        if (body[3] !== 32 || body[6] !== 1) return close()
        format = { bpp: 32, bigEndian: body[5] !== 0, max: [body.readUInt16BE(7), body.readUInt16BE(9), body.readUInt16BE(11)], shift: [body[13], body[14], body[15]] }
        dirty = { x: 0, y: 0, w: WIDTH, h: HEIGHT }
      } else if (type === 2) {
        const body = await read(3)
        await read(body.readUInt16BE(1) * 4)
      } else if (type === 3) {
        const body = await read(9)
        if (body[0] === 0) dirty = { x: 0, y: 0, w: WIDTH, h: HEIGHT }
        requested = true
      } else if (type === 4) await read(7)
      else if (type === 5) await read(5)
      else if (type === 6) {
        const body = await read(7)
        await read(body.readUInt32BE(3))
      } else if (type === 251) {
        const body = await read(7)
        await read(body[5] * 16)
      } else return close()
    }
  })().catch(close)
  client.once('close', close)
  return client
}

type Viewer = { viewId: string; controller?: { capability: string; epoch: number; sequence: number; applied: number } }
type State = { revision: number; controlEpoch: number; mode: DesktopState['mode']; interruptedTurnId?: string; reasonCode?: string; viewers: Map<string, Viewer>; updatedAt: string }
export interface FixtureDesktopHooks {
  later(ms: number, fn: () => void): void
  sessionId(botId: string): string
  activeTurn(botId: string): BotTurn | undefined
  turn(turnId: string): BotTurn | undefined
  interrupt(turnId: string): void
  continueTask(botId: string, interruptedTurnId: string, operationId: string): string
  event(botId: string, summary: string): void
}
const now = () => new Date().toISOString()
const fail = (code: string, message: string) => new HostRequestError(message, code)
/** Handoff state machine mirroring the Host: epochs, single controller, one continuation. */
export class FixtureDesktops {
  private states = new Map<string, State>()
  private screens = new Map<string, FixtureScreen>()
  private operations = new Map<string, DesktopOperation>()
  private keys = new Map<string, string>()
  private tickets = new Map<string, string>()
  constructor(private readonly hooks: FixtureDesktopHooks) {}
  screen(botId: string) {
    let screen = this.screens.get(botId)
    if (!screen) this.screens.set(botId, (screen = new FixtureScreen()))
    return screen
  }
  private state(botId: string) {
    let state = this.states.get(botId)
    if (!state) this.states.set(botId, (state = { revision: 0, controlEpoch: 0, mode: 'bot', viewers: new Map(), updatedAt: now() }))
    return state
  }
  held(botId: string) {
    return this.state(botId).mode !== 'bot'
  }
  project(botId: string): DesktopState {
    const state = this.state(botId)
    return {
      botId,
      sessionId: this.hooks.sessionId(botId),
      revision: state.revision,
      controlEpoch: state.controlEpoch,
      mode: state.mode,
      desktopGeneration: 'fixture-desktop-1',
      width: WIDTH,
      height: HEIGHT,
      ...(state.interruptedTurnId ? { interruptedTurnId: state.interruptedTurnId } : {}),
      ...(state.reasonCode ? { reasonCode: state.reasonCode } : {}),
      controlled: [...state.viewers.values()].some((viewer) => viewer.controller),
      viewers: state.viewers.size,
      capabilities: ['desktop.live.v1', 'desktop.handoff.v1'],
      available: true,
      updatedAt: state.updatedAt,
    }
  }
  private bump(state: State, patch: Partial<State>) {
    Object.assign(state, patch, { revision: state.revision + 1, updatedAt: now() })
  }
  private viewer(viewId: string) {
    for (const [botId, state] of this.states) {
      const viewer = state.viewers.get(viewId)
      if (viewer) return { botId, state, viewer }
    }
    throw fail('DESKTOP_UNAVAILABLE', 'Esta visualização da tela terminou; abra a tela novamente')
  }
  private operation(op: Omit<DesktopOperation, 'id' | 'createdAt' | 'updatedAt'>, key: string) {
    const value: DesktopOperation = { ...op, id: randomUUID(), createdAt: now(), updatedAt: now() }
    this.operations.set(value.id, value)
    this.keys.set(key, value.id)
    return value
  }
  private complete(id: string, patch: Partial<DesktopOperation>) {
    const op = this.operations.get(id)!
    this.operations.set(id, { ...op, ...patch, updatedAt: now() })
  }
  private pause(botId: string, reasonCode: string) {
    const state = this.state(botId)
    for (const viewer of state.viewers.values()) viewer.controller = undefined
    if (state.mode === 'human') this.bump(state, { mode: 'paused', controlEpoch: state.controlEpoch + 1, reasonCode })
  }
  media(ticket: string): Duplex {
    const botId = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    if (!botId) throw fail('TICKET_INVALID', 'A autorização da tela expirou')
    return serveFixtureRfb(this.screen(botId))
  }
  request(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case 'bot.desktop.inspect':
        return this.project(String(p.botId))
      case 'bot.desktop.open': {
        const botId = String(p.botId)
        const state = this.state(botId)
        if (state.viewers.size >= 2) throw fail('VIEWER_LIMIT', 'Há telas demais abertas')
        const viewId = randomUUID()
        state.viewers.set(viewId, { viewId })
        const ticket = randomBytes(32).toString('hex')
        this.tickets.set(ticket, botId)
        return { viewId, mediaTicket: ticket, ticketExpiresAt: new Date(Date.now() + 30_000).toISOString(), state: this.project(botId) }
      }
      case 'bot.desktop.close': {
        const { botId, state, viewer } = this.viewer(String(p.viewId))
        state.viewers.delete(viewer.viewId)
        if (viewer.controller) this.pause(botId, 'CONTROLLER_CLOSED')
        return { closed: true, state: this.project(botId) }
      }
      case 'bot.desktop.acquire': {
        const previous = this.keys.get(String(p.idempotencyKey))
        if (previous) return this.operations.get(previous)
        const { botId, state, viewer } = this.viewer(String(p.viewId))
        if ([...state.viewers.values()].some((v) => v.controller) || ['acquiring', 'resuming', 'human'].includes(state.mode)) throw fail('CONTROL_BUSY', 'Outra pessoa já está com o controle')
        if (state.revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'O estado da tela mudou')
        const active = this.hooks.activeTurn(botId)
        const interruptedTurnId = active?.id ?? (state.mode === 'paused' ? state.interruptedTurnId : undefined)
        this.bump(state, { mode: 'acquiring', controlEpoch: state.controlEpoch + 1, reasonCode: undefined, interruptedTurnId })
        const op = this.operation({ botId, sessionId: this.hooks.sessionId(botId), kind: 'acquire', status: 'running', phase: 'intent', controlEpoch: state.controlEpoch, viewId: viewer.viewId, ...(interruptedTurnId ? { interruptedTurnId } : {}) }, String(p.idempotencyKey))
        this.hooks.later(500, () => {
          const turn = interruptedTurnId ? this.hooks.turn(interruptedTurnId) : undefined
          if (turn && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(turn.status)) this.hooks.interrupt(turn.id)
          const still = interruptedTurnId && this.hooks.turn(interruptedTurnId)?.status === 'interrupted' ? interruptedTurnId : undefined
          this.screen(botId).setActivity(false)
          this.bump(state, { mode: 'human', interruptedTurnId: still })
          this.complete(op.id, { status: 'succeeded', phase: 'completed', interruptedTurnId: still })
          this.hooks.event(botId, 'Você está no controle da tela; o bot está pausado')
        })
        return op
      }
      case 'bot.desktop.operation.get': {
        const op = this.operations.get(String(p.operationId))
        if (!op) throw fail('NOT_FOUND', 'Operação da tela não encontrada')
        return op
      }
      case 'bot.desktop.operation.lookup': {
        const id = this.keys.get(String(p.idempotencyKey))
        return id ? this.operations.get(id) : null
      }
      case 'bot.desktop.claimControl': {
        const { botId, state, viewer } = this.viewer(String(p.viewId))
        const op = this.operations.get(String(p.operationId))
        if (op?.status !== 'succeeded' || op.viewId !== viewer.viewId || state.mode !== 'human' || op.controlEpoch !== state.controlEpoch) throw fail('CONTROL_EXPIRED', 'Este pedido de controle não vale mais')
        const capability = randomBytes(32).toString('hex')
        viewer.controller = { capability, epoch: state.controlEpoch, sequence: -1, applied: 0 }
        return { controlCapability: capability, controlEpoch: state.controlEpoch, desktopGeneration: 'fixture-desktop-1', leaseMs: 12_000, renewMs: 3_000, state: this.project(botId) }
      }
      case 'bot.desktop.renew': {
        const { botId, state, viewer } = this.viewer(String(p.viewId))
        if (p.controlCapability && (viewer.controller?.capability !== p.controlCapability || state.mode !== 'human')) throw fail('CONTROL_EXPIRED', 'O controle expirou')
        return { state: this.project(botId), controlling: !!p.controlCapability }
      }
      case 'bot.desktop.input': {
        const { botId, state, viewer } = this.viewer(String(p.viewId))
        const controller = viewer.controller
        if (!controller || controller.capability !== p.controlCapability || controller.epoch !== p.controlEpoch || state.mode !== 'human') throw fail('CONTROL_EXPIRED', 'O controle expirou')
        const sequence = Number(p.sequence)
        if (sequence === controller.sequence) return { sequence, applied: controller.applied }
        if (sequence < controller.sequence) throw fail('INPUT_SEQUENCE_INVALID', 'Entrada fora de ordem')
        controller.sequence = sequence
        const events = p.events as DesktopInput[]
        this.screen(botId).apply(events)
        controller.applied = events.length
        return { sequence, applied: events.length }
      }
      case 'bot.desktop.return': {
        const previous = this.keys.get(String(p.idempotencyKey))
        if (previous) return this.operations.get(previous)
        const botId = String(p.botId)
        const state = this.state(botId)
        if (state.mode === 'bot') throw fail('STALE_DESKTOP', 'O bot já está com o controle')
        if (state.mode === 'human') {
          const viewer = p.viewId ? state.viewers.get(String(p.viewId)) : undefined
          if (!viewer?.controller || viewer.controller.capability !== p.controlCapability) throw fail('CONTROL_BUSY', 'Somente quem está no controle pode devolvê-lo agora')
        }
        if (state.revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'O estado da tela mudou')
        const interrupted = state.interruptedTurnId
        const continueTask = p.continueTask === true && !!interrupted
        for (const viewer of state.viewers.values()) viewer.controller = undefined
        this.bump(state, { mode: 'resuming', controlEpoch: state.controlEpoch + 1 })
        const op = this.operation({ botId, sessionId: this.hooks.sessionId(botId), kind: 'return', status: 'running', phase: 'intent', controlEpoch: state.controlEpoch, continueTask: p.continueTask === true, ...(p.viewId ? { viewId: String(p.viewId) } : {}), ...(interrupted ? { interruptedTurnId: interrupted } : {}) }, String(p.idempotencyKey))
        this.hooks.later(500, () => {
          const continuationTurnId = continueTask ? this.hooks.continueTask(botId, interrupted!, op.id) : undefined
          this.bump(state, { mode: 'bot', interruptedTurnId: undefined, reasonCode: undefined })
          this.complete(op.id, { status: 'succeeded', phase: 'completed', ...(continuationTurnId ? { continuationTurnId } : {}) })
          this.hooks.event(botId, continuationTurnId ? 'Controle devolvido; o bot continua a partir do que você deixou' : 'Controle devolvido ao bot')
        })
        return op
      }
    }
    throw fail('INVALID_REQUEST', `Unsupported fixture desktop method ${method}`)
  }
  dispose() {
    for (const screen of this.screens.values()) screen.dispose()
  }
}
