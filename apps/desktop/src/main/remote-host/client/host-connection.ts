import type { HostConnectionState } from '../../../shared/hosts'
import {
  type BridgeClientFrame,
  type BridgeHostFrame,
  REMOTE_BRIDGE_LIMITS,
  REMOTE_BRIDGE_PROTOCOL,
  type RemoteHostInfo,
  type RemoteOriginRole,
  type RemoteOs,
} from '../../../shared/remote-bridge'
import { decodeHostFrame, encodeBridgeFrame } from '../bridge-codec'

/** What a connection needs from a socket: the global `WebSocket`, or the `ws` client, which has the same events. */
export type BridgeClientSocket = Pick<WebSocket, 'send' | 'close' | 'addEventListener'>

export interface HostConnectionTimings {
  pingMs: number
  deadMs: number
  welcomeTimeoutMs: number
  retryBaseMs: number
  retryMaxMs: number
}

const DEFAULT_TIMINGS: HostConnectionTimings = {
  pingMs: REMOTE_BRIDGE_LIMITS.pingMs,
  deadMs: REMOTE_BRIDGE_LIMITS.deadMs,
  welcomeTimeoutMs: REMOTE_BRIDGE_LIMITS.welcomeTimeoutMs,
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
}

export interface HostConnectionSnapshot {
  state: HostConnectionState
  epoch: number
  info: RemoteHostInfo | null
  hostVersion: string | null
}

export interface HostConnectionDeps {
  /** Opens a socket to the host's bridge: with a ticket of the gateway, or straight to a development host. */
  connect: () => Promise<BridgeClientSocket>
  appVersion: string
  client: () => { deviceName: string; os: RemoteOs; locale: string }
  onChange: (snapshot: HostConnectionSnapshot) => void
  /** What the host pushes to one of this computer's renderers. */
  onEvent: (origin: number, channel: string, args: unknown[]) => void
  timings?: Partial<HostConnectionTimings>
}

/** An error a host answered, with its code (`remote-unsupported`, `unknown-channel`, …) when it gave one. */
export class HostInvokeError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

const NOT_CONNECTED = 'The server is not connected.'
const CONNECTION_LOST = 'The connection to the server was lost.'

/**
 * This computer's end of the bridge to one remote host. It keeps one socket open, reconnecting with backoff, and
 * carries the calls of this computer's renderers (its origins) to the host and the host's pushes back to them. A
 * renderer stays an origin across reconnections: each time the host answers again, its origins are opened again and
 * the epoch increases, so the window loads what it shows of the host again.
 */
