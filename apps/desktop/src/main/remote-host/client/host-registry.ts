import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import type { FleetServerId } from '../../../shared/fleet-servers'
import { type HostId, isValidHostId, LOCAL_HOST_ID, remoteHostId } from '../../../shared/host-key'
import type { HostView } from '../../../shared/hosts'
import type { RemoteOriginRole, RemoteOs } from '../../../shared/remote-bridge'
import { type BridgeClientSocket, HostConnection, type HostConnectionTimings } from './host-connection'

/** One paired server, as the registry reads it: where it is, its environments, and this computer's name there. */
export interface HostRegistryServer {
  id: FleetServerId
  getConnection(): { url: string | null; hostname: string | null }
  getSnapshot(): { environments: FleetEnvironment[] }
  /** Asks the server for a one-use ticket to the bridge of a workspaces environment. */
  bridgeTicket(environmentId: string): Promise<{ path: string }>
  /** The name this computer has on the server, which its hosts show while it is connected. */
  deviceName(): string | null
}

/** Every paired server, and a call back whenever one is paired, removed, or changes. */
export interface HostRegistryServers {
  list(): HostRegistryServer[]
  onChange(listener: () => void): () => void
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
  servers: HostRegistryServers
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

type Remote = {
  connection: HostConnection
  label: string
  server: string
  serverId: FleetServerId | null
  environment: FleetEnvironment | null
}

/**
 * The hosts this computer's windows can show: this computer, and the workspaces environments of every paired server,
 * one per scope of the owner's work, each named after its environment.
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
        serverId: null,
        environment: null,
      })
      connection.start()
    }
    this.stopFleet = this.deps.servers.onChange(() => this.sync())
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
      serverId: null,
      tint: null,
      state: 'online',
      epoch: 0,
      os: this.deps.local.os,
      homeDir: this.deps.local.homeDir,
      desktopEffects: true,
      editor: true,
      browser: true,
      computer: false,
      folderTransfers: false,
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
      serverId: remote.serverId,
      tint: environment?.tint ?? null,
      state,
      epoch,
      os: info?.os ?? 'linux',
      homeDir: info?.homeDir ?? '',
      desktopEffects: info?.desktopEffects ?? false,
      editor: info?.editor ?? false,
      browser: info?.browser ?? false,
      computer: info?.computer ?? false,
      folderTransfers: info?.folderTransfers ?? false,
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

  private connection(
    hostId: HostId,
    connect: () => Promise<BridgeClientSocket>,
    serverId: FleetServerId | null = null
  ): HostConnection {
    return new HostConnection({
      connect,
      appVersion: this.deps.appVersion,
      // A host sees this computer under the name it has on the host's server.
      client: () => {
        const client = this.deps.client()
        const name = serverId ? this.server(serverId)?.deviceName() : null
        return name ? { ...client, deviceName: name.slice(0, 128) } : client
      },
      onChange: () => this.changed(),
      onEvent: (origin, channel, args) => this.deps.onEvent(hostId, origin, channel, args),
      timings: this.deps.timings,
    })
  }

  private server(serverId: FleetServerId): HostRegistryServer | null {
    return this.deps.servers.list().find((server) => server.id === serverId) ?? null
  }

  /** Dials a host through its own server, looked up when it dials: the server may have moved or left since. */
  private async gatewaySocket(serverId: FleetServerId, environmentId: string): Promise<BridgeClientSocket> {
    const server = this.server(serverId)
    if (!server?.getConnection().url) throw new Error('The server is not connected.')
    const ticket = await server.bridgeTicket(environmentId)
    if (!TICKET_PATH.test(ticket.path)) throw new Error('Invalid bridge ticket path')
    const origin = server.getConnection().url
    if (!origin) throw new Error('The server is not connected.')
    const url = new URL(origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return this.deps.openSocket(url.origin + ticket.path)
  }

  /** Follows every paired server: the workspaces environments of each become hosts, and leave with it. */
  private sync(): void {
    const wanted = new Map<HostId, { server: HostRegistryServer; environment: FleetEnvironment }>()
    for (const server of this.deps.servers.list()) {
      if (server.getConnection().url === null) continue
      for (const environment of server.getSnapshot().environments) {
        if (environment.kind !== 'workspaces') continue
        const id = remoteHostId(server.id, environment.id)
        if (isValidHostId(id)) wanted.set(id, { server, environment })
      }
    }
    for (const [id, remote] of [...this.remotes]) {
      if (id === DIRECT_HOST_ID || wanted.has(id)) continue
      remote.connection.stop()
      this.remotes.delete(id)
    }
    for (const [id, { server, environment }] of wanted) {
      const name = server.getConnection().hostname ?? ''
      let remote = this.remotes.get(id)
      if (!remote) {
        remote = {
          connection: this.connection(id, () => this.gatewaySocket(server.id, environment.id), server.id),
          label: environment.name,
          server: name,
          serverId: server.id,
          environment,
        }
        this.remotes.set(id, remote)
      }
      // A server holds several environments, one per scope: each host is named after its own.
      remote.label = environment.name
      remote.server = name
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
