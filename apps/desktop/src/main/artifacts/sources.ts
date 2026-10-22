import { ArtifactHostError, createRemoteAdmin, UPLOAD_METHODS, type ArtifactAdmin } from '@maestrly/artifact-host'
import { fleetArtifactResultSchema } from '@maestrly/bot-fleet-protocol'
import type { Conversation } from '../../shared/conversation'
import type { FleetServerId } from '../../shared/fleet-servers'
import type { FleetClientService } from '../fleet/client/service'

/** Artifacts are hosted only on a bot server. */
export type ArtifactHostKey = 'server'
export interface ArtifactSource {
  readonly key: ArtifactHostKey
  /** This computer's id for the paired server it is; absent where there is one host only (a bot, a workspaces host). */
  readonly server?: FleetServerId
  readonly owner: { kind: 'device' | 'bot'; id: string }
  admin(): Promise<ArtifactAdmin>
  ready(): boolean
  viewerBase(): string | null
  publicBase(): string | null
  linkExpiryDays(): number | null
}
export interface ArtifactSources {
  publishTarget(conversation: Conversation): ArtifactSource
  forConversation(conversation: Conversation): ArtifactSource[]
  managed(): ArtifactSource[]
}
/** Why the bot server cannot host artifacts right now, as the agent tools and the app explain it. */
export type ServerUnavailableReason =
  | 'server_absent'
  | 'server_unsupported'
  | 'server_off'
  | 'server_unreachable'
  | 'no_viewer'
/** With `server`, the name of the server it is about, when the owner has several. */
export function serverUnavailable(
  reason: ServerUnavailableReason = 'server_unreachable',
  server?: string
): ArtifactHostError {
  return new ArtifactHostError('host_unavailable', 'The bot server artifact host is unavailable', {
    reason,
    ...(server ? { server } : {}),
  })
}
/**
 * The desktop's sources: the paired bot servers, each a source of its own. Conversations publish on the one chosen;
 * lookups search every one, so an artifact is found on whichever server holds it. A server that is not ready stands
 * as a placeholder that says why, which also keeps lookups from reporting its artifacts as missing meanwhile. Nothing
 * is ever published on this computer.
 */
export function createDesktopSources(deps: {
  servers: () => Array<{ serverId: FleetServerId; source: ArtifactSource | null; unavailable(): ArtifactHostError }>
  publishing: () => FleetServerId | null
}): ArtifactSources {
  const placeholder = (server: FleetServerId | undefined, unavailable: () => ArtifactHostError): ArtifactSource => ({
    key: 'server',
    ...(server ? { server } : {}),
    owner: { kind: 'device', id: '' },
    ready: () => false,
    admin: async () => {
      throw unavailable()
    },
    viewerBase: () => null,
    publicBase: () => null,
    linkExpiryDays: () => null,
  })
  const all = () => {
    const servers = deps.servers()
    if (servers.length === 0) return [placeholder(undefined, () => serverUnavailable('server_absent'))]
    return servers.map((entry) => entry.source ?? placeholder(entry.serverId, entry.unavailable))
  }
  return {
    publishTarget: () => {
      const id = deps.publishing()
      const entry = deps.servers().find((server) => server.serverId === id)
      if (!entry) throw serverUnavailable('server_absent')
      if (!entry.source) throw entry.unavailable()
      return entry.source
    },
    forConversation: all,
    managed: all,
  }
}
export function createFleetAdmin(fleet: Pick<FleetClientService, 'call'>, validate?: () => void): ArtifactAdmin {
  return createRemoteAdmin(async (method, args) => {
    validate?.()
    let result: unknown
    try {
      result = await fleet.call(
        (UPLOAD_METHODS as readonly string[]).includes(method) ? 'artifactUpload' : 'artifactAdmin',
        { body: { method, args } }
      )
    } catch {
      throw serverUnavailable()
    }
    validate?.()
    const parsed = fleetArtifactResultSchema.safeParse(result)
    if (!parsed.success) throw serverUnavailable()
    // The host's client validates the serialized error code before rethrowing it.
    return parsed.data.ok ? parsed.data : { ok: false, error: ArtifactHostError.from(parsed.data.error).toJSON() }
  })
}
