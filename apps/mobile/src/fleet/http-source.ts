import { buildPath, FLEET_GATEWAY_ROUTES, FLEET_TRANSCRIPT_REASONING_FEATURE } from '@maestrly/bot-fleet-protocol'
import { fetch as expoFetch } from 'expo/fetch'
import { File } from 'expo-file-system'
import { createGatewayClient, type FetchLike } from '../gateway/client'
import { openEventStream, type StreamingFetch } from '../gateway/event-stream'
import type { PairedServer } from '../servers/registry'
import type { FleetSource } from './source'

/** Expo's fetch streams response bodies (the event stream needs it) and, being native, sends no Origin header. */
export const nativeFetch = expoFetch as unknown as FetchLike

/** A client for one paired server, such as for unpairing a server that is not the active one. */
export const gatewayClientFor = (server: PairedServer, token: string) =>
  createGatewayClient({ origin: server.origin, token, fetch: nativeFetch })

/** A paired bot server, reached over the network. */
export function createHttpSource(server: PairedServer, token: string): FleetSource {
  const client = gatewayClientFor(server, token)
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
    fileSource: (botId, fileId) => ({
      uri: server.origin + buildPath(FLEET_GATEWAY_ROUTES.botFile.path, { id: botId, fileId }),
      headers: client.headers(),
    }),
    readAttachment: (uri) => new File(uri).base64(),
  }
}