export class HostConnection {
  private readonly timings: HostConnectionTimings
  private socket: BridgeClientSocket | null = null
  private state: HostConnectionState = 'offline'
  private epoch = 0
  private info: RemoteHostInfo | null = null
  private hostVersion: string | null = null
  private running = false
  /** Invalidates the callbacks of a socket this connection gave up on. */
  private generation = 0
  private attempts = 0
  private nextInvokeId = 1
  private pingCount = 0
  private lastSeen = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly origins = new Map<number, RemoteOriginRole>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: HostConnectionDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings }
  }

  snapshot(): HostConnectionSnapshot {
    return { state: this.state, epoch: this.epoch, info: this.info, hostVersion: this.hostVersion }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.attempts = 0
    this.setState('connecting')
    void this.open()
  }

  /** Closes the bridge and forgets its origins; the host keeps running whatever it was running. */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.drop()
    this.origins.clear()
    this.setState('offline')
  }

  /** Tries again now, as after the host was updated or when the person asks. */
  retry(): void {
    if (!this.running || this.state === 'online') return
    this.drop()
    this.attempts = 0
    this.setState(this.epoch ? 'reconnecting' : 'connecting')
    void this.open()
  }

  /** Makes a renderer of this computer an origin of the host; it stays one until closed. */
  openOrigin(origin: number, role: RemoteOriginRole): void {
    if (this.origins.has(origin)) return
    this.origins.set(origin, role)
    if (this.state === 'online') this.write({ t: 'open', origin, ...role })
  }

  hasOrigin(origin: number): boolean {
    return this.origins.has(origin)
  }

  closeOrigin(origin: number): void {
    if (!this.origins.delete(origin)) return
    if (this.state === 'online') this.write({ t: 'close', origin })
  }

  invoke(origin: number, channel: string, args: unknown[]): Promise<unknown> {
    if (this.state !== 'online') return Promise.reject(new HostInvokeError(NOT_CONNECTED, 'not-connected'))
    const id = this.nextInvokeId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.write({ t: 'invoke', id, origin, channel, args })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  send(origin: number, channel: string, args: unknown[]): void {
    if (this.state === 'online') this.write({ t: 'send', origin, channel, args })
  }

  private setState(state: HostConnectionState): void {
    if (this.state === state) return
    this.state = state
    this.deps.onChange(this.snapshot())
  }

  /** Throws for a frame that cannot be encoded (too large, or a cyclic value): the caller's own mistake. */
  private write(frame: BridgeClientFrame): void {
    const text = encodeBridgeFrame(frame)
    try {
      this.socket?.send(text)
    } catch {
      this.lost()
    }
  }

  private async open(): Promise<void> {
    const generation = ++this.generation
    let socket: BridgeClientSocket
    try {
      socket = await this.deps.connect()
    } catch {
      if (generation === this.generation && this.running) this.lost()
      return
    }
    if (generation !== this.generation || !this.running) {
      socket.close()
      return
    }
    this.socket = socket
    const current = (): boolean => generation === this.generation && this.socket === socket
    socket.addEventListener('open', () => {
      if (!current()) return
      this.lastSeen = Date.now()
      this.write({
        t: 'hello',
        protocol: REMOTE_BRIDGE_PROTOCOL,
        appVersion: this.deps.appVersion,
        client: this.deps.client(),
      })
    })
    socket.addEventListener('message', (event) => {
      if (current()) this.receive((event as MessageEvent).data)
    })
    const ended = (): void => {
      if (current()) this.lost()
    }
    socket.addEventListener('close', ended)
    socket.addEventListener('error', ended)
    // Covers a socket that never opens and a host that never answers the hello.
    this.welcomeTimer = setTimeout(ended, this.timings.welcomeTimeoutMs)
  }

  private receive(data: unknown): void {
    let frame: BridgeHostFrame
    try {
      if (typeof data !== 'string') throw new Error('Binary frame')
      frame = decodeHostFrame(data)
    } catch {
      return this.lost()
    }
    this.lastSeen = Date.now()
    switch (frame.t) {
      case 'welcome':
        return this.welcomed(frame.host)
      case 'refused':
        return this.refused(frame.hostVersion)
      case 'result': {
        const waiting = this.pending.get(frame.id)
        if (!waiting) return
        this.pending.delete(frame.id)
        if (frame.ok) waiting.resolve(frame.value)
        else waiting.reject(new HostInvokeError(frame.error.message, frame.error.code))
        return
      }
      case 'event':
        if (this.origins.has(frame.origin)) this.deps.onEvent(frame.origin, frame.channel, frame.args)
        return
      case 'ping':
        return this.write({ t: 'pong', n: frame.n })
      case 'pong':
        return
    }
  }

  private welcomed(info: RemoteHostInfo): void {
    if (this.state === 'online') return
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer)
    this.welcomeTimer = null
    this.attempts = 0
    this.info = info
    this.hostVersion = null
    this.epoch++
    this.state = 'online'
    for (const [origin, role] of this.origins) this.write({ t: 'open', origin, ...role })
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastSeen > this.timings.deadMs) this.lost()
      else this.write({ t: 'ping', n: ++this.pingCount })
    }, this.timings.pingMs)
    this.pingTimer.unref?.()
    this.deps.onChange(this.snapshot())
  }

  /** The host runs another version: trying again changes nothing until one of the two is updated. */
  private refused(hostVersion: string): void {
    this.drop()
    this.hostVersion = hostVersion
    this.setState('incompatible')
  }

  /** Gives up on the current socket and everything waiting on it. */
  private drop(): void {
    this.generation++
    for (const timer of [this.retryTimer, this.welcomeTimer]) if (timer) clearTimeout(timer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.retryTimer = this.welcomeTimer = this.pingTimer = null
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {
      /* The socket is already gone. */
    }
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const { reject } of waiting) reject(new HostInvokeError(CONNECTION_LOST, 'connection-lost'))
  }

  private lost(): void {
    this.drop()
    if (!this.running) return
    const delay = Math.min(this.timings.retryMaxMs, this.timings.retryBaseMs * 2 ** this.attempts++)
    this.setState('reconnecting')
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.open()
    }, delay)
    this.retryTimer.unref?.()
  }
}
