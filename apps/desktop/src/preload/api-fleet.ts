import type {
  FleetDevicesResponse,
  FleetLoginAttempt,
  FleetLoginStartRequest,
  FleetPairingCodeResponse,
} from '@maestrly/bot-fleet-protocol'
import type { MacInventory, MacImportSelection, MacImportReport } from '../shared/fleet-provisioning'
import type {
  FleetCreateWorkspacesInput,
  FleetMoveBotInput,
  FleetProvisioningTargetInput,
  FleetScreenTargetInput,
} from '../shared/fleet-targets'
import type {
  FleetBotAccounts,
  FleetBotSkills,
  FleetBotMcpServers,
  FleetSubscriptionKind,
} from '@maestrly/bot-fleet-protocol'
import type { FleetInstallerStatus } from '../shared/fleet-installer'
import type { FleetDesktopAccessInput, FleetDesktopAccessView } from '../shared/fleet-desktop-access'
import type { FleetDownloadEvent, FleetDownloadFileKey, FleetDownloadProgress } from '../shared/fleet-downloads'
import { ipcRenderer } from 'electron'
import type {
  FleetOwnerMemory,
  FleetOwnerMemoryEntry,
  FleetOwnerMemoryPatchRequest,
  FleetRoutineRun,
  FleetRoutineRunPage,
  FleetRoutineRunSettings,
  FleetPeerThread,
  FleetPeerThreadList,
  FleetPeerThreadPatchRequest,
  FleetPeerThreadSettings,
  FleetBotMemory,
  FleetBotMemoryPatchRequest,
  FleetArchivedBot,
  FleetArchivedEnvironment,
  FleetBot,
  FleetBotMove,
  FleetCreateBotRequest,
  FleetEnvironment,
  FleetPatchEnvironmentRequest,
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
  FleetImageMediaType,
  FleetConversationOp,
} from '@maestrly/bot-fleet-protocol'
import type {
  ChatConfig,
  ChatConvTools,
  ChatProjectCommand,
  ChatSkillCommand,
  ChatSkillOverride,
  ChatSkillSelection,
  ChatSkillsState,
  ChatUserPrompt,
} from '../shared/chat'
import type {
  ConversationSubagentProfileConfigPayload,
  ConversationSubagentProfileSaveResult,
} from '../shared/subagent-profiles'

/**
 * The desktop chat calls the bot composer menus make, run by the bot's own Maestrly on its primary conversation.
 * Same signatures as the local `window.api.chat*` methods minus the conversation id.
 */
export type FleetConversationOps = {
  chatConfig: () => Pick<ChatConfig, 'mcpServers' | 'appToolsEnabled' | 'imageGenEnabled'>
  chatGetConvTools: () => ChatConvTools
  chatSetConvTools: (patch: { app?: boolean; mcpDisabled?: string[]; imageGen?: boolean }) => { ok: boolean }
  chatSubagentProfilesGetConversation: () => ConversationSubagentProfileConfigPayload
  chatSubagentProfilesSetConversationEnabled: (enabled: boolean) => ConversationSubagentProfileSaveResult
  chatSubagentsSetConversationEnabled: (enabled: boolean) => ConversationSubagentProfileSaveResult
  chatSkillsState: () => ChatSkillsState
  chatSkillSetOverride: (name: string, state: ChatSkillOverride | 'inherit') => { ok: boolean }
  chatSkillResetOverrides: () => { ok: boolean }
  chatSkillSetSelection: (selection: ChatSkillSelection) => { ok: boolean; error?: string }
  chatCommands: () => { prompts: ChatUserPrompt[]; project: ChatProjectCommand[]; skills: ChatSkillCommand[] }
  /** Starts compacting with the bot's compaction model; `ok: false` with `busy`, `not-configured` or `too-short`. */
  chatCompact: () => { ok: boolean; error?: string }
  chatBackgroundCompactionRetry: () => { ok: boolean; error?: string }
}
// Compile-time guard: the typed map and the protocol's op list stay identical.
type _OpsMatch = [keyof FleetConversationOps] extends [FleetConversationOp]
  ? [FleetConversationOp] extends [keyof FleetConversationOps]
    ? true
    : never
  : never
const _opsMatch: _OpsMatch = true
void _opsMatch

