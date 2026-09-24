import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'
import {
  FLEET_PROTOCOL_VERSION,
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
  type FleetAddApiKeyAccountRequest,
  type FleetAddApiKeyAccountResponse,
} from '@maestrly/bot-fleet-protocol'
import type { ChatStreamEvent } from '../../../shared/chat'
import { getAppSetting, setAppSetting, getConversation, getConvUiPrefs, patchConvUiPrefs } from '../../store'
import { createStandaloneConversation } from '../../standalone-conversation-service'
import {
  acquireChatConversationSlot,
  getChatPermissionBroker,
  getChatQuestionBroker,
  listChatRunnerCapabilities,
  primeChatTurnSelection,
  publishConvChatSettings,
  startExecutorChatTurn,
  stopChatAndWait,
} from '../../chat/service'
import { listChatMessages } from '../../chat/chat-store'
import { addProvider, listProviders, removeProvider } from '../../chat/catalog'
import { apiKeyStorageMode, clearApiKey, hasApiKey, setApiKey } from '../../chat/credentials'
import { invalidateProvider } from '../../chat/provider'
import { invalidateModels } from '../../chat/models'
import { observeChatHost } from '../../chat/host-events'
import { InstanceHttpError, InstanceEvents, type InstanceControl } from './server'
import { InstanceInputQueue, promptForInput } from './queue'
import { InstanceHoldManager, registerInstanceHoldGate } from './gate'
import { InstanceTranscriptExtras, projectChatMessages, transcriptPage, fleetQuestions, toolTarget } from './transcript'
import { InstanceHelpStore } from './help'
import { setBotIdentity } from './identity'
import { broadcast } from '../../window-ipc'
import type { BotInstanceConfig } from './config'

export function canDispatch(
  ready: boolean,
  connected: boolean,
  running: boolean,
  hold: FleetInstanceHold['state']
): boolean {
  return ready && connected && !running && hold === 'none'
}

