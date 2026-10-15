import type {
  MobileArgs,
  MobileBridgeState,
  MobileChannelKey,
  MobileEvent,
  MobileResult,
} from '@maestrly/bot-fleet-protocol'

export type ChatsHandlers = {
  onEvent(event: MobileEvent): void
  onState(state: MobileBridgeState, detail?: { retryInMs?: number; hostVersion?: string }): void
  /** The host welcomed the phone (again): what the phone shows is read again. */
  onReady(): void
}

export interface ChatsConnection {
  invoke<K extends MobileChannelKey>(key: K, args: MobileArgs<K>): Promise<MobileResult<K>>
  /** Tries now instead of waiting for the next retry. */
  reconnectNow(): void
  close(): void
}

/** A server without a workspaces environment: it has no chats, and the phone keeps nothing for it. */
export const noChatsSource = (serverId: string): ChatsSource => ({
  serverId,
  environmentId: null,
  connect() {
    throw new Error('The server hosts no workspaces environment')
  },
  readAttachment: () => Promise.reject(new Error('The server hosts no workspaces environment')),
})

/** Where chats come from: the server's workspaces host over the bridge, or the in-memory demo server. */
export interface ChatsSource {
  readonly serverId: string
  /** The workspaces environment whose chats these are; null for a server that hosts none, which never connects. */
  readonly environmentId: string | null
  connect(handlers: ChatsHandlers): ChatsConnection
  /** The base64 contents of a file chosen on the phone, read only when its message is sent. */
  readAttachment(uri: string): Promise<string>
}