export type FleetConnectionView = {
  features: string[]
  state: 'unconfigured' | 'connecting' | 'connected' | 'reconnecting' | 'unauthorized' | 'incompatible'
  deviceId: string | null
  url: string | null
  hostname: string | null
  error: string | null
  tokenPersistence: 'secure' | 'memory'
}
export type FleetSnapshot = {
  host: FleetHostInfo | null
  bots: FleetBot[]
  /** Empty for gateways without environments; archived ones are listed on demand. */
  environments: FleetEnvironment[]
  inbox: FleetInboxItem[]
  peerMessages: FleetPeerMessage[]
}
/**
 * A new bot joins an existing environment (`environmentId`) or gets a new one (`environment`), never both; with
 * neither, as before environments, it gets a new environment named after it. Both need a gateway with environments.
 */
export type FleetCreateBotInput = Omit<FleetCreateBotRequest, 'idempotencyKey' | 'environment'> & {
  environment?: { name: string; memoryLimitBytes?: number | null }
}
/** An owner memory entry is global (`environmentId` null or absent) or seen only by the bots of one environment. */
export type FleetOwnerMemoryCreateInput = { content: string; replacesId?: string; environmentId?: string | null }
export type FleetScreenData = { channelId: string; data: ArrayBuffer }
/** An image the owner attaches from the Mac; main base64-encodes it for the gateway. */
export type FleetOutgoingAttachment = {
  kind?: 'image' | 'pdf' | 'text'
  name: string
  mediaType: FleetImageMediaType | 'application/pdf' | 'text/plain'
  data: Uint8Array
}
/** Bytes of a bot image (a FleetImageRef from the transcript). */
export type FleetImageData = { mediaType: FleetImageMediaType; data: Uint8Array }
/** How much of a shared video main has copied to its cache so far. */
export type FleetMediaProgress = { botId: string; fileId: string; received: number; total: number }
export type FleetScreenState = {
  channelId: string
  state: 'connecting' | 'open' | 'closed' | 'error'
  code?: number
  reason?: string
}
export type {
  FleetProvisioningTarget,
  FleetProvisioningTargetInput,
  FleetScreenTarget,
  FleetScreenTargetInput,
} from '../shared/fleet-targets'
export type { FleetDesktopAccessInput, FleetDesktopAccessView } from '../shared/fleet-desktop-access'
export type {
  FleetApiKeyProviderKind,
  FleetActivityEntry,
  FleetArchivedEnvironment,
  FleetEnvironment,
  FleetScreenSurface,
  FleetOwnerMemory,
  FleetOwnerMemoryEntry,
  FleetOwnerMemoryPatchRequest,
  FleetRoutineRun,
  FleetRoutineRunPage,
  FleetRoutineRunSettings,
  FleetPeerThread,
  FleetPeerThreadList,
  FleetPeerThreadPatchRequest,
  FleetPeerThreadSettings,
  FleetBotMemory,
  FleetBotMemoryPatchRequest,
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
  FleetImageMediaType,
  FleetImageRef,
  FleetUsage,
} from '@maestrly/bot-fleet-protocol'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Provisioning and sign-ins take a target: an environment (shared by its bots), a bot, or a bare bot id as the views
// from before environments pass it.
export const fleetApi = {
  fleetInstallerProvideBotEnvironment: (): Promise<FleetInstallerStatus> =>
    ipcRenderer.invoke('fleet:installer:provideBotEnvironment'),
  fleetLoginStart: (
    target: FleetProvisioningTargetInput,
    request: FleetLoginStartRequest
  ): Promise<{ attempt: FleetLoginAttempt; relay: 'listening' | 'unavailable' | 'none' }> =>
    ipcRenderer.invoke('fleet:login:start', target, request),
  fleetLoginStatus: (target: FleetProvisioningTargetInput, loginId: string): Promise<FleetLoginAttempt> =>
    ipcRenderer.invoke('fleet:login:status', target, loginId),
  fleetLoginSubmitCode: (
    target: FleetProvisioningTargetInput,
    loginId: string,
    code: string
  ): Promise<FleetLoginAttempt> => ipcRenderer.invoke('fleet:login:code', target, loginId, code),
  fleetLoginCancel: (target: FleetProvisioningTargetInput, loginId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:login:cancel', target, loginId),
  fleetLoginOpen: (
    target: FleetProvisioningTargetInput,
    loginId: string,
    page: 'auth' | 'device' | 'manual'
  ): Promise<void> => ipcRenderer.invoke('fleet:login:open', target, loginId, page),
  fleetProvisioningInventory: (): Promise<MacInventory> => ipcRenderer.invoke('fleet:provisioning:inventory'),
  fleetImportFromMac: (target: FleetProvisioningTargetInput, selection: MacImportSelection): Promise<MacImportReport> =>
    ipcRenderer.invoke('fleet:provisioning:import', target, selection),
  fleetBotAccounts: (target: FleetProvisioningTargetInput): Promise<FleetBotAccounts> =>
    ipcRenderer.invoke('fleet:bot:accounts', target),
  fleetRemoveBotSubscription: (
    target: FleetProvisioningTargetInput,
    kind: FleetSubscriptionKind,
    slot: string
  ): Promise<void> => ipcRenderer.invoke('fleet:bot:subscription-remove', target, kind, slot),
  fleetBotSkills: (target: FleetProvisioningTargetInput): Promise<FleetBotSkills> =>
    ipcRenderer.invoke('fleet:bot:skills', target),
  fleetRemoveBotSkill: (target: FleetProvisioningTargetInput, name: string): Promise<void> =>
    ipcRenderer.invoke('fleet:bot:skill-remove', target, name),
  fleetBotMcpServers: (target: FleetProvisioningTargetInput): Promise<FleetBotMcpServers> =>
    ipcRenderer.invoke('fleet:bot:mcp-servers', target),
  fleetRemoveBotMcpServer: (target: FleetProvisioningTargetInput, serverId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:bot:mcp-remove', target, serverId),
  fleetGetConnection: (): Promise<FleetConnectionView> => ipcRenderer.invoke('fleet:getConnection'),
  fleetConnect: (input: { url: string; code: string; deviceName?: string }): Promise<FleetConnectionView> =>
    ipcRenderer.invoke('fleet:connect', input),
  fleetDisconnect: (): Promise<void> => ipcRenderer.invoke('fleet:disconnect'),
  /** A one-use code that pairs another device (a phone) with this computer's bot server. */
  fleetCreatePairing: (): Promise<FleetPairingCodeResponse> => ipcRenderer.invoke('fleet:createPairing'),
  /** The phones and computers paired with the bot server. */
  fleetDevices: (): Promise<FleetDevicesResponse> => ipcRenderer.invoke('fleet:devices'),
  /** Removes another paired device; it can no longer reach the bot server. */
  fleetRevokeDevice: (deviceId: string): Promise<void> => ipcRenderer.invoke('fleet:revokeDevice', deviceId),
  fleetGetSnapshot: (): Promise<FleetSnapshot> => ipcRenderer.invoke('fleet:getSnapshot'),
  fleetRefresh: (): Promise<FleetSnapshot> => ipcRenderer.invoke('fleet:refresh'),
  fleetGetHost: (): Promise<FleetHostInfo> => ipcRenderer.invoke('fleet:getHost'),
  fleetListBots: (): Promise<{ bots: FleetBot[] }> => ipcRenderer.invoke('fleet:listBots'),
  fleetGetBot: (botId: string): Promise<FleetBot> => ipcRenderer.invoke('fleet:getBot', botId),
  fleetCreateBot: (input: FleetCreateBotInput): Promise<FleetBot> => ipcRenderer.invoke('fleet:createBot', input),
  fleetUpdateBot: (botId: string, patch: FleetPatchBotRequest): Promise<FleetBot> =>
    ipcRenderer.invoke('fleet:updateBot', botId, patch),
  fleetBotAction: (
    botId: string,
    action: 'start' | 'stop' | 'restart' | 'archive' | 'pause' | 'resume' | 'cancel'
  ): Promise<FleetBot | void> => ipcRenderer.invoke('fleet:botAction', botId, action),
  /** Stops one conversation's turn: `primary` for the bot's own, or a routine run's or a peer thread's id. */
  fleetCancelTurn: (botId: string, conversation: string): Promise<void> =>
    ipcRenderer.invoke('fleet:cancelTurn', botId, conversation),
  /**
   * Moves a bot to another environment of its server, or to a new one, with everything that is its own (`bot-move`).
   * Answers at once with the move; its progress arrives in the bot's `move`.
   */
  fleetMoveBot: (botId: string, input: FleetMoveBotInput): Promise<FleetBotMove> =>
    ipcRenderer.invoke('fleet:moveBot', botId, input),
  /** The bot's last move, running or finished, with why it failed. */
  fleetGetBotMove: (botId: string): Promise<FleetBotMove> => ipcRenderer.invoke('fleet:botMove', botId),
  fleetListArchivedBots: (): Promise<{ bots: FleetArchivedBot[] }> => ipcRenderer.invoke('fleet:listArchivedBots'),
  /** Recreates an archived bot's container on its kept files; it comes back as `creating`. */
  fleetRestoreArchivedBot: (botId: string): Promise<FleetBot> => ipcRenderer.invoke('fleet:restoreArchivedBot', botId),
  /** Irreversible: deletes an archived bot's files and every server record of it. */
  fleetDeleteArchivedBot: (botId: string): Promise<void> => ipcRenderer.invoke('fleet:deleteArchivedBot', botId),
  /** Acts on every bot of the environment; archiving removes its container and keeps its files and bots. */
  fleetEnvironmentAction: (
    environmentId: string,
    action: 'start' | 'stop' | 'restart' | 'archive'
  ): Promise<FleetEnvironment> => ipcRenderer.invoke('fleet:environmentAction', environmentId, action),
  /**
   * Creates a workspaces environment: Maestrly running on the server for the owner's chats and workspaces of one scope.
   * Without input, as older views ask, it is named Workspaces and takes the server's defaults.
   */
  fleetCreateWorkspaces: (input?: FleetCreateWorkspacesInput): Promise<FleetEnvironment> =>
    input === undefined
      ? ipcRenderer.invoke('fleet:createWorkspaces')
      : ipcRenderer.invoke('fleet:createWorkspaces', input),
  /**
   * Moves the environment to the server's bot image: `idle` schedules it for when none of its bots is busy and answers
   * at once; `now` restarts it at once, interrupting its bots. Gateways with `environment-updates` only.
   */
  fleetEnvironmentUpdate: (environmentId: string, when: 'idle' | 'now'): Promise<FleetEnvironment> =>
    ipcRenderer.invoke('fleet:environmentUpdate', environmentId, when),
  /** Cancels an update that waits for the environment's bots. */
  fleetEnvironmentUpdateCancel: (environmentId: string): Promise<FleetEnvironment> =>
    ipcRenderer.invoke('fleet:environmentUpdateCancel', environmentId),
  /** Asks the environment to check for Claude Code and Codex releases; gateways with `runtime-updates` only. */
  fleetEnvironmentRuntimesCheck: (environmentId: string): Promise<FleetEnvironment> =>
    ipcRenderer.invoke('fleet:environmentRuntimesCheck', environmentId),
  fleetPatchEnvironment: (environmentId: string, patch: FleetPatchEnvironmentRequest): Promise<FleetEnvironment> =>
    ipcRenderer.invoke('fleet:patchEnvironment', environmentId, patch),
  /** Empty for gateways without environments. */
  fleetListArchivedEnvironments: (): Promise<{ environments: FleetArchivedEnvironment[] }> =>
    ipcRenderer.invoke('fleet:listArchivedEnvironments'),
  /** Recreates an archived environment's container on its kept files, with its bots. */
  fleetRestoreArchivedEnvironment: (environmentId: string): Promise<FleetEnvironment> =>
    ipcRenderer.invoke('fleet:restoreArchivedEnvironment', environmentId),
  /** Irreversible: deletes an archived environment's files, its bots and every server record of them. */
  fleetDeleteArchivedEnvironment: (environmentId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:deleteArchivedEnvironment', environmentId),
  /** Opens a section of the environment's Maestrly settings on its environment screen. */
  fleetEnvironmentUiOpen: (environmentId: string, target: FleetUiOpenRequest['target']): Promise<void> =>
    ipcRenderer.invoke('fleet:environmentUiOpen', environmentId, target),
  fleetListSelections: (
    botId: string
  ): Promise<{
    options: FleetSelectionOption[]
    current: FleetSelection | null
  }> => ipcRenderer.invoke('fleet:listSelections', botId),
  /** The models of an environment's accounts, for its default compaction model; the environment must run. */
  fleetEnvironmentSelections: (
    environmentId: string
  ): Promise<{
    options: FleetSelectionOption[]
    current: FleetSelection | null
  }> => ipcRenderer.invoke('fleet:environmentSelections', environmentId),
  fleetAddApiKeyAccount: (
    target: FleetProvisioningTargetInput,
    input: FleetAddApiKeyAccountRequest
  ): Promise<{ providerId: string }> => ipcRenderer.invoke('fleet:add-api-key-account', target, input),
  fleetRemoveAccount: (target: FleetProvisioningTargetInput, providerId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:remove-account', target, providerId),
  fleetGetTranscript: (botId: string, before?: string | null, limit?: number): Promise<FleetTranscriptPage> =>
    ipcRenderer.invoke('fleet:getTranscript', botId, before, limit),
  /** With `citation`, the message refers to one of the bot's routine runs, which the bot reads to answer. */
  fleetSendMessage: (
    botId: string,
    text: string,
    attachments: FleetOutgoingAttachment[] = [],
    citation: string | null = null
  ): Promise<{ inputId: string; itemId: string; queued: boolean }> =>
    ipcRenderer.invoke('fleet:sendMessage', botId, text, attachments, citation),
  /** An image of the bot's conversation, or with `runId` of that routine run's. */
  fleetGetImage: (botId: string, imageId: string, runId: string | null = null): Promise<FleetImageData> =>
    ipcRenderer.invoke('fleet:getImage', botId, imageId, runId),
  /** The bot's routine runs, newest first, a page at a time (`routine-conversations`). */
  fleetListRuns: (
    botId: string,
    before: string | null = null,
    routineId: string | null = null
  ): Promise<FleetRoutineRunPage> => ipcRenderer.invoke('fleet:listRuns', botId, before, routineId),
  fleetGetRun: (botId: string, runId: string): Promise<FleetRoutineRun> =>
    ipcRenderer.invoke('fleet:getRun', botId, runId),
  fleetGetRunTranscript: (
    botId: string,
    runId: string,
    before?: string | null,
    limit?: number
  ): Promise<FleetTranscriptPage> => ipcRenderer.invoke('fleet:getRunTranscript', botId, runId, before, limit),
  /** A run kept is never deleted on its own. */
  fleetPinRun: (botId: string, runId: string, pinned: boolean): Promise<FleetRoutineRun> =>
    ipcRenderer.invoke('fleet:pinRun', botId, runId, pinned),
  /** Deletes the run's conversation; its report and files stay. Rejects with FLEET_RUN_CONFLICT while it works. */
  fleetDeleteRunConversation: (botId: string, runId: string): Promise<FleetRoutineRun> =>
    ipcRenderer.invoke('fleet:deleteRunConversation', botId, runId),
  /** The owner's message in the run's conversation, which the bot answers there. */
  fleetSendRunMessage: (
    botId: string,
    runId: string,
    text: string,
    attachments: FleetOutgoingAttachment[] = []
  ): Promise<{ inputId: string; itemId: string; queued: boolean }> =>
    ipcRenderer.invoke('fleet:sendRunMessage', botId, runId, text, attachments),
  fleetSetRunSettings: (botId: string, settings: FleetRoutineRunSettings): Promise<FleetRoutineRunSettings> =>
    ipcRenderer.invoke('fleet:setRunSettings', botId, settings),
  /** The bot's conversations with other bots, each in a conversation of its own (`peer-conversations`). */
  fleetListPeerThreads: (botId: string): Promise<FleetPeerThreadList> =>
    ipcRenderer.invoke('fleet:listPeerThreads', botId),
  fleetGetPeerThreadTranscript: (
    botId: string,
    threadId: string,
    before?: string | null,
    limit?: number
  ): Promise<FleetTranscriptPage> =>
    ipcRenderer.invoke('fleet:getPeerThreadTranscript', botId, threadId, before, limit),
  /** Keeps a thread (`pinned`), or lets a paused one go on (`resume`). */
  fleetPatchPeerThread: (
    botId: string,
    threadId: string,
    patch: FleetPeerThreadPatchRequest
  ): Promise<FleetPeerThread> => ipcRenderer.invoke('fleet:patchPeerThread', botId, threadId, patch),
  /** Deletes the bot's conversation of the thread; its files stay. Rejects with FLEET_PEER_THREAD_CONFLICT while it works. */
  fleetDeletePeerThreadConversation: (botId: string, threadId: string): Promise<FleetPeerThread> =>
    ipcRenderer.invoke('fleet:deletePeerThreadConversation', botId, threadId),
  /** The owner's message in the bot's conversation of the thread: the bots' messages in a row start again from it. */
  fleetSendPeerThreadMessage: (
    botId: string,
    threadId: string,
    text: string,
    attachments: FleetOutgoingAttachment[] = []
  ): Promise<{ inputId: string; itemId: string; queued: boolean }> =>
    ipcRenderer.invoke('fleet:sendPeerThreadMessage', botId, threadId, text, attachments),
  fleetSetPeerThreadSettings: (botId: string, settings: FleetPeerThreadSettings): Promise<FleetPeerThreadSettings> =>
    ipcRenderer.invoke('fleet:setPeerThreadSettings', botId, settings),
  /** Resolves with a receipt; joins the transfer already running for the file instead of starting another. */
  fleetDownloadFile: (botId: string, fileId: string): Promise<string> =>
    ipcRenderer.invoke('fleet:downloadFile', botId, fileId),
  fleetCancelDownload: (botId: string, fileId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:cancelDownload', botId, fileId),
  fleetGetActiveDownload: (botId: string, fileId: string): Promise<FleetDownloadProgress | null> =>
    ipcRenderer.invoke('fleet:getActiveDownload', botId, fileId),
  /** The bot files this window shows, replacing its previous list: they finish without a system notification. */
  fleetAttendDownloads: (files: FleetDownloadFileKey[]): Promise<void> =>
    ipcRenderer.invoke('fleet:attendDownloads', files),
  onFleetDownload: (cb: (event: FleetDownloadEvent) => void): (() => void) => subscribe('fleet:download', cb),
  fleetRevealDownload: (receipt: string): Promise<void> => ipcRenderer.invoke('fleet:revealDownload', receipt),
  fleetGetDownload: (botId: string, fileId: string): Promise<string | null> =>
    ipcRenderer.invoke('fleet:getDownload', botId, fileId),
  /** A `maestrly-media:` URL that plays a shared video once main has it in its cache. */
  fleetPrepareMedia: (botId: string, fileId: string): Promise<string> =>
    ipcRenderer.invoke('fleet:prepareMedia', botId, fileId),
  fleetRemoveQueuedMessage: (botId: string, inputId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:removeQueuedMessage', botId, inputId),
  /** Edits the owner's last message (feature `message-edit`): the conversation is cut there and runs again. */
  fleetEditMessage: (
    botId: string,
    inputId: string,
    text: string
  ): Promise<{ inputId: string; itemId: string; queued: boolean }> =>
    ipcRenderer.invoke('fleet:editMessage', botId, inputId, text),
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
  fleetConversationCall: <Op extends keyof FleetConversationOps>(
    botId: string,
    op: Op,
    ...args: Parameters<FleetConversationOps[Op]>
  ): Promise<ReturnType<FleetConversationOps[Op]>> => ipcRenderer.invoke('fleet:conversationCall', botId, op, args),
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
  fleetOwnerMemoryList: (status: 'active' | 'all' = 'all'): Promise<FleetOwnerMemory> =>
    ipcRenderer.invoke('fleet:ownerMemoryList', status),
  fleetOwnerMemoryCreate: (input: FleetOwnerMemoryCreateInput): Promise<FleetOwnerMemoryEntry> =>
    ipcRenderer.invoke('fleet:ownerMemoryCreate', input),
  fleetOwnerMemoryUpdate: (entryId: string, patch: FleetOwnerMemoryPatchRequest): Promise<FleetOwnerMemoryEntry> =>
    ipcRenderer.invoke('fleet:ownerMemoryUpdate', entryId, patch),
  fleetOwnerMemoryDelete: (entryId: string): Promise<void> => ipcRenderer.invoke('fleet:ownerMemoryDelete', entryId),
  fleetListRoutineRuns: (botId: string, routineId: string): Promise<{ runs: FleetRoutineRun[] }> =>
    ipcRenderer.invoke('fleet:listRoutineRuns', botId, routineId),
  fleetListBotMemories: (
    botId: string,
    status: 'active' | 'archived' | 'superseded' | 'all' = 'active'
  ): Promise<{ memories: FleetBotMemory[] }> => ipcRenderer.invoke('fleet:listBotMemories', botId, status),
  fleetPatchBotMemory: (botId: string, memoryId: string, patch: FleetBotMemoryPatchRequest): Promise<FleetBotMemory> =>
    ipcRenderer.invoke('fleet:patchBotMemory', botId, memoryId, patch),
  fleetDeleteBotMemory: (botId: string, memoryId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:deleteBotMemory', botId, memoryId),
  fleetGetInbox: (): Promise<{ items: FleetInboxItem[] }> => ipcRenderer.invoke('fleet:getInbox'),
  fleetGetPeerMessages: (limit?: number): Promise<{ messages: FleetPeerMessage[] }> =>
    ipcRenderer.invoke('fleet:getPeerMessages', limit),
  /** A bot's browser or apps area, or an environment's screen; a bare bot id is its browser area. */
  fleetScreenOpen: (target: FleetScreenTargetInput, mode: 'view' | 'control'): Promise<{ channelId: string }> =>
    ipcRenderer.invoke('fleet:screenOpen', target, mode),
  fleetScreenSend: (channelId: string, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('fleet:screenSend', channelId, data),
  fleetScreenClose: (channelId: string): Promise<void> => ipcRenderer.invoke('fleet:screenClose', channelId),
  fleetScreenClipboardRead: (channelId: string): Promise<string> =>
    ipcRenderer.invoke('fleet:screenClipboardRead', channelId),
  fleetScreenClipboardWrite: (channelId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('fleet:screenClipboardWrite', channelId, text),
  /** What this Mac gives a bot, and every Mac linked to it. */
  fleetDesktopAccess: (botId: string): Promise<FleetDesktopAccessView> =>
    ipcRenderer.invoke('fleet:desktopAccess:get', botId),
  /** Gives a bot access to projects on this Mac, or changes it. */
  fleetDesktopAccessSave: (botId: string, input: FleetDesktopAccessInput): Promise<FleetDesktopAccessView> =>
    ipcRenderer.invoke('fleet:desktopAccess:save', botId, input),
  /** Takes this Mac's access back; the bot's conversations stay here. */
  fleetDesktopAccessDisable: (botId: string): Promise<FleetDesktopAccessView> =>
    ipcRenderer.invoke('fleet:desktopAccess:disable', botId),
  /** Removes another Mac's link; that Mac revokes its side when it hears of it. */
  fleetDesktopAccessRemoveOther: (botId: string, desktopId: string): Promise<FleetDesktopAccessView> =>
    ipcRenderer.invoke('fleet:desktopAccess:removeOther', botId, desktopId),
  onFleetDesktopAccess: (cb: (payload: { botId: string }) => void): (() => void) =>
    subscribe('fleet:desktop-access', cb),
  onFleetEvent: (cb: (event: FleetGatewayEvent) => void): (() => void) => subscribe('fleet:event', cb),
  onFleetMediaProgress: (cb: (progress: FleetMediaProgress) => void): (() => void) =>
    subscribe('fleet:mediaProgress', cb),
  onFleetConnection: (cb: (view: FleetConnectionView) => void): (() => void) => subscribe('fleet:connection', cb),
  onFleetScreenData: (cb: (data: FleetScreenData) => void): (() => void) => subscribe('fleet:screen:data', cb),
  onFleetScreenState: (cb: (state: FleetScreenState) => void): (() => void) => subscribe('fleet:screen:state', cb),
  onFleetInstanceOpenAccounts: (cb: (target: 'accounts' | 'skills' | 'mcp') => void): (() => void) =>
    subscribe('fleet:instance:open-settings', cb),
  /** Hides a bot's settings window. Closing it would destroy the window and stop the bot's control server. */
  fleetInstanceHideWindow: (): Promise<void> => ipcRenderer.invoke('fleet:instance:hide'),
}
