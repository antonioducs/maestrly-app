import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import { app } from 'electron'
import {
  FLEET_BOT_SIDE_TURNS_MAX,
  FLEET_PEER_THREAD_LIMITS,
  FLEET_PROTOCOL_VERSION,
  FLEET_UNIFIED_DESKTOP_FEATURE,
  FLEET_BOT_MEMORY_LIMITS,
  FLEET_ROUTINE_RUN_LIMITS,
  type FleetBotMemory,
  type FleetBotMemoryPatchRequest,
  type FleetInputSource,
  FLEET_QUEUE_PREVIEW_MAX,
  summarizeText,
  fleetInstanceProfileSchema,
  type FleetInstanceProfile,
  type FleetInstanceStatus,
  type FleetInstanceInput,
  type FleetInteractionResolution,
  type FleetInstanceHold,
  type FleetInstanceReleaseRequest,
  type FleetSelectionOption,
  type FleetSelection,
  type FleetBotDelegation,
  FLEET_BOT_DELEGATION_DEFAULT,
  type FleetTranscriptItem,
  type FleetPendingInteraction,
  type FleetInputReceipt,
  type FleetUsage,
  type FleetConversationCallRequest,
  type FleetCompactionState,
  type FleetFileOrigin,
  type FleetFileRef,
  type FleetFileSettings,
  type FleetFilesDeleted,
  type FleetFilesList,
  type FleetFilesUsage,
  type FleetEditMessageRequest,
  type FleetAttachmentInput,
  type FleetInstanceRunDeleted,
  type FleetRoutineRunMedia,
  type FleetTranscriptPage,
  fleetAttachmentInputSchema,
} from '@maestrly/bot-fleet-protocol'
import type { LocalMemory } from '../../../shared/memory'
import type { BackgroundCompactionConfig } from '../../../shared/background-compaction'
import { validateSubagentProfileEffort, validateSubagentProfileFastMode } from '../../../shared/subagent-profile-effort'
import { botMemorySpaceId, registerConversationMemorySpace, clearConversationMemorySpace } from '../../memory/spaces'
import { setMemoryCoreExtras, clearMemoryCoreExtras } from '../../memory/core'
import { setOwnerMemoryWriter, clearOwnerMemoryWriter } from '../../memory/extraction/owner-writer'
import { cancelMemoryExtraction } from '../../memory/extraction/scheduler'
import {
  listLocalMemories,
  getLocalMemory,
  updateLocalMemory,
  forgetLocalMemory,
} from '../../memory/local-memory-service'
import { OwnerMemoryClient } from './owner-memory'
import {
  estimatedCostOfUsage,
  usageMetaForModel,
  type ChatAttachmentInput,
  type ChatStreamEvent,
} from '../../../shared/chat'
import { sameContextModel, selectContextObservation } from '../../../shared/context-observation'
import { permissionExtraResources } from '../../../shared/permission-preview'
import type { PermissionRequest } from '../../chat/permission'
import { getAppSetting, getConversation, getConvUiPrefs, patchConvUiPrefs } from '../../store'
import { getHiddenChatModelsFor } from '../../store/settings'
import {
  createStandaloneConversation,
  createStandaloneConversationInFolderOf,
} from '../../standalone-conversation-service'
import { createConversationFileScope } from '../../conversation-file-scope'
import {
  acquireChatConversationSlot,
  getChatPermissionBroker,
  getChatQuestionBroker,
  listChatRunnerCapabilities,
  primeChatTurnSelection,
  publishConvChatSettings,
  startExecutorChatTurn,
  stopChatAndWait,
  effectiveModelMeta,
  fleetChatConfig,
  fleetChatGetConvTools,
  fleetChatSetConvTools,
  fleetChatCommands,
  backgroundCompactionStatus,
  setConversationCompactionOverride,
  suspendConversationBackgroundCompaction,
  resumeConversationBackgroundCompaction,
  retryBackgroundCompaction,
  startManualCompaction,
  truncateConversationForResend,
  type ChatConversationSlot,
} from '../../chat/service'
import {
  clearCompactionSummarizer,
  setCompactionFocus,
  setCompactionSummarizer,
} from '../../chat/compaction-summarizer'
import {
  getConversationContextLimit,
  limitConversationContextWindow,
  setConversationContextLimit,
} from '../../chat/conversation-context-limit'
import {
  chatHistoryStats,
  getChatMessage,
  getChatMessagesWithSeq,
  latestMeasuredContextSnapshot,
  listChatMessagesAfter,
  listChatMessagesPage,
} from '../../chat/chat-store'
import { listProviders } from '../../chat/catalog'
import { hasApiKey } from '../../chat/credentials'
import { observeChatHost } from '../../chat/host-events'
import { presentationForTool, presentsOnCompletion, type PresentationRequest } from './desktop/presentation'
import { setConversationShellEnv, type ConversationShellEnv } from '../../chat/conversation-env'
import { setConversationScreen, type ScreenArea } from '../../conversation-screen'
import { INSTANCE_CAPABILITIES, InstanceHttpError, type InstanceEvents, type InstanceFile } from './server'
import {
  InstanceInputQueue,
  conversationQueue,
  inputRunId,
  promptForInput,
  threadCompactionFocus,
  type QueuedInput,
} from './queue'
import { START_RETRY_MIN_MS, repeatsReportedFailure, startRetry, type ReportedStartFailure } from './turn-retry'
import { InstanceHoldManager, registerInstanceHoldGate } from './gate'
import { InstanceTranscriptExtras, fleetQuestions, toolTarget, permissionTool } from './transcript'
import { LiveTranscript } from './live-transcript'
import { InstanceHelpStore } from './help'
import { BotRunConversations, isRunId, type RunLane, type ThreadRecord } from './routine-runs'
import { ThreadReports } from './thread-reports'
import { ThreadWaits, type ThreadWaitResult } from './thread-waits'
import type { MemoryCoreExtraSection } from '../../memory/core'
import type { BotDisplay } from './displays'
import type { LaneComputers } from './lane-computers'
import { keepRunFiles, runMedia } from './run-files'
import { clearBotIdentity, setBotIdentity, type BotIdentityPeer } from './identity'
import type { GatewayConfig } from './gateway-client'
import { FleetImageStore } from './images'
import { FleetFileSettingsError, FleetFileStore } from './files'
import { findFileOrigins } from './file-origins'
import { readConversationFile } from './attachment-files'
import { validateAttachmentBytes } from './incoming-attachments'
import { botToolsPatchRefusal, validateFleetConversationArgs, projectFleetChatConfig } from './conversation'
import {
  botPaths,
  readBotPaused,
  readGatewayToken,
  readStoredProfile,
  writeBotPaused,
  writeGatewayToken,
  writeStoredProfile,
  type StoredProfile,
} from './registry'
import { inspectSubagentProfile } from '../../chat/subagent-profile-ipc'
import { fleetRuntimeReport } from './runtimes'
import {
  getConversationSubagentProfileRules,
  setConversationSubagentProfilesEnabled,
  setConversationSubagentsEnabled,
} from '../../chat/subagent-profile-config'
import {
  listSkillsState,
  setConversationSkillOverride,
  resetConversationSkillOverrides,
  setConversationSkillSelection,
} from '../../chat/skill-state'
import { setSubagentConcurrency } from '../../chat/subagent-concurrency'
import { setSubagentRouter, type SubagentRouter } from '../../chat/subagent-route'
import { getSubscriptionFailoverRouter } from '../../chat/subscription-failover/router'
import { parallelTasksPolicy, setBotTaskPolicy } from './task-policy'
import { accountHeadroom, warmAccountHeadroom } from './account-headroom'
import { createDelegationRouter, delegationPolicyPrompt } from './delegation'

/** Whether the bot may start turns at all; each conversation then starts its own while it runs none. */
export function canDispatch(
  ready: boolean,
  connected: boolean,
  hold: FleetInstanceHold['state'],
  compactionReady = true
): boolean {
  return ready && connected && compactionReady && hold === 'none'
}

/** A turn running in one of the bot's conversations: its own (`key` null) or a side conversation's lane. */
interface ActiveTurn {
  key: string | null
  inputId: string
  startedAt: string
  abort: AbortController
  /** The side conversation's lane, once loaded; null for the bot's own. */
  lane: RunLane | null
  cancelling: boolean
  /** The tool it uses now. */
  tool: { tool: string; target: string | null } | null
  /** Its conversation's context is being compacted, before the turn's message is saved or during the turn. */
  compacting: boolean
  /** Resolves once the turn ended. */
  settled: Promise<void>
  settle: () => void
}

function continuationText(reason: 'takeover' | 'paused', durationMs: number | null, note: string | null): string {
  if (reason === 'paused') return 'The owner resumed you. Continue the task where you stopped.'
  const seconds = Math.floor((durationMs ?? 0) / 1000)
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return `The owner used your screen for ${duration} and handed it back.${note ? ` Their note: "${note}".` : ''} The screen may have changed: take a fresh screenshot before acting, then continue the task.`
}
export { continuationText }
/**
 * What a thread's first answer tells the bot that opened it from another conversation: what it had sent, why, and,
 * for one opened from its owner's conversation, how its answer gets back there.
 */
export function openingContext(record: Pick<ThreadRecord, 'opening' | 'origin'>): string {
  const sent = record.opening?.sent ?? ''
  const ask = record.opening?.ask
  const parts = [`You opened this conversation from another one by sending: "${sent}".`]
  if (ask) parts.push(`Your owner had asked there: "${ask}".`)
  if (record.origin === 'primary')
    parts.push(
      'Your owner asked for this in your main conversation. When you have what they need, call bot_peers_report with a short answer: it shows there.'
    )
  return parts.join(' ').slice(0, FLEET_PEER_THREAD_LIMITS.contextMax)
}
export function releaseSystemCode(reason: 'takeover' | 'paused' | null): 'takeover' | 'resumed' {
  return reason === 'takeover' ? 'takeover' : 'resumed'
}
export function visibleFleetModels<T extends { providerId: string; modelId: string }>(
  models: T[],
  hiddenFor: (providerId: string) => string[]
): T[] {
  return models.filter((model) => !hiddenFor(model.providerId).includes(model.modelId))
}
export function effectiveFleetSelection(
  options: FleetSelectionOption[],
  saved: FleetSelection | null,
  defaults: { providerId: string | null; modelId: string | null; reasoning: string | null; fastMode: boolean },
  visibleOptions: FleetSelectionOption[] = options
): FleetSelection | null {
  const option = saved && options.find((item) => item.providerId === saved.providerId && item.modelId === saved.modelId)
  if (option)
    return {
      ...saved,
      reasoning: option.efforts.includes(saved!.reasoning ?? '') ? saved!.reasoning : null,
      fastMode: option.fastMode && saved!.fastMode,
    }
  const fallback =
    visibleOptions.find((item) => item.providerId === defaults.providerId && item.modelId === defaults.modelId) ??
    visibleOptions[0]
  if (!fallback) return null
  return {
    providerId: fallback.providerId,
    modelId: fallback.modelId,
    reasoning: fallback.efforts.includes(defaults.reasoning ?? '') ? defaults.reasoning : null,
    fastMode: fallback.fastMode && defaults.fastMode,
  }
}

/** The models the environment's accounts offer, as bots choose them; the accounts are shared by every bot. */
export async function loadFleetAccountOptions(includeHidden = false): Promise<FleetSelectionOption[]> {
  const models = await listChatRunnerCapabilities(true)
  return (includeHidden ? models : visibleFleetModels(models, getHiddenChatModelsFor)).map((model) => ({
    id: `${model.providerId}::${model.modelId}`,
    providerId: model.providerId,
    providerLabel: model.providerLabel,
    modelId: model.modelId,
    modelLabel: model.modelId,
    efforts: model.reasoningEfforts,
    fastMode: model.fastMode,
  }))
}

function assistantText(conversationId: string, messageId: string | null): string | null {
  if (!messageId) return null
  const message = getChatMessage(conversationId, messageId)
  if (message?.role !== 'assistant') return null
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .slice(0, FLEET_ROUTINE_RUN_LIMITS.finalTextMax)
}

/**
 * An attachment an edited message keeps, as the queue takes it again: null when its bytes are gone or no longer valid,
 * as an edit in a local chat drops the ones it cannot read.
 */
export function queuedAttachment(attachment: ChatAttachmentInput): FleetAttachmentInput | null {
  const bytes = attachment.bytes
    ? Buffer.from(attachment.bytes)
    : attachment.kind === 'text' && attachment.data !== undefined
      ? Buffer.from(attachment.data, 'utf8')
      : null
  if (!bytes) return null
  const parsed = fleetAttachmentInputSchema.safeParse({
    kind: attachment.kind,
    name: attachment.name,
    mediaType: attachment.mediaType,
    dataBase64: bytes.toString('base64'),
  })
  if (!parsed.success) return null
  try {
    validateAttachmentBytes(parsed.data, bytes)
  } catch {
    return null
  }
  return parsed.data
}

function toFleetBotMemory(memory: LocalMemory): FleetBotMemory {
  return {
    id: memory.id,
    title: memory.title,
    content: memory.content.slice(0, FLEET_BOT_MEMORY_LIMITS.contentMax),
    truncated: memory.content.length > FLEET_BOT_MEMORY_LIMITS.contentMax,
    type: memory.type,
    status: memory.status,
    pinned: memory.pinned,
    source: memory.source,
    useCount: memory.useCount,
    createdAt: new Date(memory.createdAt).toISOString(),
    updatedAt: new Date(memory.updatedAt).toISOString(),
  }
}

const COMPACTION_DISABLED: BackgroundCompactionConfig = { enabled: false, intervalTokens: 100_000, selection: null }

/** A bot's two screens: its apps display and the area of the environment display that holds its browser. */
export interface BotScreen {
  display: string
  width: number
  height: number
  browserArea: ScreenArea
  /** Variables of the bot's shells and programs (display, session bus, browser). */
  env: ConversationShellEnv
}

