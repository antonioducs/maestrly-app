import type https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { HostFilesRoutes } from '../fleet/instance/host-files-http'
import type { EditorRoutes } from '../fleet/instance/server'
import { RemoteUiHub, type RemoteUiHubDeps } from '../remote-host/server/remote-ui-hub'
import { PEER_DEFAULT_PORT, type PeerGrant, type PeerPairingRequest } from '../../shared/peer'
import type { RemoteOs } from '../../shared/remote-bridge'
import type { PeerIdentity, PeerStorage } from './identity'
import { HostPairings, type PairingPrompt, PeerPairingError } from './pairing-host'
import { createPeerServer } from './server'
import { issueToken, newPeerRecord, type PeerStore } from './store'

const HOSTING_KEY = 'peer.hosting'
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
  bind?: { host: string; port: number }
  now?(): number
}

/** Listens on `port`, or on one of the next ports when it is taken; port 0 lets the system choose. */
async function listenFrom(server: https.Server, host: string, first: number): Promise<number> {
  for (let offset = 0; offset <= (first === 0 ? 0 : NEXT_PORTS); offset++) {
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
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || first === 0) throw error
    }
  }
  throw new Error('No free port for the peer server.')
}

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

  /** The paired computers using this one now. */
  connected(): string[] {
    return this.hub.tags()
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

  private async open(): Promise<void> {
    if (this.server) return
    const identity = this.deps.identity()
    if (!identity) return
    const server = createPeerServer({
      identity,
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
    this.port = await listenFrom(server, bind.host, bind.port)
    this.server = server
    this.known = new Set(this.deps.store.list().map((record) => record.deviceId))
    this.stopStore = this.deps.store.onChange(() => this.dropRemoved())
    void this.deps.hostFiles.sweep().catch(() => undefined)
    // Folder archives are whole copies of folders: the ones nobody reads go within the day.
    this.sweepTimer = setInterval(() => void this.deps.hostFiles.sweep().catch(() => undefined), HOST_FILES_SWEEP_MS)
    this.sweepTimer.unref?.()
  }

  private async close(): Promise<void> {
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
    const busy = this.hub.tags().length > 0
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
        now: this.now(),
      }),
      grant.token
    )
    if (!saved) throw new PeerPairingError('unavailable')
    return { token, port: this.port, addresses: this.deps.localAddresses() }
  }
}
