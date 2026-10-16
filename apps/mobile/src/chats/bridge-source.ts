import {
  FLEET_PHONES_FEATURE,
  FLEET_MOBILE_HOST_FEATURE,
  fleetBridgeOrigin,
  MobileBridgeClient,
  MobileBridgeError,
  type MobileBridgeSocket,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError, type GatewayClient } from '../gateway/client'
import type { PairedServer } from '../servers/registry'
import type { ChatsSource } from './source'

export type BridgeClientInfo = {
  appVersion: string
  deviceName: string
  os: 'ios' | 'android'
  locale: string
}

/** What a gateway refusal means for the bridge: stop for good, wait for the host, or try again. */
function bridgeError(error: unknown): unknown {
  if (!(error instanceof GatewayError)) return error
  if (error.code === 'UNAUTHORIZED') return new MobileBridgeError('UNAUTHORIZED', error.message)
  if (error.code === 'PROTOCOL_INCOMPATIBLE') return new MobileBridgeError('UNSUPPORTED', error.message)
  if (error.code === 'BOT_NOT_RUNNING' || error.code === 'CONFLICT' || error.code === 'NOT_FOUND')
    return new MobileBridgeError('UNAVAILABLE', error.message)
  return error
}

/**
 * Opens a bridge socket to one of the server's workspaces hosts: a one-use ticket from the gateway, then the
 * WebSocket. React Native always sends an Origin header, so the phone names it in the ticket request and sends it
 * explicitly. A stopped host waits to be started: the phone never switches to another one on its own.
 */
export async function openBridgeSocket(
  server: PairedServer,
  client: Pick<GatewayClient, 'call'>,
  features: () => string[],
  environmentId: string,
  createSocket: (url: string, origin: string) => MobileBridgeSocket
): Promise<MobileBridgeSocket> {
  if (!features().includes(FLEET_PHONES_FEATURE))
    throw new MobileBridgeError('UNSUPPORTED', 'The bot server predates phones on the bridge')
  const origin = fleetBridgeOrigin(server.origin)
  if (!origin) throw new MobileBridgeError('UNSUPPORTED', 'The server address cannot carry a bridge')
  try {
    const { environments } = await client.call('environmentsList')
    const host = environments.find((item) => item.id === environmentId && item.kind === 'workspaces')
    if (host?.lifecycle !== 'running') throw new MobileBridgeError('UNAVAILABLE', 'The workspaces host is not running')
    if (!host.capabilities.includes(FLEET_MOBILE_HOST_FEATURE))
      throw new MobileBridgeError('UNSUPPORTED', 'The workspaces host predates phones')
    const ticket = await client.call('environmentBridgeTicket', { params: { eid: host.id }, body: { origin } })
    return createSocket(server.origin.replace(/^http/, 'ws') + ticket.path, origin)
  } catch (error) {
    throw bridgeError(error)
  }
}

/** React Native's WebSocket takes headers as a third argument, which the DOM's type does not know. */
type NativeWebSocket = new (url: string, protocols: undefined, options: { headers: Record<string, string> }) => unknown
const nativeSocket = (url: string, origin: string): MobileBridgeSocket =>
  new (WebSocket as unknown as NativeWebSocket)(url, undefined, { headers: { Origin: origin } }) as MobileBridgeSocket

/** A paired server's chats, through one of its workspaces hosts. */
export function createBridgeChatsSource(
  server: PairedServer,
  client: Pick<GatewayClient, 'call'>,
  features: () => string[],
  environmentId: string,
  info: BridgeClientInfo,
  readFile: (uri: string) => Promise<string>
): ChatsSource {
  return {
    serverId: server.id,
    environmentId,
    connect(handlers) {
      const bridge = new MobileBridgeClient({
        connect: () => openBridgeSocket(server, client, features, environmentId, nativeSocket),
        appVersion: info.appVersion,
        client: { deviceName: info.deviceName.slice(0, 128), os: info.os, locale: info.locale.slice(0, 16) },
        onEvent: handlers.onEvent,
        onState: handlers.onState,
        onReady: handlers.onReady,
      })
      bridge.start()
      return {
        invoke: (key, args) => bridge.invoke(key, args),
        reconnectNow: () => bridge.reconnectNow(),
        close: () => bridge.stop(),
      }
    },
    readAttachment: readFile,
  }
}
