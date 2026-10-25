import type {
  FleetDevicesResponse,
  FleetDictationKeyResponse,
  FleetDictationStatus,
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
import type { FleetConnectionView, FleetServerId, FleetServerView } from '../shared/fleet-servers'
import type { FleetBotAttentionChange, FleetBotAttentionEntry } from '../shared/notifications'
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
  FleetFileSettings,
  FleetFilesDeleted,
  FleetFilesList,
  FleetFilesUsage,
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

export type { FleetConnectionView } from '../shared/fleet-servers'
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
    serverId: FleetServerId,
    target: FleetProvisioningTargetInput,
    request: FleetLoginStartRequest
  ): Promise<{ attempt: FleetLoginAttempt; relay: 'listening' | 'unavailable' | 'none' }> =>
    ipcRenderer.invoke('fleet:login:start', serverId, target, request),
  fleetLoginStatus: (
    serverId: FleetServerId,
    target: FleetProvisioningTargetInput,
    loginId: string
  ): Promise<FleetLoginAttempt> => ipcRenderer.invoke('fleet:login:status', serverId, target, loginId),
  fleetLoginSubmitCode: (
    serverId: FleetServerId,
    target: FleetProvisioningTargetInput,
    loginId: string,
    code: string
  ): Promise<FleetLoginAttempt> => ipcRenderer.invoke('fleet:login:code', serverId, target, loginId, code),
  fleetLoginCancel: (serverId: FleetServerId, target: FleetProvisioningTargetInput, loginId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:login:cancel', serverId, target, loginId),
  fleetLoginOpen: (
    serverId: FleetServerId,
    target: FleetProvisioningTargetInput,
    loginId: string,
    page: 'auth' | 'device' | 'manual'
  ): Promise<void> => ipcRenderer.invoke('fleet:login:open', serverId, target, loginId, page),
  fleetProvisioningInventory: (): Promise<MacInventory> => ipcRenderer.invoke('fleet:provisioning:inventory'),
  fleetImportFromMac: (
    serverId: FleetServerId,
    target: FleetProvisioningTargetInput,
    selection: MacImportSelection
  ): Promise<MacImportReport> => ipcRenderer.invoke('fleet:provisioning:import', serverId, target, selection),
  fleetBotAccounts: (serverId: FleetServerId, target: FleetProvisioningTargetInput): Promise<FleetBotAccounts> =>
    ipcRenderer.invoke('fleet:bot:accounts', serverId, target),
  fleetRemoveBotSubscription: (
    serverId: FleetServerId,
    target: FleetProvisioningTargetInput,
    kind: FleetSubscriptionKind,
    slot: string
  ): Promise<void> => ipcRenderer.invoke('fleet:bot:subscription-remove', serverId, target, kind, slot),
  fleetBotSkills: (serverId: FleetServerId, target: FleetProvisioningTargetInput): Promise<FleetBotSkills> =>
    ipcRenderer.invoke('fleet:bot:skills', serverId, target),
  fleetRemoveBotSkill: (serverId: FleetServerId, target: FleetProvisioningTargetInput, name: string): Promise<void> =>
    ipcRenderer.invoke('fleet:bot:skill-remove', serverId, target, name),
  fleetBotMcpServers: (serverId: FleetServerId, target: FleetProvisioningTargetInput): Promise<FleetBotMcpServers> =>
    ipcRenderer.invoke('fleet:bot:mcp-servers', serverId, target),
  fleetRemoveBotMcpServer: (
    fleetServerId: FleetServerId,
    target: FleetProvisioningTargetInput,
    serverId: string
  ): Promise<void> => ipcRenderer.invoke('fleet:bot:mcp-remove', fleetServerId, target, serverId),
  fleetGetConnection: (serverId: FleetServerId): Promise<FleetConnectionView> =>
    ipcRenderer.invoke('fleet:getConnection', serverId),
  /** The servers this computer is paired with. */
  fleetServers: (): Promise<FleetServerView[]> => ipcRenderer.invoke('fleet:servers'),
  onFleetServers: (cb: (servers: FleetServerView[]) => void): (() => void) => subscribe('fleet:servers', cb),
  /** The bots with something new for the owner on this computer, marked until the owner opens them. */
  fleetBotAttention: (): Promise<FleetBotAttentionEntry[]> => ipcRenderer.invoke('fleet:listBotAttention'),
  onFleetBotAttention: (cb: (change: FleetBotAttentionChange) => void): (() => void) =>
    subscribe('fleet:botAttention', cb),
  /** The bot the main window shows, which notifies nothing and is not marked; null when it shows anything else. */
  fleetSetVisibleBot: (target: { serverId: FleetServerId; botId: string } | null): void =>
    ipcRenderer.send('fleet:visibleBot', target),
  /** Pairs this computer with a server; with `serverId`, pairs that server again. */
  fleetConnect: (
    input: { url: string; code: string; deviceName?: string },
    serverId?: FleetServerId
  ): Promise<FleetServerView> => ipcRenderer.invoke('fleet:connect', input, serverId),
  fleetDisconnect: (serverId: FleetServerId): Promise<void> => ipcRenderer.invoke('fleet:disconnect', serverId),
  /** A one-use code that pairs another device (a phone) with this computer's bot server. */
  fleetCreatePairing: (serverId: FleetServerId): Promise<FleetPairingCodeResponse> =>
    ipcRenderer.invoke('fleet:createPairing', serverId),
  /** The phones and computers paired with the bot server. */
  fleetDevices: (serverId: FleetServerId): Promise<FleetDevicesResponse> =>
    ipcRenderer.invoke('fleet:devices', serverId),
  /** Removes another paired device; it can no longer reach the bot server. */
  fleetRevokeDevice: (serverId: FleetServerId, deviceId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:revokeDevice', serverId, deviceId),
  /** The bot server's dictation key for phones; null when the server predates it. */
  fleetDictation: (serverId: FleetServerId): Promise<FleetDictationStatus | null> =>
    ipcRenderer.invoke('fleet:dictation', serverId),
  /** Stores this computer's dictation engine and key on the bot server, for its phones. */
  fleetDictationUseLocal: (serverId: FleetServerId): Promise<FleetDictationKeyResponse> =>
    ipcRenderer.invoke('fleet:dictationUseLocal', serverId),
  fleetDictationRemove: (serverId: FleetServerId): Promise<void> =>
    ipcRenderer.invoke('fleet:dictationRemove', serverId),
  fleetGetSnapshot: (serverId: FleetServerId): Promise<FleetSnapshot> =>
    ipcRenderer.invoke('fleet:getSnapshot', serverId),
  fleetRefresh: (serverId: FleetServerId): Promise<FleetSnapshot> => ipcRenderer.invoke('fleet:refresh', serverId),
  fleetGetHost: (serverId: FleetServerId): Promise<FleetHostInfo> => ipcRenderer.invoke('fleet:getHost', serverId),
  fleetListBots: (serverId: FleetServerId): Promise<{ bots: FleetBot[] }> =>
    ipcRenderer.invoke('fleet:listBots', serverId),
  fleetGetBot: (serverId: FleetServerId, botId: string): Promise<FleetBot> =>
    ipcRenderer.invoke('fleet:getBot', serverId, botId),
  fleetCreateBot: (serverId: FleetServerId, input: FleetCreateBotInput): Promise<FleetBot> =>
    ipcRenderer.invoke('fleet:createBot', serverId, input),
  fleetUpdateBot: (serverId: FleetServerId, botId: string, patch: FleetPatchBotRequest): Promise<FleetBot> =>
    ipcRenderer.invoke('fleet:updateBot', serverId, botId, patch),
  fleetBotAction: (
    serverId: FleetServerId,
    botId: string,
    action: 'start' | 'stop' | 'restart' | 'archive' | 'pause' | 'resume' | 'cancel'
  ): Promise<FleetBot | void> => ipcRenderer.invoke('fleet:botAction', serverId, botId, action),
  /** Stops one conversation's turn: `primary` for the bot's own, or a routine run's or a peer thread's id. */
  fleetCancelTurn: (serverId: FleetServerId, botId: string, conversation: string): Promise<void> =>
    ipcRenderer.invoke('fleet:cancelTurn', serverId, botId, conversation),
  /**
   * Moves a bot to another environment of its server, or to a new one, with everything that is its own (`bot-move`).
   * Answers at once with the move; its progress arrives in the bot's `move`.
   */
  fleetMoveBot: (serverId: FleetServerId, botId: string, input: FleetMoveBotInput): Promise<FleetBotMove> =>
    ipcRenderer.invoke('fleet:moveBot', serverId, botId, input),
  /** The bot's last move, running or finished, with why it failed. */
  fleetGetBotMove: (serverId: FleetServerId, botId: string): Promise<FleetBotMove> =>
    ipcRenderer.invoke('fleet:botMove', serverId, botId),
  fleetListArchivedBots: (serverId: FleetServerId): Promise<{ bots: FleetArchivedBot[] }> =>
    ipcRenderer.invoke('fleet:listArchivedBots', serverId),
  /** Recreates an archived bot's container on its kept files; it comes back as `creating`. */
  fleetRestoreArchivedBot: (serverId: FleetServerId, botId: string): Promise<FleetBot> =>
    ipcRenderer.invoke('fleet:restoreArchivedBot', serverId, botId),
  /** Irreversible: deletes an archived bot's files and every server record of it. */
  fleetDeleteArchivedBot: (serverId: FleetServerId, botId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:deleteArchivedBot', serverId, botId),
  /** Acts on every bot of the environment; archiving removes its container and keeps its files and bots. */
  fleetEnvironmentAction: (
    serverId: FleetServerId,
    environmentId: string,
    action: 'start' | 'stop' | 'restart' | 'archive'
  ): Promise<FleetEnvironment> => ipcRenderer.invoke('fleet:environmentAction', serverId, environmentId, action),
  /**
   * Creates a workspaces environment: Maestrly running on the server for the owner's chats and workspaces of one scope.
   * Without input, as older views ask, it is named Workspaces and takes the server's defaults.
   */
  fleetCreateWorkspaces: (serverId: FleetServerId, input?: FleetCreateWorkspacesInput): Promise<FleetEnvironment> =>
    input === undefined
      ? ipcRenderer.invoke('fleet:createWorkspaces', serverId)
      : ipcRenderer.invoke('fleet:createWorkspaces', serverId, input),
  /**
   * Moves the environment to the server's bot image: `idle` schedules it for when none of its bots is busy and answers
   * at once; `now` restarts it at once, interrupting its bots. Gateways with `environment-updates` only.
   */
  fleetEnvironmentUpdate: (
    serverId: FleetServerId,
    environmentId: string,
    when: 'idle' | 'now'
  ): Promise<FleetEnvironment> => ipcRenderer.invoke('fleet:environmentUpdate', serverId, environmentId, when),
  /** Cancels an update that waits for the environment's bots. */
  fleetEnvironmentUpdateCancel: (serverId: FleetServerId, environmentId: string): Promise<FleetEnvironment> =>
    ipcRenderer.invoke('fleet:environmentUpdateCancel', serverId, environmentId),
  /** Asks the environment to check for Claude Code and Codex releases; gateways with `runtime-updates` only. */
  fleetEnvironmentRuntimesCheck: (serverId: FleetServerId, environmentId: string): Promise<FleetEnvironment> =>
    ipcRenderer.invoke('fleet:environmentRuntimesCheck', serverId, environmentId),
  fleetPatchEnvironment: (
    serverId: FleetServerId,
    environmentId: string,
    patch: FleetPatchEnvironmentRequest
  ): Promise<FleetEnvironment> => ipcRenderer.invoke('fleet:patchEnvironment', serverId, environmentId, patch),
  /** Empty for gateways without environments. */
  fleetListArchivedEnvironments: (serverId: FleetServerId): Promise<{ environments: FleetArchivedEnvironment[] }> =>
    ipcRenderer.invoke('fleet:listArchivedEnvironments', serverId),
  /** Recreates an archived environment's container on its kept files, with its bots. */
  fleetRestoreArchivedEnvironment: (serverId: FleetServerId, environmentId: string): Promise<FleetEnvironment> =>
    ipcRenderer.invoke('fleet:restoreArchivedEnvironment', serverId, environmentId),
  /** Irreversible: deletes an archived environment's files, its bots and every server record of them. */
  fleetDeleteArchivedEnvironment: (serverId: FleetServerId, environmentId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:deleteArchivedEnvironment', serverId, environmentId),
  /** Opens a section of the environment's Maestrly settings on its environment screen. */
  fleetEnvironmentUiOpen: (
    serverId: FleetServerId,
    environmentId: string,
    target: FleetUiOpenRequest['target']
  ): Promise<void> => ipcRenderer.invoke('fleet:environmentUiOpen', serverId, environmentId, target),
  fleetListSelections: (
    serverId: FleetServerId,
    botId: string
  ): Promise<{
    options: FleetSelectionOption[]
    current: FleetSelection | null
  }> => ipcRenderer.invoke('fleet:listSelections', serverId, botId),
  /** The models of an environment's accounts, for its default compaction model; the environment must run. */
  fleetEnvironmentSelections: (
    serverId: FleetServerId,
    environmentId: string
  ): Promise<{
    options: FleetSelectionOption[]
    current: FleetSelection | null
  }> => ipcRenderer.invoke('fleet:environmentSelections', serverId, environmentId),
  fleetAddApiKeyAccount: (
    serverId: FleetServerId,
    target: FleetProvisioningTargetInput,
    input: FleetAddApiKeyAccountRequest
  ): Promise<{ providerId: string }> => ipcRenderer.invoke('fleet:add-api-key-account', serverId, target, input),
  fleetRemoveAccount: (
    serverId: FleetServerId,
    target: FleetProvisioningTargetInput,
    providerId: string
  ): Promise<void> => ipcRenderer.invoke('fleet:remove-account', serverId, target, providerId),
  fleetGetTranscript: (
    serverId: FleetServerId,
    botId: string,
    before?: string | null,
    limit?: number
  ): Promise<FleetTranscriptPage> => ipcRenderer.invoke('fleet:getTranscript', serverId, botId, before, limit),
  /** With `citation`, the message refers to one of the bot's routine runs, which the bot reads to answer. */
  fleetSendMessage: (
    serverId: FleetServerId,
    botId: string,
    text: string,
    attachments: FleetOutgoingAttachment[] = [],
    citation: string | null = null
  ): Promise<{ inputId: string; itemId: string; queued: boolean }> =>
    ipcRenderer.invoke('fleet:sendMessage', serverId, botId, text, attachments, citation),
  /** An image of the bot's conversation, or with `runId` of that routine run's. */
  fleetGetImage: (
    serverId: FleetServerId,
    botId: string,
    imageId: string,
    runId: string | null = null
  ): Promise<FleetImageData> => ipcRenderer.invoke('fleet:getImage', serverId, botId, imageId, runId),
  /** The bot's routine runs, newest first, a page at a time (`routine-conversations`). */
  fleetListRuns: (
    serverId: FleetServerId,
    botId: string,
    before: string | null = null,
    routineId: string | null = null
  ): Promise<FleetRoutineRunPage> => ipcRenderer.invoke('fleet:listRuns', serverId, botId, before, routineId),
  fleetGetRun: (serverId: FleetServerId, botId: string, runId: string): Promise<FleetRoutineRun> =>
    ipcRenderer.invoke('fleet:getRun', serverId, botId, runId),
  fleetGetRunTranscript: (
    serverId: FleetServerId,
    botId: string,
    runId: string,
    before?: string | null,
    limit?: number
  ): Promise<FleetTranscriptPage> =>
    ipcRenderer.invoke('fleet:getRunTranscript', serverId, botId, runId, before, limit),
  /** A run kept is never deleted on its own. */
  fleetPinRun: (serverId: FleetServerId, botId: string, runId: string, pinned: boolean): Promise<FleetRoutineRun> =>
    ipcRenderer.invoke('fleet:pinRun', serverId, botId, runId, pinned),
  /** The owner opened the run: it is new on none of their devices (`owner-seen`). */
  fleetSeeRun: (serverId: FleetServerId, botId: string, runId: string): Promise<FleetRoutineRun> =>
    ipcRenderer.invoke('fleet:seeRun', serverId, botId, runId),
  /** Deletes the run's conversation; its report and files stay. Rejects with FLEET_RUN_CONFLICT while it works. */
  fleetDeleteRunConversation: (serverId: FleetServerId, botId: string, runId: string): Promise<FleetRoutineRun> =>
    ipcRenderer.invoke('fleet:deleteRunConversation', serverId, botId, runId),
  /** The owner's message in the run's conversation, which the bot answers there. */
  fleetSendRunMessage: (
    serverId: FleetServerId,
    botId: string,
    runId: string,
    text: string,
    attachments: FleetOutgoingAttachment[] = []
  ): Promise<{ inputId: string; itemId: string; queued: boolean }> =>
    ipcRenderer.invoke('fleet:sendRunMessage', serverId, botId, runId, text, attachments),
  fleetSetRunSettings: (
    serverId: FleetServerId,
    botId: string,
    settings: FleetRoutineRunSettings
  ): Promise<FleetRoutineRunSettings> => ipcRenderer.invoke('fleet:setRunSettings', serverId, botId, settings),
  /** The bot's conversations with other bots, each in a conversation of its own (`peer-conversations`). */
  fleetListPeerThreads: (serverId: FleetServerId, botId: string): Promise<FleetPeerThreadList> =>
    ipcRenderer.invoke('fleet:listPeerThreads', serverId, botId),
  fleetGetPeerThreadTranscript: (
    serverId: FleetServerId,
    botId: string,
    threadId: string,
    before?: string | null,
    limit?: number
  ): Promise<FleetTranscriptPage> =>
    ipcRenderer.invoke('fleet:getPeerThreadTranscript', serverId, botId, threadId, before, limit),
  /** Keeps a thread (`pinned`), lets a paused one go on (`resume`), or saw it as it is now (`seen`, `owner-seen`). */
  fleetPatchPeerThread: (
    serverId: FleetServerId,
    botId: string,
    threadId: string,
    patch: FleetPeerThreadPatchRequest
  ): Promise<FleetPeerThread> => ipcRenderer.invoke('fleet:patchPeerThread', serverId, botId, threadId, patch),
  /** Deletes the bot's conversation of the thread; its files stay. Rejects with FLEET_PEER_THREAD_CONFLICT while it works. */
  fleetDeletePeerThreadConversation: (
    serverId: FleetServerId,
    botId: string,
    threadId: string
  ): Promise<FleetPeerThread> => ipcRenderer.invoke('fleet:deletePeerThreadConversation', serverId, botId, threadId),
  /** The owner's message in the bot's conversation of the thread: the bots' messages in a row start again from it. */
  fleetSendPeerThreadMessage: (
    serverId: FleetServerId,
    botId: string,
    threadId: string,
    text: string,
    attachments: FleetOutgoingAttachment[] = []
  ): Promise<{ inputId: string; itemId: string; queued: boolean }> =>
    ipcRenderer.invoke('fleet:sendPeerThreadMessage', serverId, botId, threadId, text, attachments),
  fleetSetPeerThreadSettings: (
    serverId: FleetServerId,
    botId: string,
    settings: FleetPeerThreadSettings
  ): Promise<FleetPeerThreadSettings> => ipcRenderer.invoke('fleet:setPeerThreadSettings', serverId, botId, settings),
  /** Resolves with a receipt; joins the transfer already running for the file instead of starting another. */
  fleetDownloadFile: (serverId: FleetServerId, botId: string, fileId: string): Promise<string> =>
    ipcRenderer.invoke('fleet:downloadFile', serverId, botId, fileId),
  fleetListBotFiles: (serverId: FleetServerId, botId: string): Promise<FleetFilesList> =>
    ipcRenderer.invoke('fleet:listBotFiles', serverId, botId),
  fleetDeleteBotFiles: (serverId: FleetServerId, botId: string, ids: string[]): Promise<FleetFilesDeleted> =>
    ipcRenderer.invoke('fleet:deleteBotFiles', serverId, botId, ids),
  fleetSetBotFileSettings: (
    serverId: FleetServerId,
    botId: string,
    settings: FleetFileSettings
  ): Promise<FleetFilesUsage> => ipcRenderer.invoke('fleet:setBotFileSettings', serverId, botId, settings),
  fleetCancelDownload: (serverId: FleetServerId, botId: string, fileId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:cancelDownload', serverId, botId, fileId),
  fleetGetActiveDownload: (
    serverId: FleetServerId,
    botId: string,
    fileId: string
  ): Promise<FleetDownloadProgress | null> => ipcRenderer.invoke('fleet:getActiveDownload', serverId, botId, fileId),
  /** The bot files this window shows, replacing its previous list: they finish without a system notification. */
  fleetAttendDownloads: (files: FleetDownloadFileKey[]): Promise<void> =>
    ipcRenderer.invoke('fleet:attendDownloads', files),
  onFleetDownload: (cb: (serverId: FleetServerId, event: FleetDownloadEvent) => void): (() => void) =>
    subscribe<{ serverId: FleetServerId; event: FleetDownloadEvent }>('fleet:download', (p) => cb(p.serverId, p.event)),
  fleetRevealDownload: (receipt: string): Promise<void> => ipcRenderer.invoke('fleet:revealDownload', receipt),
  fleetGetDownload: (serverId: FleetServerId, botId: string, fileId: string): Promise<string | null> =>
    ipcRenderer.invoke('fleet:getDownload', serverId, botId, fileId),
  /** A `maestrly-media:` URL that plays a shared video once main has it in its cache. */
  fleetPrepareMedia: (serverId: FleetServerId, botId: string, fileId: string): Promise<string> =>
    ipcRenderer.invoke('fleet:prepareMedia', serverId, botId, fileId),
  fleetRemoveQueuedMessage: (serverId: FleetServerId, botId: string, inputId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:removeQueuedMessage', serverId, botId, inputId),
  /** Edits the owner's last message (feature `message-edit`): the conversation is cut there and runs again. */
  fleetEditMessage: (
    serverId: FleetServerId,
    botId: string,
    inputId: string,
    text: string
  ): Promise<{ inputId: string; itemId: string; queued: boolean }> =>
    ipcRenderer.invoke('fleet:editMessage', serverId, botId, inputId, text),
  fleetResolveInteraction: (
    serverId: FleetServerId,
    botId: string,
    interactionId: string,
    resolution: FleetInteractionResolution
  ): Promise<void> => ipcRenderer.invoke('fleet:resolveInteraction', serverId, botId, interactionId, resolution),
  fleetTakeover: (serverId: FleetServerId, botId: string): Promise<FleetTakeoverState> =>
    ipcRenderer.invoke('fleet:takeover', serverId, botId),
  fleetReleaseTakeover: (
    serverId: FleetServerId,
    botId: string,
    input: FleetTakeoverReleaseRequest
  ): Promise<FleetTakeoverState> => ipcRenderer.invoke('fleet:releaseTakeover', serverId, botId, input),
  fleetUiOpen: (serverId: FleetServerId, botId: string, input: FleetUiOpenRequest): Promise<void> =>
    ipcRenderer.invoke('fleet:uiOpen', serverId, botId, input),
  fleetConversationCall: <Op extends keyof FleetConversationOps>(
    serverId: FleetServerId,
    botId: string,
    op: Op,
    ...args: Parameters<FleetConversationOps[Op]>
  ): Promise<ReturnType<FleetConversationOps[Op]>> =>
    ipcRenderer.invoke('fleet:conversationCall', serverId, botId, op, args),
  fleetListRoutines: (serverId: FleetServerId, botId: string): Promise<{ routines: FleetRoutine[] }> =>
    ipcRenderer.invoke('fleet:listRoutines', serverId, botId),
  fleetCreateRoutine: (
    serverId: FleetServerId,
    botId: string,
    input: Omit<FleetCreateRoutineRequest, 'idempotencyKey'>
  ): Promise<FleetRoutine> => ipcRenderer.invoke('fleet:createRoutine', serverId, botId, input),
  fleetUpdateRoutine: (
    serverId: FleetServerId,
    botId: string,
    routineId: string,
    input: FleetPatchRoutineRequest
  ): Promise<FleetRoutine> => ipcRenderer.invoke('fleet:updateRoutine', serverId, botId, routineId, input),
  fleetDeleteRoutine: (serverId: FleetServerId, botId: string, routineId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:deleteRoutine', serverId, botId, routineId),
  fleetRunRoutine: (serverId: FleetServerId, botId: string, routineId: string): Promise<FleetRoutine> =>
    ipcRenderer.invoke('fleet:runRoutine', serverId, botId, routineId),
  fleetOwnerMemoryList: (serverId: FleetServerId, status: 'active' | 'all' = 'all'): Promise<FleetOwnerMemory> =>
    ipcRenderer.invoke('fleet:ownerMemoryList', serverId, status),
  fleetOwnerMemoryCreate: (
    serverId: FleetServerId,
    input: FleetOwnerMemoryCreateInput
  ): Promise<FleetOwnerMemoryEntry> => ipcRenderer.invoke('fleet:ownerMemoryCreate', serverId, input),
  fleetOwnerMemoryUpdate: (
    serverId: FleetServerId,
    entryId: string,
    patch: FleetOwnerMemoryPatchRequest
  ): Promise<FleetOwnerMemoryEntry> => ipcRenderer.invoke('fleet:ownerMemoryUpdate', serverId, entryId, patch),
  fleetOwnerMemoryDelete: (serverId: FleetServerId, entryId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:ownerMemoryDelete', serverId, entryId),
  fleetListRoutineRuns: (
    serverId: FleetServerId,
    botId: string,
    routineId: string
  ): Promise<{ runs: FleetRoutineRun[] }> => ipcRenderer.invoke('fleet:listRoutineRuns', serverId, botId, routineId),
  fleetListBotMemories: (
    serverId: FleetServerId,
    botId: string,
    status: 'active' | 'archived' | 'superseded' | 'all' = 'active'
  ): Promise<{ memories: FleetBotMemory[] }> => ipcRenderer.invoke('fleet:listBotMemories', serverId, botId, status),
  fleetPatchBotMemory: (
    serverId: FleetServerId,
    botId: string,
    memoryId: string,
    patch: FleetBotMemoryPatchRequest
  ): Promise<FleetBotMemory> => ipcRenderer.invoke('fleet:patchBotMemory', serverId, botId, memoryId, patch),
  fleetDeleteBotMemory: (serverId: FleetServerId, botId: string, memoryId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:deleteBotMemory', serverId, botId, memoryId),
  fleetGetInbox: (serverId: FleetServerId): Promise<{ items: FleetInboxItem[] }> =>
    ipcRenderer.invoke('fleet:getInbox', serverId),
  fleetGetPeerMessages: (serverId: FleetServerId, limit?: number): Promise<{ messages: FleetPeerMessage[] }> =>
    ipcRenderer.invoke('fleet:getPeerMessages', serverId, limit),
  /** A bot's browser or apps area, or an environment's screen; a bare bot id is its browser area. */
  fleetScreenOpen: (
    serverId: FleetServerId,
    target: FleetScreenTargetInput,
    mode: 'view' | 'control'
  ): Promise<{ channelId: string }> => ipcRenderer.invoke('fleet:screenOpen', serverId, target, mode),
  fleetScreenSend: (channelId: string, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('fleet:screenSend', channelId, data),
  fleetScreenClose: (channelId: string): Promise<void> => ipcRenderer.invoke('fleet:screenClose', channelId),
  fleetScreenClipboardRead: (channelId: string): Promise<string> =>
    ipcRenderer.invoke('fleet:screenClipboardRead', channelId),
  fleetScreenClipboardWrite: (channelId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('fleet:screenClipboardWrite', channelId, text),
  /** What this Mac gives a bot, and every Mac linked to it. */
  fleetDesktopAccess: (serverId: FleetServerId, botId: string): Promise<FleetDesktopAccessView> =>
    ipcRenderer.invoke('fleet:desktopAccess:get', serverId, botId),
  /** Gives a bot access to projects on this Mac, or changes it. */
  fleetDesktopAccessSave: (
    serverId: FleetServerId,
    botId: string,
    input: FleetDesktopAccessInput
  ): Promise<FleetDesktopAccessView> => ipcRenderer.invoke('fleet:desktopAccess:save', serverId, botId, input),
  /** Takes this Mac's access back; the bot's conversations stay here. */
  fleetDesktopAccessDisable: (serverId: FleetServerId, botId: string): Promise<FleetDesktopAccessView> =>
    ipcRenderer.invoke('fleet:desktopAccess:disable', serverId, botId),
  /** Removes another Mac's link; that Mac revokes its side when it hears of it. */
  fleetDesktopAccessRemoveOther: (
    serverId: FleetServerId,
    botId: string,
    desktopId: string
  ): Promise<FleetDesktopAccessView> =>
    ipcRenderer.invoke('fleet:desktopAccess:removeOther', serverId, botId, desktopId),
  onFleetDesktopAccess: (cb: (serverId: FleetServerId, botId: string) => void): (() => void) =>
    subscribe<{ serverId: FleetServerId; botId: string }>('fleet:desktop-access', (p) => cb(p.serverId, p.botId)),
  onFleetEvent: (cb: (serverId: FleetServerId, event: FleetGatewayEvent) => void): (() => void) =>
    subscribe<{ serverId: FleetServerId; event: FleetGatewayEvent }>('fleet:event', (p) => cb(p.serverId, p.event)),
  onFleetMediaProgress: (cb: (serverId: FleetServerId, progress: FleetMediaProgress) => void): (() => void) =>
    subscribe<{ serverId: FleetServerId; progress: FleetMediaProgress }>('fleet:mediaProgress', (p) =>
      cb(p.serverId, p.progress)
    ),
  onFleetConnection: (cb: (serverId: FleetServerId, view: FleetConnectionView) => void): (() => void) =>
    subscribe<{ serverId: FleetServerId; connection: FleetConnectionView }>('fleet:connection', (p) =>
      cb(p.serverId, p.connection)
    ),
  onFleetScreenData: (cb: (data: FleetScreenData) => void): (() => void) => subscribe('fleet:screen:data', cb),
  onFleetScreenState: (cb: (state: FleetScreenState) => void): (() => void) => subscribe('fleet:screen:state', cb),
  onFleetInstanceOpenAccounts: (cb: (target: 'accounts' | 'skills' | 'mcp') => void): (() => void) =>
    subscribe('fleet:instance:open-settings', cb),
  /** Hides a bot's settings window. Closing it would destroy the window and stop the bot's control server. */
  fleetInstanceHideWindow: (): Promise<void> => ipcRenderer.invoke('fleet:instance:hide'),
}
