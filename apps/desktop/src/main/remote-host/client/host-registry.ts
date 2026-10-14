import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { type HostId, isValidHostId, LOCAL_HOST_ID, remoteHostId } from '../../../shared/host-key'
import type { HostView } from '../../../shared/hosts'
import type { RemoteOriginRole, RemoteOs } from '../../../shared/remote-bridge'
import { type BridgeClientSocket, HostConnection, type HostConnectionTimings } from './host-connection'

/** What the registry reads from the fleet client: the paired server and its environments. */
export interface HostRegistryFleet {
  getConnection(): { url: string | null; hostname: string | null }
  getSnapshot(): { environments: FleetEnvironment[] }
  onChange(listener: () => void): () => void
  /** Asks the server for a one-use ticket to the bridge of a workspaces environment. */
  bridgeTicket(environmentId: string): Promise<{ path: string }>
}

/** A host reached without a server, for development and tests: its control server's address and token. */
export interface DirectHost {
  origin: string
  token: string
}

/**
 * A host reached straight at its control server, without a bot server in between: `http://<token>@<address>:<port>`
 * in `MAESTRLY_DEV_DIRECT_HOST`. Honored only by development and test builds.
 */
export function parseDirectHost(value: string | undefined, allowed: boolean): DirectHost | null {
  if (!allowed || !value) return null
  try {
    const url = new URL(value)
    const token = decodeURIComponent(url.username)
    if (!token || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
    return { origin: `${url.protocol}//${url.host}`, token }
  } catch {
    return null
  }
}

export interface HostRegistryDeps {
  fleet: HostRegistryFleet
  /** This computer's id for the paired server. */
  serverId: () => string
  appVersion: string
  local: { os: RemoteOs; homeDir: string }
  client: () => { deviceName: string; os: RemoteOs; locale: string }
  openSocket: (url: string) => BridgeClientSocket
  direct?: { host: DirectHost; openSocket: (host: DirectHost) => BridgeClientSocket } | null
  onChanged: (hosts: HostView[]) => void
  onEvent: (hostId: HostId, origin: number, channel: string, args: unknown[]) => void
  timings?: Partial<HostConnectionTimings>
}

export const DIRECT_HOST_ID: HostId = 'direct/host'

const TICKET_PATH = /^\/v1\/bridge\?ticket=[A-Za-z0-9_-]+$/

type Remote = { connection: HostConnection; label: string; server: string; environment: FleetEnvironment | null }

/**
 * The hosts this computer's windows can show: this computer, and the workspaces environments of the paired server, one
 * per scope of the owner's work, each named after its environment.
 * A remote host has a connection while its environment runs; stopped, starting or failed, it stays listed as offline
 * with its environment's state, so the window can offer to start it.
 */
export class HostRegistry {
  private readonly remotes = new Map<HostId, Remote>()
  private stopFleet: (() => void) | null = null
  private last = ''

  constructor(private readonly deps: HostRegistryDeps) {}

  start(): void {
    const direct = this.deps.direct
    if (direct) {
      const connection = this.connection(DIRECT_HOST_ID, async () => direct.openSocket(direct.host))
      this.remotes.set(DIRECT_HOST_ID, {
        connection,
        label: new URL(direct.host.origin).host,
        server: '',
        environment: null,
      })
      connection.start()
    }
    this.stopFleet = this.deps.fleet.onChange(() => this.sync())
    this.sync()
  }

  stop(): void {
    this.stopFleet?.()
    this.stopFleet = null
    for (const remote of this.remotes.values()) remote.connection.stop()
    this.remotes.clear()
  }

  list(): HostView[] {
    const local: HostView = {
      id: LOCAL_HOST_ID,
      remote: false,
      label: '',
      server: '',
      tint: null,
      state: 'online',
      epoch: 0,
      os: this.deps.local.os,
      homeDir: this.deps.local.homeDir,
      desktopEffects: true,
      editor: true,
      browser: true,
      computer: false,
      environment: null,
      hostVersion: null,
    }
    return [local, ...[...this.remotes].map(([id, remote]) => this.view(id, remote))]
  }

  private view(id: HostId, remote: Remote): HostView {
    const { state, epoch, info, hostVersion } = remote.connection.snapshot()
    const environment = remote.environment
    return {
      id,
      remote: true,
      label: remote.label,
      server: remote.server,
      tint: environment?.tint ?? null,
      state,
      epoch,
      os: info?.os ?? 'linux',
      homeDir: info?.homeDir ?? '',
      desktopEffects: info?.desktopEffects ?? false,
      editor: info?.editor ?? false,
      browser: info?.browser ?? false,
      computer: info?.computer ?? false,
      environment: environment && {
        id: environment.id,
        lifecycle: environment.lifecycle,
        updateAvailable: environment.update?.available === true,
      },
      hostVersion,
    }
  }

  /** The development host reached without a server, when this window has one. */
  directHost(): DirectHost | null {
    return this.deps.direct?.host ?? null
  }

  /** The connection of a remote host that is listed, whatever its state. */
  get(hostId: HostId): HostConnection | null {
    return this.remotes.get(hostId)?.connection ?? null
  }

  retry(hostId: HostId): void {
    this.get(hostId)?.retry()
  }

  /** Makes a renderer an origin of a host on its first call, and returns the host's connection. */
  use(hostId: HostId, origin: number, role: () => RemoteOriginRole): HostConnection {
    const connection = this.get(hostId)
    if (!connection) throw new Error('Unknown host')
    if (!connection.hasOrigin(origin)) connection.openOrigin(origin, role())
    return connection
  }

  /** A renderer of this computer went away: no host keeps it as an origin. */
  closeOrigin(origin: number): void {
    for (const remote of this.remotes.values()) remote.connection.closeOrigin(origin)
  }

  private connection(hostId: HostId, connect: () => Promise<BridgeClientSocket>): HostConnection {
    return new HostConnection({
      connect,
      appVersion: this.deps.appVersion,
      client: this.deps.client,
      onChange: () => this.changed(),
      onEvent: (origin, channel, args) => this.deps.onEvent(hostId, origin, channel, args),
      timings: this.deps.timings,
    })
  }

  private async gatewaySocket(environmentId: string): Promise<BridgeClientSocket> {
    const ticket = await this.deps.fleet.bridgeTicket(environmentId)
    if (!TICKET_PATH.test(ticket.path)) throw new Error('Invalid bridge ticket path')
    const origin = this.deps.fleet.getConnection().url
    if (!origin) throw new Error('The server is not connected.')
    const url = new URL(origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return this.deps.openSocket(url.origin + ticket.path)
  }

  /** Follows the paired server: its workspaces environments become hosts, and leave with it. */
  private sync(): void {
    const { fleet } = this.deps
    const paired = fleet.getConnection().url !== null
    const environments = paired
      ? fleet.getSnapshot().environments.filter((environment) => environment.kind === 'workspaces')
      : []
    const wanted = new Map<HostId, FleetEnvironment>()
    if (environments.length) {
      const serverId = this.deps.serverId()
      for (const environment of environments) {
        const id = remoteHostId(serverId, environment.id)
        if (isValidHostId(id)) wanted.set(id, environment)
      }
    }
    for (const [id, remote] of [...this.remotes]) {
      if (id === DIRECT_HOST_ID || wanted.has(id)) continue
      remote.connection.stop()
      this.remotes.delete(id)
    }
    const server = fleet.getConnection().hostname ?? ''
    for (const [id, environment] of wanted) {
      let remote = this.remotes.get(id)
      if (!remote) {
        remote = {
          connection: this.connection(id, () => this.gatewaySocket(environment.id)),
          label: environment.name,
          server,
          environment,
        }
        this.remotes.set(id, remote)
      }
      // A server holds several environments, one per scope: each host is named after its own.
      remote.label = environment.name
      remote.server = server
      remote.environment = environment
      // A bridge exists only while the environment runs: restarted or updated, it is dialed again from scratch.
      if (environment.lifecycle === 'running') remote.connection.start()
      else remote.connection.stop()
    }
    this.changed()
  }

  private changed(): void {
    const hosts = this.list()
    const text = JSON.stringify(hosts)
    if (text === this.last) return
    this.last = text
    this.deps.onChanged(hosts)
  }
}
