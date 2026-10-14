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

/** Where chats come from: the server's workspaces host over the bridge, or the in-memory demo server. */
export interface ChatsSource {
  readonly serverId: string
  connect(handlers: ChatsHandlers): ChatsConnection
  /** The base64 contents of a file chosen on the phone, read only when its message is sent. */
  readAttachment(uri: string): Promise<string>
}
