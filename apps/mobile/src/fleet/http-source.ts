import { buildPath, FLEET_GATEWAY_ROUTES, FLEET_TRANSCRIPT_REASONING_FEATURE } from '@maestrly/bot-fleet-protocol'
import { fetch as expoFetch } from 'expo/fetch'
import { File } from 'expo-file-system'
import { createGatewayClient, type FetchLike } from '../gateway/client'
import { openEventStream, type StreamingFetch } from '../gateway/event-stream'
import { socketScreenOpener, type ScreenSocket } from '../screen/link'
import type { PairedServer } from '../servers/registry'
import { eventsQuery, type FleetSource } from './source'

/** Expo's fetch streams response bodies (the event stream needs it) and, being native, sends no Origin header. */
export const nativeFetch = expoFetch as unknown as FetchLike

/** A client for one paired server, such as for unpairing a server that is not the active one. */
export const gatewayClientFor = (server: PairedServer, token: string) =>
  createGatewayClient({ origin: server.origin, token, fetch: nativeFetch })

/** React Native's WebSocket takes headers as a third argument, which the DOM's type does not know. */
type NativeWebSocket = new (url: string, protocols: undefined, options: { headers: Record<string, string> }) => unknown
const nativeScreenSocket = (url: string, origin: string): ScreenSocket =>
  new (WebSocket as unknown as NativeWebSocket)(url, undefined, { headers: { Origin: origin } }) as ScreenSocket

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
        url: server.origin + buildPath(FLEET_GATEWAY_ROUTES.events.path, {}, eventsQuery(reasoning)),
        headers: client.headers(),
        fetch: expoFetch as unknown as StreamingFetch,
        createDecoder: () => new TextDecoder(),
        ...handlers,
      }),
    imageSource: (botId, imageId, laneId) => ({
      uri:
        server.origin +
        buildPath(FLEET_GATEWAY_ROUTES.botImage.path, { id: botId, imageId }, laneId ? { run: laneId } : undefined),
      headers: client.headers(),
    }),
    fileSource: (botId, fileId) => ({
      uri: server.origin + buildPath(FLEET_GATEWAY_ROUTES.botFile.path, { id: botId, fileId }),
      headers: client.headers(),
    }),
    readAttachment: (uri) => new File(uri).base64(),
    openScreen: socketScreenOpener({ origin: server.origin, call: client.call, createSocket: nativeScreenSocket }),
  }
}
