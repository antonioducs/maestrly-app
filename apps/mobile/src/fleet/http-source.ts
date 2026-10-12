import { buildPath, FLEET_GATEWAY_ROUTES, FLEET_TRANSCRIPT_REASONING_FEATURE } from '@maestrly/bot-fleet-protocol'
import { fetch as expoFetch } from 'expo/fetch'
import { File } from 'expo-file-system'
import { createGatewayClient, type FetchLike } from '../gateway/client'
import { openEventStream, type StreamingFetch } from '../gateway/event-stream'
import type { PairedServer } from '../servers/registry'
import type { FleetSource } from './source'

/**
 * A paired bot server. Expo's fetch streams response bodies (the event stream needs it) and, being native, sends no
 * Origin header, which the gateway refuses.
 */
export function createHttpSource(server: PairedServer, token: string): FleetSource {
  const client = createGatewayClient({ origin: server.origin, token, fetch: expoFetch as unknown as FetchLike })
  const reasoning = server.features.includes(FLEET_TRANSCRIPT_REASONING_FEATURE)
  return {
    serverId: server.id,
    features: server.features,
    call: client.call,
    openEvents: (handlers) =>
      openEventStream({
        url: server.origin + buildPath(FLEET_GATEWAY_ROUTES.events.path, {}, reasoning ? { reasoning: 1 } : undefined),
        headers: client.headers(),
        fetch: expoFetch as unknown as StreamingFetch,
        createDecoder: () => new TextDecoder(),
        ...handlers,
      }),
    imageSource: (botId, imageId) => ({
      uri: server.origin + buildPath(FLEET_GATEWAY_ROUTES.botImage.path, { id: botId, imageId }),
      headers: client.headers(),
    }),
    readAttachment: (uri) => new File(uri).base64(),
  }
}
