import { ArtifactHostError, createRemoteAdmin, UPLOAD_METHODS, type ArtifactAdmin } from '@maestrly/artifact-host'
import { fleetArtifactResultSchema } from '@maestrly/bot-fleet-protocol'
import type { Conversation } from '../../shared/conversation'
import type { FleetClientService } from '../fleet/client/service'

/** Artifacts are hosted only on the bot server. */
export type ArtifactHostKey = 'server'
export interface ArtifactSource {
  readonly key: ArtifactHostKey
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
export function serverUnavailable(reason: ServerUnavailableReason = 'server_unreachable'): ArtifactHostError {
  return new ArtifactHostError('host_unavailable', 'The bot server artifact host is unavailable', { reason })
}
/**
 * The desktop's sources: the paired bot server alone. Without a ready server there is nowhere to publish or look, and
 * the reason is reported instead; nothing is ever published on this computer.
 */
export function createDesktopSources(deps: {
  server: () => ArtifactSource | null
  /** Why the server is not ready; it also keeps lookups from reporting an artifact as missing meanwhile. */
  unavailable: () => ArtifactHostError
}): ArtifactSources {
  const placeholder: ArtifactSource = {
    key: 'server',
    owner: { kind: 'device', id: '' },
    ready: () => false,
    admin: async () => {
      throw deps.unavailable()
    },
    viewerBase: () => null,
    publicBase: () => null,
    linkExpiryDays: () => null,
  }
  const all = () => [deps.server() ?? placeholder]
  return {
    publishTarget: () => {
      const server = deps.server()
      if (!server) throw deps.unavailable()
      return server
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
