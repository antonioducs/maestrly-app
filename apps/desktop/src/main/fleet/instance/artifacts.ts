import {
  ARTIFACT_ERROR_CODES,
  ArtifactHostError,
  createRemoteAdmin,
  fromWire,
  UPLOAD_METHODS,
} from '@maestrly/artifact-host'
import type { FleetArtifactResult } from '@maestrly/bot-fleet-protocol'
import type { ArtifactSource, ArtifactSources } from '../../artifacts/sources'
import { type GatewayConfig, gatewayRequest } from './gateway-client'
import type { BotRuntime } from './runtime'

const botOff = () =>
  new ArtifactHostError('host_unavailable', 'Bot artifact publishing is disabled', { reason: 'bot_off' })
const unavailable = () =>
  new ArtifactHostError('host_unavailable', 'The bot server artifact host is unavailable', {
    reason: 'server_unreachable',
  })

export function botArtifactSource(runtime: BotRuntime): ArtifactSource | null {
  const access = () => (runtime.artifactsEnabled && runtime.gatewayConfig?.token ? runtime.gatewayConfig : null)
  if (!access()) return null
  return gatewayArtifactSource({ owner: { kind: 'bot', id: runtime.botId }, access, off: botOff })
}

/**
 * Artifacts an agent publishes through the gateway's internal API with its own token: a bot's, or those of the
 * workspaces host that runs the owner's chats. The gateway keeps each to its own artifacts and to the agent tools.
 */
export function gatewayArtifactSource(options: {
  owner: ArtifactSource['owner']
  /** The gateway and token to publish with, or null while publishing is not allowed. */
  access: () => GatewayConfig | null
  /** Why publishing is not allowed. */
  off: () => ArtifactHostError
}): ArtifactSource {
  const config = () => {
    const value = options.access()
    if (!value?.token) throw options.off()
    return value
  }
  const admin = createRemoteAdmin(async (method, args) => {
    const current = config()
    const upload = (UPLOAD_METHODS as readonly string[]).includes(method)
    let result: FleetArtifactResult
    try {
      result = await gatewayRequest(
        current,
        upload ? 'artifactBotUpload' : 'artifactBotAdmin',
        { method, args },
        undefined,
        AbortSignal.timeout(upload ? 120_000 : 30_000)
      )
    } catch {
      throw unavailable()
    }
    if (!result || (!result.ok && !(ARTIFACT_ERROR_CODES as readonly string[]).includes(result.error.code)))
      throw unavailable()
    if (result.ok) {
      try {
        fromWire(result.value)
      } catch {
        throw unavailable()
      }
    }
    return result.ok ? result : { ok: false, error: ArtifactHostError.from(result.error).toJSON() }
  })
  return {
    key: 'server',
    owner: options.owner,
    ready: () => !!options.access()?.token,
    admin: async () => {
      config()
      return admin
    },
    viewerBase: () => null,
    publicBase: () => null,
    linkExpiryDays: () => null,
  }
}

export function createBotSources(sourceFor: (conversationId: string) => ArtifactSource | null): ArtifactSources {
  const source = (conversation: Parameters<ArtifactSources['publishTarget']>[0]) => {
    const value = sourceFor(conversation.id)
    if (!value) throw botOff()
    return value
  }
  return { publishTarget: source, forConversation: (conversation) => [source(conversation)], managed: () => [] }
}
