import type { FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'
import type { GatewayClient } from '../gateway/client'
import type { StreamState } from '../gateway/event-stream'

export type EventHandlers = {
  onEvent(event: FleetGatewayEvent): void
  onState(state: StreamState, detail?: { retryInMs: number }): void
}

/** Where fleet data comes from: a paired bot server over HTTP, or the in-memory demo server. */
export interface FleetSource {
  readonly serverId: string
  readonly features: string[]
  call: GatewayClient['call']
  openEvents(handlers: EventHandlers): { close(): void; reconnectNow(): void }
  /** A transcript image, with the headers the server needs to serve it. */
  imageSource(botId: string, imageId: string): { uri: string; headers?: Record<string, string> }
  /** Where a file a bot shared downloads from, with the headers the server needs. */
  fileSource(botId: string, fileId: string): { uri: string; headers: Record<string, string> }
  /** The base64 contents of a file chosen on the phone, read only when its message is sent. */
  readAttachment(uri: string): Promise<string>
}
