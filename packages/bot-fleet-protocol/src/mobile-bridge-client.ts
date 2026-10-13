import {
  MOBILE_API_VERSION,
  MOBILE_BRIDGE_CLOSE,
  MOBILE_BRIDGE_LIMITS,
  MOBILE_BRIDGE_PROTOCOL,
  MOBILE_CHANNELS,
  MOBILE_EVENT_KEYS,
  MOBILE_EVENTS,
  mobileHostFrameSchema,
  type MobileArgs,
  type MobileChannelKey,
  type MobileEvent,
  type MobileHello,
  type MobileResult,
} from './mobile-bridge.js'

/** What the client needs of a WebSocket: the browser and React Native API. */
export interface MobileBridgeSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/**
 * - `refused`: the host refused this app's protocol or API version; the app needs an update.
 * - `unsupported`: the host predates phones; the server needs an update.
 * - `unauthorized`: the gateway no longer knows this phone.
 * - `unavailable`: the server has no running workspaces host now; the client keeps trying.
 */
export type MobileBridgeState =
  | 'connecting'
  | 'open'
  | 'retrying'
  | 'unavailable'
  | 'refused'
  | 'unsupported'
  | 'unauthorized'
  | 'closed'

export class MobileBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'MobileBridgeError'
  }
}

export interface MobileBridgeClientOptions {
  /**
   * Opens a socket to the host: asks the gateway for a ticket, then connects. Throws a `MobileBridgeError` with code
   * `UNAUTHORIZED`, `UNAVAILABLE` or `UNSUPPORTED` when connecting cannot work now; any other failure is retried.
   */
  connect: () => Promise<MobileBridgeSocket>
  client: Omit<MobileHello['client'], 'kind' | 'mobileApi'>
  appVersion: string
  onEvent: (event: MobileEvent) => void
  onState: (state: MobileBridgeState, detail?: { retryInMs?: number; hostVersion?: string }) => void
  /** After each welcome: reopen what the phone shows. */
  onReady?: () => void
  random?: () => number
}

const ORIGIN = 1
const RESERVED = ['$bin', '$undef', '$esc']

/** The bridge's JSON form of a value (see the host's bridge codec): `undefined` keeps its place in arrays. */
export function encodeMobileValue(value: unknown): unknown {
  if (value === undefined) return { $undef: 1 }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(encodeMobileValue)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = encodeMobileValue(item)
  return RESERVED.some((key) => key in out) ? { $esc: out } : out
}

export function decodeMobileValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeMobileValue)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 1 && record.$undef === 1) return undefined
  const escaped = keys.length === 1 && record.$esc && typeof record.$esc === 'object' && !Array.isArray(record.$esc)
  const source = escaped ? (record.$esc as Record<string, unknown>) : record
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) out[key] = decodeMobileValue(item)
  return out
}

export const mobileRetryDelay = (attempt: number, random: () => number): number =>
  Math.round(Math.min(30_000, 1_000 * 2 ** attempt) * (0.75 + random() * 0.5))

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * A phone's bridge to its server's workspaces host. It keeps one socket open and reconnects with backoff, says hello as
 * a phone, opens one origin and then carries calls (`invoke`) and the host's events. A call made while disconnected
 * fails at once with a retryable error; the phone decides what waits.
 */
export class MobileBridgeClient {
  private socket: MobileBridgeSocket | null = null
  private stopped = true
  private welcomed = false
  private attempt = 0
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0

  constructor(private readonly options: MobileBridgeClientOptions) {}

  get isOpen(): boolean {
    return this.welcomed && !this.stopped
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    void this.connect()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.teardown(new MobileBridgeError('CLOSED', 'The bridge was closed', true))
    this.options.onState('closed')
  }

  /** Tries now instead of waiting for the next retry. */
  reconnectNow(): void {
    if (this.stopped || this.socket) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.attempt = 0
    void this.connect()
  }

