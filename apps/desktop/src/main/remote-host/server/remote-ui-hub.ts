import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { MOBILE_API_VERSION } from '@maestrly/bot-fleet-protocol'
import { WebSocketServer } from 'ws'
import { remoteChannelRefusal } from '../../../shared/host-channels'
import {
  type BridgeClientFrame,
  type BridgeHostFrame,
  REMOTE_BRIDGE_CLOSE,
  REMOTE_BRIDGE_LIMITS,
  REMOTE_BRIDGE_PROTOCOL,
  type RemoteHostInfo,
} from '../../../shared/remote-bridge'
import { registerRemoteUiTarget } from '../../remote-ui-targets'
import { BridgeFrameError, decodeClientFrame, encodeBridgeFrame } from '../bridge-codec'
import type { IpcHandlerTable, RecordedHandler } from '../ipc-handler-table'
import { MobileApi } from './mobile-api'
import { VirtualSender } from './virtual-sender'

/** What the hub needs from a bridge socket; a `ws` WebSocket in production. */
export interface BridgeSocket {
  readonly bufferedAmount: number
  send(text: string): void
  close(code: number, reason: string): void
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}

export interface RemoteUiHubDeps {
  table: IpcHandlerTable
  appVersion: string
  hostInfo: () => RemoteHostInfo
  /** The locale of the computer that connected, for the strings this host's main process writes. */
  applyLocale: (locale: string) => void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  /** A session was added or ended: what `tags()` lists may have changed. */
  onSessionsChanged?: () => void
}

type ResultError = { message: string; code?: string }

function failure(error: unknown): ResultError {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? { message, code } : { message }
}

const text = (data: unknown): string =>
  typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)

/**
 * One connected computer or phone. A computer's origins each have the virtual sender the IPC handlers talk to; a
 * phone's origin has the mobile API instead, the only channels it may call.
 */
class Session {
  private welcomed = false
  private mobile = false
  private readonly mobileOrigins = new Map<number, MobileApi>()
  private ended = false
  private lastSeen = Date.now()
  private pingCount = 0
  private readonly origins = new Map<number, { sender: VirtualSender; unregister: () => void }>()
  private readonly keepalive: ReturnType<typeof setInterval>

  constructor(
    private readonly deps: RemoteUiHubDeps,
    private readonly socket: BridgeSocket,
    /** The paired computer this session is for, on a desktop shared with the owner's computers; null otherwise. */
    readonly tag: string | null,
    private readonly onEnded: (session: Session) => void
  ) {
    socket.on('message', (data) => this.receive(text(data)))
    socket.on('close', () => this.end())
    socket.on('error', (error) => {
      deps.log('warn', `Bridge socket failed: ${failure(error).message}`)
      this.end()
    })
    this.keepalive = setInterval(() => {
      if (Date.now() - this.lastSeen > REMOTE_BRIDGE_LIMITS.deadMs) this.close(REMOTE_BRIDGE_CLOSE.dead, 'dead')
      else this.write({ t: 'ping', n: ++this.pingCount })
    }, REMOTE_BRIDGE_LIMITS.pingMs)
    this.keepalive.unref?.()
  }

  close(code: number, reason: string): void {
    if (this.ended) return
    try {
      this.socket.close(code, reason)
    } catch {
      /* The socket is already gone. */
    }
    this.end()
  }

  private end(): void {
    if (this.ended) return
    this.ended = true
    clearInterval(this.keepalive)
    for (const origin of new Set([...this.origins.keys(), ...this.mobileOrigins.keys()])) this.closeOrigin(origin)
    this.onEnded(this)
  }

  private closeOrigin(origin: number): void {
    this.mobileOrigins.get(origin)?.dispose()
    this.mobileOrigins.delete(origin)
    const entry = this.origins.get(origin)
    if (!entry) return
    this.origins.delete(origin)
    entry.unregister()
    entry.sender.destroy()
  }

