import type https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { HostFilesRoutes } from '../fleet/instance/host-files-http'
import type { EditorRoutes } from '../fleet/instance/server'
import { RemoteUiHub, type RemoteUiHubDeps } from '../remote-host/server/remote-ui-hub'
import {
  isPeerPort,
  PEER_DEFAULT_PORT,
  type PeerGrant,
  type PeerPairingRequest,
  type PeerPortError,
} from '../../shared/peer'
import { REMOTE_BRIDGE_CLOSE, type RemoteOs } from '../../shared/remote-bridge'
import type { PeerIdentity, PeerStorage } from './identity'
import { HostPairings, type PairingPrompt, PeerPairingError } from './pairing-host'
import { createPeerServer } from './server'
import { issueToken, newPeerRecord, type PeerStore } from './store'

const HOSTING_KEY = 'peer.hosting'
const PORT_KEY = 'peer.port'
const AWAKE_KEY = 'peer-sessions'
const NEXT_PORTS = 9
const HOST_FILES_SWEEP_MS = 60 * 60 * 1_000

export interface PeerHostingDeps {
  storage: PeerStorage
  /** This profile's identity, created on first use; null without a keyring. */
  identity(): PeerIdentity | null
  store: PeerStore
  appVersion: string
  os: RemoteOs
  hub: Omit<RemoteUiHubDeps, 'applyLocale' | 'onSessionsChanged'>
  hostFiles: HostFilesRoutes & { sweep(): Promise<unknown> }
  editor: EditorRoutes & { closeAll(): void }
  holdAwake(key: string): () => void
  /** Where the owner's other computers may reach this one, newest first. */
  localAddresses(): string[]
  onPrompt(prompt: PairingPrompt): void
  /** Hosting, its port, or the computers using this one changed. */
  onChange(): void
  /** Where the peer server listens without a port the owner chose; port 0 lets the system choose. */
  bind?: { host: string; port: number }
  now?(): number
}

/** Listens on `first`, or on one of the `next` ports after it when it is taken; port 0 lets the system choose. */
async function listenFrom(server: https.Server, host: string, first: number, next: number): Promise<number> {
  const last = first === 0 ? 0 : next
  for (let offset = 0; offset <= last; offset++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(first === 0 ? 0 : first + offset, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      return (server.address() as AddressInfo).port
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || offset === last) throw error
    }
  }
  throw new Error('No free port for the peer server.')
}