  invoke<K extends MobileChannelKey>(
    key: K,
    args: MobileArgs<K>,
    timeoutMs: number = MOBILE_BRIDGE_LIMITS.invokeTimeoutMs
  ): Promise<MobileResult<K>> {
    const spec = MOBILE_CHANNELS[key]
    let parsed: unknown
    try {
      parsed = spec.args.parse(args)
    } catch {
      return Promise.reject(new MobileBridgeError('INVALID', `Invalid arguments for ${spec.channel}`))
    }
    const socket = this.socket
    if (!socket || !this.welcomed)
      return Promise.reject(new MobileBridgeError('DISCONNECTED', 'Not connected to the host', true))
    const id = ++this.nextId
    return new Promise<MobileResult<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new MobileBridgeError('TIMEOUT', 'The host took too long to answer', true))
      }, timeoutMs)
      this.pending.set(id, {
        timer,
        reject,
        resolve: (value) => {
          const result = spec.result.safeParse(value === undefined ? null : value)
          if (result.success) resolve(result.data as MobileResult<K>)
          else reject(new MobileBridgeError('BAD_RESPONSE', `Unexpected answer from ${spec.channel}`))
        },
      })
      this.write({ t: 'invoke', id, origin: ORIGIN, channel: spec.channel, args: [parsed] })
    })
  }

  private write(frame: unknown): void {
    try {
      this.socket?.send(JSON.stringify(encodeMobileValue(frame)))
    } catch {
      this.socket?.close()
    }
  }

  private setState(
    state: Parameters<MobileBridgeClientOptions['onState']>[0],
    detail?: { retryInMs?: number; hostVersion?: string }
  ) {
    this.options.onState(state, detail)
  }

  private async connect(): Promise<void> {
    this.retryTimer = null
    if (this.stopped) return
    const generation = ++this.generation
    this.setState('connecting')
    let socket: MobileBridgeSocket
    try {
      socket = await this.options.connect()
    } catch (error) {
      if (this.stopped || generation !== this.generation) return
      const code = error instanceof MobileBridgeError ? error.code : 'NETWORK'
      if (code === 'UNAUTHORIZED') return this.finish('unauthorized')
      if (code === 'UNSUPPORTED') return this.finish('unsupported')
      return this.scheduleRetry(code === 'UNAVAILABLE' ? 'unavailable' : 'retrying')
    }
    if (this.stopped || generation !== this.generation) {
      socket.close(1000, 'stopped')
      return
    }
    this.socket = socket
    this.welcomed = false
    socket.onopen = () => {
      this.armSilence()
      const hello: MobileHello = {
        t: 'hello',
        protocol: MOBILE_BRIDGE_PROTOCOL,
        appVersion: this.options.appVersion,
        client: { ...this.options.client, kind: 'mobile', mobileApi: MOBILE_API_VERSION },
      }
      this.write(hello)
      this.welcomeTimer = setTimeout(
        () => socket.close(MOBILE_BRIDGE_CLOSE.dead, 'no-welcome'),
        MOBILE_BRIDGE_LIMITS.welcomeTimeoutMs
      )
    }
    socket.onmessage = (event) => this.receive(socket, event.data)
    socket.onerror = () => {}
    socket.onclose = (event) => this.closed(socket, event.code)
  }

  private receive(socket: MobileBridgeSocket, data: unknown): void {
    if (socket !== this.socket) return
    this.armSilence()
    let raw: unknown
    try {
      raw = decodeMobileValue(JSON.parse(typeof data === 'string' ? data : String(data)))
    } catch {
      return
    }
    const parsed = mobileHostFrameSchema.safeParse(raw)
    if (!parsed.success) return
    const frame = parsed.data
    switch (frame.t) {
      case 'welcome':
        if (this.welcomeTimer) clearTimeout(this.welcomeTimer)
        this.welcomeTimer = null
        if (frame.mobileApi !== MOBILE_API_VERSION) {
          this.finish('unsupported')
          return
        }
        this.welcomed = true
        this.attempt = 0
        this.write({ t: 'open', origin: ORIGIN, role: 'main' })
        this.setState('open')
        this.options.onReady?.()
        return
      case 'refused':
        this.finish('refused', { hostVersion: frame.hostVersion })
        return
      case 'result': {
        const pending = this.pending.get(frame.id)
        if (!pending) return
        this.pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.ok) pending.resolve(frame.value)
        else pending.reject(new MobileBridgeError(frame.error.code ?? 'HOST_ERROR', frame.error.message))
        return
      }
      case 'event': {
        if (frame.origin !== ORIGIN) return
        const key = MOBILE_EVENT_KEYS.get(frame.channel)
        if (!key) return
        const payload = MOBILE_EVENTS[key].payload.safeParse(frame.args[0])
        if (payload.success) this.options.onEvent({ key, payload: payload.data } as MobileEvent)
        return
      }
      case 'ping':
        this.write({ t: 'pong', n: frame.n })
        return
      case 'pong':
        return
    }
  }

  private armSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    const socket = this.socket
    this.silenceTimer = setTimeout(
      () => socket?.close(MOBILE_BRIDGE_CLOSE.dead, 'silent'),
      MOBILE_BRIDGE_LIMITS.silenceMs
    )
  }

  private closed(socket: MobileBridgeSocket, code: number): void {
    if (socket !== this.socket) return
    const welcomed = this.welcomed
    this.teardown(new MobileBridgeError('DISCONNECTED', 'The connection to the host was lost', true))
    if (this.stopped) return
    // A host from before phones rejects the phone's hello as a bad frame.
    if (!welcomed && code === MOBILE_BRIDGE_CLOSE.badFrame) return this.finish('unsupported')
    if (code === MOBILE_BRIDGE_CLOSE.refused) return this.finish('refused')
    this.scheduleRetry('retrying')
  }

  private teardown(error: MobileBridgeError): void {
    const socket = this.socket
    this.socket = null
    this.welcomed = false
    for (const timer of [this.welcomeTimer, this.silenceTimer, this.retryTimer]) if (timer) clearTimeout(timer)
    this.welcomeTimer = this.silenceTimer = this.retryTimer = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      try {
        socket.close(1000, 'closing')
      } catch {
        // Already closed.
      }
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private finish(state: 'refused' | 'unsupported' | 'unauthorized', detail?: { hostVersion?: string }): void {
    this.stopped = true
    this.teardown(new MobileBridgeError(state.toUpperCase(), 'The bridge stopped', false))
    this.setState(state, detail)
  }

  private scheduleRetry(state: 'retrying' | 'unavailable'): void {
    const delay = mobileRetryDelay(this.attempt++, this.options.random ?? Math.random)
    this.setState(state, { retryInMs: delay })
    this.retryTimer = setTimeout(() => void this.connect(), delay)
  }
}
