import { type ArtifactSource, type ArtifactSources, serverUnavailable } from '../../artifacts/sources'
import { gatewayArtifactSource } from '../../fleet/instance/artifacts'
import type { HostGatewayAccess } from './config'

/**
 * Where a workspaces host's chats publish artifacts: the server it runs on, through the gateway's internal API with
 * the host's own token, as the device its environment is. The gateway limits it to the agent tools and to its own
 * artifacts; the owner's computers open, share and delete them from their artifacts center. Without a token (from a
 * gateway that predates them) there is nowhere to publish, and the agent is told to update the server.
 */
export function createHostSources(access: HostGatewayAccess | null): ArtifactSources {
  const unsupported = () => serverUnavailable('server_unsupported')
  const source: ArtifactSource | null = access
    ? gatewayArtifactSource({
        owner: { kind: 'device', id: access.environmentId },
        access: () => access.gateway,
        off: unsupported,
      })
    : null
  const target = (): ArtifactSource => {
    if (!source) throw unsupported()
    return source
  }
  return { publishTarget: target, forConversation: () => [target()], managed: () => (source ? [source] : []) }
}