  private write(frame: BridgeHostFrame): void {
    if (this.ended) return
    if (this.socket.bufferedAmount > REMOTE_BRIDGE_LIMITS.clientBufferMax)
      return this.close(REMOTE_BRIDGE_CLOSE.slowClient, 'slow-client')
    let encoded: string
    try {
      encoded = encodeBridgeFrame(frame)
    } catch (error) {
      if (!(error instanceof BridgeFrameError)) throw error
      // An invoke must get its answer; an event that cannot be sent is lost like any dropped push.
      if (frame.t === 'result')
        this.write({ t: 'result', id: frame.id, ok: false, error: { message: error.message, code: 'unsendable' } })
      else this.deps.log('warn', `Dropped a bridge frame: ${error.message}`)
      return
    }
    try {
      this.socket.send(encoded)
    } catch (error) {
      this.deps.log('warn', `Bridge send failed: ${failure(error).message}`)
      this.close(REMOTE_BRIDGE_CLOSE.dead, 'send-failed')
    }
  }

  private receive(raw: string): void {
    if (this.ended) return
    let frame: BridgeClientFrame
    try {
      frame = decodeClientFrame(raw)
    } catch {
      return this.close(REMOTE_BRIDGE_CLOSE.badFrame, 'bad-frame')
    }
    this.lastSeen = Date.now()
    if (frame.t === 'hello') return this.hello(frame)
    if (!this.welcomed) return this.close(REMOTE_BRIDGE_CLOSE.badFrame, 'hello-first')
    switch (frame.t) {
      case 'open':
        return this.open(frame)
      case 'close':
        return this.closeOrigin(frame.origin)
      case 'invoke':
        return this.invoke(frame)
      case 'send':
        return this.send(frame)
      case 'ping':
        return this.write({ t: 'pong', n: frame.n })
      case 'pong':
        return
    }
  }

  private hello(frame: Extract<BridgeClientFrame, { t: 'hello' }>): void {
    if (this.welcomed) return this.close(REMOTE_BRIDGE_CLOSE.badFrame, 'hello-twice')
    const { appVersion } = this.deps
    const phone = frame.client.os === 'ios' || frame.client.os === 'android'
    if (phone !== (frame.client.kind === 'mobile')) return this.close(REMOTE_BRIDGE_CLOSE.badFrame, 'bad-hello')
    if (frame.client.kind === 'mobile') {
      // A phone is released on its own schedule: it needs the same mobile API, not the same build. It speaks only the
      // versioned mobile channels, and leaves this host's language alone.
      const reason =
        frame.protocol !== REMOTE_BRIDGE_PROTOCOL
          ? 'protocol'
          : frame.client.mobileApi !== MOBILE_API_VERSION
            ? 'mobile-api'
            : null
      if (reason) {
        this.write({ t: 'refused', reason, hostVersion: appVersion })
        return this.close(REMOTE_BRIDGE_CLOSE.refused, reason)
      }
      this.welcomed = true
      this.mobile = true
      this.write({
        t: 'welcome',
        protocol: REMOTE_BRIDGE_PROTOCOL,
        appVersion,
        host: this.deps.hostInfo(),
        mobileApi: MOBILE_API_VERSION,
      })
      return
    }
    // The renderer on the other computer calls this host's handlers directly, so both must be the same build.
    const reason =
      frame.protocol !== REMOTE_BRIDGE_PROTOCOL ? 'protocol' : frame.appVersion !== appVersion ? 'version' : null
    if (reason) {
      this.write({ t: 'refused', reason, hostVersion: appVersion })
      return this.close(REMOTE_BRIDGE_CLOSE.refused, reason)
    }
    this.welcomed = true
    this.deps.applyLocale(frame.client.locale)
    this.write({ t: 'welcome', protocol: REMOTE_BRIDGE_PROTOCOL, appVersion, host: this.deps.hostInfo() })
  }

  private open(frame: Extract<BridgeClientFrame, { t: 'open' }>): void {
    if (this.origins.has(frame.origin) || this.mobileOrigins.has(frame.origin)) return
    const { origin } = frame
    if (this.mobile) {
      if (frame.role !== 'main') return
      this.mobileOrigins.set(
        origin,
        new MobileApi({
          table: this.deps.table,
          emit: (channel, payload) => this.write({ t: 'event', origin, channel, args: [payload] }),
          log: this.deps.log,
        })
      )
      return
    }
    const sender = new VirtualSender((channel, args) => this.write({ t: 'event', origin, channel, args }))
    const unregister = registerRemoteUiTarget(
      sender,
      frame.role === 'main' ? { role: 'main' } : { role: 'panel', convId: frame.convId, panel: frame.panel }
    )
    this.origins.set(origin, { sender, unregister })
  }

