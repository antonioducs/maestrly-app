import {
  FLEET_PEER_THREADS_QUERY,
  FLEET_REASONING_QUERY,
  FLEET_ROUTINE_RUNS_QUERY,
  type FleetGatewayEvent,
} from '@maestrly/bot-fleet-protocol'
import type { GatewayClient } from '../gateway/client'
import type { StreamState } from '../gateway/event-stream'
import type { OpenScreen } from '../screen/link'

export type EventHandlers = {
  onEvent(event: FleetGatewayEvent): void
  onState(state: StreamState, detail?: { retryInMs: number }): void
}

/**
 * What the phone reads on the event stream: `reasoning` items when the server sends them, and the records and
 * transcripts of routine runs and threads between bots, which live in conversations of their own. A gateway that
 * predates them ignores the parameters and sends none.
 */
export const eventsQuery = (reasoning: boolean): Record<string, number> => ({
  ...(reasoning ? { [FLEET_REASONING_QUERY]: 1 } : {}),
  [FLEET_ROUTINE_RUNS_QUERY]: 1,
  [FLEET_PEER_THREADS_QUERY]: 1,
})

/** Where fleet data comes from: a paired bot server over HTTP, or the in-memory demo server. */
export interface FleetSource {
  readonly serverId: string
  readonly features: string[]
  call: GatewayClient['call']
  openEvents(handlers: EventHandlers): { close(): void; reconnectNow(): void }
  /**
   * A transcript image, with the headers the server needs to serve it. An image of a routine run's or a thread's own
   * conversation is read from there (`laneId`).
   */
  imageSource(botId: string, imageId: string, laneId?: string | null): { uri: string; headers?: Record<string, string> }
  /** Where a file a bot shared downloads from, with the headers the server needs. */
  fileSource(botId: string, fileId: string): { uri: string; headers: Record<string, string> }
  /** The base64 contents of a file chosen on the phone, read only when its message is sent. */
  readAttachment(uri: string): Promise<string>
  /** Opens a bot's screen, through a server that lets phones (`phone-screens`); absent where none can. */
  openScreen?: OpenScreen
}
