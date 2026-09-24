import { ipcRenderer } from 'electron'
import type {
  FleetActivityEntry,
  FleetBot,
  FleetCreateBotRequest,
  FleetCreateRoutineRequest,
  FleetGatewayEvent,
  FleetHostInfo,
  FleetInboxItem,
  FleetInteractionResolution,
  FleetPatchBotRequest,
  FleetPatchRoutineRequest,
  FleetPeerMessage,
  FleetRoutine,
  FleetSelection,
  FleetSelectionOption,
  FleetTakeoverReleaseRequest,
  FleetTakeoverState,
  FleetTranscriptPage,
  FleetUiOpenRequest,
  FleetAddApiKeyAccountRequest,
} from '@maestrly/bot-fleet-protocol'
export type FleetConnectionView = {
  state: 'unconfigured' | 'connecting' | 'connected' | 'reconnecting' | 'unauthorized' | 'incompatible'
  url: string | null
  hostname: string | null
  error: string | null
  tokenPersistence: 'secure' | 'memory'
}
export type FleetDigest = { entries: FleetActivityEntry[]; since: number; awayMs: number } | null
export type FleetSnapshot = {
  host: FleetHostInfo | null
  bots: FleetBot[]
  inbox: FleetInboxItem[]
  peerMessages: FleetPeerMessage[]
}
export type FleetScreenData = { channelId: string; data: ArrayBuffer }
export type FleetScreenState = {
  channelId: string
  state: 'connecting' | 'open' | 'closed' | 'error'
  code?: number
  reason?: string
}
export type {
  FleetApiKeyProviderKind,
  FleetActivityEntry,
  FleetBot,
  FleetGatewayEvent,
  FleetHostInfo,
  FleetInboxItem,
  FleetPeerMessage,
  FleetRoutine,
  FleetSelection,
  FleetSelectionOption,
  FleetTakeoverState,
  FleetTranscriptPage,
} from '@maestrly/bot-fleet-protocol'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const fleetApi = {
  fleetGetConnection: (): Promise<FleetConnectionView> => ipcRenderer.invoke('fleet:getConnection'),
  fleetConnect: (input: { url: string; code: string; deviceName?: string }): Promise<FleetConnectionView> =>
    ipcRenderer.invoke('fleet:connect', input),
  fleetDisconnect: (): Promise<void> => ipcRenderer.invoke('fleet:disconnect'),
  fleetGetSnapshot: (): Promise<FleetSnapshot> => ipcRenderer.invoke('fleet:getSnapshot'),
  fleetRefresh: (): Promise<FleetSnapshot> => ipcRenderer.invoke('fleet:refresh'),
  fleetGetHost: (): Promise<FleetHostInfo> => ipcRenderer.invoke('fleet:getHost'),
  fleetListBots: (): Promise<{ bots: FleetBot[] }> => ipcRenderer.invoke('fleet:listBots'),
  fleetGetBot: (botId: string): Promise<FleetBot> => ipcRenderer.invoke('fleet:getBot', botId),
  fleetCreateBot: (input: Omit<FleetCreateBotRequest, 'idempotencyKey'>): Promise<FleetBot> =>
    ipcRenderer.invoke('fleet:createBot', input),
  fleetUpdateBot: (botId: string, patch: FleetPatchBotRequest): Promise<FleetBot> =>
    ipcRenderer.invoke('fleet:updateBot', botId, patch),
  fleetBotAction: (
    botId: string,
    action: 'start' | 'stop' | 'restart' | 'archive' | 'pause' | 'resume' | 'cancel'
  ): Promise<FleetBot | void> => ipcRenderer.invoke('fleet:botAction', botId, action),
  fleetListSelections: (botId: string): Promise<{ options: FleetSelectionOption[]; current: FleetSelection | null }> =>
    ipcRenderer.invoke('fleet:listSelections', botId),
  fleetAddApiKeyAccount: (botId: string, input: FleetAddApiKeyAccountRequest): Promise<{ providerId: string }> =>
    ipcRenderer.invoke('fleet:add-api-key-account', botId, input),
  fleetRemoveAccount: (botId: string, providerId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:remove-account', botId, providerId),
  fleetGetTranscript: (botId: string, before?: string | null, limit?: number): Promise<FleetTranscriptPage> =>
    ipcRenderer.invoke('fleet:getTranscript', botId, before, limit),
  fleetSendMessage: (botId: string, text: string): Promise<{ inputId: string; itemId: string; queued: boolean }> =>
    ipcRenderer.invoke('fleet:sendMessage', botId, text),
  fleetRemoveQueuedMessage: (botId: string, inputId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:removeQueuedMessage', botId, inputId),
  fleetResolveInteraction: (
    botId: string,
    interactionId: string,
    resolution: FleetInteractionResolution
  ): Promise<void> => ipcRenderer.invoke('fleet:resolveInteraction', botId, interactionId, resolution),
  fleetTakeover: (botId: string): Promise<FleetTakeoverState> => ipcRenderer.invoke('fleet:takeover', botId),
  fleetReleaseTakeover: (botId: string, input: FleetTakeoverReleaseRequest): Promise<FleetTakeoverState> =>
    ipcRenderer.invoke('fleet:releaseTakeover', botId, input),
  fleetUiOpen: (botId: string, input: FleetUiOpenRequest): Promise<void> =>
    ipcRenderer.invoke('fleet:uiOpen', botId, input),
  fleetListRoutines: (botId: string): Promise<{ routines: FleetRoutine[] }> =>
    ipcRenderer.invoke('fleet:listRoutines', botId),
  fleetCreateRoutine: (
    botId: string,
    input: Omit<FleetCreateRoutineRequest, 'idempotencyKey'>
  ): Promise<FleetRoutine> => ipcRenderer.invoke('fleet:createRoutine', botId, input),
  fleetUpdateRoutine: (botId: string, routineId: string, input: FleetPatchRoutineRequest): Promise<FleetRoutine> =>
    ipcRenderer.invoke('fleet:updateRoutine', botId, routineId, input),
  fleetDeleteRoutine: (botId: string, routineId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:deleteRoutine', botId, routineId),
  fleetRunRoutine: (botId: string, routineId: string): Promise<FleetRoutine> =>
    ipcRenderer.invoke('fleet:runRoutine', botId, routineId),
  fleetGetInbox: (): Promise<{ items: FleetInboxItem[] }> => ipcRenderer.invoke('fleet:getInbox'),
  fleetGetPeerMessages: (limit?: number): Promise<{ messages: FleetPeerMessage[] }> =>
    ipcRenderer.invoke('fleet:getPeerMessages', limit),
  fleetGetDigest: (): Promise<FleetDigest> => ipcRenderer.invoke('fleet:getDigest'),
  fleetAckDigest: (lastSeq: number): Promise<void> => ipcRenderer.invoke('fleet:ackDigest', lastSeq),
  fleetScreenOpen: (botId: string, mode: 'view' | 'control'): Promise<{ channelId: string }> =>
    ipcRenderer.invoke('fleet:screenOpen', botId, mode),
  fleetScreenSend: (channelId: string, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('fleet:screenSend', channelId, data),
  fleetScreenClose: (channelId: string): Promise<void> => ipcRenderer.invoke('fleet:screenClose', channelId),
  onFleetEvent: (cb: (event: FleetGatewayEvent) => void): (() => void) => subscribe('fleet:event', cb),
  onFleetConnection: (cb: (view: FleetConnectionView) => void): (() => void) => subscribe('fleet:connection', cb),
  onFleetDigest: (cb: (digest: FleetDigest) => void): (() => void) => subscribe('fleet:digest', cb),
  onFleetScreenData: (cb: (data: FleetScreenData) => void): (() => void) => subscribe('fleet:screen:data', cb),
  onFleetScreenState: (cb: (state: FleetScreenState) => void): (() => void) => subscribe('fleet:screen:state', cb),
  onFleetInstanceOpenAccounts: (cb: () => void): (() => void) => subscribe('fleet:instance:open-accounts', cb),
}