/** What a bot uses of its environment. */
export interface BotRuntimeHost {
  /** Maestrly's data folder. */
  readonly userData: string
  /** The environment's home folder. */
  readonly home: string
  /** The environment's event stream; each bot event carries its bot id. */
  readonly events: InstanceEvents
  readonly gatewayUrl: string | null
  /** Complete catalog, including user-hidden models; `force` asks for a fresh list. */
  accountOptions(force: boolean): Promise<FleetSelectionOption[]>
  /** The other bots of the environment. */
  peers(botId: string): BotIdentityPeer[]
  /** What the environment offers, which each status advertises; the instance's own list without one. */
  capabilities?(): string[]
  /** Shows the bot's browser in its area of the environment display. */
  floatBrowser(conversationId: string): void
  /** Brings the app a tool of the bot uses forward on its desktop, when the environment gives bots one. */
  present?(conversationId: string, request: PresentationRequest): void
  /** Closes the bot's own Chromium, where it has one, keeping its tabs to reopen. */
  stopBrowser?(botId: string): void
  /** Whether the bot drives a Chromium of its own, with its own site logins, rather than the environment's browser. */
  hasOwnBrowser?(botId: string): boolean
  /** Stops a conversation's turn and closes its windows, terminals and browser views: a routine run's, once it ends. */
  closeConversation?(conversationId: string): Promise<void>
  /** Deletes a conversation with its messages and files: a routine run's, when the owner or retention deletes it. */
  purgeConversation?(conversationId: string): Promise<void>
  /** The desktops of the bots' side conversations, when the environment gives bots displays. */
  laneComputers?: Pick<LaneComputers, 'open' | 'close' | 'computer'> | null
}

/**
 * The shell environment of a side conversation without a desktop of its own: the bot's browser and theme, and no
 * display, session bus or desktop socket. They are set empty rather than left out, so its programs never fall back to
 * the environment display the process runs on, nor open on the desktop of the bot's own conversation.
 */
export function laneShellEnv(env: ConversationShellEnv): ConversationShellEnv {
  return {
    DISPLAY: '',
    DBUS_SESSION_BUS_ADDRESS: '',
    MAESTRLY_DESKTOP_SOCKET: '',
    ...(env.BROWSER ? { BROWSER: env.BROWSER } : {}),
    ...(env.MAESTRLY_BOT_BROWSER_PROFILE ? { MAESTRLY_BOT_BROWSER_PROFILE: env.MAESTRLY_BOT_BROWSER_PROFILE } : {}),
    ...(env.GTK_THEME ? { GTK_THEME: env.GTK_THEME } : {}),
  }
}

type EventPayload = Parameters<InstanceEvents['publish']>[0]

/**
 * One bot of an environment: its profile, conversation, queue, transcript, images, memory space, hold, help requests,
 * gateway token, compaction and screens. Everything the bot's conversation runs resolves this runtime by conversation
 * id; nothing of a bot is kept in a process-wide singleton.
 */
