import net from 'node:net'
import type { FleetRemoteTarget, FleetTunnelState } from '../../../shared/fleet-installer'
import { InstallerError } from './errors'
import { BOT_SERVER_GATEWAY_PORT } from './project'
import { SshSession } from './ssh'

/** What the tunnel needs from an SSH connection. */
export type TunnelSession = Pick<SshSession, 'forward' | 'onClose' | 'close'>

export interface TunnelOptions {
  target: FleetRemoteTarget
  hostKey: string
  /** Maestrly's key to the server; null asks the owner to set up access again. */
  privateKey: () => string | null
  /**
   * The SSH session to carry the traffic instead of one signed in with `privateKey`, such as setup's own session until
   * Maestrly's key is on the server. The tunnel does not close it; rejecting with `ssh-auth` stops the tunnel.
   */
  session?: () => Promise<TunnelSession>
  listenPort: number
  remotePort?: number
  delay?: (attempt: number) => number
  /** A free loopback port, used when `listenPort` is taken. */
  freePort?: () => Promise<number>
  onState?: (state: FleetTunnelState) => void
  onForwardError?: (error: InstallerError | null) => void
}

/**
 * Forwards `127.0.0.1:<port>` on this computer to the gateway on the server's loopback, over one SSH connection that
 * reconnects with backoff. A local connection without an SSH session is dropped at once; the fleet client retries.
 * A changed host key stops it for good.
 */
export class SshTunnel {
  private server: net.Server | null = null
  private session: TunnelSession | null = null
  private readonly sockets = new Set<net.Socket>()
  private currentState: FleetTunnelState = 'off'
  private currentPort: number
  private stopped = false
  private wake: (() => void) | null = null
  /** The last error opening a channel to the gateway, such as forwarding being disabled on the server. */
  lastForwardError: InstallerError | null = null

  constructor(private readonly options: TunnelOptions) {
    this.currentPort = options.listenPort
  }

  get port(): number {
    return this.currentPort
  }

  get state(): FleetTunnelState {
    return this.currentState
  }

  private setState(state: FleetTunnelState) {
    if (state === this.currentState) return
    this.currentState = state
    this.options.onState?.(state)
  }

  /** Listens on this computer, then connects in the background; resolves with the port it listens on. */
  async start(): Promise<number> {
    if (this.server) return this.currentPort
    this.stopped = false
    const server = net.createServer((socket) => this.accept(socket))
    try {
      await listen(server, this.options.listenPort)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !this.options.freePort) throw error
      await listen(server, await this.options.freePort())
    }
    this.server = server
    this.currentPort = (server.address() as net.AddressInfo).port
    void this.run()
    return this.currentPort
  }

  private accept(socket: net.Socket) {
    const session = this.session
    if (!session) return socket.destroy()
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.pause()
    session.forward(this.options.remotePort ?? BOT_SERVER_GATEWAY_PORT).then(
      (channel) => {
        const recovered = this.lastForwardError !== null
        this.lastForwardError = null
        if (recovered) this.options.onForwardError?.(null)
        if (socket.destroyed) return channel.destroy()
        channel.on('error', () => socket.destroy())
        channel.once('close', () => socket.destroy())
        socket.once('close', () => channel.destroy())
        socket.pipe(channel).pipe(socket)
        socket.resume()
      },
      (error: unknown) => {
        this.lastForwardError = error instanceof InstallerError ? error : new InstallerError('unknown', String(error))
        this.options.onForwardError?.(this.lastForwardError)
        socket.destroy()
      }
    )
  }

  /** How to open the next SSH session: the given one, or a sign-in with Maestrly's key; null without a key. */
  private opener(): (() => Promise<TunnelSession>) | null {
    if (this.options.session) return this.options.session
    const privateKey = this.options.privateKey()
    if (!privateKey) return null
    return () =>
      SshSession.connect(
        this.options.target,
        { kind: 'key', privateKey, passphrase: null },
        { expectedHostKey: this.options.hostKey, keepaliveIntervalMs: 15_000 }
      )
  }

  private async run() {
    const delay = this.options.delay ?? ((attempt: number) => Math.min(30_000, 1_000 * 2 ** attempt))
    let attempt = 0
    let connectedBefore = false
    while (!this.stopped) {
      const open = this.opener()
      if (!open) return this.setState('needs-credentials')
      this.setState(connectedBefore ? 'reconnecting' : 'connecting')
      try {
        const session = await open()
        if (this.stopped) {
          if (!this.options.session) session.close()
          return
        }
        this.session = session
        connectedBefore = true
        attempt = 0
        this.setState('connected')
        await new Promise<void>((resolve) => session.onClose(() => resolve()))
        this.session = null
        if (this.stopped) return
        this.setState('reconnecting')
      } catch (error) {
        if (this.stopped) return
        const code = error instanceof InstallerError ? error.code : null
        if (code === 'ssh-host-key') return this.setState('host-key-changed')
        if (code === 'ssh-auth') return this.setState('needs-credentials')
        attempt++
      }
      if (this.stopped) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay(attempt))
        timer.unref()
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wake = null
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.wake?.()
    if (!this.options.session) this.session?.close()
    this.session = null
    for (const socket of this.sockets) socket.destroy()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    this.setState('off')
  }
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}
