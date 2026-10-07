import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import { app } from 'electron'
import {
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
  type FleetTranscriptItem,
  type FleetPendingInteraction,
  type FleetInputReceipt,
  type FleetUsage,
  type FleetConversationCallRequest,
  type FleetCompactionState,
  type FleetFileRef,
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
import { estimatedCostOfUsage, usageMetaForModel, type ChatStreamEvent } from '../../../shared/chat'
import { sameContextModel, selectContextObservation } from '../../../shared/context-observation'
import type { PermissionRequest } from '../../chat/permission'
import { getAppSetting, getConversation, getConvUiPrefs, patchConvUiPrefs } from '../../store'
import { getHiddenChatModelsFor } from '../../store/settings'
import { createStandaloneConversation } from '../../standalone-conversation-service'
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
} from '../../chat/service'
import { clearCompactionSummarizer, setCompactionSummarizer } from '../../chat/compaction-summarizer'
import {
  getConversationContextLimit,
  limitConversationContextWindow,
  setConversationContextLimit,
} from '../../chat/conversation-context-limit'
import {
  chatHistoryStats,
  getChatMessage,
  latestMeasuredContextSnapshot,
  listChatMessagesPage,
} from '../../chat/chat-store'
import { listProviders } from '../../chat/catalog'
import { hasApiKey } from '../../chat/credentials'
import { observeChatHost } from '../../chat/host-events'
import { presentationForTool, presentsOnCompletion, type PresentationRequest } from './desktop/presentation'
import { setConversationShellEnv, type ConversationShellEnv } from '../../chat/conversation-env'
import { setConversationScreen, type ScreenArea } from '../../conversation-screen'
import { INSTANCE_CAPABILITIES, InstanceHttpError, type InstanceEvents, type InstanceFile } from './server'
import { InstanceInputQueue, promptForInput } from './queue'
import { InstanceHoldManager, registerInstanceHoldGate } from './gate'
import { InstanceTranscriptExtras, fleetQuestions, toolTarget, permissionTool } from './transcript'
import { LiveTranscript } from './live-transcript'
import { InstanceHelpStore } from './help'
import { clearBotIdentity, setBotIdentity, type BotIdentityPeer } from './identity'
import type { GatewayConfig } from './gateway-client'
import { FleetImageStore } from './images'
import { FleetFileStore } from './files'
import { readConversationFile } from './attachment-files'
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

export function canDispatch(
  ready: boolean,
  connected: boolean,
  running: boolean,
  hold: FleetInstanceHold['state'],
  compactionReady = true
): boolean {
  return ready && connected && compactionReady && !running && hold === 'none'
}