export class BotRuntime {
  readonly ownerMemory: OwnerMemoryClient
  readonly events: InstanceEvents
  readonly queue: InstanceInputQueue
  readonly extras: InstanceTranscriptExtras
  readonly help: InstanceHelpStore
  readonly holdManager: InstanceHoldManager
  readonly images: FleetImageStore
  readonly files: FleetFileStore
  readonly live: LiveTranscript
  /** The side conversations: routine runs' (`routine-conversations`) and threads' with other bots (`peer-conversations`). */
  readonly runs: BotRunConversations
  /** The answers the bot brought back to its own conversation from threads it opened there. */
  readonly threadReports: ThreadReports
  /** Its conversations waiting, within their turn, for a thread's answer (`bot_peers_wait`). */
  readonly threadWaits = new ThreadWaits()
  /** Names of the peers this bot listed, for the replies of its peer tools. */
  readonly peerNames = new Map<string, string>()
  private stored: StoredProfile | null
  private delegationRouterCache: SubagentRouter | undefined
  private gatewayToken: string | null
  private screen: BotScreen | null = null
  private accountOptions: FleetSelectionOption[] = []
  private accountCheckedAt = 0
  /** Whether the environment's accounts were read once: until then, a compaction model cannot be checked. */
  private accountsLoaded = false
  private ready = false
  /** The turns running now, one per conversation: the bot's own (`null`) and its side conversations' (by run id). */
  private readonly turns = new Map<string | null, ActiveTurn>()
  /** The conversations whose turns a hold interrupted (null for the bot's own): each continues where it stopped. */
  private interrupted = new Set<string | null>()
  /** The idempotency key of each conversation's continuation, kept while a release is retried. */
  private readonly releaseKeys = new Map<string | null, string>()
  /** Per conversation, the turns that could not start in a row and when the next one may. */
  private readonly retries = new Map<string | null, { at: number; failures: number }>()
  /** A usage limit of the bot's accounts: no conversation starts a turn before it. */
  private quotaRetryAt = 0
  /** The usage limit last reported to the owner, for every conversation: they share the accounts. */
  private reportedStartFailure: string | null = null
  /** Per conversation, any other start failure last reported there: each conversation tells why it waits. */
  private readonly reportedStartFailures = new Map<string | null, ReportedStartFailure>()
  private lastSummary: string | null = null
  private lastTurnAt: string | null = null
  private floatAttempted = false
  private stopObserving: (() => void) | null = null
  private stopGate: (() => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private statusTimer: NodeJS.Timeout | null = null
  private transcriptTimer: NodeJS.Timeout | null = null
  private floatTimers = new Set<NodeJS.Timeout>()
  /** Tool calls whose app comes forward once they finish, such as a terminal just created. */
  private readonly presentOnCompletion = new Map<string, { conversationId: string; request: PresentationRequest }>()
  private permissionAt = new Map<string, string>()
  private questionAt = new Map<string, string>()
  /** The transcript item id of each question asked, by tool call. */
  private questionItems = new Map<string, string>()
  /** The tool of each pending permission request, once its call was found: it never changes. */
  private permissionTools = new Map<string, ReturnType<typeof permissionTool>>()
  private usage: FleetUsage | null = null
  private usageTask: Promise<void> = Promise.resolve()
  private compactionProblem: FleetCompactionState['problem'] = 'missing'
  private compactionChecked: { key: string; valid: boolean } | null = null
  private compactionApplied: string | null = null
  /** The compaction settings applied to the bot's conversation, which its runs' conversations take too. */
  private compactionDesired: BackgroundCompactionConfig | null = null
  /** Set by an install: the conversation resumes (an uninstall suspended it) once the bot's own settings apply. */
  private resumePending = false
  private manualCompacting = false
  /** An edit of the owner's last message is cutting the conversation: no turn starts until it is done. */
  private editing = false
  private disposed = false
  /** The conversation whose hooks (memory, identity, gate, screen) this runtime registered. */
  private registeredConversation: { id: string; cwd: string | null } | null = null

  constructor(
    readonly botId: string,
    public slot: number,
    private readonly host: BotRuntimeHost
  ) {
    const paths = botPaths(host.userData, host.home, botId)
    this.events = host.events
    this.stored = readStoredProfile(botId)
    this.gatewayToken = readGatewayToken(botId)
    this.ownerMemory = new OwnerMemoryClient(() => this.gatewayConfig)
    this.queue = new InstanceInputQueue(paths.inputs, paths.attachments)
    this.images = new FleetImageStore(paths.images)
    this.files = new FleetFileStore(path.join(paths.folder, 'files'))
    this.extras = new InstanceTranscriptExtras(paths.transcript, (item) =>
      this.publish({ type: 'transcript.upsert', item })
    )
    this.help = new InstanceHelpStore(this.extras, () => this.changed())
    this.live = new LiveTranscript({
      conversationId: () => this.primaryConversationId,
      queue: conversationQueue(this.queue, null),
      extras: this.extras,
      images: this.images,
      publish: (item) => this.publish({ type: 'transcript.upsert', item }),
      turnInputId: () => this.turns.get(null)?.inputId ?? null,
    })
    this.runs = new BotRunConversations({
      file: paths.runs,
      threadsFile: paths.threads,
      folder: paths.runsFolder,
      queue: this.queue,
      images: this.images,
      publish: (runId, item) => this.publish({ type: 'transcript.upsert', item, runId }),
      turnInputId: (runId) => this.turns.get(runId)?.inputId ?? null,
      changed: () => this.changed(),
    })
    this.threadReports = new ThreadReports(paths.threadReports)
    this.holdManager = new InstanceHoldManager(
      () => {
        if (this.disposed) return
        if (this.holdManager.state.reason === 'paused' || this.holdManager.releaseKeepsPaused)
          writeBotPaused(this.botId, true)
        else if (this.holdManager.state.state === 'none') writeBotPaused(this.botId, false)
        this.changed()
      },
      () => this.screenConversationIds()
    )
  }
  /** The conversations whose screen actions a hold stops: the one the bot's desktop shows, and every one working. */
  private screenConversationIds(): string[] {
    const ids = new Set<string>()
    const foreground = this.foregroundConversationId
    if (foreground) ids.add(foreground)
    for (const turn of this.turns.values()) {
      const id = this.conversationOfTurn(turn)
      if (id) ids.add(id)
    }
    return [...ids]
  }
  get primaryConversationId(): string | null {
    return this.stored?.primaryConversationId ?? null
  }
  /**
   * The conversation the bot's desktop shows: its own, unless a side conversation asks the owner for help (a login, a
   * code, a captcha in its browser) while its own does not. Side conversations otherwise work out of sight: their
   * browser through its tools, their programs on a desktop of their own.
   */
  get foregroundConversationId(): string | null {
    const primary = this.primaryConversationId
    if (this.help.pending().length > 0) return primary
    return this.runs.loadedLanes().find((lane) => lane.help.pending().length > 0)?.conversationId ?? primary
  }
  /** The conversation a turn works in: a side conversation's, or the bot's own. */
  private conversationOfTurn(turn: ActiveTurn): string | null {
    if (turn.key === null) return this.primaryConversationId
    return turn.lane?.conversationId ?? this.runs.get(turn.key)?.conversationId ?? null
  }
  /** The conversation's key among the turns: null for the bot's own, its run id for a side conversation. */
  private turnKeyOf(conversationId: string): string | null | undefined {
    if (conversationId === this.primaryConversationId) return null
    return this.runs.byConversation(conversationId)?.runId
  }
  /** Whether a conversation is this bot's: its own, or one of its routine runs'. */
  ownsConversation(conversationId: string | undefined): boolean {
    if (!conversationId) return false
    return conversationId === this.primaryConversationId || !!this.runs.byConversation(conversationId)
  }
  /** Whether the gateway runs this bot's routines in conversations of their own. */
  get routineConversations(): boolean {
    return this.stored?.profile.gateway.routineConversations === true
  }
  get name(): string | null {
    return this.stored?.profile.name ?? null
  }
  /** The bot's color for its desktop (`#rrggbb`), or null when the gateway sent none. */
  get tint(): string | null {
    return this.stored?.profile.tint ?? null
  }
  /** Read-only usage for the environment editor; no conversation or credentials cross this boundary. */
  settingsUsage() {
    return {
      id: this.botId,
      name: this.name ?? this.botId,
      selection: this.currentSelection(),
      compaction: this.stored?.profile.compaction ?? null,
    }
  }
  get artifactsEnabled(): boolean {
    return this.stored?.profile.gateway.artifactsEnabled ?? false
  }
  /** Whether the gateway routes this bot's calls to the Macs that link it; an older gateway never does. */
  get desktopBridgeEnabled(): boolean {
    return this.stored?.profile.gateway.desktopBridgeEnabled ?? false
  }
  /** Whether the environment has a gateway: its tools are offered even before the bot's token arrives. */
  get gatewayConfigured(): boolean {
    return !!this.host.gatewayUrl
  }
  /**
   * The bot's own gateway access, or null until the gateway installs the bot with its token. Null as well from the
   * moment the runtime is disposed, so a writer or client still held elsewhere reaches nothing.
   */
  get gatewayConfig(): GatewayConfig | null {
    return !this.disposed && this.host.gatewayUrl && this.gatewayToken
      ? { url: this.host.gatewayUrl, token: this.gatewayToken }
      : null
  }
  setGatewayToken(token: string): void {
    if (token === this.gatewayToken) return
    writeGatewayToken(this.botId, token)
    this.gatewayToken = token
    const id = this.primaryConversationId
    if (id && !this.disposed) setOwnerMemoryWriter(id, this.ownerMemory.writer())
    if (!this.disposed)
      for (const lane of this.runs.loadedLanes())
        if (lane.unregister) setOwnerMemoryWriter(lane.conversationId, this.ownerMemory.writer())
  }
  /**
   * The input the turn running in a conversation answers: who sent it, and for a turn in a routine run's conversation,
   * that run (an owner's message there too, so the run's report can be updated).
   */
  currentInput(conversationId: string): {
    source: FleetInputSource
    text: string
    routine?: { id: string; title: string; runId?: string }
    run?: { id: string }
    thread?: { id: string }
  } | null {
    const key = this.turnKeyOf(conversationId)
    const inputId = key === undefined ? undefined : this.turns.get(key)?.inputId
    const item = inputId ? this.queue.all().find((item) => item.id === inputId) : undefined
    if (!item) return null
    const routine = item.input.routine
    const record = item.input.run ? this.runs.routine(item.input.run.id) : undefined
    return {
      source: item.input.source,
      text: item.input.text,
      ...(item.input.thread ? { thread: { id: item.input.thread.id } } : {}),
      ...(routine
        ? { routine: { id: routine.id, title: routine.title, ...(routine.runId ? { runId: routine.runId } : {}) } }
        : record
          ? { routine: { id: record.routineId, title: record.routineTitle, runId: record.runId } }
          : {}),
      ...(item.input.run ? { run: { id: item.input.run.id } } : {}),
    }
  }
  private get memorySpaceId(): string {
    return botMemorySpaceId(this.botId)
  }

  async memories(
    status: 'active' | 'archived' | 'superseded' | 'all' = 'active'
  ): Promise<{ memories: FleetBotMemory[] }> {
    const list = listLocalMemories(this.memorySpaceId, {
      ...(status === 'all' ? {} : { status }),
      limit: FLEET_BOT_MEMORY_LIMITS.listMax,
    })
    return { memories: list.map(toFleetBotMemory) }
  }
  async patchMemory(id: string, patch: FleetBotMemoryPatchRequest): Promise<FleetBotMemory> {
    if (!getLocalMemory(this.memorySpaceId, id)) throw new InstanceHttpError(404, 'NOT_FOUND', 'Memory not found.')
    return toFleetBotMemory(
      updateLocalMemory(this.memorySpaceId, id, {
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        ...(patch.status ? { status: patch.status } : {}),
      }).memory
    )
  }
  async deleteMemory(id: string): Promise<void> {
    if (!forgetLocalMemory(this.memorySpaceId, id)) throw new InstanceHttpError(404, 'NOT_FOUND', 'Memory not found.')
  }
  async start(): Promise<void> {
    await this.queue.load()
    await this.runs.load()
    await this.images.load()
    await this.files.load()
    if (this.files.needsOrigins) {
      const conversations = [
        ...(this.primaryConversationId
          ? [{ conversationId: this.primaryConversationId, origin: { kind: 'primary' } as const }]
          : []),
        ...this.runs
          .list()
          .map((lane) => ({ conversationId: lane.conversationId, origin: this.fileOrigin(lane.conversationId) })),
      ]
      await this.files
        .assignOrigins(findFileOrigins(conversations))
        .catch((error) => console.warn('[fleet] could not find where shared files came from', error))
    }
    await this.extras.load()
    for (const item of this.extras.list()) {
      if (item.kind === 'permission' && item.state === 'pending')
        await this.extras.upsert({ ...item, state: 'expired', resolvedAt: new Date().toISOString() })
      if (item.kind === 'question' && item.state === 'pending')
        await this.extras.upsert({ ...item, state: 'dismissed', answers: null })
    }
    const hadConversation = !!this.stored?.primaryConversationId
    if (readBotPaused(this.botId)) await this.holdManager.hold('paused', false, async () => {})
    // Read before the conversation takes its compaction settings: a bot whose compaction model is valid gets them at
    // once and never passes through "off", which would discard the compaction it prepared before a restart.
    await this.loadAccounts(false)
    if (this.stored) await this.ensureConversation()
    this.live.anchor()
    if (this.primaryConversationId) await this.reconcileQueue()
    await this.queue.sweepAttachments()
    if (hadConversation) await this.system('restarted', null, null)
    // Persisted membership may be stale: the gateway can archive or pause this bot while the environment is stopped.
    // Loading its data does not authorize queued work; a fresh profile installation below does.
    void this.refreshUsage()
    this.pollTimer = setInterval(() => {
      void this.tick()
    }, 1_000)
    this.changed()
    void this.tick()
  }
  /**
   * Stops the bot's timers and removes everything it registered for its conversation (memory space, owner memory,
   * summarizer, identity, hold gate, screen and shell environment). Persisted data stays. Callbacks still in flight
   * find the runtime disposed and do nothing. With `uninstall`, the conversation's background work stops as well: its
   * compaction is turned off and suspended (never handed to the global settings) until the bot is installed again,
   * and its memory extraction is cancelled. Both are awaited briefly, and whatever they return later is discarded, so
   * nothing is written after a purge. Otherwise the override just ends with the process, so a prepared compaction
   * survives a restart.
   */
  async dispose(options: { uninstall?: boolean } = {}): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.statusTimer) clearTimeout(this.statusTimer)
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer)
    for (const timer of this.floatTimers) clearTimeout(timer)
    this.floatTimers.clear()
    this.pollTimer = this.statusTimer = this.transcriptTimer = null
    const running = [...this.turns.values()]
    for (const turn of running) turn.abort.abort()
    this.threadWaits.cancelAll()
    // Stopped before the hooks go, so no gap lets its work fall back to the environment's settings.
    const background = options.uninstall ? this.stopBackgroundWork() : Promise.resolve()
    this.unregisterConversation(options.uninstall === true)
    // The side conversations' desktops go with the bot.
    const desktops = Promise.all(
      this.runs.list().map((record) => this.host.laneComputers?.close(record.conversationId))
    ).catch(() => undefined)
    this.runs.unloadAll()
    // Owner memory goes through the bot's token; an uninstalled bot keeps none, even for a caller holding its writer.
    if (options.uninstall) this.gatewayToken = null
    await Promise.all(running.map((turn) => turn.settled)).catch(() => undefined)
    await Promise.all([
      this.queue.idle(),
      this.extras.idle(),
      this.runs.idle(),
      this.images.idle(),
      this.usageTask,
      background,
      desktops,
    ]).catch(() => undefined)
  }
  /** Suspends the compaction of the bot's conversation and cancels its memory extraction, waiting briefly for both. */
  private async stopBackgroundWork(): Promise<void> {
    const primary = this.registeredConversation?.id ?? this.primaryConversationId
    // Its runs' conversations too: one that ran a turn may still be compacting or extracting memories.
    const ids = [...(primary ? [primary] : []), ...this.runs.list().map((record) => record.conversationId)]
    await Promise.all(
      ids.flatMap((id) => [
        suspendConversationBackgroundCompaction(id).catch(() => {
          console.error(
            JSON.stringify({ component: 'bot-instance', level: 'error', message: 'Compaction suspension failed' })
          )
        }),
        cancelMemoryExtraction(id),
      ])
    )
  }
  private unregisterConversation(releaseCompaction: boolean): void {
    this.stopObserving?.()
    this.stopGate?.()
    this.stopObserving = this.stopGate = null
    const registered = this.registeredConversation
    if (!registered) return
    this.registeredConversation = null
    const id = registered.id
    clearCompactionSummarizer(id)
    this.clearTasks(id)
    setConversationContextLimit(id, null)
    clearConversationMemorySpace(id)
    clearMemoryCoreExtras(id)
    clearOwnerMemoryWriter(id)
    setConversationScreen(id, null)
    setConversationShellEnv(id, null)
    if (registered.cwd) clearBotIdentity(registered.cwd, this.botId)
    if (releaseCompaction) {
      this.compactionApplied = null
      try {
        // Off, never back to the global settings: those belong to the environment screen, not to this bot.
        setConversationCompactionOverride(id, COMPACTION_DISABLED)
      } catch {
        // The chat service may be shutting down; the suspension still keeps the conversation idle.
      }
    }
  }
  /** Gives the bot its screens (or none outside a container); applied to its conversation now or once it exists. */
  attachScreen(screen: BotScreen | null): void {
    this.screen = screen
    const id = this.primaryConversationId
    if (id && !this.disposed) this.applyScreen(id)
    if (!this.disposed)
      for (const lane of this.runs.loadedLanes()) if (lane.unregister) this.applyLaneScreen(lane.conversationId)
  }
  /**
   * What a side conversation's tools and shells use of the screens. Its browser shows in the bot's area when it comes
   * forward; its programs open on its own desktop while one runs, and on none otherwise.
   */
  private applyLaneScreen(id: string): void {
    if (!this.screen) {
      setConversationScreen(id, null)
      setConversationShellEnv(id, null)
      return
    }
    const own = this.host.laneComputers?.computer(id) ?? null
    const { display, width, height, browserArea, env } = this.screen
    setConversationScreen(
      id,
      own
        ? { display: own.display, width: own.width, height: own.height, windowArea: browserArea }
        : { display, width, height, windowArea: browserArea }
    )
    setConversationShellEnv(id, own ? own.env : laneShellEnv(env))
  }
  /**
   * The desktop of one of the bot's side conversations, started on its first use; null where the environment gives
   * bots no displays, so its tools use the screen they always had.
   */
  async laneComputer(conversationId: string): Promise<{ display: BotDisplay; started: boolean } | null> {
    const computers = this.host.laneComputers
    if (!computers || !this.screen || this.disposed) return null
    if (conversationId === this.primaryConversationId || !this.runs.byConversation(conversationId))
      throw new Error('Only a side conversation of the bot has a desktop of its own.')
    return computers.open(conversationId, {
      botArea: this.screen.browserArea,
      // Given back: the conversation's tools and shells use what a side conversation without a desktop has.
      restore: () => {
        const record = this.runs.byConversation(conversationId)
        if (!this.disposed && record && this.runs.loaded(record.runId)?.unregister) this.applyLaneScreen(conversationId)
        else {
          setConversationScreen(conversationId, null)
          setConversationShellEnv(conversationId, null)
        }
      },
    })
  }
  private applyScreen(id: string): void {
    if (!this.screen) {
      setConversationScreen(id, null)
      setConversationShellEnv(id, null)
      return
    }
    const { display, width, height, browserArea, env } = this.screen
    setConversationScreen(id, { display, width, height, windowArea: browserArea })
    setConversationShellEnv(id, env)
  }
  private schedule(action: () => void, delayMs: number): void {
    if (this.disposed) return
    const timer = setTimeout(() => {
      this.floatTimers.delete(timer)
      if (!this.disposed) action()
    }, delayMs)
    this.floatTimers.add(timer)
  }
  private async ensureConversation(): Promise<void> {
    if (!this.stored || this.disposed) return
    if (this.stored.primaryConversationId && !getConversation(this.stored.primaryConversationId))
      throw new Error('Persisted primary bot conversation is missing.')
    if (!this.stored.primaryConversationId) {
      const created = await createStandaloneConversation({ name: this.stored.profile.name })
      this.stored.primaryConversationId = created.id
      writeStoredProfile(this.botId, this.stored)
      await this.system('created', null, null)
    }
    const id = this.stored.primaryConversationId
    this.registeredConversation = { id, cwd: getConversation(id)?.cwd ?? null }
    this.applyScreen(id)
    this.applyProfile()
    registerConversationMemorySpace(id, { id: this.memorySpaceId, kind: 'bot' })
    setMemoryCoreExtras(id, (signal) => this.primaryCoreSections(signal))
    if (this.gatewayConfig) setOwnerMemoryWriter(id, this.ownerMemory.writer())
    await this.syncCompaction()
    if (!this.floatAttempted) {
      this.floatAttempted = true
      this.schedule(() => {
        this.host.floatBrowser(id)
        // A bot's desktop starts with its browser window shown.
        this.host.present?.(id, { app: 'browser' })
      }, 2_000)
    }
    this.stopObserving?.()
    this.stopGate?.()
    this.stopObserving = observeChatHost(id, (event) => {
      if (event.channel === `chat:delta:${id}`) this.onChatEvent(event.payload as ChatStreamEvent)
    })
    this.stopGate = registerInstanceHoldGate(this.holdManager, id)
  }
  private delegationSettings(): FleetBotDelegation {
    return this.stored?.profile.delegation ?? FLEET_BOT_DELEGATION_DEFAULT
  }
  /** Routes the tasks of the bot's conversations that delegate to the models its owner allows. */
  private delegationRouter(): SubagentRouter {
    this.delegationRouterCache ??= createDelegationRouter({
      settings: () => this.delegationSettings(),
      options: () => visibleFleetModels(this.accountOptions, getHiddenChatModelsFor),
      headroom: (providerId) => accountHeadroom(providerId),
      admissible: (providerId) => getSubscriptionFailoverRouter().isAdmissible(providerId),
      warm: (providerIds) => warmAccountHeadroom(providerIds),
    })
    return this.delegationRouterCache
  }
  /** How a conversation of the bot runs tasks: in parallel up to its limit, and routed when it delegates. */
  private applyTasks(conversationId: string, delegates: boolean): void {
    setSubagentConcurrency(conversationId, { pool: this.botId, limit: this.delegationSettings().maxTasks })
    setSubagentRouter(conversationId, delegates ? this.delegationRouter() : null)
    setBotTaskPolicy(conversationId, () =>
      delegates
        ? delegationPolicyPrompt({
            settings: () => this.delegationSettings(),
            options: () => visibleFleetModels(this.accountOptions, getHiddenChatModelsFor),
          })
        : parallelTasksPolicy(this.delegationSettings().maxTasks)
    )
  }
  private clearTasks(conversationId: string): void {
    setSubagentConcurrency(conversationId, null)
    setSubagentRouter(conversationId, null)
    setBotTaskPolicy(conversationId, null)
  }
  private applyProfile(): void {
    if (!this.stored?.primaryConversationId || this.disposed) return
    const id = this.stored.primaryConversationId
    const previous = getConvUiPrefs(id).chat ?? {}
    patchConvUiPrefs(id, {
      chat: {
        ...previous,
        mode: 'agent',
        permMode: this.stored.profile.ceiling,
        tools: { ...previous.tools, app: true },
      },
    })
    publishConvChatSettings(id)
    this.applyTasks(id, this.delegationSettings().mode === 'delegate')
    // The owner's cap on the conversation's window, whatever its model; the usage the Mac shows follows it at once.
    const limit = this.stored.profile.compaction?.contextLimitTokens ?? null
    if ((getConversationContextLimit(id) ?? null) !== limit) {
      setConversationContextLimit(id, limit)
      void this.refreshUsage()
    }
    const conversation = getConversation(id)
    if (conversation) {
      if (this.registeredConversation?.id === id) this.registeredConversation.cwd = conversation.cwd
      setBotIdentity(conversation.cwd, this.stored.profile, () => this.host.peers(this.botId), {
        unifiedDesktop: () => this.host.capabilities?.().includes(FLEET_UNIFIED_DESKTOP_FEATURE) ?? false,
        ownBrowser: () => this.host.hasOwnBrowser?.(this.botId) ?? false,
      })
    }
    const selection = this.currentSelection()
    if (selection) {
      primeChatTurnSelection(id, {
        providerId: selection.providerId,
        modelId: selection.modelId,
        reasoning: selection.reasoning ?? undefined,
        fastMode: selection.fastMode,
      })
    }
  }
  /**
   * Registers what a run's conversation needs for its turns, as the bot's own has: the bot's memory, owner memory,
   * screens, compaction, hold, and its chat events. It stays registered while its lane is loaded.
   */
  private registerRun(lane: RunLane): void {
    if (lane.unregister || this.disposed) return
    const id = lane.conversationId
    this.applyLaneScreen(id)
    registerConversationMemorySpace(id, { id: this.memorySpaceId, kind: 'bot' })
    setMemoryCoreExtras(id, (signal) => this.ownerMemory.coreSections(signal))
    if (this.gatewayConfig) setOwnerMemoryWriter(id, this.ownerMemory.writer())
    setCompactionSummarizer(id, () => {
      const current = this.stored?.profile.compaction
      return this.compactionProblem === null && current
        ? {
            providerId: current.providerId,
            modelId: current.modelId,
            effort: current.reasoning ?? 'off',
            fastMode: current.fastMode,
          }
        : null
    })
    this.applyRunCompaction(id)
    const record = lane.record
    setCompactionFocus(
      id,
      record.kind === 'thread' ? threadCompactionFocus(this.stored?.profile.name ?? this.botId, record) : null
    )
    const stopObserving = observeChatHost(id, (event) => {
      if (event.channel === `chat:delta:${id}`) this.onChatEvent(event.payload as ChatStreamEvent, lane)
    })
    const stopGate = registerInstanceHoldGate(this.holdManager, id)
    lane.unregister = () => {
      stopObserving()
      stopGate()
      clearCompactionSummarizer(id)
      setCompactionFocus(id, null)
      this.clearTasks(id)
      setConversationContextLimit(id, null)
      clearConversationMemorySpace(id)
      clearMemoryCoreExtras(id)
      clearOwnerMemoryWriter(id)
      setConversationScreen(id, null)
      setConversationShellEnv(id, null)
    }
  }
  /** A run's conversation compacts as the bot's own does, never on the environment's global setting. */
  private applyRunCompaction(id: string): void {
    try {
      setConversationCompactionOverride(id, this.compactionDesired ?? COMPACTION_DISABLED)
    } catch {
      setConversationCompactionOverride(id, COMPACTION_DISABLED)
    }
  }
  /** Before each turn in a run's conversation: the bot's mode, permissions, model and context limit, as its own. */
  private prepareRun(lane: RunLane): void {
    this.registerRun(lane)
    if (!this.stored) return
    const id = lane.conversationId
    const previous = getConvUiPrefs(id).chat ?? {}
    patchConvUiPrefs(id, {
      chat: {
        ...previous,
        mode: 'agent',
        permMode: this.stored.profile.ceiling,
        tools: { ...previous.tools, app: true },
      },
    })
    const delegation = this.delegationSettings()
    this.applyTasks(id, delegation.mode === 'delegate' && delegation.sideConversations)
    setConversationContextLimit(id, this.stored.profile.compaction?.contextLimitTokens ?? null)
    const selection = this.currentSelection()
    if (selection)
      primeChatTurnSelection(id, {
        providerId: selection.providerId,
        modelId: selection.modelId,
        reasoning: selection.reasoning ?? undefined,
        fastMode: selection.fastMode,
      })
  }
  /** What a run's conversation holds for the owner: the images, videos and files it shows. */
  private runMediaOf(lane: RunLane): FleetRoutineRunMedia {
    try {
      return runMedia(lane.conversationId, (part) => this.images.toolRefs(part))
    } catch {
      return { images: 0, videos: 0, files: 0 }
    }
  }
  /**
   * Deletes a routine run's conversation: its images and attachments are copied first to a folder of the bot's
   * conversation (its shared files are there already), then the conversation, its inputs and its transcript go.
   */
  async deleteRun(runId: string): Promise<FleetInstanceRunDeleted> {
    if (this.disposed) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
    const record = this.runs.get(runId)
    if (!record) throw new InstanceHttpError(404, 'NOT_FOUND', 'This routine run has no conversation.')
    if (this.turns.has(runId))
      throw new InstanceHttpError(
        409,
        'CONFLICT',
        record.kind === 'thread'
          ? 'The conversation with another bot is working; stop it first.'
          : 'The routine run is working; stop it first.'
      )
    const primary = this.primaryConversationId ? getConversation(this.primaryConversationId) : undefined
    const dropped = this.files?.settings().deleteWithConversations ? this.files.idsFrom(runId) : []
    const kept = getConversation(record.conversationId)
      ? await keepRunFiles({
          record,
          folder: primary?.cwd ?? null,
          images: this.images,
          dropped: new Set(dropped),
        })
      : { folder: '', files: [] }
    await this.queue.forgetRun(runId)
    await this.host.closeConversation?.(record.conversationId).catch(() => undefined)
    await this.host.laneComputers?.close(record.conversationId).catch(() => undefined)
    await cancelMemoryExtraction(record.conversationId)
    if (getConversation(record.conversationId)) await this.host.purgeConversation?.(record.conversationId)
    await this.runs.remove(runId)
    if (dropped.length)
      await this.files.remove(dropped).then(
        () => this.changed(),
        // The run is gone either way: its files stay, marked as from a deleted conversation, for the owner to delete.
        (error) => console.warn('[fleet] could not delete a run’s shared files', error)
      )
    this.publish({ type: 'reset', runId })
    this.changed()
    return { kept }
  }
  private currentSelection(): FleetSelection | null {
    return effectiveFleetSelection(
      this.accountOptions,
      this.stored?.profile.selection ?? null,
      {
        providerId: getAppSetting('chat.defaultProvider'),
        modelId: getAppSetting('chat.defaultModel'),
        reasoning: getAppSetting('chat.defaultReasoning'),
        fastMode: getAppSetting('chat.defaultFastMode') === '1',
      },
      visibleFleetModels(this.accountOptions, getHiddenChatModelsFor)
    )
  }
  async profile(value: FleetInstanceProfile): Promise<FleetInstanceStatus> {
    if (this.disposed) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
    const profile = fleetInstanceProfileSchema.parse(value)
    if (profile.botId !== this.botId)
      throw new InstanceHttpError(400, 'INVALID_REQUEST', 'The profile names another bot.')
    for (const field of ['selection', 'compaction'] as const) {
      const selection = profile[field]
      const previous = this.stored?.profile[field]
      if (
        selection &&
        !(field === 'compaction' && profile.compactionInherited) &&
        getHiddenChatModelsFor(selection.providerId).includes(selection.modelId) &&
        (previous?.providerId !== selection.providerId || previous?.modelId !== selection.modelId)
      ) {
        throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Hidden models cannot be selected for new settings.')
      }
    }
    this.stored = { profile, primaryConversationId: this.stored?.primaryConversationId ?? null }
    writeStoredProfile(this.botId, this.stored)
    // An install carries the bot's final settings: once they apply, a conversation an uninstall suspended resumes.
    this.resumePending = true
    await this.ensureConversation()
    await this.refreshAccounts(true)
    // The meter follows a model switch at once instead of waiting for the next turn.
    await this.refreshUsage()
    this.changed()
    void this.tick()
    return this.status()
  }
  /** The gateway confirmed membership and pause, and the environment registered this bot before any work starts. */
  activate(): void {
    if (this.disposed || this.ready) return
    this.ready = true
    this.changed()
    void this.tick()
  }
  /** Stops dispatch immediately, before asynchronous cancellation and window cleanup during uninstall. */
  deactivate(): void {
    this.ready = false
  }
  private async refreshAccounts(force = false): Promise<void> {
    if (!force && Date.now() - this.accountCheckedAt < 10_000) return
    const previous = JSON.stringify(this.accountOptions.map((option) => option.id))
    const loaded = await this.loadAccounts(force)
    if (this.disposed) return
    if (loaded) this.applyProfile()
    await this.syncCompaction()
    if (JSON.stringify(this.accountOptions.map((option) => option.id)) !== previous) this.changed()
  }
  /** Reads the models of the environment's accounts; none, and false, when they cannot be read. */
  private async loadAccounts(force: boolean): Promise<boolean> {
    this.accountCheckedAt = Date.now()
    try {
      const options = await this.host.accountOptions(force)
      if (this.disposed) return false
      this.accountOptions = options
      this.accountsLoaded = true
      return true
    } catch {
      if (!this.disposed) this.accountOptions = []
      return false
    }
  }
  /** Whether the environment's model metadata accepts the compaction model's effort and Fast mode. */
  private async compactionSelectionValid(selection: NonNullable<BackgroundCompactionConfig['selection']>) {
    const key = JSON.stringify(selection)
    if (this.compactionChecked?.key === key) return this.compactionChecked.valid
    const { meta } = await effectiveModelMeta(selection.modelId, selection.providerId).catch(() => ({ meta: null }))
    const metadata = { status: meta ? ('available' as const) : ('unavailable' as const), meta }
    const valid =
      validateSubagentProfileEffort(selection, metadata).valid &&
      validateSubagentProfileFastMode(selection, metadata).valid
    this.compactionChecked = { key, valid }
    return valid
  }
  /**
   * Gives the bot's conversation its own compaction settings: the model from its profile, or compaction off while it
   * has none. The global setting belongs to the environment screen and is never written here. Until the environment's
   * accounts were read once, a configured model only looks unavailable: the conversation keeps the settings it has,
   * since turning compaction off would discard what it prepared. After an install, a suspended conversation resumes
   * once the bot's own settings are in place, never before, so it never runs on the global setting.
   */
  private async syncCompaction(): Promise<void> {
    const id = this.primaryConversationId
    if (!id || this.disposed) return
    const config = this.stored?.profile.compaction
    const option =
      config &&
      this.accountOptions.find((item) => item.providerId === config.providerId && item.modelId === config.modelId)
    let problem: FleetCompactionState['problem'] = !config ? 'missing' : !option ? 'unavailable' : null
    let desired = COMPACTION_DISABLED
    if (config && !problem) {
      const selection = {
        providerId: config.providerId,
        modelId: config.modelId,
        effort: config.reasoning ?? 'off',
        fastMode: config.fastMode,
      }
      if (await this.compactionSelectionValid(selection))
        desired = { enabled: true, intervalTokens: config.intervalTokens, selection }
      else problem = 'invalid'
    }
    if (this.disposed) return
    const waiting = problem === 'unavailable' && !this.accountsLoaded
    const key = JSON.stringify(desired)
    if (!waiting && this.compactionApplied !== key) {
      try {
        setConversationCompactionOverride(id, desired)
        this.compactionApplied = key
        this.compactionDesired = desired
      } catch {
        problem = 'invalid'
        setConversationCompactionOverride(id, COMPACTION_DISABLED)
        this.compactionApplied = JSON.stringify(COMPACTION_DISABLED)
        this.compactionDesired = COMPACTION_DISABLED
      }
      for (const lane of this.runs.loadedLanes()) if (lane.unregister) this.applyRunCompaction(lane.conversationId)
    }
    if (this.resumePending && this.compactionApplied !== null) {
      this.resumePending = false
      resumeConversationBackgroundCompaction(id)
      for (const record of this.runs.list()) resumeConversationBackgroundCompaction(record.conversationId)
    }
    const previous = this.compactionProblem
    this.compactionProblem = problem
    if (previous !== problem) this.changed()
    setCompactionSummarizer(id, () => {
      const current = this.stored?.profile.compaction
      return this.compactionProblem === null && current
        ? {
            providerId: current.providerId,
            modelId: current.modelId,
            effort: current.reasoning ?? 'off',
            fastMode: current.fastMode,
          }
        : null
    })
  }
  async selections(): Promise<{ options: FleetSelectionOption[]; current: FleetSelection | null }> {
    await this.refreshAccounts(true)
    return {
      options: visibleFleetModels(this.accountOptions, getHiddenChatModelsFor),
      current: this.currentSelection(),
    }
  }
  /** The environment's accounts changed: the bot reads its models again and may start queued work. */
  accountsChanged(): void {
    if (this.disposed) return
    this.compactionChecked = null
    this.changed()
    void this.refreshAccounts(true).then(() => {
      if (this.disposed) return
      this.changed()
      void this.tick()
    })
  }
  /** The environment removed an account: the bot stops offering its models before the next refresh. */
  async accountRemoved(providerId: string): Promise<void> {
    if (this.disposed) return
    this.accountOptions = this.accountOptions.filter((option) => option.providerId !== providerId)
    await this.syncCompaction()
    this.accountsChanged()
  }
  /** What waits for the owner: in the bot's conversation, and in the loaded conversations of its runs. */
  private pending(): FleetPendingInteraction[] {
    const id = this.primaryConversationId
    const own = id ? this.interactionsOf(id, this.live) : []
    const runs = this.runs.loadedLanes().flatMap((lane) =>
      [...this.interactionsOf(lane.conversationId, lane.live), ...lane.help.pending()].map((entry) => ({
        ...entry,
        runId: lane.runId,
      }))
    )
    return [...own, ...this.help.pending(), ...runs]
  }
  private interactionsOf(conversationId: string, live: LiveTranscript): FleetPendingInteraction[] {
    const permissions: FleetPendingInteraction[] = getChatPermissionBroker()
      .pendingFor(conversationId)
      .map((request) => ({
        kind: 'permission',
        id: request.id,
        at: this.permissionAt.get(request.id) ?? new Date().toISOString(),
        title: request.title,
        detail: permissionExtraResources(request).join(', ') || null,
        tool: this.permissionToolFor(request, live),
        itemId: 'perm:' + request.id,
      }))
    const questions: FleetPendingInteraction[] = getChatQuestionBroker()
      .pendingQuestionsFor(conversationId)
      .map((entry) => ({
        kind: 'question',
        id: entry.toolCallId,
        at: this.questionAt.get(entry.toolCallId) ?? new Date().toISOString(),
        questions: fleetQuestions(entry.questions),
        itemId: this.questionItems.get(entry.toolCallId) ?? 'question:' + entry.toolCallId,
      }))
    return [...permissions, ...questions]
  }
  private refreshUsage(): Promise<void> {
    const id = this.primaryConversationId
    if (!id || this.disposed) return Promise.resolve()
    const task = this.usageTask
      .then(async () => {
        if (this.disposed) return
        // The newest measured assistant, from the kept totals of the conversation's older messages.
        const snapshot = latestMeasuredContextSnapshot(id)
        const history = chatHistoryStats(id)
        const fallback = history.lastUsage
        const contextUsedTokens = snapshot
          ? Math.round(snapshot.usedTokens)
          : fallback?.contextInput != null
            ? Math.round(fallback.contextInput + (fallback.contextOutput ?? 0))
            : null
        const current = this.currentSelection()
        const currentMeta = current
          ? (await effectiveModelMeta(current.modelId, current.providerId).catch(() => ({ meta: null }))).meta
          : null
        // A sample from another model must not lend its window once the owner switches models, as in the local chat.
        const measuredWindow =
          !current || sameContextModel(snapshot?.model ?? history.lastModel, current)
            ? (snapshot?.modelContextWindow ?? fallback?.modelContextWindow)
            : undefined
        // Runtimes report their model's own window; the bot's conversation compacts at its cap, so the meter shows that.
        const contextWindowTokens =
          limitConversationContextWindow(id, measuredWindow ?? currentMeta?.contextWindow ?? undefined) ?? null
        const models = await Promise.all(
          history.perModel.map(async (item) => ({
            key: `${item.providerId ?? ''}\0${item.modelId ?? ''}`,
            meta: item.modelId
              ? (await effectiveModelMeta(item.modelId, item.providerId ?? undefined).catch(() => ({ meta: null })))
                  .meta
              : null,
          }))
        )
        const metaByModel = Object.fromEntries(models.map((item) => [item.key, item.meta]))
        let cost = 0
        let known = history.perModel.length > 0
        for (const item of history.perModel) {
          const meta = usageMetaForModel(metaByModel, item, {
            providerId: current?.providerId,
            modelId: current?.modelId,
            meta: currentMeta,
          })
          const amount = estimatedCostOfUsage(
            {
              input: item.input + item.subInput,
              output: item.output + item.subOutput,
              cacheRead: item.cachedInput + item.subCachedInput,
              cacheCreate: item.cacheCreate + item.subCacheCreate,
            },
            meta,
            item.runtimeEstimatedCostUsd,
            {
              input: item.catalogInput ?? 0,
              output: item.catalogOutput ?? 0,
              cacheRead: item.catalogCacheRead ?? 0,
              cacheCreate: item.catalogCacheCreate ?? 0,
            }
          )
          if (amount == null) known = false
          else cost += amount
        }
        this.usage = {
          contextUsedTokens,
          contextWindowTokens,
          contextQuality: snapshot?.quality ?? (contextUsedTokens == null ? null : 'estimated'),
          costUsd: known ? cost : null,
          updatedAt: new Date().toISOString(),
        }
        this.changed()
      })
      .catch(() => undefined)
    this.usageTask = task
    return task
  }
  async status(): Promise<FleetInstanceStatus> {
    await this.refreshAccounts()
    const conversationId = this.primaryConversationId
    // Status is rebuilt several times a second while a turn streams: the progress sits on the latest assistant or
    // compaction marker, so the newest page is enough and a long conversation is never parsed whole here.
    const progress = conversationId
      ? selectContextObservation(listChatMessagesPage(conversationId, { limit: 20 }).messages, {
          conversationId,
          model: this.currentSelection(),
          streaming: this.turns.has(null),
          compacting: this.manualCompacting,
        }).progress
      : undefined
    const background = conversationId
      ? backgroundCompactionStatus(conversationId)
      : { status: 'idle' as const, error: undefined }
    const compaction: FleetCompactionState | null = conversationId
      ? {
          configured: this.compactionProblem === null,
          problem: this.compactionProblem,
          background: { status: background.status, error: background.error?.slice(0, 200) ?? null },
          progress: progress
            ? {
                id: progress.id,
                status: progress.status,
                phase: progress.phase ?? null,
                completed: progress.completed ?? null,
                total: progress.total ?? null,
                attempt: progress.attempt ?? null,
                beforeTokens: progress.beforeTokens ?? null,
                afterTokens: progress.afterTokens ?? null,
                afterQuality: progress.afterQuality ?? null,
                error: progress.error?.slice(0, 500) ?? null,
                updatedAt: new Date(progress.updatedAt).toISOString(),
              }
            : null,
        }
      : null
    const providers = [
      ...new Map([
        ...this.accountOptions.map(
          (option) => [option.providerId, { id: option.providerId, label: option.providerLabel }] as const
        ),
        ...listProviders()
          .filter((provider) => hasApiKey(provider.id))
          .map((provider) => [provider.id, { id: provider.id, label: provider.name }] as const),
      ]).values(),
    ]
    const pending = this.pending()
    // The bot's own conversation's turn first, then its side conversations' from the oldest.
    const turns = [...this.turns.values()].sort(
      (a, b) => (a.key === null ? 0 : 1) - (b.key === null ? 0 : 1) || a.startedAt.localeCompare(b.startedAt)
    )
    const legacy = turns[0] ?? null
    // What the bot does shows from its own conversation first, else from its side conversations.
    const activeTool = turns.find((turn) => turn.tool)?.tool ?? null
    const queue = this.queue
      .list()
      .filter((item) => !item.attachmentError)
      .map((item) => ({
        inputId: item.id,
        source: item.input.source,
        preview: summarizeText(item.input.text, FLEET_QUEUE_PREVIEW_MAX),
        runId: inputRunId(item),
        ...(item.stopped ? { stopped: true } : {}),
      }))
    // What the owner stopped waits for them: the bot is not working on it.
    const waiting = queue.filter((item) => !item.stopped).length
    const activity: FleetInstanceStatus['activity'] =
      this.holdManager.state.state !== 'none'
        ? waiting
          ? { kind: 'queued', count: waiting }
          : { kind: 'idle', lastTurnSummary: this.lastSummary, lastTurnAt: this.lastTurnAt }
        : pending[0]?.kind === 'permission'
          ? { kind: 'permission', title: pending[0].tool?.name ?? pending[0].title }
          : pending[0]?.kind === 'question'
            ? { kind: 'question' }
            : pending[0]?.kind === 'help'
              ? { kind: 'help', reason: pending[0].reason }
              : !providers.length
                ? { kind: 'setup', need: 'account' }
                : this.compactionProblem !== null
                  ? { kind: 'setup', need: 'compaction' }
                  : compaction?.progress?.status === 'running' || compaction?.progress?.status === 'retrying'
                    ? { kind: 'compacting' }
                    : activeTool
                      ? { kind: 'tool', ...activeTool }
                      : turns.some((turn) => turn.compacting)
                        ? { kind: 'compacting' }
                        : turns.length
                          ? { kind: 'thinking' }
                          : waiting
                            ? { kind: 'queued', count: waiting }
                            : { kind: 'idle', lastTurnSummary: this.lastSummary, lastTurnAt: this.lastTurnAt }
    return {
      appVersion: app.getVersion(),
      capabilities: this.host.capabilities?.() ?? [...INSTANCE_CAPABILITIES],
      protocol: FLEET_PROTOCOL_VERSION,
      ready: this.ready,
      accounts: { connected: providers.length > 0, providers },
      selection: this.stored?.profile.selection ?? null,
      ceiling: this.stored?.profile.ceiling ?? 'ask',
      profile: this.stored ? { botId: this.stored.profile.botId, name: this.stored.profile.name } : null,
      conversationId: this.primaryConversationId,
      ...(await fleetRuntimeReport()),
      // Older readers know one turn: the bot's own conversation's, else the oldest.
      turn: legacy
        ? {
            state: legacy.cancelling ? 'cancelling' : 'running',
            startedAt: legacy.startedAt,
            inputId: legacy.inputId,
            runId: legacy.key,
          }
        : { state: 'idle', startedAt: null, inputId: null, runId: null },
      turns: turns.map((turn) => ({
        state: turn.cancelling ? 'cancelling' : 'running',
        startedAt: turn.startedAt,
        inputId: turn.inputId,
        runId: turn.key,
        tool: turn.tool,
        ...(turn.compacting ? { compacting: true } : {}),
      })),
      hold: this.holdManager.state,
      queue,
      activity,
      pending,
      usage: this.usage,
      compaction,
      sharedFiles: this.files?.isLoaded ? this.files.usage() : null,
      lastEventSeq: this.events.lastSeq,
    }
  }
  private publish(event: EventPayload): void {
    if (this.disposed) return
    this.events.publish({ ...event, botId: this.botId })
  }
  /** The environment's runtimes changed: publish a status carrying them. */
  runtimesChanged(): void {
    this.changed()
  }

  /** The conversation the bot's desktop showed when it last changed; undefined before the first change. */
  private shownForeground: string | null | undefined = undefined
  private changed(): void {
    if (this.disposed) return
    // A side conversation that asks for help comes forward on the bot's desktop, and goes back once it is helped.
    const foreground = this.foregroundConversationId
    const previous = this.shownForeground
    this.shownForeground = foreground
    if (previous && foreground && previous !== foreground) {
      this.host.floatBrowser(foreground)
      this.host.present?.(foreground, { app: 'browser' })
    }
    if (this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      if (this.disposed) return
      void this.status().then((status) => {
        this.publish({ type: 'status', status })
      })
    }, 250)
  }
  async input(received: FleetInstanceInput): Promise<FleetInputReceipt> {
    if (this.disposed) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
    if ((received.source === 'routine' && !received.routine) || (received.source === 'peer' && !received.peer))
      throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Input source metadata is missing.')
    const runId = received.run?.id ?? received.thread?.id ?? null
    if (received.run) await this.openRun(received)
    const value = received.thread ? await this.openThread(received) : received
    // The owner writing in a conversation they stopped lets what waits there go on, after their message.
    const resumes =
      value.source === 'owner' &&
      this.queue.list().some((candidate) => candidate.stopped && inputRunId(candidate) === runId)
    const result = await this.queue.enqueue(value)
    // The owner writing again is the moment to check at once whether a turn that could not start now can.
    if (value.source === 'owner') {
      this.retries.delete(runId)
      this.quotaRetryAt = 0
    }
    const item = this.queue.all().find((candidate) => candidate.id === result.inputId)
    if (resumes) this.publish(runId ? { type: 'reset', runId } : { type: 'reset' })
    else if (item && !item.started)
      this.publish({
        type: 'transcript.upsert',
        item: {
          kind: 'user',
          id: item.itemId,
          at: item.at,
          text: item.input.text,
          source: item.input.source,
          routine: item.input.routine,
          peer: item.input.peer,
          ...(item.input.citation ? { citation: item.input.citation } : {}),
          queued: true,
          ...(item.stopped ? { stopped: true } : {}),
          memories: [],
          images: this.queue.refs(item),
        },
        runId,
      })
    this.changed()
    void this.tick()
    return result
  }
  private readonly opening = new Map<string, Promise<void>>()
  /**
   * The conversation of the run an input goes to: made for the run's routine input when it has none yet, in the bot's
   * conversation folder. Any other input needs the run to have one already.
   */
  private async openRun(value: FleetInstanceInput): Promise<void> {
    const runId = value.run!.id
    if (!isRunId(runId)) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid routine run id.')
    await this.opening.get(runId)
    // A thread's conversation is never a run's.
    if (this.runs.thread(runId)) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid routine run id.')
    if (this.runs.get(runId)) return
    if (value.source !== 'routine' || !value.routine)
      throw new InstanceHttpError(404, 'NOT_FOUND', 'This routine run has no conversation.')
    const routine = value.routine
    const primary = this.primaryConversationId
    if (!primary || !getConversation(primary))
      throw new InstanceHttpError(409, 'CONFLICT', 'The bot conversation is unavailable.')
    const opening = (async () => {
      const conversation = await createStandaloneConversationInFolderOf(primary, routine.title || 'Routine run')
      await this.runs.add({
        runId,
        routineId: routine.id,
        routineTitle: routine.title,
        conversationId: conversation.id,
        createdAt: new Date().toISOString(),
      })
    })()
    this.opening.set(runId, opening)
    try {
      await opening
    } finally {
      this.opening.delete(runId)
    }
  }
  /**
   * The conversation of the thread an input goes to (`peer-conversations`): made for another bot's first message in
   * a thread this bot has none of. The thread's first message to the bot that opened it from another conversation
   * carries what it had sent there, and why.
   */
  private async openThread(value: FleetInstanceInput): Promise<FleetInstanceInput> {
    const thread = value.thread!
    if (!isRunId(thread.id)) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid thread id.')
    await this.opening.get(thread.id)
    if (this.runs.routine(thread.id)) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid thread id.')
    if (!this.runs.thread(thread.id)) {
      if (value.source !== 'peer' || !value.peer)
        throw new InstanceHttpError(404, 'NOT_FOUND', 'This conversation with another bot is not here.')
      await this.createThread({
        threadId: thread.id,
        peerBotId: value.peer.botId,
        peerName: value.peer.name,
        title: thread.title,
        origin: 'peer',
        opening: null,
      })
    }
    const record = this.runs.thread(thread.id)
    if (!record?.opening || value.source !== 'peer') return value
    const { kind: _kind, runId: _runId, ...stored } = record
    await this.runs.updateThread({ ...stored, opening: null })
    return { ...value, thread: { ...thread, context: openingContext(record) } }
  }
  /** Makes a thread's conversation on this bot's side, in its conversation folder, as a routine run's. */
  private async createThread(record: Omit<ThreadRecord, 'conversationId' | 'createdAt'>): Promise<void> {
    const primary = this.primaryConversationId
    if (!primary || !getConversation(primary))
      throw new InstanceHttpError(409, 'CONFLICT', 'The bot conversation is unavailable.')
    const opening = (async () => {
      if (this.runs.get(record.threadId)) return
      const name = `${record.peerName}: ${record.title}`.slice(0, 120)
      const conversation = await createStandaloneConversationInFolderOf(primary, name)
      await this.runs.addThread({ ...record, conversationId: conversation.id, createdAt: new Date().toISOString() })
    })()
    this.opening.set(record.threadId, opening)
    try {
      await opening
    } finally {
      this.opening.delete(record.threadId)
    }
  }
  /**
   * A thread this bot opened from one of its conversations (`bot_peers_send`): its conversation is made now, and
   * shows first the message that opened it.
   */
  async recordThread(record: Omit<ThreadRecord, 'conversationId' | 'createdAt'>, opened: FleetTranscriptItem) {
    if (this.disposed || this.runs.get(record.threadId)) return
    await this.createThread(record)
    const lane = await this.runLane(record.threadId)
    await lane?.extras.upsert(opened)
  }
  /** What the bot brings back to its own conversation from a thread it opened there (`bot_peers_report`). */
  async reportThread(threadId: string, text: string): Promise<void> {
    const record = this.runs.thread(threadId)
    if (!record) throw new Error('This conversation with another bot is not here.')
    await this.threadReports.add({ threadId, peerName: record.peerName, title: record.title, text })
    this.threadWaits.reported(threadId, text)
  }
  /** The bot sent another message in a thread from its conversation of it (`bot_peers_send`). */
  noteThreadSent(threadId: string): void {
    this.threadWaits.sent(threadId)
  }
  /**
   * Waits, within the turn of another conversation, for a thread's answer (`bot_peers_wait`): one it reported since
   * the bot last wrote there comes at once. An answer received this way leaves the reports of the bot's next turn.
   */
  async waitThread(threadId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ThreadWaitResult> {
    const record = this.runs.thread(threadId)
    if (this.disposed || !record)
      throw new Error('No conversation with another bot has this id here. Pass the thread bot_peers_send returned.')
    if (!this.threadWaits.pending(threadId)) {
      const since = Math.max(Date.parse(record.createdAt), this.threadWaits.lastSentAt(threadId))
      const stored = (await this.threadReports.list().catch(() => [])).find(
        (report) => report.threadId === threadId && Date.parse(report.at) >= since
      )
      if (stored) {
        await this.threadReports.remove(threadId, stored.text).catch(() => undefined)
        return { status: 'reported', text: stored.text }
      }
    }
    const result = await this.threadWaits.wait(threadId, options)
    if (result.status === 'reported') await this.threadReports.remove(threadId, result.text).catch(() => undefined)
    return result
  }
  /** The always-on memory of the bot's own conversation: its owner, and the answers its threads brought back. */
  private async primaryCoreSections(signal: AbortSignal): Promise<MemoryCoreExtraSection[] | null> {
    const owner = await this.ownerMemory.coreSections(signal)
    if (owner === null) return null
    const reports = await this.threadReports.section().catch(() => null)
    return reports ? [...owner, reports] : owner
  }
  async deleteInput(id: string): Promise<void> {
    const runId = (() => {
      const item = this.queue.all().find((candidate) => candidate.id === id)
      return item ? inputRunId(item) : null
    })()
    const result = await this.queue.delete(id)
    if (result === 'missing') throw new InstanceHttpError(404, 'NOT_FOUND', 'Input not found.')
    if (result === 'started') throw new InstanceHttpError(409, 'CONFLICT', 'Input already started.')
    await this.queue.cleanup(id)
    this.publish(runId ? { type: 'reset', runId } : { type: 'reset' })
    this.changed()
  }
  /**
   * The owner edits their last message: the conversation is cut from it, with everything after it (the bot's answer,
   * its notes and interactions), and the edited text runs as a new turn. Only while the bot is idle and nothing waits,
   * so no turn or other input ever sees a conversation half cut.
   */
  async editInput(inputId: string, value: FleetEditMessageRequest): Promise<FleetInputReceipt> {
    if (this.disposed) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
    // A retried edit gets the receipt of the input it made: the message it edited is gone by now.
    const prior = this.queue.receipt(value.idempotencyKey)
    if (prior) return prior
    const conversationId = this.primaryConversationId
    const record = this.queue.all().find((item) => item.id === inputId)
    if (!conversationId || !record) throw new InstanceHttpError(404, 'NOT_FOUND', 'Input not found.')
    if (record.input.source !== 'owner' || record.input.run)
      throw new InstanceHttpError(409, 'CONFLICT', 'Only a message of the owner can be edited.')
    // Only the bot's own conversation needs to rest: its side conversations may keep working meanwhile.
    const ownQueue = conversationQueue(this.queue, null)
    if (
      this.editing ||
      this.turns.has(null) ||
      this.manualCompacting ||
      this.holdManager.state.state !== 'none' ||
      ownQueue.list().length > 0 ||
      ownQueue.transcriptInputs().unmapped.length > 0 ||
      this.interactionsOf(conversationId, this.live).length > 0 ||
      this.help.pending().length > 0
    )
      throw new InstanceHttpError(409, 'CONFLICT', 'The bot is busy.')
    const native = record.nativeMessageId
      ? getChatMessagesWithSeq(conversationId, [record.nativeMessageId])[0]
      : undefined
    if (!native) throw new InstanceHttpError(409, 'CONFLICT', 'The message is no longer in the conversation.')
    if (
      listChatMessagesAfter(conversationId, native.seq).some(
        (row) => row.message.role === 'user' && !row.message.internal
      )
    )
      throw new InstanceHttpError(409, 'CONFLICT', 'Only the last message can be edited.')
    const keepsFiles = native.message.parts.some((part) => part.type === 'file' && !part.hidden)
    if (!value.text.trim() && !(value.attachments ? value.attachments.length > 0 : keepsFiles))
      throw new InstanceHttpError(400, 'INVALID_REQUEST', 'A message needs text or an attachment.')
    this.editing = true
    let slot: ChatConversationSlot | null = null
    let truncated = false
    let receipt: FleetInputReceipt
    try {
      slot = await acquireChatConversationSlot(conversationId, new AbortController().signal, 0).catch(() => null)
      if (!slot || this.disposed) throw new InstanceHttpError(409, 'CONFLICT', 'The bot is busy.')
      const removed = new Set([
        native.message.id,
        ...listChatMessagesAfter(conversationId, native.seq).map((row) => row.message.id),
      ])
      const cut = await truncateConversationForResend(conversationId, native.message.id, slot.operation)
      if (!cut.ok)
        throw new InstanceHttpError(
          409,
          'CONFLICT',
          cut.error === 'busy' ? 'The bot is busy.' : 'The message is no longer in the conversation.'
        )
      truncated = true
      // What the cut removed leaves the transcript too, before any new turn can add to it.
      await this.extras.pruneFrom(native.message.createdAt, removed)
      await this.queue.forget([record.id])
      // Seqs are given again after a cut: the transcript reads from the conversation as it is now.
      this.live.anchor()
      receipt = await this.queue.enqueue({
        source: 'owner',
        text: value.text,
        idempotencyKey: value.idempotencyKey,
        attachments:
          value.attachments ??
          cut.attachments.flatMap((attachment) => {
            const kept = queuedAttachment(attachment)
            return kept ? [kept] : []
          }),
      })
    } finally {
      this.editing = false
      slot?.release()
      // Readers load the transcript again, even when the edited message could not be queued after the cut.
      if (truncated) {
        this.publish({ type: 'reset' })
        this.changed()
        void this.refreshUsage()
      }
    }
    // The owner writing again, as a new message does: the edited turn does not wait out an earlier failure's delay.
    this.retries.delete(null)
    this.quotaRetryAt = 0
    void this.tick()
    return receipt
  }
  async transcript(before: string | null, limit: number, reasoning = false) {
    return this.live.page(before, limit, reasoning)
  }
  /** A page of a routine run's own conversation. */
  async runTranscript(
    runId: string,
    before: string | null,
    limit: number,
    reasoning = false
  ): Promise<FleetTranscriptPage> {
    const lane = await this.runLane(runId)
    if (!lane) throw new InstanceHttpError(404, 'NOT_FOUND', 'This routine run has no conversation.')
    return lane.live.page(before, limit, reasoning)
  }
  /** An image of the bot's conversation, or with `runId` of that run's. */
  async image(imageId: string, runId: string | null = null): Promise<{ mediaType: string; bytes: Uint8Array }> {
    const queued = await this.queue.readImage(imageId)
    if (queued) return queued
    let result: { mediaType: string; bytes: Uint8Array } | null = null
    if (runId) {
      const lane = await this.runLane(runId)
      if (lane) result = await this.images.read(imageId, lane.conversationId, lane.live.imageMessages(imageId))
    } else {
      const id = this.primaryConversationId
      if (!id) throw new InstanceHttpError(404, 'NOT_FOUND', 'Image not found.')
      result = await this.images.read(imageId, id, this.live.imageMessages(imageId))
    }
    if (!result) throw new InstanceHttpError(404, 'NOT_FOUND', 'Image not found.')
    return result
  }

  /** Where a conversation of this bot shares from: its own, a run's, a thread's, or one it no longer knows. */
  private fileOrigin(conversationId: string | undefined): FleetFileOrigin {
    if (!conversationId || conversationId === this.primaryConversationId) return { kind: 'primary' }
    const lane = this.runs.byConversation(conversationId)
    if (!lane) return { kind: 'unknown' }
    return lane.kind === 'routine'
      ? { kind: 'routine', runId: lane.runId, title: lane.routineTitle.slice(0, 200) }
      : { kind: 'thread', threadId: lane.threadId, title: lane.peerName.slice(0, 200) }
  }

  async publishFile(relativePath: string, name?: string, conversationId?: string): Promise<FleetFileRef> {
    const id = this.primaryConversationId
    const conversation = id ? getConversation(id) : null
    if (!conversation) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot conversation not found.')
    const scope = await createConversationFileScope(conversation)
    const source = await scope.resolveBridgePath(relativePath)
    const ref = await this.files.publish(
      { root: source.root, target: path.resolve(source.root, relativePath) },
      { name, origin: this.fileOrigin(conversationId) }
    )
    this.changed()
    return ref
  }

  async listFiles(): Promise<FleetFilesList> {
    const gone = (laneId: string) => !this.runs.get(laneId)
    return {
      files: this.files.list().map((file) => ({
        ...file,
        originGone:
          file.origin.kind === 'routine'
            ? gone(file.origin.runId)
            : file.origin.kind === 'thread'
              ? gone(file.origin.threadId)
              : false,
      })),
      removed: this.files.removedFiles(),
      usage: this.files.usage(),
      diskFreeBytes: await this.files.diskFreeBytes(),
    }
  }

  async deleteFiles(ids: string[]): Promise<FleetFilesDeleted> {
    const result = await this.files.remove(ids)
    if (result.deleted.length) this.changed()
    return { ...result, usage: this.files.usage() }
  }

  async setFileSettings(settings: FleetFileSettings): Promise<FleetFilesUsage> {
    try {
      const usage = await this.files.setSettings(settings)
      this.changed()
      return usage
    } catch (error) {
      if (error instanceof FleetFileSettingsError) throw new InstanceHttpError(409, 'CONFLICT', error.message)
      throw error
    }
  }

  private async attachmentFile(fileId: string) {
    const id = this.primaryConversationId
    if (!id) return null
    const found =
      (await this.queue.readFile(fileId)) ?? (await readConversationFile(id, fileId, this.live.fileMessages(fileId)))
    if (found) return found
    // An attachment of a run's conversation the owner has open: that run's lane is loaded.
    for (const lane of this.runs.loadedLanes()) {
      const messages = lane.live.fileMessages(fileId)
      if (messages.length) return readConversationFile(lane.conversationId, fileId, messages)
    }
    return null
  }

  async fileMeta(fileId: string): Promise<FleetFileRef> {
    const result = this.files.meta(fileId) ?? (await this.attachmentFile(fileId))?.ref
    if (!result) throw new InstanceHttpError(404, 'NOT_FOUND', 'File not found.')
    return result
  }

  async file(fileId: string): Promise<InstanceFile> {
    const published = await this.files.open(fileId)
    if (published) return { ref: published.ref, stream: published.handle.createReadStream() }
    const attached = await this.attachmentFile(fileId)
    if (!attached) throw new InstanceHttpError(404, 'NOT_FOUND', 'File not found.')
    return { ref: attached.ref, stream: Readable.from([attached.bytes]) }
  }
  /**
   * The user messages of one conversation the queue may map its started inputs to: every one created since the oldest
   * of them still unmapped (a second before it), none when every one is mapped.
   */
  private nativeUsersForQueue(
    live: LiveTranscript = this.live,
    runId: string | null = null
  ): Array<{ id: string; at: number; text: string }> {
    const unmapped = this.queue.transcriptInputs().unmapped.filter((item) => inputRunId(item) === runId)
    if (!unmapped.length) return []
    return live.userMessagesSince(Math.min(...unmapped.map((item) => Date.parse(item.at))) - 1_000)
  }
  /** Maps the started inputs of every conversation to their native messages, or puts them back in the queue. */
  private async reconcileQueue(): Promise<void> {
    await this.queue.reconcile(this.nativeUsersForQueue(), (item) => inputRunId(item) === null)
    const runs = new Set(
      this.queue
        .transcriptInputs()
        .unmapped.map(inputRunId)
        .filter((runId): runId is string => runId !== null)
    )
    for (const runId of runs) {
      const lane = await this.runLane(runId)
      const users = lane ? this.nativeUsersForQueue(lane.live, runId) : []
      await this.queue.reconcile(users, (item) => inputRunId(item) === runId)
    }
  }
  /**
   * A run's conversation, loaded; the lane of the running turn, and those with interactions waiting for the owner,
   * stay loaded. A lane loaded anew shows nothing pending any more: only a turn of its own could have asked.
   */
  private async runLane(runId: string): Promise<RunLane | null> {
    const known = this.runs.loaded(runId)
    const lane = await this.runs.lane(runId, (candidate) => this.keepsLane(candidate))
    if (lane && !known && lane !== this.turns.get(runId)?.lane) {
      for (const item of lane.extras.list()) {
        if (item.kind === 'permission' && item.state === 'pending')
          await lane.extras.upsert({ ...item, state: 'expired', resolvedAt: new Date().toISOString() })
        if (item.kind === 'question' && item.state === 'pending')
          await lane.extras.upsert({ ...item, state: 'dismissed', answers: null })
      }
    }
    return lane
  }
  private keepsLane(lane: RunLane): boolean {
    return (
      this.turns.has(lane.runId) ||
      lane.help.pending().length > 0 ||
      getChatPermissionBroker().pendingFor(lane.conversationId).length > 0 ||
      getChatQuestionBroker().pendingQuestionsFor(lane.conversationId).length > 0
    )
  }
  /** The lane of one of the bot's conversations: null for its own, a loaded run's lane, or undefined for neither. */
  private laneOf(conversationId: string): RunLane | null | undefined {
    if (conversationId === this.primaryConversationId) return null
    const record = this.runs.byConversation(conversationId)
    return record ? this.runs.loaded(record.runId) : undefined
  }
  /** The tool a permission request is for, from its call once found (then kept) or else from its resources. */
  private permissionToolFor(request: PermissionRequest, live = this.live): ReturnType<typeof permissionTool> {
    const known = this.permissionTools.get(request.id)
    if (known !== undefined) return known
    const call = request.toolCallId ? live.messageWithToolCall(request.toolCallId) : null
    const tool = permissionTool(request, call ? [call] : [])
    if (call || !request.toolCallId) {
      this.permissionTools.set(request.id, tool)
      for (const oldest of this.permissionTools.keys()) {
        if (this.permissionTools.size <= 200) break
        this.permissionTools.delete(oldest)
      }
    }
    return tool
  }
  /** The turns running in the bot's side conversations. */
  private sideTurns(): number {
    let count = 0
    for (const key of this.turns.keys()) if (key !== null) count++
    return count
  }
  /**
   * Starts a turn in each conversation that has an input waiting and none running: the bot's own conversation always,
   * and up to `FLEET_BOT_SIDE_TURNS_MAX` side conversations at once. A conversation's inputs run one after another; a
   * conversation never waits for another. Resolves once the turns it started have ended.
   */
  private async tick(): Promise<void> {
    if (this.disposed || !this.primaryConversationId || Date.now() < this.quotaRetryAt) return
    await this.refreshAccounts()
    if (
      this.disposed ||
      !canDispatch(
        this.ready,
        this.accountOptions.length > 0,
        this.holdManager.state.state,
        this.compactionProblem === null
      )
    )
      return
    const now = Date.now()
    const seen = new Set<string | null>()
    const started: Promise<void>[] = []
    // Claimed synchronously, with no await in between: two ticks never start the same conversation.
    for (const item of this.queue.list()) {
      if (item.attachmentError) continue
      const key = inputRunId(item)
      if (seen.has(key)) continue
      seen.add(key)
      // A conversation the owner stopped waits, with everything queued in it, until they write there.
      if (item.stopped) continue
      if (this.turns.has(key) || (this.retries.get(key)?.at ?? 0) > now) continue
      if (key === null && (this.manualCompacting || this.editing)) continue
      if (key !== null && this.sideTurns() >= FLEET_BOT_SIDE_TURNS_MAX) continue
      started.push(this.runTurn(this.claim(key, item), item))
    }
    await Promise.all(started)
  }
  /** Takes a conversation's next input for a turn of its own. */
  private claim(key: string | null, item: QueuedInput): ActiveTurn {
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const turn: ActiveTurn = {
      key,
      inputId: item.id,
      startedAt: new Date().toISOString(),
      abort: new AbortController(),
      lane: null,
      cancelling: false,
      tool: null,
      compacting: false,
      settled,
      settle,
    }
    this.turns.set(key, turn)
    this.changed()
    return turn
  }
  /** Runs one turn in its conversation: the bot's own, or a side conversation's lane. */
  private async runTurn(turn: ActiveTurn, item: QueuedInput): Promise<void> {
    const runId = turn.key
    const signal = turn.abort.signal
    let release: (() => void) | null = null
    let lane: RunLane | null = null
    try {
      if (runId) {
        lane = await this.runLane(runId)
        if (!lane || !getConversation(lane.conversationId)) {
          await this.dropRunInput(item, runId)
          return
        }
        turn.lane = lane
        this.changed()
      }
      const id = lane?.conversationId ?? this.primaryConversationId
      const live = lane?.live ?? this.live
      if (!id) return
      const slot = await acquireChatConversationSlot(id, signal)
      release = slot.release
      if (
        signal.aborted ||
        this.holdManager.state.state !== 'none' ||
        this.compactionProblem !== null ||
        (!lane && this.manualCompacting) ||
        !this.queue.list().some((candidate) => candidate.id === item.id)
      )
        return
      if (lane) this.prepareRun(lane)
      else this.applyProfile()
      const attachments = await this.queue.readAttachments(item)
      signal.throwIfAborted()
      await this.queue.markStarted(item.id)
      signal.throwIfAborted()
      // A thread's turn answering the other bot: once it ends, whoever waits for the thread may have its answer.
      const answering =
        lane?.record.kind === 'thread' && item.input.source === 'peer' ? this.threadWaits.mark(lane.runId) : null
      live.turnStarted()
      // Pages show it so until its native message is saved: readers holding it as queued learn it was taken.
      const starting = live.startingItem()
      if (starting) this.publish({ type: 'transcript.upsert', item: starting, runId })
      const handle = await startExecutorChatTurn({
        conversationId: id,
        prompt: promptForInput(item.input),
        skipMemory: item.input.source === 'continuation',
        memoryQuery: item.input.text,
        attachments,
        signal,
        slot,
      })
      this.retries.delete(runId)
      this.reportedStartFailure = null
      this.reportedStartFailures.delete(runId)
      await this.queue.cleanup(item.id)
      release = null
      try {
        // The turn's own user message: the newest one with its prompt, created since it was queued.
        const nativeUser = live
          .turnMessages()
          .filter((message) => message.role === 'user')
          .reverse()
          .find(
            (message) =>
              message.createdAt >= Date.parse(item.at) - 1_000 &&
              message.parts
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('') === promptForInput(item.input)
          )
        if (nativeUser) await this.queue.mapNativeMessage(item.id, nativeUser.id)
        const visibleUser = live.turnItem(item.itemId)
        if (visibleUser) this.publish({ type: 'transcript.upsert', item: visibleUser, runId })
        this.changed()
      } catch (error) {
        handle.cancel()
        throw error
      }
      const outcome = await handle.done
      const finalText = assistantText(id, outcome.assistantMessageId)
      if (lane && answering !== null) this.threadWaits.turnEnded(lane.runId, answering, item.input.text, finalText)
      const summary = live.lastAssistantText(outcome.assistantMessageId)?.slice(0, 280) ?? null
      // The turn's last state, even when its final events came before its final save.
      this.scheduleTranscriptRefresh(lane)
      // The bot's idle line quotes its own conversation; a run's answer stays with the run.
      if (!lane) {
        this.lastSummary = summary
        this.lastTurnAt = new Date().toISOString()
      }
      this.retries.delete(runId)
      this.quotaRetryAt = 0
      if (outcome.status !== 'success')
        await this.system(
          outcome.status === 'cancelled' ? 'turn_cancelled' : 'turn_failed',
          outcome.status === 'error' ? outcome.error.slice(0, 400) : null,
          null,
          lane
        )
      this.publish({
        type: 'turn.finished',
        inputId: item.id,
        text: finalText,
        source: item.input.source,
        outcome: outcome.status === 'success' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed',
        summary,
        runId,
        media: lane ? this.runMediaOf(lane) : null,
      })
      if (!lane) void this.refreshUsage()
    } catch (error) {
      const cancelled = signal.aborted
      const attachment =
        !cancelled &&
        error instanceof Error &&
        (error.message === 'invalid-attachment' || error.message === 'pdf-unreadable')
          ? error.message
          : null
      // The input stays queued: it starts again later, after its accounts' usage limit or a growing delay. A usage
      // limit holds every conversation, since they share the accounts; any other failure holds only this one.
      const failures = (this.retries.get(runId)?.failures ?? 0) + 1
      const retry =
        cancelled || attachment ? null : startRetry(error, failures, () => this.currentSelection()?.providerId ?? null)
      if (retry?.quota) {
        this.quotaRetryAt = retry.at
        this.retries.set(runId, { at: 0, failures })
      } else this.retries.set(runId, { at: retry?.at ?? Date.now() + START_RETRY_MIN_MS, failures })
      const live = lane?.live ?? this.live
      await this.queue
        .reconcile(this.nativeUsersForQueue(live, runId), (candidate) => inputRunId(candidate) === runId)
        .then(async () => {
          // Back in the queue when its native message was never saved: shown queued again, as pages show it.
          const requeued = live.queuedItem(item.id)
          if (requeued) this.publish({ type: 'transcript.upsert', item: requeued, runId })
          if (attachment) {
            await this.queue.failAttachment(item.id, attachment)
            this.retries.delete(runId)
            this.publish(runId ? { type: 'reset', runId } : { type: 'reset' })
          }
        })
        .catch(() => {
          console.error(JSON.stringify({ component: 'bot-instance', level: 'error', message: 'Input recovery failed' }))
        })
      // Each failure alerts the owner's devices: one that repeats the last one reported waits quietly instead. A usage
      // limit is the same in every conversation; any other failure is told in each conversation it holds.
      let repeated = false
      if (retry?.quota) {
        repeated = retry.key === this.reportedStartFailure
        this.reportedStartFailure = retry.key
      } else if (retry) {
        repeated = repeatsReportedFailure(this.reportedStartFailures.get(runId), retry.key)
        if (!repeated) this.reportedStartFailures.set(runId, { key: retry.key, at: Date.now() })
      }
      if (!repeated) {
        await this.system(
          cancelled ? 'turn_cancelled' : 'turn_failed',
          cancelled ? null : (retry?.text ?? (error instanceof Error ? error.message.slice(0, 400) : 'Turn failed.')),
          null,
          lane
        )
        this.publish({
          type: 'turn.finished',
          inputId: item.id,
          text: null,
          source: item.input.source,
          outcome: cancelled ? 'cancelled' : 'failed',
          summary: null,
          runId,
          media: lane ? this.runMediaOf(lane) : null,
        })
      }
    } finally {
      release?.()
      if (this.turns.get(runId) === turn) this.turns.delete(runId)
      turn.settle()
      this.changed()
      // A run that ended gives back what it opened: its browser, terminals and the programs they run.
      if (lane && !this.queue.list().some((candidate) => inputRunId(candidate) === lane!.runId))
        void this.host.closeConversation?.(lane.conversationId).catch(() => undefined)
      if (this.queue.list().some((candidate) => !candidate.attachmentError)) void this.tick()
    }
  }
  /** An input of a run whose conversation is gone: it leaves the queue, and the gateway hears its turn failed. */
  private async dropRunInput(item: QueuedInput, runId: string): Promise<void> {
    await this.queue.delete(item.id).catch(() => undefined)
    await this.queue.cleanup(item.id).catch(() => undefined)
    this.publish({ type: 'reset', runId })
    this.publish({
      type: 'turn.finished',
      inputId: item.id,
      text: null,
      source: item.input.source,
      outcome: 'failed',
      summary: null,
      runId,
    })
  }
  /**
   * The owner's Stop: stops the turns as `cancel` does, and holds what waits in their conversations until the owner
   * writes there, the stopped turn's own input too when its message was not saved yet (stopped while it prepared, such
   * as during a long compaction). Otherwise that input would go back to the queue and start again on its own.
   */
  async stop(conversation?: string | null): Promise<void> {
    const lanes = conversation === undefined ? [...this.turns.keys()] : [conversation]
    for (const lane of lanes)
      if (await this.queue.stop(lane)) this.publish(lane ? { type: 'reset', runId: lane } : { type: 'reset' })
    await this.cancel(conversation)
  }
  /**
   * Stops turns: every running one (`undefined`), the bot's own conversation's (`null`), or a side conversation's (its
   * run id). The others keep running.
   */
  async cancel(conversation?: string | null): Promise<void> {
    const stopping = [...this.turns.values()].filter((turn) => conversation === undefined || turn.key === conversation)
    await Promise.all(
      stopping.map(async (turn) => {
        turn.cancelling = true
        turn.abort.abort()
        this.changed()
        const id = this.conversationOfTurn(turn)
        if (id) await stopChatAndWait(id)
      })
    )
    this.changed()
  }
  async hold(reason: 'takeover' | 'paused'): Promise<FleetInstanceHold> {
    const wasHeld = this.holdManager.state.state !== 'none'
    // Taking the screen or pausing stops every conversation's turn; each continues in its own once released.
    const interrupted = new Set(this.turns.keys())
    const state = await this.holdManager.hold(reason, interrupted.size > 0, () => this.cancel())
    if (!wasHeld) {
      this.interrupted = interrupted
      await this.system(reason === 'takeover' ? 'takeover' : 'paused', null, null)
    }
    // A paused bot frees its browser's memory; a takeover keeps it open for the person who took the screen.
    if (reason === 'paused') this.host.stopBrowser?.(this.botId)
    return state
  }
  async release(value: FleetInstanceReleaseRequest): Promise<FleetInstanceHold> {
    const previous = this.holdManager.state
    if (previous.state !== 'held') throw new InstanceHttpError(409, 'CONFLICT', 'Instance is not held.')
    if (this.holdManager.releaseKeepsPaused) {
      const result = this.holdManager.release()
      this.changed()
      return result
    }
    // Every conversation the hold interrupted, and every one that asked for help, continues where it stopped. A hold
    // whose interrupted conversations are unknown (taken before they were recorded) continues the bot's own.
    const continuing = new Set<string | null>()
    if (previous.interruptedTurn)
      for (const key of this.interrupted.size ? this.interrupted : [null]) continuing.add(key)
    if (this.help.pending().length > 0) continuing.add(null)
    for (const lane of this.runs.loadedLanes()) if (lane.help.pending().length > 0) continuing.add(lane.runId)
    if (value.continue)
      for (const key of continuing) {
        const lane = key === null ? null : this.runs.get(key)
        if (lane === undefined) continue
        let idempotencyKey = this.releaseKeys.get(key)
        if (!idempotencyKey) {
          idempotencyKey = randomUUID()
          this.releaseKeys.set(key, idempotencyKey)
        }
        await this.input({
          source: 'continuation',
          text: continuationText(previous.reason ?? 'takeover', value.durationMs, value.note),
          attachments: [],
          idempotencyKey,
          // A thread with another bot continues as a thread: as a run, its conversation would be refused.
          ...(lane?.kind === 'thread'
            ? { thread: { id: lane.runId, title: lane.title } }
            : lane
              ? { run: { id: lane.runId } }
              : {}),
        })
      }
    await this.help.resolveAll(value.note)
    for (const lane of this.runs.loadedLanes()) await lane.help.resolveAll(value.note)
    await this.system(releaseSystemCode(previous.reason), value.note, value.durationMs)
    const result = this.holdManager.release()
    // Kept until the release went through: a retried release continues the same conversations with the same keys.
    this.interrupted = new Set()
    this.releaseKeys.clear()
    this.changed()
    void this.tick()
    return result
  }
  async resolve(id: string, value: FleetInteractionResolution): Promise<void> {
    const pending = this.pending().find((entry) => entry.id === id)
    if (!pending) throw new InstanceHttpError(404, 'NOT_FOUND', 'Interaction not found.')
    if (pending.kind === 'permission' && value.kind === 'permission') {
      getChatPermissionBroker().reply({ requestId: id, reply: value.reply })
    } else if (pending.kind === 'question' && (value.kind === 'question' || value.kind === 'question_dismiss')) {
      const extras = (pending.runId ? this.runs.loaded(pending.runId)?.extras : undefined) ?? this.extras
      const item = extras.list().find((entry) => entry.kind === 'question' && entry.toolCallId === id)
      if (item?.kind === 'question')
        await extras.upsert({
          ...item,
          state: value.kind === 'question' ? 'answered' : 'dismissed',
          answers: value.kind === 'question' ? value.answers : null,
        })
      getChatQuestionBroker().reply(id, value.kind === 'question' ? value.answers : [])
    } else if (pending.kind === 'help' && value.kind === 'help') {
      await ((pending.runId ? this.runs.loaded(pending.runId)?.help : undefined) ?? this.help).resolve(id, value.note)
    } else throw new InstanceHttpError(409, 'CONFLICT', 'Interaction kind mismatch.')
    this.changed()
  }
  async conversationCall(request: FleetConversationCallRequest): Promise<{ result: unknown }> {
    const id = this.primaryConversationId
    if (!id || !getConversation(id))
      throw new InstanceHttpError(409, 'CONFLICT', 'Primary conversation is unavailable.')
    let args: unknown[]
    try {
      args = validateFleetConversationArgs(request.op, request.args)
    } catch {
      throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid conversation call arguments.')
    }
    let result: unknown
    switch (request.op) {
      case 'chatConfig':
        result = projectFleetChatConfig(fleetChatConfig())
        break
      case 'chatGetConvTools':
        result = fleetChatGetConvTools(id)
        break
      case 'chatSetConvTools': {
        const patch = args[0] as { app?: boolean; mcpDisabled?: string[]; imageGen?: boolean }
        const refusal = botToolsPatchRefusal(patch)
        if (refusal) throw new InstanceHttpError(409, 'CONFLICT', refusal)
        result = fleetChatSetConvTools(id, patch)
        break
      }
      case 'chatSubagentProfilesGetConversation':
        result = await inspectSubagentProfile(getConversationSubagentProfileRules(id))
        break
      case 'chatSubagentProfilesSetConversationEnabled': {
        const saved = setConversationSubagentProfilesEnabled(id, args[0] as boolean)
        result = saved.ok ? { ...saved, value: await inspectSubagentProfile(saved.value) } : saved
        break
      }
      case 'chatSubagentsSetConversationEnabled':
        result = setConversationSubagentsEnabled(id, args[0] as boolean)
        break
      case 'chatSkillsState':
        result = await listSkillsState(id)
        break
      case 'chatSkillSetOverride':
        setConversationSkillOverride(id, args[0] as string, args[1] as 'on' | 'off' | 'inherit')
        result = { ok: true }
        break
      case 'chatSkillResetOverrides':
        result = resetConversationSkillOverrides(id)
        break
      case 'chatSkillSetSelection':
        result = setConversationSkillSelection(id, args[0] as Parameters<typeof setConversationSkillSelection>[1])
        break
      case 'chatCommands':
        result = await fleetChatCommands(id)
        break
      case 'chatCompact':
        if (this.compactionProblem !== null) result = { ok: false, error: 'not-configured' }
        else if (this.turns.has(null) || this.manualCompacting || this.editing) result = { ok: false, error: 'busy' }
        else {
          const started = startManualCompaction(id, () => {
            this.manualCompacting = false
            if (this.disposed) return
            this.onChatEvent({ kind: 'compaction-finished', status: 'completed' })
            void this.tick()
          })
          if (started.ok) this.manualCompacting = true
          result = started
        }
        break
      case 'chatBackgroundCompactionRetry':
        if (this.compactionProblem !== null) result = { ok: false, error: 'not-configured' }
        else {
          void retryBackgroundCompaction(id).then(
            () => this.changed(),
            () => this.changed()
          )
          result = { ok: true }
        }
        break
    }
    if (
      request.op === 'chatSetConvTools' ||
      request.op === 'chatSubagentProfilesSetConversationEnabled' ||
      request.op === 'chatSubagentsSetConversationEnabled' ||
      request.op === 'chatSkillSetOverride' ||
      request.op === 'chatSkillResetOverrides' ||
      request.op === 'chatSkillSetSelection'
    )
      this.changed()
    const json = JSON.stringify(result)
    if (json === undefined) throw new InstanceHttpError(500, 'INTERNAL', 'Conversation result is unavailable.')
    return { result: JSON.parse(json) as unknown }
  }
  private async system(
    code: Extract<FleetTranscriptItem, { kind: 'system' }>['code'],
    text: string | null,
    durationMs: number | null,
    lane: RunLane | null = null
  ): Promise<void> {
    if (this.disposed) return
    await (lane?.extras ?? this.extras).upsert({
      kind: 'system',
      id: 'system:' + randomUUID(),
      at: new Date().toISOString(),
      code,
      text,
      durationMs,
    })
  }
  /** The environment routes permission and question events of this bot's conversations here. */
  permissionAsked(request: PermissionRequest): void {
    const lane = this.disposed ? undefined : this.laneOf(request.conversationId)
    if (lane === undefined) return
    const at = new Date().toISOString()
    this.permissionAt.set(request.id, at)
    void (lane?.extras ?? this.extras)
      .upsert({
        kind: 'permission',
        id: 'perm:' + request.id,
        at,
        requestId: request.id,
        title: request.title,
        detail: permissionExtraResources(request).join(', ') || null,
        tool: this.permissionToolFor(request, lane?.live ?? this.live),
        state: 'pending',
        resolvedAt: null,
      })
      .then(() => this.changed())
  }
  permissionResolved(event: { requestId: string; conversationId: string; decision: 'allow' | 'deny' }): void {
    const lane = this.disposed ? undefined : this.laneOf(event.conversationId)
    if (lane === undefined) return
    this.permissionTools.delete(event.requestId)
    const extras = lane?.extras ?? this.extras
    const item = extras.list().find((entry) => entry.kind === 'permission' && entry.requestId === event.requestId)
    if (item?.kind === 'permission')
      void extras
        .upsert({
          ...item,
          state: event.decision === 'allow' ? 'approved' : 'denied',
          resolvedAt: new Date().toISOString(),
        })
        .then(() => this.changed())
  }
  questionAsked(event: { conversationId: string; toolCallId: string }): void {
    const lane = this.disposed ? undefined : this.laneOf(event.conversationId)
    if (lane === undefined) return
    const pending = getChatQuestionBroker()
      .pendingQuestionsFor(event.conversationId)
      .find((entry) => entry.toolCallId === event.toolCallId)
    if (!pending) return
    const at = new Date().toISOString()
    this.questionAt.set(event.toolCallId, at)
    // In the place of its tool call, as the native question would be: with the time it was asked, the item sorted after
    // every item of its message, below whatever the turn wrote after the answer.
    const anchor = this.questionAnchor(event.toolCallId, lane?.live ?? this.live) ?? {
      id: 'question:' + event.toolCallId,
      at,
    }
    this.questionItems.set(event.toolCallId, anchor.id)
    for (const oldest of this.questionItems.keys()) {
      if (this.questionItems.size <= 200) break
      this.questionItems.delete(oldest)
    }
    void (lane?.extras ?? this.extras)
      .upsert({
        kind: 'question',
        id: anchor.id,
        at: anchor.at,
        toolCallId: event.toolCallId,
        questions: fleetQuestions(pending.questions),
        state: 'pending',
        answers: null,
      })
      .then(() => this.changed())
  }
  /** The id and time `projectMessages` gives the question's tool part, once its message holds it. */
  private questionAnchor(toolCallId: string, live: LiveTranscript): { id: string; at: string } | null {
    const message = live.messageWithToolCall(toolCallId)
    if (message?.role !== 'assistant') return null
    const index = message.parts.findIndex((part) => part.type === 'tool' && part.toolCallId === toolCallId)
    return index < 0 ? null : { id: `${message.id}:${index}`, at: new Date(message.createdAt).toISOString() }
  }
  questionAnswered(event: { conversationId: string; toolCallId: string }): void {
    const lane = this.disposed ? undefined : this.laneOf(event.conversationId)
    if (lane === undefined) return
    const extras = lane?.extras ?? this.extras
    const item = extras.list().find((entry) => entry.kind === 'question' && entry.toolCallId === event.toolCallId)
    if (item?.kind === 'question' && item.state === 'pending')
      void extras.upsert({ ...item, state: 'dismissed', answers: null }).then(() => this.changed())
    else this.changed()
  }
  /** The help requests of one of the bot's conversations: its own, or a loaded routine run's. */
  helpFor(conversationId: string): InstanceHelpStore {
    const lane = this.laneOf(conversationId)
    if (lane === undefined) throw new Error('This conversation does not belong to the bot.')
    return lane?.help ?? this.help
  }
  private onChatEvent(event: ChatStreamEvent, lane: RunLane | null = null): void {
    if (this.disposed) return
    const id = lane?.conversationId ?? this.primaryConversationId
    // Only the conversation the bot's desktop shows brings its browser and apps forward there.
    const active = () => !this.disposed && !!id && id === this.foregroundConversationId
    // Each conversation's turn tracks its own tool: conversations working at once never mix theirs up.
    const turn = this.turns.get(lane?.runId ?? null)
    // And whether its conversation compacts: before its message is saved, that is all the turn does, maybe for long.
    if (turn && event.kind === 'compaction-progress')
      turn.compacting = event.progress.status === 'running' || event.progress.status === 'retrying'
    else if (
      turn?.compacting &&
      (event.kind === 'compaction' ||
        event.kind === 'compaction-finished' ||
        event.kind === 'text-start' ||
        event.kind === 'reasoning-start' ||
        event.kind === 'tool-call' ||
        event.kind === 'finish' ||
        event.kind === 'aborted' ||
        event.kind === 'error')
    )
      turn.compacting = false
    if (event.kind === 'tool-call') {
      if (turn) turn.tool = { tool: event.toolName, target: toolTarget(event.input) }
      if (event.toolName.startsWith('browser_') && id)
        this.schedule(() => {
          if (active()) this.host.floatBrowser(id)
        }, 1_000)
      const request = presentationForTool(event.toolName, event.input)
      if (id && request) {
        if (presentsOnCompletion(event.toolName))
          this.presentOnCompletion.set(event.toolCallId, { conversationId: id, request })
        else
          this.schedule(() => {
            if (active()) this.host.present?.(id, request)
          }, 1_000)
      }
    }
    if (event.kind === 'tool-state' && event.state.status !== 'running') {
      if (turn) turn.tool = null
      const presented = this.presentOnCompletion.get(event.toolCallId)
      if (presented && event.state.status !== 'pending' && event.state.status !== 'awaiting-permission') {
        this.presentOnCompletion.delete(event.toolCallId)
        if (event.state.status === 'completed' && active())
          this.host.present?.(presented.conversationId, presented.request)
      }
    }
    if (event.kind === 'finish' || event.kind === 'aborted')
      for (const [toolCallId, presented] of this.presentOnCompletion)
        if (presented.conversationId === id) this.presentOnCompletion.delete(toolCallId)
    if (
      event.kind === 'text-delta' ||
      event.kind === 'text-start' ||
      event.kind === 'reasoning-delta' ||
      event.kind === 'reasoning-start' ||
      event.kind === 'tool-state' ||
      event.kind === 'tool-call' ||
      event.kind === 'finish' ||
      event.kind === 'aborted' ||
      event.kind === 'error' ||
      event.kind === 'compaction' ||
      event.kind === 'compaction-finished'
    ) {
      if ('messageId' in event && event.messageId) (lane?.live ?? this.live).touched(event.messageId)
      this.scheduleTranscriptRefresh(lane)
    }
    this.changed()
  }
  /** The run lanes whose transcripts changed since the last refresh; null stands for the bot's own conversation. */
  private staleTranscripts?: Set<RunLane | null>
  /** Sends the transcript items that changed, at most every 250 ms. */
  private scheduleTranscriptRefresh(lane: RunLane | null = null): void {
    ;(this.staleTranscripts ??= new Set()).add(lane)
    if (this.transcriptTimer || this.disposed) return
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = null
      if (this.disposed) return
      const lanes = [...(this.staleTranscripts ?? [null])]
      this.staleTranscripts?.clear()
      for (const stale of lanes) void (stale?.live ?? this.live).refresh().catch(() => undefined)
    }, 250)
  }
}