const portError = (error: unknown): PeerPortError =>
  (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'in-use' : 'failed'

type Bound = { server: https.Server; port: number } | { error: unknown }

/**
 * This desktop shared with the owner's other computers: while the owner keeps it on, a peer server takes pairings
 * and lets paired computers use this profile through the remote UI hub, its files, and its editor, as a workspaces
 * host does. This computer's own language stays its own, and it stays awake while another computer uses it.
 */
export class PeerHosting {
  readonly hub: RemoteUiHub
  readonly pairings: HostPairings
  private server: https.Server | null = null
  private port: number | null = null
  private releaseAwake: (() => void) | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private stopStore: (() => void) | null = null
  private known = new Set<string>()
  /** Since when each paired computer uses this one. */
  private readonly since = new Map<string, number>()
  private failure: string | null = null
  private readonly now: () => number

  constructor(private readonly deps: PeerHostingDeps) {
    this.now = deps.now ?? Date.now
    this.hub = new RemoteUiHub({
      ...deps.hub,
      // The owner sits at this computer: another one does not change its language.
      applyLocale: () => {},
      onSessionsChanged: () => this.sessionsChanged(),
    })
    this.pairings = new HostPairings({
      identity: () => this.requireIdentity(),
      appVersion: deps.appVersion,
      now: this.now,
      onPrompt: deps.onPrompt,
      onPaired: (client, grant, remote) => this.paired(client, grant, remote),
    })
  }

  enabled(): boolean {
    return this.deps.storage.get(HOSTING_KEY) === '1'
  }

  listeningPort(): number | null {
    return this.port
  }

  /** The port the owner chose; null for the default, or one of the next ports when another program holds it. */
  chosenPort(): number | null {
    const port = Number(this.deps.storage.get(PORT_KEY) || Number.NaN)
    return isPeerPort(port) ? port : null
  }

  /**
   * Keeps the port the owner chose, or the default for null. While sharing is on, the peer server takes the new port
   * before it leaves the old one: when it cannot, nothing changes and the reason is returned. The computers using this
   * one are told the new port as their sessions close, and reconnect there.
   */
  async setPort(port: number | null): Promise<PeerPortError | null> {
    if (port !== null && !isPeerPort(port)) return 'invalid'
    if (port === this.chosenPort()) return null
    const identity = this.deps.identity()
    // Already where it would go: the server stays rather than fail to take the port it holds itself.
    const stays = this.port !== null && this.port === (port ?? (this.deps.bind ? null : PEER_DEFAULT_PORT))
    if (this.enabled() && identity && !stays) {
      const bound = await this.bind(identity, port)
      if ('error' in bound) return portError(bound.error)
      this.deps.storage.set(PORT_KEY, port === null ? '' : String(port))
      if (this.server) await this.move(bound)
      else this.adopt(bound)
    } else {
      this.deps.storage.set(PORT_KEY, port === null ? '' : String(port))
    }
    this.deps.onChange()
    return null
  }

  /** The paired computers using this one now. */
  connected(): string[] {
    return this.hub.tags()
  }

  /** Since when a paired computer uses this one; null while it does not. */
  connectedSince(deviceId: string): number | null {
    return this.since.get(deviceId) ?? null
  }

  /** Why sharing is on and the peer server does not listen, as the system said; null otherwise. */
  error(): string | null {
    return this.failure
  }

  /**
   * Ends what a paired computer has open here now. It stays paired: its owner can connect it again, and only removing
   * it stops it for good.
   */
  disconnect(deviceId: string): void {
    if (!this.since.has(deviceId)) return
    this.hub.closeTagged(deviceId, 'disconnected')
    this.deps.editor.closeAll()
  }

  /** Opens the peer server at startup when the owner left hosting on. */
  async start(): Promise<void> {
    if (this.enabled()) await this.open()
  }

  async setEnabled(on: boolean): Promise<'ok' | 'keyring-unavailable'> {
    if (on) {
      if (!this.deps.identity()) return 'keyring-unavailable'
      this.deps.storage.set(HOSTING_KEY, '1')
      await this.open()
    } else {
      this.deps.storage.set(HOSTING_KEY, '')
      await this.close()
    }
    this.deps.onChange()
    return 'ok'
  }

  async stop(): Promise<void> {
    await this.close()
  }

  private requireIdentity(): PeerIdentity {
    const identity = this.deps.identity()
    if (!identity) throw new PeerPairingError('unavailable')
    return identity
  }

  /** Opens the peer server; a port it cannot take is kept as the error Settings shows. */
  private async open(): Promise<void> {
    if (this.server) return
    const identity = this.deps.identity()
    if (!identity) return
    const bound = await this.bind(identity, this.chosenPort())
    if ('error' in bound) {
      this.failure = bound.error instanceof Error ? bound.error.message : String(bound.error)
      return
    }
    this.adopt(bound)
  }

  /** A peer server listening on the port the owner chose, exactly, or on the default or one of the next ports. */
  private async bind(identity: PeerIdentity, chosen: number | null): Promise<Bound> {
    const server = createPeerServer({
      identity,
      name: () => this.deps.identity()?.name ?? identity.name,
      appVersion: this.deps.appVersion,
      os: this.deps.os,
      store: this.deps.store,
      pairings: this.pairings,
      bridge: this.hub,
      hostFiles: this.deps.hostFiles,
      editor: this.deps.editor,
      now: this.now,
    })
    const bind = this.deps.bind ?? { host: '0.0.0.0', port: PEER_DEFAULT_PORT }
    try {
      const port =
        chosen === null
          ? await listenFrom(server, bind.host, bind.port, NEXT_PORTS)
          : await listenFrom(server, bind.host, chosen, 0)
      return { server, port }
    } catch (error) {
      return { error }
    }
  }

  private adopt(bound: { server: https.Server; port: number }): void {
    this.failure = null
    this.server = bound.server
    this.port = bound.port
    this.known = new Set(this.deps.store.list().map((record) => record.deviceId))
    this.stopStore = this.deps.store.onChange(() => this.dropRemoved())
    void this.deps.hostFiles.sweep().catch(() => undefined)
    // Folder archives are whole copies of folders: the ones nobody reads go within the day.
    this.sweepTimer = setInterval(() => void this.deps.hostFiles.sweep().catch(() => undefined), HOST_FILES_SWEEP_MS)
    this.sweepTimer.unref?.()
  }

  /** Leaves the old port for a server that already listens on the new one; the store and sweep stay as they were. */
  private async move(bound: { server: https.Server; port: number }): Promise<void> {
    const old = this.server
    this.server = bound.server
    this.port = bound.port
    this.failure = null
    this.hub.closeAll(REMOTE_BRIDGE_CLOSE.moved, String(bound.port))
    this.deps.editor.closeAll()
    if (!old) return
    old.closeAllConnections()
    await new Promise<void>((resolve) => old.close(() => resolve()))
  }

  private async close(): Promise<void> {
    this.failure = null
    const server = this.server
    if (!server) return
    this.server = null
    this.port = null
    this.stopStore?.()
    this.stopStore = null
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    this.hub.closeAll()
    this.deps.editor.closeAll()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** A computer the owner removed loses its bridges at once, and the editor connections it may hold. */
  private dropRemoved(): void {
    const current = new Set(this.deps.store.list().map((record) => record.deviceId))
    const removed = [...this.known].filter((deviceId) => !current.has(deviceId))
    this.known = current
    if (!removed.length) return
    for (const deviceId of removed) this.hub.closeTagged(deviceId)
    this.deps.editor.closeAll()
  }

  private sessionsChanged(): void {
    const tags = new Set(this.hub.tags())
    for (const deviceId of tags) if (!this.since.has(deviceId)) this.since.set(deviceId, this.now())
    for (const deviceId of [...this.since.keys()]) if (!tags.has(deviceId)) this.since.delete(deviceId)
    const busy = tags.size > 0
    if (busy && !this.releaseAwake) this.releaseAwake = this.deps.holdAwake(AWAKE_KEY)
    if (!busy && this.releaseAwake) {
      this.releaseAwake()
      this.releaseAwake = null
    }
    this.deps.onChange()
  }

  /** Keeps the computer just paired and gives it what it needs to reach this one. */
  private paired(client: PeerPairingRequest, grant: PeerGrant, remote: string): PeerGrant {
    const token = issueToken()
    const saved = this.deps.store.save(
      newPeerRecord({
        deviceId: client.deviceId,
        name: client.name,
        os: client.os,
        certPem: client.certificate,
        port: grant.port ?? PEER_DEFAULT_PORT,
        addresses: [remote, ...grant.addresses],
        issuedToken: token,
        // A computer that does not share itself pairs without a port of its own.
        hosting: grant.port !== null,
        now: this.now(),
      }),
      grant.token
    )
    if (!saved) throw new PeerPairingError('unavailable')
    return { token, port: this.port, addresses: this.deps.localAddresses() }
  }
}
