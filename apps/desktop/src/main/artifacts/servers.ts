import type { ArtifactHostError } from '@maestrly/artifact-host'
import { defaultFleetServer, type FleetServerId } from '../../shared/fleet-servers'
import type { ArtifactServerView } from '../../shared/artifacts'
import type { FleetClientService } from '../fleet/client/service'
import { ServerArtifacts } from './server-artifacts'
import { type ArtifactSource, serverUnavailable, type ServerUnavailableReason } from './sources'

type ServerClient = Pick<FleetClientService, 'call' | 'hasFeature' | 'getConnection'>

/** A paired server as artifacts see it: its source while it can host, and why it cannot otherwise. */
export type ArtifactServerEntry = {
  serverId: FleetServerId
  source: ArtifactSource | null
  unavailable(): ArtifactHostError
}

/** What the artifacts service needs of the paired servers. */
export interface ArtifactServerSet {
  /** The server conversations of this computer publish to: the one chosen while it is paired, else the default. */
  publishing(): ServerArtifacts | null
  publishingId(): FleetServerId | null
  get(serverId: FleetServerId): ServerArtifacts | null
  entries(): ArtifactServerEntry[]
  views(): ArtifactServerView[]
  name(serverId: FleetServerId): string
  refresh(): Promise<void>
}

/**
 * The artifact hosts of every paired server, one `ServerArtifacts` each. Only the installed server is also reached
 * through the installer's separate viewer port; any other through its own address.
 */
export class ArtifactServers implements ArtifactServerSet {
  private readonly byId = new Map<FleetServerId, ServerArtifacts>()

  constructor(
    private readonly deps: {
      servers: () => Array<{ id: FleetServerId; installed: boolean }>
      client: (serverId: FleetServerId) => ServerClient | null
      /** The installer's separate viewer port, for the server it installed. */
      viewerPort: () => number | null
      /** The server the owner chose to publish to, kept as this computer's setting. */
      chosen: () => FleetServerId | null
      name: (serverId: FleetServerId) => string
    }
  ) {}

  get(serverId: FleetServerId): ServerArtifacts | null {
    const paired = this.deps.servers().find((server) => server.id === serverId)
    if (!paired) {
      this.byId.delete(serverId)
      return null
    }
    let artifacts = this.byId.get(serverId)
    if (!artifacts) {
      artifacts = new ServerArtifacts({
        serverId,
        fleet: () => this.deps.client(serverId),
        viewerPort: () =>
          this.deps.servers().some((server) => server.id === serverId && server.installed)
            ? this.deps.viewerPort()
            : null,
      })
      this.byId.set(serverId, artifacts)
    }
    return artifacts
  }

  publishingId(): FleetServerId | null {
    const servers = this.deps.servers()
    const chosen = this.deps.chosen()
    if (chosen && servers.some((server) => server.id === chosen)) return chosen
    return defaultFleetServer(servers)?.id ?? null
  }

  publishing(): ServerArtifacts | null {
    const id = this.publishingId()
    return id ? this.get(id) : null
  }

  entries(): ArtifactServerEntry[] {
    const servers = this.deps.servers()
    for (const id of [...this.byId.keys()]) if (!servers.some((server) => server.id === id)) this.byId.delete(id)
    // With several servers, why one cannot host says which one it is.
    const named = servers.length > 1
    return servers.flatMap(({ id }) => {
      const artifacts = this.get(id)
      if (!artifacts) return []
      return [
        {
          serverId: id,
          source: artifacts.source(),
          unavailable: () => {
            const reason = (artifacts.unavailable() ?? serverUnavailable()).details?.reason as ServerUnavailableReason
            return serverUnavailable(reason, named ? this.name(id) : undefined)
          },
        },
      ]
    })
  }

  views(): ArtifactServerView[] {
    const publishing = this.publishingId()
    return this.deps.servers().flatMap(({ id, installed }) => {
      const artifacts = this.get(id)
      return artifacts
        ? [{ serverId: id, name: this.name(id), installed, publishing: id === publishing, status: artifacts.status() }]
        : []
    })
  }

  name(serverId: FleetServerId): string {
    return this.deps.name(serverId)
  }

  async refresh(): Promise<void> {
    await Promise.all(this.deps.servers().map(({ id }) => this.get(id)?.refresh()))
  }
}