  /** The handler to run for a frame, or why it cannot run. */
  private resolve(
    frame: { origin: number; channel: string },
    kind: RecordedHandler['kind']
  ): { error: ResultError } | { handler: RecordedHandler; event: object } {
    if (remoteChannelRefusal(frame.channel))
      return { error: { message: 'This action is not available on a remote host.', code: 'remote-unsupported' } }
    const handler = this.deps.table.get(frame.channel)
    if (!handler || handler.kind !== kind) return { error: { message: 'Unknown channel', code: 'unknown-channel' } }
    const sender = this.origins.get(frame.origin)?.sender
    if (!sender) return { error: { message: 'Unknown origin', code: 'unknown-origin' } }
    // What a handler reads from Electron's event: the sender, and no frame (a remote renderer has no sub-frames).
    const event = {
      sender,
      senderFrame: null,
      processId: -1,
      frameId: -1,
      reply: (channel: string, ...args: unknown[]) => sender.send(channel, ...args),
    }
    return { handler, event }
  }

  private invoke(frame: Extract<BridgeClientFrame, { t: 'invoke' }>): void {
    if (this.mobile) {
      const api = this.mobileOrigins.get(frame.origin)
      if (!api)
        return this.write({
          t: 'result',
          id: frame.id,
          ok: false,
          error: { message: 'Unknown origin', code: 'unknown-origin' },
        })
      api.invoke(frame.channel, frame.args).then(
        (value) => this.write({ t: 'result', id: frame.id, ok: true, value }),
        (error) => this.write({ t: 'result', id: frame.id, ok: false, error: failure(error) })
      )
      return
    }
    const target = this.resolve(frame, 'invoke')
    if ('error' in target) return this.write({ t: 'result', id: frame.id, ok: false, error: target.error })
    Promise.resolve()
      .then(() => target.handler.fn(target.event, ...frame.args))
      .then(
        (value) => this.write({ t: 'result', id: frame.id, ok: true, value }),
        (error) => this.write({ t: 'result', id: frame.id, ok: false, error: failure(error) })
      )
  }

  private send(frame: Extract<BridgeClientFrame, { t: 'send' }>): void {
    // The mobile API has calls only.
    if (this.mobile) return
    const target = this.resolve(frame, 'send')
    if ('error' in target) return
    try {
      target.handler.fn(target.event, ...frame.args)
    } catch (error) {
      this.deps.log('warn', `Handler of ${frame.channel} failed: ${failure(error).message}`)
    }
  }
}

/**
 * The host end of the bridge: each socket is one computer whose renderers use this host. A renderer's calls arrive as
 * `invoke` and `send` frames and run the same IPC handlers a window of this app would reach; what those handlers and
 * the rest of the main process push to a renderer goes back as `event` frames. The control server authenticates the
 * socket before handing it over.
 */
export class RemoteUiHub {
  private readonly sessions = new Set<Session>()
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: REMOTE_BRIDGE_LIMITS.maxFrameBytes,
    // Frames are JSON text, often sent over a slow link; small ones are not worth compressing.
    perMessageDeflate: { threshold: 1024 },
  })

  constructor(private readonly deps: RemoteUiHubDeps) {}

  attach(socket: BridgeSocket, tag: string | null = null): void {
    this.sessions.add(
      new Session(this.deps, socket, tag, (session) => {
        if (this.sessions.delete(session)) this.deps.onSessionsChanged?.()
      })
    )
    this.deps.onSessionsChanged?.()
  }

  /** Completes the WebSocket handshake of an authenticated upgrade request and attaches the socket. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, tag: string | null = null): void {
    this.server.handleUpgrade(request, socket, head, (ws) => this.attach(ws, tag))
  }

  sessionCount(): number {
    return this.sessions.size
  }

  /** The paired computers connected now, once each. */
  tags(): string[] {
    return [...new Set([...this.sessions].flatMap((session) => (session.tag ? [session.tag] : [])))]
  }

  /**
   * Closes every session of one paired computer: one this host no longer lets use it (`removed`), or one its owner
   * disconnected for now (`disconnected`), which stays paired.
   */
  closeTagged(tag: string, why: 'removed' | 'disconnected' = 'removed'): void {
    for (const session of [...this.sessions]) {
      if (session.tag === tag) session.close(REMOTE_BRIDGE_CLOSE[why], why)
    }
  }

  closeAll(code = 1001, reason = 'host-stopping'): void {
    for (const session of [...this.sessions]) session.close(code, reason)
  }
}