const PROFILE_KEY = 'fleet.instance.profile'
const PAUSED_KEY = 'fleet.instance.paused'
interface StoredProfile {
  profile: FleetInstanceProfile
  primaryConversationId: string | null
}
function readProfile(): StoredProfile | null {
  const raw = getAppSetting(PROFILE_KEY)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as StoredProfile
    return {
      profile: fleetInstanceProfileSchema.parse(value.profile),
      primaryConversationId: value.primaryConversationId,
    }
  } catch {
    throw new Error('Invalid persisted bot instance profile.')
  }
}
function writeProfile(value: StoredProfile): void {
  setAppSetting(PROFILE_KEY, JSON.stringify(value))
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

export class BotInstanceRuntime implements InstanceControl {
  readonly events = new InstanceEvents()
  readonly queue: InstanceInputQueue
  readonly extras: InstanceTranscriptExtras
  readonly help: InstanceHelpStore
  readonly holdManager: InstanceHoldManager
  private stored: StoredProfile | null
  private accountOptions: FleetSelectionOption[] = []
  private accountCheckedAt = 0
  private ready = false
  private turning = false
  private cancelling = false
  private turnStartedAt: string | null = null
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
  private permissionAt = new Map<string, string>()
  private questionAt = new Map<string, string>()
  private lastEmitted = new Map<string, string>()

  constructor(
    readonly config: BotInstanceConfig,
    private readonly window: BrowserWindow,
    private readonly floatBrowser?: (conversationId: string) => void
  ) {
    this.stored = readProfile()
    const base = app.getPath('userData')
    this.queue = new InstanceInputQueue(path.join(base, 'fleet-instance', 'inputs.json'))
    this.extras = new InstanceTranscriptExtras(path.join(base, 'fleet-instance', 'transcript.json'), (item) =>
      this.events.publish({ type: 'transcript.upsert', item })
    )
    this.help = new InstanceHelpStore(this.extras, () => this.changed())
    this.holdManager = new InstanceHoldManager(() => {
      if (this.holdManager.state.reason === 'paused') setAppSetting(PAUSED_KEY, '1')
      else if (this.holdManager.state.state === 'none') setAppSetting(PAUSED_KEY, '0')
      this.changed()
    })
  }
  get primaryConversationId(): string | null {
    return this.stored?.primaryConversationId ?? null
  }
  get gatewayConfig(): { url: string; token: string } | null {
    return this.config.gatewayUrl && this.config.gatewayToken
      ? { url: this.config.gatewayUrl, token: this.config.gatewayToken }
      : null
  }
  async start(): Promise<void> {
    await this.queue.load()
    await this.extras.load()
    for (const item of this.extras.list()) {
      if (item.kind === 'permission' && item.state === 'pending')
        await this.extras.upsert({ ...item, state: 'expired', resolvedAt: new Date().toISOString() })
      if (item.kind === 'question' && item.state === 'pending')
        await this.extras.upsert({ ...item, state: 'dismissed', answers: null })
    }
    const hadConversation = !!this.stored?.primaryConversationId
    if (getAppSetting(PAUSED_KEY) === '1') await this.holdManager.hold('paused', false, async () => {})
    if (!this.stored && this.config.id && this.config.name) {
      this.stored = {
        profile: {
          botId: this.config.id,
          name: this.config.name,
          instructions: '',
          ceiling: 'ask',
          selection: null,
          gateway: { peersEnabled: !!this.config.gatewayUrl },
        },
        primaryConversationId: null,
      }
      writeProfile(this.stored)
    }
    if (this.stored) await this.ensureConversation()
    if (this.primaryConversationId) await this.queue.reconcile(this.nativeUsers())
    if (hadConversation) await this.system('restarted', null, null)
    this.wireBrokers()
    this.ready = true
    await this.refreshAccounts()
    this.pollTimer = setInterval(() => {
      void this.tick()
    }, 1_000)
    this.changed()
    void this.tick()
  }
  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.statusTimer) clearTimeout(this.statusTimer)
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer)
    this.stopObserving?.()
    this.stopGate?.()
  }
  health(): { ok: true; appVersion: string; protocol: 1; ready: boolean } {
    return { ok: true, appVersion: app.getVersion(), protocol: FLEET_PROTOCOL_VERSION, ready: this.ready }
  }
  private async ensureConversation(): Promise<void> {
    if (!this.stored) return
    if (this.stored.primaryConversationId && !getConversation(this.stored.primaryConversationId))
      throw new Error('Persisted primary bot conversation is missing.')
    if (!this.stored.primaryConversationId) {
      const created = await createStandaloneConversation({ name: this.stored.profile.name })
      this.stored.primaryConversationId = created.id
      writeProfile(this.stored)
      await this.system('created', null, null)
    }
    this.applyProfile()
    const id = this.stored.primaryConversationId
    if (!this.floatAttempted) {
      this.floatAttempted = true
      setTimeout(() => this.floatBrowser?.(id), 2_000)
    }
    this.stopObserving?.()
    this.stopGate?.()
    this.stopObserving = observeChatHost(id, (event) => {
      if (event.channel === `chat:delta:${id}`) this.onChatEvent(event.payload as ChatStreamEvent)
    })
    this.stopGate = registerInstanceHoldGate(this.holdManager, id)
  }
  private applyProfile(): void {
    if (!this.stored?.primaryConversationId) return
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
    const conversation = getConversation(id)
    if (conversation) setBotIdentity(conversation.cwd, this.stored.profile)
    const selection = this.stored.profile.selection
    if (
      selection &&
      this.accountOptions.some(
        (option) => option.providerId === selection.providerId && option.modelId === selection.modelId
      )
    ) {
      primeChatTurnSelection(id, {
        providerId: selection.providerId,
        modelId: selection.modelId,
        reasoning: selection.reasoning ?? undefined,
        fastMode: selection.fastMode,
      })
    }
  }
  async profile(value: FleetInstanceProfile): Promise<FleetInstanceStatus> {
    const profile = fleetInstanceProfileSchema.parse(value)
    this.stored = { profile, primaryConversationId: this.stored?.primaryConversationId ?? null }
    writeProfile(this.stored)
    await this.ensureConversation()
    await this.refreshAccounts(true)
    this.changed()
    void this.tick()
    return this.status()
  }
  private async refreshAccounts(force = false): Promise<void> {
    if (!force && Date.now() - this.accountCheckedAt < 10_000) return
    this.accountCheckedAt = Date.now()
    const previous = JSON.stringify(this.accountOptions.map((option) => option.id))
    try {
      const models = await listChatRunnerCapabilities(true)
      this.accountOptions = models.map((model) => ({
        id: `${model.providerId}::${model.modelId}`,
        providerId: model.providerId,
        providerLabel: model.providerLabel,
        modelId: model.modelId,
        modelLabel: model.modelId,
        efforts: model.reasoningEfforts,
        fastMode: model.fastMode,
      }))
      this.applyProfile()
    } catch {
      this.accountOptions = []
    }
    if (JSON.stringify(this.accountOptions.map((option) => option.id)) !== previous) this.changed()
  }
  async selections(): Promise<{ options: FleetSelectionOption[]; current: FleetSelection | null }> {
    await this.refreshAccounts(true)
    return { options: this.accountOptions, current: this.stored?.profile.selection ?? null }
  }
  async addApiKeyAccount(value: FleetAddApiKeyAccountRequest): Promise<FleetAddApiKeyAccountResponse> {
    if (apiKeyStorageMode() !== 'secure')
      throw new InstanceHttpError(409, 'CONFLICT', 'Secure credential storage is unavailable.')
    const baseURL =
      value.baseURL ?? (value.kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')
    let provider: ReturnType<typeof addProvider>
    try {
      provider = addProvider({ name: value.name, baseURL, kind: value.kind })
    } catch {
      throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid provider configuration.')
    }
    if (setApiKey(provider.id, value.key) !== 'secure') {
      clearApiKey(provider.id)
      removeProvider(provider.id)
      throw new InstanceHttpError(409, 'CONFLICT', 'Secure credential storage is unavailable.')
    }
    this.changed()
    void this.refreshAccounts(true).then(() => {
      this.changed()
      void this.tick()
    })
    return { providerId: provider.id }
  }
  async removeAccount(providerId: string): Promise<void> {
    if (!listProviders().some((provider) => provider.id === providerId))
      throw new InstanceHttpError(404, 'NOT_FOUND', 'Account does not exist.')
    removeProvider(providerId)
    clearApiKey(providerId)
    invalidateProvider(providerId)
    invalidateModels(providerId)
    if (getAppSetting('chat.defaultProvider') === providerId) {
      setAppSetting('chat.defaultProvider', '')
      setAppSetting('chat.defaultModel', '')
      setAppSetting('chat.defaultReasoning', 'off')
    }
    this.accountOptions = this.accountOptions.filter((option) => option.providerId !== providerId)
    this.changed()
    void this.refreshAccounts(true).then(() => {
      this.changed()
      void this.tick()
    })
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
  async status(): Promise<FleetInstanceStatus> {
    await this.refreshAccounts()
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
    const queue = this.queue.list().map((item) => ({
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
          ? { kind: 'permission', title: pending[0].title }
          : pending[0]?.kind === 'question'
            ? { kind: 'question' }
            : pending[0]?.kind === 'help'
              ? { kind: 'help', reason: pending[0].reason }
              : !providers.length
                ? { kind: 'setup' }
                : this.activeTool
                  ? { kind: 'tool', ...this.activeTool }
                  : this.turning
                    ? { kind: 'thinking' }
                    : queue.length
                      ? { kind: 'queued', count: queue.length }
                      : { kind: 'idle', lastTurnSummary: this.lastSummary, lastTurnAt: this.lastTurnAt }
    return {
      appVersion: app.getVersion(),
      protocol: FLEET_PROTOCOL_VERSION,
      ready: this.ready,
      accounts: { connected: providers.length > 0, providers },
      selection: this.stored?.profile.selection ?? null,
      ceiling: this.stored?.profile.ceiling ?? 'ask',
      profile: this.stored ? { botId: this.stored.profile.botId, name: this.stored.profile.name } : null,
      conversationId: this.primaryConversationId,
      turn: {
        state: this.cancelling ? 'cancelling' : this.turning ? 'running' : 'idle',
        startedAt: this.turnStartedAt,
      },
      hold: this.holdManager.state,
      queue,
      activity,
      pending,
      lastEventSeq: this.events.lastSeq,
    }
  }
  private changed(): void {
    if (this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      void this.status().then((status) => {
        this.events.publish({ type: 'status', status })
      })
    }, 250)
  }
  async input(value: FleetInstanceInput): Promise<FleetInputReceipt> {
    if ((value.source === 'routine' && !value.routine) || (value.source === 'peer' && !value.peer))
      throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Input source metadata is missing.')
    const result = await this.queue.enqueue(value)
    const item = this.queue.all().find((candidate) => candidate.id === result.inputId)
    if (item && !item.started)
      this.events.publish({
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
    this.events.publish({ type: 'reset' })
    this.changed()
  }
  async transcript(before: string | null, limit: number) {
    const native = this.primaryConversationId
      ? projectChatMessages(listChatMessages(this.primaryConversationId), this.queue.all())
      : []
    const queued: FleetTranscriptItem[] = this.queue.list().map((entry) => ({
      kind: 'user',
      id: entry.itemId,
      at: entry.at,
      text: entry.input.text,
      source: entry.input.source,
      routine: entry.input.routine,
      peer: entry.input.peer,
      queued: true,
    }))
    const extra = this.extras.list()
    const questions = new Set(
      extra.filter((item) => item.kind === 'question').map((item) => (item.kind === 'question' ? item.toolCallId : ''))
    )
    return transcriptPage(
      [...native.filter((item) => item.kind !== 'question' || !questions.has(item.toolCallId)), ...queued, ...extra],
      before,
      limit
    )
  }
  private nativeUsers(): Array<{ id: string; at: number; text: string }> {
    if (!this.primaryConversationId) return []
    return listChatMessages(this.primaryConversationId)
      .filter((message) => message.role === 'user')
      .map((message) => ({
        id: message.id,
        at: message.createdAt,
        text: message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
      }))
  }
  private async tick(): Promise<void> {
    if (!this.primaryConversationId || Date.now() < this.retryAt) return
    await this.refreshAccounts()
    if (!canDispatch(this.ready, this.accountOptions.length > 0, this.turning, this.holdManager.state.state)) return
    const item = this.queue.list()[0]
    if (!item) return
    this.turning = true
    this.turnStartedAt = new Date().toISOString()
    this.turnAbort = new AbortController()
    this.changed()
    let release: (() => void) | null = null
    try {
      const id = this.primaryConversationId
      const slot = await acquireChatConversationSlot(id, this.turnAbort.signal)
      release = slot.release
      if (
        this.turnAbort.signal.aborted ||
        this.holdManager.state.state !== 'none' ||
        !this.queue.list().some((candidate) => candidate.id === item.id)
      )
        return
      this.applyProfile()
      await this.queue.markStarted(item.id)
      const handle = await startExecutorChatTurn({
        conversationId: id,
        prompt: promptForInput(item.input),
        signal: this.turnAbort.signal,
        slot,
      })
      release = null
      try {
        const nativeUser = [...this.nativeUsers()]
          .reverse()
          .find((user) => user.at >= Date.parse(item.at) - 1_000 && user.text === promptForInput(item.input))
        if (nativeUser) await this.queue.mapNativeMessage(item.id, nativeUser.id)
        const visibleUser = projectChatMessages(listChatMessages(id), this.queue.all()).find(
          (entry) => entry.id === item.itemId
        )
        if (visibleUser) this.events.publish({ type: 'transcript.upsert', item: visibleUser })
        this.changed()
      } catch (error) {
        handle.cancel()
        throw error
      }
      const outcome = await handle.done
      const page = await this.transcript(null, 500)
      const last = [...page.items]
        .reverse()
        .find((entry) => entry.kind === 'assistant' && entry.id.startsWith((outcome.assistantMessageId ?? '') + ':'))
      const summary = last?.kind === 'assistant' ? last.text.slice(0, 280) : null
      this.lastSummary = summary
      this.lastTurnAt = new Date().toISOString()
      this.retryAt = 0
      if (outcome.status !== 'success')
        await this.system(
          outcome.status === 'cancelled' ? 'turn_cancelled' : 'turn_failed',
          outcome.status === 'error' ? outcome.error.slice(0, 400) : null,
          null
        )
      this.events.publish({
        type: 'turn.finished',
        outcome: outcome.status === 'success' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed',
        summary,
      })
    } catch (error) {
      this.retryAt = Date.now() + 5_000
      await this.queue.reconcile(this.nativeUsers()).catch(() => {
        console.error(JSON.stringify({ component: 'bot-instance', level: 'error', message: 'Input recovery failed' }))
      })
      const cancelled = this.turnAbort?.signal.aborted === true
      await this.system(
        cancelled ? 'turn_cancelled' : 'turn_failed',
        cancelled ? null : error instanceof Error ? error.message.slice(0, 400) : 'Turn failed.',
        null
      )
      this.events.publish({ type: 'turn.finished', outcome: cancelled ? 'cancelled' : 'failed', summary: null })
    } finally {
      release?.()
      this.turning = false
      this.cancelling = false
      this.turnStartedAt = null
      this.turnAbort = null
      this.activeTool = null
      this.changed()
      if (this.queue.list().length) void this.tick()
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
    const needsContinuation = value.continue && (previous.interruptedTurn || this.help.pending().length > 0)
    await this.help.resolveAll(value.note)
    await this.system(releaseSystemCode(previous.reason), value.note, value.durationMs)
    const result = this.holdManager.release()
    if (needsContinuation)
      await this.input({
        source: 'continuation',
        text: continuationText(previous.reason ?? 'takeover', value.durationMs, value.note),
        idempotencyKey: randomUUID(),
      })
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
  async open(target: 'accounts' | 'main'): Promise<void> {
    this.window.show()
    this.window.focus()
    if (target === 'accounts') {
      broadcast('fleet:instance:open-accounts')
    }
  }
  private async system(
    code: Extract<FleetTranscriptItem, { kind: 'system' }>['code'],
    text: string | null,
    durationMs: number | null
  ): Promise<void> {
    await this.extras.upsert({
      kind: 'system',
      id: 'system:' + randomUUID(),
      at: new Date().toISOString(),
      code,
      text,
      durationMs,
    })
  }
  private wireBrokers(): void {
    const permission = getChatPermissionBroker()
    permission.on('asked', (request: { id: string; conversationId: string; title: string; resources: string[] }) => {
      if (request.conversationId !== this.primaryConversationId) return
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
          state: 'pending',
          resolvedAt: null,
        })
        .then(() => this.changed())
    })
    permission.on('resolved', (event: { requestId: string; conversationId: string; decision: 'allow' | 'deny' }) => {
      if (event.conversationId !== this.primaryConversationId) return
      const item = this.extras
        .list()
        .find((entry) => entry.kind === 'permission' && entry.requestId === event.requestId)
      if (item?.kind === 'permission')
        void this.extras
          .upsert({
            ...item,
            state: event.decision === 'allow' ? 'approved' : 'denied',
            resolvedAt: new Date().toISOString(),
          })
          .then(() => this.changed())
    })
    const questions = getChatQuestionBroker()
    questions.on('asked', (event: { conversationId: string; toolCallId: string }) => {
      if (event.conversationId !== this.primaryConversationId) return
      const pending = questions
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
    })
    questions.on('answered', (event: { conversationId: string; toolCallId: string }) => {
      if (event.conversationId !== this.primaryConversationId) return
      const item = this.extras
        .list()
        .find((entry) => entry.kind === 'question' && entry.toolCallId === event.toolCallId)
      if (item?.kind === 'question' && item.state === 'pending')
        void this.extras.upsert({ ...item, state: 'dismissed', answers: null }).then(() => this.changed())
      else this.changed()
    })
  }
  private onChatEvent(event: ChatStreamEvent): void {
    if (event.kind === 'tool-call') {
      this.activeTool = { tool: event.toolName, target: toolTarget(event.input) }
      if (event.toolName.startsWith('browser_') && this.primaryConversationId)
        setTimeout(() => this.floatBrowser?.(this.primaryConversationId!), 1_000)
    }
    if (event.kind === 'tool-state' && event.state.status !== 'running') this.activeTool = null
    if (
      event.kind === 'text-delta' ||
      event.kind === 'text-start' ||
      event.kind === 'tool-state' ||
      event.kind === 'tool-call' ||
      event.kind === 'finish' ||
      event.kind === 'aborted'
    ) {
      if (!this.transcriptTimer)
        this.transcriptTimer = setTimeout(() => {
          this.transcriptTimer = null
          if (!this.primaryConversationId) return
          const items = projectChatMessages(listChatMessages(this.primaryConversationId), this.queue.all())
          for (const item of items) {
            const serialized = JSON.stringify(item)
            if (this.lastEmitted.get(item.id) === serialized) continue
            this.lastEmitted.set(item.id, serialized)
            this.events.publish({ type: 'transcript.upsert', item })
          }
        }, 250)
    }
    this.changed()
  }
}