function continuationText(reason: 'takeover' | 'paused', durationMs: number | null, note: string | null): string {
  if (reason === 'paused') return 'The owner resumed you. Continue the task where you stopped.'
  const seconds = Math.floor((durationMs ?? 0) / 1000)
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return `The owner used your screen for ${duration} and handed it back.${note ? ` Their note: "${note}".` : ''} The screen may have changed: take a fresh screenshot before acting, then continue the task.`
}
export { continuationText }
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
  /** Names of the peers this bot listed, for the replies of its peer tools. */
  readonly peerNames = new Map<string, string>()
  private stored: StoredProfile | null
  private gatewayToken: string | null
  private screen: BotScreen | null = null
  private accountOptions: FleetSelectionOption[] = []
  private accountCheckedAt = 0
  /** Whether the environment's accounts were read once: until then, a compaction model cannot be checked. */
  private accountsLoaded = false
  private ready = false
  private turning = false
  private cancelling = false
  private releaseContinuationKey: string | null = null
  private turnStartedAt: string | null = null
  private turnInputId: string | null = null
  private turnSettled: Promise<void> = Promise.resolve()
  private retryAt = 0
  private activeTool: { tool: string; target: string | null } | null = null
  private lastSummary: string | null = null
  private lastTurnAt: string | null = null
  private turnAbort: AbortController | null = null
  private floatAttempted = false
  private stopObserving: (() => void) | null = null
  private stopGate: (() => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private statusTimer: NodeJS.Timeout | null = null
  private transcriptTimer: NodeJS.Timeout | null = null
  private floatTimers = new Set<NodeJS.Timeout>()
  /** Tool calls whose app comes forward once they finish, such as a terminal just created. */
  private readonly presentOnCompletion = new Map<string, PresentationRequest>()
  private permissionAt = new Map<string, string>()
  private questionAt = new Map<string, string>()
  /** The tool of each pending permission request, once its call was found: it never changes. */
  private permissionTools = new Map<string, ReturnType<typeof permissionTool>>()
  private usage: FleetUsage | null = null
  private usageTask: Promise<void> = Promise.resolve()
  private compactionProblem: FleetCompactionState['problem'] = 'missing'
  private compactionChecked: { key: string; valid: boolean } | null = null
  private compactionApplied: string | null = null
  /** Set by an install: the conversation resumes (an uninstall suspended it) once the bot's own settings apply. */
  private resumePending = false
  private manualCompacting = false
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
      queue: this.queue,
      extras: this.extras,
      images: this.images,
      publish: (item) => this.publish({ type: 'transcript.upsert', item }),
    })
    this.holdManager = new InstanceHoldManager(
      () => {
        if (this.disposed) return
        if (this.holdManager.state.reason === 'paused' || this.holdManager.releaseKeepsPaused)
          writeBotPaused(this.botId, true)
        else if (this.holdManager.state.state === 'none') writeBotPaused(this.botId, false)
        this.changed()
      },
      () => this.primaryConversationId
    )
  }
  get primaryConversationId(): string | null {
    return this.stored?.primaryConversationId ?? null
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
  }
  currentInput(): { source: FleetInputSource; routine?: { id: string; title: string; runId?: string } } | null {
    const item = this.queue.all().find((item) => item.id === this.turnInputId)
    if (!item) return null
    const routine = item.input.routine
    return {
      source: item.input.source,
      ...(routine
        ? { routine: { id: routine.id, title: routine.title, ...(routine.runId ? { runId: routine.runId } : {}) } }
        : {}),
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
    await this.images.load()
    await this.files.load()
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
    if (this.primaryConversationId) await this.queue.reconcile(this.nativeUsersForQueue())
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
    this.turnAbort?.abort()
    // Stopped before the hooks go, so no gap lets its work fall back to the environment's settings.
    const background = options.uninstall ? this.stopBackgroundWork() : Promise.resolve()
    this.unregisterConversation(options.uninstall === true)
    // Owner memory goes through the bot's token; an uninstalled bot keeps none, even for a caller holding its writer.
    if (options.uninstall) this.gatewayToken = null
    await this.turnSettled.catch(() => undefined)
    await Promise.all([this.queue.idle(), this.extras.idle(), this.images.idle(), this.usageTask, background]).catch(
      () => undefined
    )
  }
  /** Suspends the compaction of the bot's conversation and cancels its memory extraction, waiting briefly for both. */
  private async stopBackgroundWork(): Promise<void> {
    const id = this.registeredConversation?.id ?? this.primaryConversationId
    if (!id) return
    await Promise.all([
      suspendConversationBackgroundCompaction(id).catch(() => {
        console.error(
          JSON.stringify({ component: 'bot-instance', level: 'error', message: 'Compaction suspension failed' })
        )
      }),
      cancelMemoryExtraction(id),
    ])
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
    setMemoryCoreExtras(id, (signal) => this.ownerMemory.coreSections(signal))
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
      } catch {
        problem = 'invalid'
        setConversationCompactionOverride(id, COMPACTION_DISABLED)
        this.compactionApplied = JSON.stringify(COMPACTION_DISABLED)
      }
    }
    if (this.resumePending && this.compactionApplied !== null) {
      this.resumePending = false
      resumeConversationBackgroundCompaction(id)
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
  private pending(): FleetPendingInteraction[] {
    const id = this.primaryConversationId
    if (!id) return this.help.pending()
    const permissions: FleetPendingInteraction[] = getChatPermissionBroker()
      .pendingFor(id)
      .map((request) => ({
        kind: 'permission',
        id: request.id,
        at: this.permissionAt.get(request.id) ?? new Date().toISOString(),
        title: request.title,
        detail: request.resources.join(', ') || null,
        tool: this.permissionToolFor(request),
        itemId: 'perm:' + request.id,
      }))
    const questions: FleetPendingInteraction[] = getChatQuestionBroker()
      .pendingQuestionsFor(id)
      .map((entry) => ({
        kind: 'question',
        id: entry.toolCallId,
        at: this.questionAt.get(entry.toolCallId) ?? new Date().toISOString(),
        questions: fleetQuestions(entry.questions),
        itemId: 'question:' + entry.toolCallId,
      }))
    return [...permissions, ...questions, ...this.help.pending()]
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
          streaming: this.turning,
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
    const queue = this.queue
      .list()
      .filter((item) => !item.attachmentError)
      .map((item) => ({
        inputId: item.id,
        source: item.input.source,
        preview: summarizeText(item.input.text, FLEET_QUEUE_PREVIEW_MAX),
      }))
    const activity: FleetInstanceStatus['activity'] =
      this.holdManager.state.state !== 'none'
        ? queue.length
          ? { kind: 'queued', count: queue.length }
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
                    : this.activeTool
                      ? { kind: 'tool', ...this.activeTool }
                      : this.turning
                        ? { kind: 'thinking' }
                        : queue.length
                          ? { kind: 'queued', count: queue.length }
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
      turn: {
        state: this.cancelling ? 'cancelling' : this.turning ? 'running' : 'idle',
        startedAt: this.turnStartedAt,
        inputId: this.turnInputId,
      },
      hold: this.holdManager.state,
      queue,
      activity,
      pending,
      usage: this.usage,
      compaction,
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

  private changed(): void {
    if (this.statusTimer || this.disposed) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      if (this.disposed) return
      void this.status().then((status) => {
        this.publish({ type: 'status', status })
      })
    }, 250)
  }
  async input(value: FleetInstanceInput): Promise<FleetInputReceipt> {
    if (this.disposed) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
    if ((value.source === 'routine' && !value.routine) || (value.source === 'peer' && !value.peer))
      throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Input source metadata is missing.')
    const result = await this.queue.enqueue(value)
    const item = this.queue.all().find((candidate) => candidate.id === result.inputId)
    if (item && !item.started)
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
          queued: true,
          memories: [],
          images: this.queue.refs(item),
        },
      })
    this.changed()
    void this.tick()
    return result
  }
  async deleteInput(id: string): Promise<void> {
    const result = await this.queue.delete(id)
    if (result === 'missing') throw new InstanceHttpError(404, 'NOT_FOUND', 'Input not found.')
    if (result === 'started') throw new InstanceHttpError(409, 'CONFLICT', 'Input already started.')
    await this.queue.cleanup(id)
    this.publish({ type: 'reset' })
    this.changed()
  }
  async transcript(before: string | null, limit: number, reasoning = false) {
    return this.live.page(before, limit, reasoning)
  }
  async image(imageId: string): Promise<{ mediaType: string; bytes: Uint8Array }> {
    const id = this.primaryConversationId
    if (!id) throw new InstanceHttpError(404, 'NOT_FOUND', 'Image not found.')
    const result =
      (await this.queue.readImage(imageId)) ?? (await this.images.read(imageId, id, this.live.imageMessages(imageId)))
    if (!result) throw new InstanceHttpError(404, 'NOT_FOUND', 'Image not found.')
    return result
  }

  async publishFile(relativePath: string, name?: string): Promise<FleetFileRef> {
    const id = this.primaryConversationId
    const conversation = id ? getConversation(id) : null
    if (!conversation) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot conversation not found.')
    const scope = await createConversationFileScope(conversation)
    const source = await scope.resolveBridgePath(relativePath)
    return this.files.publish({ root: source.root, target: path.resolve(source.root, relativePath) }, name)
  }

  private async attachmentFile(fileId: string) {
    const id = this.primaryConversationId
    if (!id) return null
    return (await this.queue.readFile(fileId)) ?? readConversationFile(id, fileId, this.live.fileMessages(fileId))
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
   * The user messages the queue may map its started inputs to: every one created since the oldest input still
   * unmapped (a second before it), none when every input is mapped.
   */
  private nativeUsersForQueue(): Array<{ id: string; at: number; text: string }> {
    const unmapped = this.queue.transcriptInputs().unmapped
    if (!unmapped.length) return []
    return this.live.userMessagesSince(Math.min(...unmapped.map((item) => Date.parse(item.at))) - 1_000)
  }
  /** The tool a permission request is for, from its call once found (then kept) or else from its resources. */
  private permissionToolFor(request: PermissionRequest): ReturnType<typeof permissionTool> {
    const known = this.permissionTools.get(request.id)
    if (known !== undefined) return known
    const call = request.toolCallId ? this.live.messageWithToolCall(request.toolCallId) : null
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
  private async tick(): Promise<void> {
    if (this.disposed || !this.primaryConversationId || Date.now() < this.retryAt) return
    await this.refreshAccounts()
    if (
      this.disposed ||
      !canDispatch(
        this.ready,
        this.accountOptions.length > 0,
        this.turning || this.manualCompacting,
        this.holdManager.state.state,
        this.compactionProblem === null
      )
    )
      return
    const item = this.queue.list().find((candidate) => !candidate.attachmentError)
    if (!item) return
    this.turning = true
    this.turnStartedAt = new Date().toISOString()
    this.turnInputId = item.id
    this.turnAbort = new AbortController()
    let settle!: () => void
    this.turnSettled = new Promise<void>((resolve) => {
      settle = resolve
    })
    this.changed()
    let release: (() => void) | null = null
    try {
      const id = this.primaryConversationId
      const slot = await acquireChatConversationSlot(id, this.turnAbort.signal)
      release = slot.release
      if (
        this.turnAbort.signal.aborted ||
        this.holdManager.state.state !== 'none' ||
        this.compactionProblem !== null ||
        this.manualCompacting ||
        !this.queue.list().some((candidate) => candidate.id === item.id)
      )
        return
      this.applyProfile()
      const attachments = await this.queue.readAttachments(item)
      this.turnAbort.signal.throwIfAborted()
      await this.queue.markStarted(item.id)
      this.turnAbort.signal.throwIfAborted()
      this.live.turnStarted()
      const handle = await startExecutorChatTurn({
        conversationId: id,
        prompt: promptForInput(item.input),
        skipMemory: item.input.source === 'continuation',
        memoryQuery: item.input.text,
        attachments,
        signal: this.turnAbort.signal,
        slot,
      })
      await this.queue.cleanup(item.id)
      release = null
      try {
        // The turn's own user message: the newest one with its prompt, created since it was queued.
        const nativeUser = this.live
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
        const visibleUser = this.live.turnItem(item.itemId)
        if (visibleUser) this.publish({ type: 'transcript.upsert', item: visibleUser })
        this.changed()
      } catch (error) {
        handle.cancel()
        throw error
      }
      const outcome = await handle.done
      const finalText = assistantText(id, outcome.assistantMessageId)
      const summary = this.live.lastAssistantText(outcome.assistantMessageId)?.slice(0, 280) ?? null
      // The turn's last state, even when its final events came before its final save.
      this.scheduleTranscriptRefresh()
      this.lastSummary = summary
      this.lastTurnAt = new Date().toISOString()
      this.retryAt = 0
      if (outcome.status !== 'success')
        await this.system(
          outcome.status === 'cancelled' ? 'turn_cancelled' : 'turn_failed',
          outcome.status === 'error' ? outcome.error.slice(0, 400) : null,
          null
        )
      this.publish({
        type: 'turn.finished',
        inputId: item.id,
        text: finalText,
        source: item.input.source,
        outcome: outcome.status === 'success' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed',
        summary,
      })
      void this.refreshUsage()
    } catch (error) {
      this.retryAt = Date.now() + 5_000
      await this.queue
        .reconcile(this.nativeUsersForQueue())
        .then(async () => {
          if (
            !this.turnAbort?.signal.aborted &&
            error instanceof Error &&
            (error.message === 'invalid-attachment' || error.message === 'pdf-unreadable')
          ) {
            await this.queue.failAttachment(item.id, error.message)
            this.retryAt = 0
            this.publish({ type: 'reset' })
          }
        })
        .catch(() => {
          console.error(JSON.stringify({ component: 'bot-instance', level: 'error', message: 'Input recovery failed' }))
        })
      const cancelled = this.turnAbort?.signal.aborted === true
      await this.system(
        cancelled ? 'turn_cancelled' : 'turn_failed',
        cancelled ? null : error instanceof Error ? error.message.slice(0, 400) : 'Turn failed.',
        null
      )
      this.publish({
        type: 'turn.finished',
        inputId: item.id,
        text: null,
        source: item.input.source,
        outcome: cancelled ? 'cancelled' : 'failed',
        summary: null,
      })
    } finally {
      release?.()
      this.turning = false
      this.cancelling = false
      this.turnStartedAt = null
      this.turnInputId = null
      this.turnAbort = null
      this.activeTool = null
      settle()
      this.changed()
      if (this.queue.list().some((candidate) => !candidate.attachmentError)) void this.tick()
    }
  }
  async cancel(): Promise<void> {
    if (!this.primaryConversationId || !this.turning) return
    this.cancelling = true
    this.turnAbort?.abort()
    await stopChatAndWait(this.primaryConversationId)
    this.changed()
  }
  async hold(reason: 'takeover' | 'paused'): Promise<FleetInstanceHold> {
    const wasHeld = this.holdManager.state.state !== 'none'
    const state = await this.holdManager.hold(reason, this.turning, () => this.cancel())
    if (!wasHeld) await this.system(reason === 'takeover' ? 'takeover' : 'paused', null, null)
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
    const needsContinuation = value.continue && (previous.interruptedTurn || this.help.pending().length > 0)
    if (needsContinuation)
      await this.input({
        source: 'continuation',
        text: continuationText(previous.reason ?? 'takeover', value.durationMs, value.note),
        attachments: [],
        idempotencyKey: (this.releaseContinuationKey ??= randomUUID()),
      })
    await this.help.resolveAll(value.note)
    await this.system(releaseSystemCode(previous.reason), value.note, value.durationMs)
    const result = this.holdManager.release()
    this.releaseContinuationKey = null
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
      const item = this.extras.list().find((entry) => entry.kind === 'question' && entry.toolCallId === id)
      if (item?.kind === 'question')
        await this.extras.upsert({
          ...item,
          state: value.kind === 'question' ? 'answered' : 'dismissed',
          answers: value.kind === 'question' ? value.answers : null,
        })
      getChatQuestionBroker().reply(id, value.kind === 'question' ? value.answers : [])
    } else if (pending.kind === 'help' && value.kind === 'help') {
      await this.help.resolve(id, value.note)
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
        else if (this.turning || this.manualCompacting) result = { ok: false, error: 'busy' }
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
    durationMs: number | null
  ): Promise<void> {
    if (this.disposed) return
    await this.extras.upsert({
      kind: 'system',
      id: 'system:' + randomUUID(),
      at: new Date().toISOString(),
      code,
      text,
      durationMs,
    })
  }
  /** The environment routes permission and question events of this bot's conversation here. */
  permissionAsked(request: PermissionRequest): void {
    if (this.disposed || request.conversationId !== this.primaryConversationId) return
    const at = new Date().toISOString()
    this.permissionAt.set(request.id, at)
    void this.extras
      .upsert({
        kind: 'permission',
        id: 'perm:' + request.id,
        at,
        requestId: request.id,
        title: request.title,
        detail: request.resources.join(', ') || null,
        tool: this.permissionToolFor(request),
        state: 'pending',
        resolvedAt: null,
      })
      .then(() => this.changed())
  }
  permissionResolved(event: { requestId: string; conversationId: string; decision: 'allow' | 'deny' }): void {
    if (this.disposed || event.conversationId !== this.primaryConversationId) return
    this.permissionTools.delete(event.requestId)
    const item = this.extras.list().find((entry) => entry.kind === 'permission' && entry.requestId === event.requestId)
    if (item?.kind === 'permission')
      void this.extras
        .upsert({
          ...item,
          state: event.decision === 'allow' ? 'approved' : 'denied',
          resolvedAt: new Date().toISOString(),
        })
        .then(() => this.changed())
  }
  questionAsked(event: { conversationId: string; toolCallId: string }): void {
    if (this.disposed || event.conversationId !== this.primaryConversationId) return
    const pending = getChatQuestionBroker()
      .pendingQuestionsFor(event.conversationId)
      .find((entry) => entry.toolCallId === event.toolCallId)
    if (!pending) return
    const at = new Date().toISOString()
    this.questionAt.set(event.toolCallId, at)
    void this.extras
      .upsert({
        kind: 'question',
        id: 'question:' + event.toolCallId,
        at,
        toolCallId: event.toolCallId,
        questions: fleetQuestions(pending.questions),
        state: 'pending',
        answers: null,
      })
      .then(() => this.changed())
  }
  questionAnswered(event: { conversationId: string; toolCallId: string }): void {
    if (this.disposed || event.conversationId !== this.primaryConversationId) return
    const item = this.extras.list().find((entry) => entry.kind === 'question' && entry.toolCallId === event.toolCallId)
    if (item?.kind === 'question' && item.state === 'pending')
      void this.extras.upsert({ ...item, state: 'dismissed', answers: null }).then(() => this.changed())
    else this.changed()
  }
  private onChatEvent(event: ChatStreamEvent): void {
    if (this.disposed) return
    if (event.kind === 'tool-call') {
      this.activeTool = { tool: event.toolName, target: toolTarget(event.input) }
      const id = this.primaryConversationId
      if (event.toolName.startsWith('browser_') && id) this.schedule(() => this.host.floatBrowser(id), 1_000)
      const request = presentationForTool(event.toolName, event.input)
      if (id && request) {
        if (presentsOnCompletion(event.toolName)) this.presentOnCompletion.set(event.toolCallId, request)
        else this.schedule(() => this.host.present?.(id, request), 1_000)
      }
    }
    if (event.kind === 'tool-state' && event.state.status !== 'running') {
      this.activeTool = null
      const request = this.presentOnCompletion.get(event.toolCallId)
      const id = this.primaryConversationId
      if (request && event.state.status !== 'pending' && event.state.status !== 'awaiting-permission') {
        this.presentOnCompletion.delete(event.toolCallId)
        if (event.state.status === 'completed' && id) this.host.present?.(id, request)
      }
    }
    if (event.kind === 'finish' || event.kind === 'aborted') this.presentOnCompletion.clear()
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
      if ('messageId' in event && event.messageId) this.live.touched(event.messageId)
      this.scheduleTranscriptRefresh()
    }
    this.changed()
  }
  /** Sends the transcript items that changed, at most every 250 ms. */
  private scheduleTranscriptRefresh(): void {
    if (this.transcriptTimer || this.disposed) return
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = null
      if (this.disposed) return
      void this.live.refresh().catch(() => undefined)
    }, 250)
  }
}
