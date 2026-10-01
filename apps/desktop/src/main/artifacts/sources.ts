import { ArtifactHostError, createRemoteAdmin, UPLOAD_METHODS, type ArtifactAdmin } from '@maestrly/artifact-host'
import { fleetArtifactResultSchema } from '@maestrly/bot-fleet-protocol'
import type { ArtifactSettings } from '../../shared/artifacts'
import type { Conversation } from '../../shared/conversation'
import type { FleetClientService } from '../fleet/client/service'
import type { ArtifactsServiceDeps } from './service'

export type ArtifactHostKey = 'local' | 'server'
export interface ArtifactSource {
  readonly key: ArtifactHostKey
  readonly owner: { kind: 'local' | 'device' | 'bot'; id: string }
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
export function serverUnavailable(reason = 'server_unreachable'): ArtifactHostError {
  return new ArtifactHostError('host_unavailable', 'The bot server artifact host is unavailable', { reason })
}
export function localSource(deps: {
  host: ArtifactsServiceDeps['host']
  settings: () => ArtifactSettings
}): ArtifactSource {
  return {
    key: 'local',
    owner: { kind: 'local', id: 'local' },
    admin: () => deps.host.ensureStarted(),
    ready: () => deps.host.status().state === 'running',
    viewerBase: () => `http://127.0.0.1:${deps.host.status().port}`,
    publicBase: () => deps.settings().publicAddress || null,
    linkExpiryDays: () => deps.settings().linkExpiryDays,
  }
}
export function createDesktopSources(deps: {
  local: ArtifactSource
  server: () => ArtifactSource | null
  settings: () => ArtifactSettings
  /** Keeps an unavailable paired server in lookups so a failed read is not reported as missing. */
  unavailable?: () => ArtifactHostError | null
}): ArtifactSources {
  const unavailable: ArtifactSource = {
    key: 'server',
    owner: { kind: 'device', id: '' },
    ready: () => false,
    admin: async () => {
      throw deps.unavailable?.() ?? serverUnavailable()
    },
    viewerBase: () => null,
    publicBase: () => null,
    linkExpiryDays: () => null,
  }
  const all = () => {
    const server = deps.server()
    return [deps.local, ...(server ? [server] : deps.unavailable?.() ? [unavailable] : [])]
  }
  return {
    publishTarget: () => {
      if (deps.settings().publishTo !== 'server') return deps.local
      const server = deps.server()
      if (!server) throw deps.unavailable?.() ?? serverUnavailable()
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
