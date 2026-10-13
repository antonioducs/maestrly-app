import { createHash, randomUUID } from 'node:crypto'
import {
  compareFleetTranscriptItems,
  FLEET_MESSAGE_TEXT_MAX,
  FLEET_TOOL_OUTPUT_MAX,
  MOBILE_BRIDGE_LIMITS,
  MOBILE_CHANNEL_KEYS,
  MOBILE_CHANNELS,
  MOBILE_EVENTS,
  type FleetImageRef,
  type FleetSelectionOption,
  type FleetTranscriptItem,
  type MobileArgs,
  type MobileAttachment,
  type MobileChannelKey,
  type MobileChatItem,
  type MobileChatPage,
  type MobileChatSetup,
  type MobileConversation,
  type MobileDispatchItem,
  type MobileEventKey,
  type MobileEventPayload,
  type MobileLists,
  type MobileResult,
  type MobileRuntime,
} from '@maestrly/bot-fleet-protocol'
import {
  applyChatEvent,
  mergePendingChatQuestions,
  toolOutputImages,
  toolOutputText,
  type ChatAttachmentInput,
  type ChatConfig,
  type ChatConvTools,
  type ChatHistoryPage,
  type ChatMessage,
  type ChatModelMeta,
  type ChatPermissionEvent,
  type ChatPermissionRequest,
  type ChatRuntimeState,
  type ChatSkillsState,
  type ChatStreamEvent,
  type MessagePart,
} from '../../../shared/chat'
import type { Conversation, ConversationStatus } from '../../../shared/conversation'
import {
  conversationDispatchBranchSlug,
  parseConversationDispatchBatchResult,
} from '../../../shared/conversation-dispatch'
import { imageId } from '../../fleet/instance/images'
import { permissionTool, projectChatMessages } from '../../fleet/instance/transcript'
import { registerRemoteUiTarget } from '../../remote-ui-targets'
import type { IpcHandlerTable } from '../ipc-handler-table'
import { VirtualSender } from './virtual-sender'

/** A mobile call that cannot be answered; `code` reaches the phone with the message. */
export class MobileApiError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'MobileApiError'
  }
}

export interface MobileApiDeps {
  table: IpcHandlerTable
  /** Sends an event to the phone. */
  emit: (channel: string, payload: unknown) => void
  /** The models the host's accounts offer; by default those server mode registered (`setHostModelOptions`). */
  selections?: (() => Promise<FleetSelectionOption[]>) | null
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  now?: () => number
  /** How long updates of an open conversation gather before they go out. */
  flushMs?: number
  /** How long a burst of list changes waits before the phone is told. */
  listsMs?: number
}

/**
 * The send requests each conversation admitted lately, by the phone's id for them. Kept by the host rather than by a
 * bridge session: a phone that lost its connection while sending resends on a new one, and must not send twice.
 */
const recentSends = new Map<string, string[]>()
const wasSent = (conversationId: string, clientId: string): boolean =>
  recentSends.get(conversationId)?.includes(clientId) === true
function noteSent(conversationId: string, clientId: string): void {
  const keys = recentSends.get(conversationId) ?? []
  keys.push(clientId)
  if (keys.length > MOBILE_BRIDGE_LIMITS.sendKeysKept) keys.shift()
  recentSends.delete(conversationId)
  recentSends.set(conversationId, keys)
  // Conversations least recently sent to are forgotten first.
  if (recentSends.size > 500) recentSends.delete(recentSends.keys().next().value as string)
}

let hostModelOptions: (() => Promise<FleetSelectionOption[]>) | null = null
/**
 * Server mode registers how its accounts list models (its environment runtime, as for bots), which phones choose
 * from. Without it the API lists the connected providers' models with no effort levels.
 */
export function setHostModelOptions(options: (() => Promise<FleetSelectionOption[]>) | null): void {
  hostModelOptions = options
}

/** The workspaces a host lists, with their conversations (the `workspace:list` answer). */
type HostWorkspace = { id: string; name: string; conversations: Conversation[] }
type ImageSource =
  | { kind: 'attachment' | 'generated'; conversationId: string; messageId: string; partId: string }
  | { kind: 'tool'; conversationId: string; messageId: string; toolPartId: string; imageId: string }

const iso = (time: number): string => new Date(Number.isFinite(time) && time > 0 ? time : 0).toISOString()
const STRUCTURAL = new Set<ChatStreamEvent['kind']>([
  'message-start',
  'finish',
  'aborted',
  'error',
  'steering-accepted',
  'compaction',
  'compaction-finished',
])
const STATUSES = new Set<ConversationStatus>(['idle', 'working', 'ready', 'waiting', 'asking', 'error'])

function mobileConversation(conversation: Conversation, workspaceName: string | null): MobileConversation {
  return {
    id: conversation.id,
    name: conversation.name,
    workspaceId: conversation.scope === 'project' ? conversation.workspaceId : null,
    workspaceName: conversation.scope === 'project' ? workspaceName : null,
    branch: conversation.scope === 'project' ? conversation.branch : null,
    status: STATUSES.has(conversation.status) ? conversation.status : 'idle',
    lastActivityAt: iso(conversation.lastActivityAt || conversation.createdAt),
    pinned: conversation.pinnedAt !== null && conversation.pinnedAt !== undefined,
    experience: conversation.scope === 'project' && conversation.experience === 'maestro' ? 'maestro' : 'standard',
  }
}

/** The conversations a phone may see: active ones, never a bot's. */
const visible = (conversation: Conversation): boolean => !conversation.archived && !conversation.botOrigin

/** One conversation a phone has open: its latest messages, live, and what it was last sent of them. */
class OpenConversation {
  messages: ChatMessage[] = []
  before: string | null = null
  permissions = new Map<string, FleetTranscriptItem>()
  streaming = false
  compacting = false
  plan: MobileRuntime['plan'] = null
  /** The JSON of each item last sent, to send only what changed. */
  sent = new Map<string, string>()
  lastRuntime = ''
  dirty = false
  flushTimer: ReturnType<typeof setTimeout> | null = null
  refetchTimer: ReturnType<typeof setTimeout> | null = null
  /** The time each message's items carry, kept while the conversation is open. */
  order = new Map<string, number>()
  constructor(readonly id: string) {}
}

/**
 * The mobile API of one phone's bridge session (see `MOBILE_CHANNELS`). It runs this host's own IPC handlers, as a
 * computer's bridge does, but through a virtual window of its own that the phone never addresses: the phone calls
 * versioned channels, and what the handlers and the rest of the main process push to that window becomes versioned
 * events. Chat messages go out as transcript items, projected as a bot's are.
 */
export class MobileApi {
  private readonly sender: VirtualSender
  private readonly unregister: () => void
  private readonly event: object
  private readonly open = new Map<string, OpenConversation>()
  private readonly images = new Map<string, ImageSource>()
  private listsTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly now: () => number
  private readonly flushMs: number
  private readonly listsMs: number

  constructor(private readonly deps: MobileApiDeps) {
    this.now = deps.now ?? Date.now
    this.flushMs = deps.flushMs ?? 120
    this.listsMs = deps.listsMs ?? 300
    this.sender = new VirtualSender((channel, args) => this.internal(channel, args[0]))
    // A main window of this host receives what the phone needs to hear about: statuses, lists, plans, settings.
    this.unregister = registerRemoteUiTarget(this.sender, { role: 'main' })
    const sender = this.sender
    this.event = {
      sender,
      senderFrame: null,
      processId: -1,
      frameId: -1,
      reply: (channel: string, ...args: unknown[]) => sender.send(channel, ...args),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const conversation of this.open.values()) this.forget(conversation)
    this.open.clear()
    if (this.listsTimer) clearTimeout(this.listsTimer)
    this.unregister()
    // Ends the chat subscriptions of the virtual window too.
    this.sender.destroy()
  }

  /** Answers one call of the phone; throws a `MobileApiError` (or the handler's error) when it cannot. */
  async invoke(channel: string, rawArgs: unknown[]): Promise<unknown> {
    const key = MOBILE_CHANNEL_KEYS.get(channel)
    if (!key) throw new MobileApiError('unknown-channel', 'Unknown channel')
    const parsed = MOBILE_CHANNELS[key].args.safeParse(rawArgs[0])
    if (!parsed.success) throw new MobileApiError('invalid', 'Invalid arguments')
    const result = await this.run(key, parsed.data as never)
    return result === undefined ? null : result
  }

  private run<K extends MobileChannelKey>(key: K, args: MobileArgs<K>): Promise<MobileResult<K>> {
    const handlers: { [P in MobileChannelKey]: (args: MobileArgs<P>) => Promise<MobileResult<P>> } = {
      lists: () => this.lists(),
      create: (value) => this.create(value),
      open: (value) => this.openConversation(value.conversationId),
      close: async (value) => {
        this.closeConversation(value.conversationId)
        return null
      },
      page: (value) => this.page(value.conversationId, value.before),
      send: (value) => this.send(value),
      stop: async (value) => {
        await this.call('chat:stop', value.conversationId)
        return null
      },
      rename: async (value) => {
        await this.call('conversation:rename', value.conversationId, value.name)
        this.listsChanged()
        return null
      },
      archive: async (value) => {
        await this.call('conversation:archive', value.conversationId, value.archived)
        this.listsChanged()
        return null
      },
      permission: async (value) => {
        await this.call('chat:permission-respond', value.requestId, value.reply)
        return null
      },
      question: async (value) => {
        await this.call('chat:question-respond', value.toolCallId, value.answers)
        return null
      },
      plan: (value) => this.decidePlan(value),
      setup: (value) => this.setup(value.conversationId),
      setSetup: (value) => this.setSetup(value),
      models: () => this.models(),
      defaults: () => this.defaults(),
      setDefaults: (value) => this.setDefaults(value),
      compact: async (value) => {
        const result = (await this.call('chat:compact', value.conversationId)) as {
          ok?: boolean
          error?: string
        } | null
        return { ok: result?.ok === true, ...(result?.error ? { error: String(result.error) } : {}) }
      },
      image: (value) => this.image(value.conversationId, value.imageId),
    }
    return (handlers[key] as (value: MobileArgs<K>) => Promise<MobileResult<K>>)(args)
  }

  private call(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.deps.table.get(channel)
    if (!handler) return Promise.reject(new MobileApiError('unavailable', `${channel} is not available on this host`))
    return Promise.resolve().then(() => handler.fn(this.event, ...args))
  }

  private emit<K extends MobileEventKey>(key: K, payload: MobileEventPayload<K>): void {
    if (!this.disposed) this.deps.emit(MOBILE_EVENTS[key].channel, payload)
  }

  // ---- Lists ----

  private async hostLists(): Promise<{ workspaces: HostWorkspace[]; chats: Conversation[] }> {
    const [workspaces, chats] = await Promise.all([
      this.call('workspace:list') as Promise<HostWorkspace[] | null>,
      this.call('conversation:list-standalone') as Promise<Conversation[] | null>,
    ])
    return { workspaces: workspaces ?? [], chats: chats ?? [] }
  }

  private async lists(): Promise<MobileLists> {
    const { workspaces, chats } = await this.hostLists()
    return {
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        defaultBranch: (workspace as { defaultBranch?: string | null }).defaultBranch ?? null,
        conversations: (workspace.conversations ?? [])
          .filter(visible)
          .map((conversation) => mobileConversation(conversation, workspace.name)),
      })),
      chats: chats.filter(visible).map((conversation) => mobileConversation(conversation, null)),
    }
  }

  private async findConversation(id: string): Promise<MobileConversation> {
    const { workspaces, chats } = await this.hostLists()
    const chat = chats.find((item) => item.id === id && visible(item))
    if (chat) return mobileConversation(chat, null)
    for (const workspace of workspaces) {
      const found = (workspace.conversations ?? []).find((item) => item.id === id && visible(item))
      if (found) return mobileConversation(found, workspace.name)
    }
    throw new MobileApiError('not-found', 'Unknown conversation')
  }

  private listsChanged(): void {
    if (this.listsTimer || this.disposed) return
    this.listsTimer = setTimeout(() => {
      this.listsTimer = null
      this.emit('lists', {})
    }, this.listsMs)
  }

  private async create(args: MobileArgs<'create'>): Promise<MobileConversation> {
    if (args.workspaceId === null) {
      if (args.experience === 'maestro') throw new MobileApiError('invalid', 'Maestro needs a workspace')
      const created = (await this.call(
        'conversation:create-standalone',
        args.name ? { name: args.name } : {}
      )) as Conversation
      this.listsChanged()
      return mobileConversation(created, null)
    }
    const { workspaces } = await this.hostLists()
    const workspace = workspaces.find((item) => item.id === args.workspaceId)
    if (!workspace) throw new MobileApiError('not-found', 'Unknown workspace')
    const branches = (await this.call('workspace:branches', workspace.id)) as { defaultBranch?: string } | null
    // A chat started from a phone works on a new branch of its own, from the workspace's default branch.
    const branch = `chat/${conversationDispatchBranchSlug(args.name ?? 'chat')}-${randomUUID().slice(0, 8)}`
    const created = (await this.call('conversation:create', {
      workspaceId: workspace.id,
      branch,
      isNewBranch: true,
      ...(branches?.defaultBranch ? { base: branches.defaultBranch } : {}),
      mode: 'worktree',
      experience: args.experience ?? 'standard',
      ...(args.name ? { name: args.name } : {}),
    })) as Conversation
    this.listsChanged()
    return mobileConversation(created, workspace.name)
  }

  // ---- Conversations ----

  private async openConversation(id: string): Promise<MobileResult<'open'>> {
    const conversation = await this.findConversation(id)
    let open = this.open.get(id)
    if (!open) {
      open = new OpenConversation(id)
      this.open.set(id, open)
      // A send handler: it answers nothing. Events of the conversation reach the virtual window from now on.
      await this.call('chat:subscribe', id)
    }
    const [page, runtime, plan, dispatch] = await Promise.all([
      this.call('chat:history:page', id, { limit: MOBILE_BRIDGE_LIMITS.pageSize }) as Promise<ChatHistoryPage>,
      this.call('chat:runtime', id) as Promise<ChatRuntimeState>,
      this.call('plan:get', id).catch(() => null) as Promise<{
        plan?: string
        title?: string
        version?: number
      } | null>,
      this.call('conversation-dispatch:status', id).catch(() => null) as Promise<{
        sourceConversationId?: string | null
      } | null>,
    ])
    open.messages = mergePendingChatQuestions(page?.messages ?? [], id, runtime?.pendingQuestions ?? [])
    open.before = page?.hasMore && page.earliestSeq !== null ? `seq-${page.earliestSeq}` : null
    open.streaming = runtime?.streaming === true
    open.compacting = runtime?.compacting === true
    open.plan = plan?.plan ? { version: plan.version ?? 1, title: plan.title ?? null, text: plan.plan } : null
    open.permissions.clear()
    for (const request of runtime?.pendingPermissions ?? []) this.addPermission(open, request)
    const items = this.items(open)
    open.sent = new Map(items.map((item) => [item.id, JSON.stringify(item)]))
    const current = this.runtime(open)
    open.lastRuntime = JSON.stringify(current)
    return {
      conversation,
      sourceConversationId: dispatch?.sourceConversationId ?? null,
      page: { items, before: open.before },
      runtime: current,
    }
  }

  private closeConversation(id: string): void {
    const open = this.open.get(id)
    if (!open) return
    this.open.delete(id)
    this.forget(open)
  }

  private forget(open: OpenConversation): void {
    if (open.flushTimer) clearTimeout(open.flushTimer)
    if (open.refetchTimer) clearTimeout(open.refetchTimer)
    open.flushTimer = open.refetchTimer = null
    void this.call('chat:unsubscribe', open.id).catch(() => undefined)
  }

  private async page(id: string, before: string): Promise<MobileChatPage> {
    const match = /^seq-(\d+)$/.exec(before)
    if (!match) throw new MobileApiError('invalid', 'Invalid page cursor')
    const page = (await this.call('chat:history:page', id, {
      beforeSeq: Number(match[1]),
      limit: MOBILE_BRIDGE_LIMITS.pageSize,
    })) as ChatHistoryPage
    return {
      items: this.project(id, page?.messages ?? []),
      before: page?.hasMore && page.earliestSeq !== null ? `seq-${page.earliestSeq}` : null,
    }
  }

  private async send(args: MobileArgs<'send'>): Promise<MobileResult<'send'>> {
    const open = this.open.get(args.conversationId)
    if (wasSent(args.conversationId, args.clientId)) return { status: 'duplicate' }
    let result: { ok?: boolean; error?: string } | null
    try {
      result = (await this.call('chat:send', {
        conversationId: args.conversationId,
        text: args.text,
        attachments: args.attachments.map(chatAttachment),
      })) as { ok?: boolean; error?: string } | null
    } catch (error) {
      throw new MobileApiError(
        (error as { code?: unknown }).code === 'invalid-attachment' ? 'invalid-attachment' : 'send-failed',
        error instanceof Error ? error.message : String(error)
      )
    }
    if (!result?.ok)
      throw new MobileApiError(result?.error ?? 'send-failed', result?.error ?? 'The message was not sent')
    noteSent(args.conversationId, args.clientId)
    // The message the host admitted is in the latest page; the stream carries the answer.
    if (open) this.refetch(open)
    return { status: 'started' }
  }

  private async decidePlan(args: MobileArgs<'plan'>): Promise<MobileResult<'plan'>> {
    const result = (await this.call('plan:decide', args.conversationId, {
      action: args.action,
      ...(args.feedback ? { feedback: args.feedback } : {}),
    })) as { ok?: boolean; error?: string } | null | undefined
    // The broker answers nothing when there was no plan left to decide.
    if (result && result.ok === false) return { ok: false, error: String(result.error ?? 'plan-failed') }
    return { ok: true }
  }

  // ---- Setup ----

  private async setup(id: string): Promise<MobileChatSetup> {
    const conversation = await this.findConversation(id)
    const [mode, permMode, selection, reasoning, fastMode, tools, skills, config, subagents] = await Promise.all([
      this.call('chat:get-mode', id),
      this.call('chat:get-perm-mode', id),
      this.call('chat:get-selection', id),
      this.call('chat:get-reasoning', id),
      this.call('chat:get-fast-mode', id),
      this.call('chat:get-conv-tools', id) as Promise<ChatConvTools | null>,
      this.call('chat:skills:state', id) as Promise<ChatSkillsState | null>,
      this.call('chat:config') as Promise<ChatConfig | null>,
      this.call('chat:subagent-profiles:get-conversation', id).catch(() => null) as Promise<{
        subagentsEnabled?: boolean
      } | null>,
    ])
    const ref = selection as { providerId?: string; modelId?: string } | null
    const model = ref?.providerId && ref.modelId ? { providerId: ref.providerId, modelId: ref.modelId } : null
    const [meta, limit] = model
      ? await Promise.all([
          this.call('chat:model-meta', model.modelId, model.providerId).catch(
            () => null
          ) as Promise<ChatModelMeta | null>,
          this.call('chat:context-limit:get', model.providerId, model.modelId).catch(() => null) as Promise<{
            limit?: number | null
            providerWindow?: number | null
            catalogWindow?: number | null
            effective?: number | null
          } | null>,
        ])
      : [null, null]
    const positive = (value: unknown) => (typeof value === 'number' && value > 0 ? Math.round(value) : null)
    const disabled = new Set(tools?.mcpDisabled ?? [])
    return {
      selection: model,
      reasoning: typeof reasoning === 'string' && reasoning ? reasoning : 'off',
      fastMode: fastMode === true,
      mode: mode === 'design' || mode === 'plan' || mode === 'ask' ? mode : 'agent',
      permMode: permMode === 'full' || permMode === 'auto' ? permMode : 'ask',
      experience: conversation.experience,
      ultra: meta?.nativeUltraMode ? 'native' : 'maestrly',
      tools: {
        app: tools?.app !== false,
        imageGen: tools?.imageGen !== false,
        subagents: subagents?.subagentsEnabled !== false,
      },
      contextLimit: model
        ? {
            limit: positive(limit?.limit),
            window: positive(limit?.providerWindow) ?? positive(limit?.catalogWindow) ?? positive(limit?.effective),
            editable: meta?.contextLimitEditable !== false,
          }
        : null,
      mcp: (config?.mcpServers ?? [])
        .filter((server) => server.enabled && !server.unavailable)
        .map((server) => ({ id: server.id, name: server.name, enabled: !disabled.has(server.id) })),
      skills: (skills?.skills ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description.slice(0, 2000),
        enabled: skill.enabled,
        override: skill.override === 'on' || skill.override === 'off' ? skill.override : null,
      })),
    }
  }

  private async setSetup({ conversationId: id, patch }: MobileArgs<'setSetup'>): Promise<MobileChatSetup> {
    const answer = (value: unknown) => {
      const result = value as { ok?: boolean; error?: string } | null | undefined
      if (result && result.ok === false)
        throw new MobileApiError(result.error ?? 'setup-failed', result.error ?? 'Not changed')
    }
    if (patch.selection) answer(await this.call('chat:set-selection', id, patch.selection))
    if (patch.reasoning) answer(await this.call('chat:set-reasoning', id, patch.reasoning))
    if (patch.fastMode !== undefined) answer(await this.call('chat:set-fast-mode', id, patch.fastMode))
    if (patch.mode) answer(await this.call('chat:set-mode', id, patch.mode))
    if (patch.permMode) answer(await this.call('chat:set-perm-mode', id, patch.permMode))
    if (patch.mcp) {
      const tools = (await this.call('chat:get-conv-tools', id)) as ChatConvTools | null
      const disabled = new Set(tools?.mcpDisabled ?? [])
      if (patch.mcp.enabled) disabled.delete(patch.mcp.id)
      else disabled.add(patch.mcp.id)
      answer(await this.call('chat:set-conv-tools', id, { mcpDisabled: [...disabled] }))
    }
    if (patch.skill) answer(await this.call('chat:skills:set-override', id, patch.skill.name, patch.skill.state))
    if (patch.skillsReset) answer(await this.call('chat:skills:reset-overrides', id))
    if (patch.tools?.app !== undefined || patch.tools?.imageGen !== undefined)
      answer(
        await this.call('chat:set-conv-tools', id, {
          ...(patch.tools.app !== undefined ? { app: patch.tools.app } : {}),
          ...(patch.tools.imageGen !== undefined ? { imageGen: patch.tools.imageGen } : {}),
        })
      )
    if (patch.tools?.subagents !== undefined)
      answer(await this.call('chat:subagents:set-conversation-enabled', id, patch.tools.subagents))
    if (patch.contextLimit !== undefined) {
      const selection = (await this.call('chat:get-selection', id)) as { providerId?: string; modelId?: string } | null
      if (!selection?.providerId || !selection.modelId)
        throw new MobileApiError('invalid', 'Choose a model before setting its context limit')
      answer(await this.call('chat:context-limit:set', selection.providerId, selection.modelId, patch.contextLimit))
    }
    return this.setup(id)
  }

  private async defaults(): Promise<MobileResult<'defaults'>> {
    const config = (await this.call('chat:config')) as ChatConfig | null
    return {
      selection: config?.defaultSelection
        ? { providerId: config.defaultSelection.providerId, modelId: config.defaultSelection.modelId }
        : null,
      reasoning: config?.defaultReasoning || 'off',
      fastMode: config?.defaultFastMode === true,
    }
  }

  private async setDefaults(args: MobileArgs<'setDefaults'>): Promise<MobileResult<'setDefaults'>> {
    const current = await this.defaults()
    const selection = args.selection ?? current.selection
    if (!selection) throw new MobileApiError('invalid', 'Choose a model for new chats first')
    const result = (await this.call('chat:set-default', {
      ...selection,
      ...(args.reasoning ? { reasoning: args.reasoning } : {}),
      ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
    })) as { ok?: boolean; error?: string } | null
    if (result && result.ok === false)
      throw new MobileApiError(result.error ?? 'setup-failed', result.error ?? 'Not changed')
    return this.defaults()
  }

  private async models(): Promise<MobileResult<'models'>> {
    const config = (await this.call('chat:config')) as ChatConfig | null
    const defaultSelection = config?.defaultSelection
      ? { providerId: config.defaultSelection.providerId, modelId: config.defaultSelection.modelId }
      : null
    const selections = this.deps.selections === undefined ? hostModelOptions : this.deps.selections
    if (selections) return { options: await selections(), defaultSelection }
    // Outside server mode (tests, development): the connected providers' models, without effort levels.
    const providers = (config?.providers ?? []).filter((provider) => provider.connected ?? provider.apiKeyPresent)
    const lists = await Promise.all(
      providers.map(async (provider) => {
        const models = ((await this.call('chat:models', provider.id).catch(() => [])) as string[] | null) ?? []
        return models.map((modelId) => ({
          id: `${provider.id}::${modelId}`,
          providerId: provider.id,
          providerLabel: provider.name,
          modelId,
          modelLabel: modelId,
          efforts: [],
          fastMode: false,
        }))
      })
    )
    return { options: lists.flat(), defaultSelection }
  }

  private async image(conversationId: string, id: string): Promise<MobileResult<'image'>> {
    const source = this.images.get(id)
    if (!source || source.conversationId !== conversationId) throw new MobileApiError('not-found', 'Unknown image')
    const result = (await (source.kind === 'tool'
      ? this.call('chat:tool-image', {
          conversationId,
          messageId: source.messageId,
          toolPartId: source.toolPartId,
          imageId: source.imageId,
        })
      : this.call(source.kind === 'generated' ? 'chat:generated-image' : 'chat:attachment-image', {
          conversationId,
          messageId: source.messageId,
          partId: source.partId,
        }))) as { ok?: boolean; bytes?: Uint8Array; mediaType?: string; dataUrl?: string } | null
    if (!result?.ok) throw new MobileApiError('not-found', 'The image is no longer available')
    if (result.bytes)
      return { mediaType: result.mediaType ?? 'image/png', dataBase64: Buffer.from(result.bytes).toString('base64') }
    const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(result.dataUrl ?? '')
    if (!dataUrl) throw new MobileApiError('not-found', 'The image is no longer available')
    return { mediaType: dataUrl[1], dataBase64: dataUrl[2] }
  }

  // ---- Projection ----

  /**
   * The transcript items of messages, recording where each image they show comes from. Items are ordered by time, and
   * a turn's answer may be stamped a moment before the message it answers was saved: each message is given a time
   * after the one before it in the history's order, and keeps it (`order`) while the conversation stays open.
   */
  private project(
    conversationId: string,
    raw: ChatMessage[],
    order: Map<string, number> | null = null
  ): MobileChatItem[] {
    let previous = -Infinity
    const messages = raw.map((message) => {
      const time = order?.get(message.id) ?? Math.max(message.createdAt, previous + 1)
      order?.set(message.id, time)
      previous = time
      // A transcript's user item holds at most FLEET_MESSAGE_TEXT_MAX characters; a longer paste would drop the item.
      const parts =
        message.role === 'user' &&
        message.parts.some((part) => part.type === 'text' && part.text.length > FLEET_MESSAGE_TEXT_MAX)
          ? message.parts.map((part) =>
              part.type === 'text' && part.text.length > FLEET_MESSAGE_TEXT_MAX
                ? { ...part, text: part.text.slice(0, FLEET_MESSAGE_TEXT_MAX - 1) + '…' }
                : part
            )
          : message.parts
      return time === message.createdAt && parts === message.parts ? message : { ...message, createdAt: time, parts }
    })
    const owner = new Map<Extract<MessagePart, { type: 'tool' }>, ChatMessage>()
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === 'tool') owner.set(part, message)
        else if (part.type === 'file' && part.kind === 'image')
          this.images.set(imageId('a', message.id, part.id), {
            kind: 'attachment',
            conversationId,
            messageId: message.id,
            partId: part.id,
          })
        else if (part.type === 'generated-image')
          this.images.set(imageId('g', message.id, part.id), {
            kind: 'generated',
            conversationId,
            messageId: message.id,
            partId: part.id,
          })
      }
    }
    const projected = projectChatMessages(messages, [], (part) => {
      const message = owner.get(part)
      if (!message || (part.state.status !== 'completed' && part.state.status !== 'running')) return []
      return toolOutputImages(part.state.output)
        .slice(0, 8)
        .flatMap((image): FleetImageRef[] => {
          if (!/^image\/(png|jpeg|webp|gif)$/.test(image.mediaType)) return []
          const id =
            't-' +
            createHash('sha256')
              .update(conversationId + '\0' + image.id)
              .digest('base64url')
              .slice(0, 32)
          this.images.set(id, {
            kind: 'tool',
            conversationId,
            messageId: message.id,
            toolPartId: part.id,
            imageId: image.id,
          })
          return [
            {
              id,
              mediaType: image.mediaType as FleetImageRef['mediaType'],
              byteSize: image.byteSize ?? null,
              name: image.name ?? null,
            },
          ]
        })
    })
    const items: MobileChatItem[] = projected.map((item) => this.dispatchItem(item, messages) ?? item)
    // How a turn ended when it did not end well: the desktop shows it under the answer, and so does the phone.
    for (const message of messages) {
      if (message.role !== 'assistant' || message.internal) continue
      const code = message.error ? 'turn_failed' : message.finishReason === 'aborted' ? 'turn_cancelled' : null
      if (code)
        items.push({
          kind: 'system',
          id: `${message.id}:end`,
          at: new Date(message.createdAt).toISOString(),
          code,
          text: message.error ? message.error.slice(0, 500) : null,
          durationMs: message.responseDurationMs ?? null,
        })
    }
    return items.sort(compareFleetTranscriptItems)
  }

  /** A `start_conversations` call as the card of the conversations it started. */
  private dispatchItem(item: FleetTranscriptItem, messages: ChatMessage[]): MobileDispatchItem | null {
    if (item.kind !== 'tool' || item.name !== 'start_conversations') return null
    const at = item.id.lastIndexOf(':')
    const message = messages.find((entry) => entry.id === item.id.slice(0, at))
    const part = message?.parts[Number(item.id.slice(at + 1))]
    const output =
      part?.type === 'tool' && part.state.status === 'completed'
        ? toolOutputText(part.state.output)
        : (item.output ?? '')
    const result = parseConversationDispatchBatchResult(output.slice(0, FLEET_TOOL_OUTPUT_MAX * 20))
    return {
      kind: 'dispatch',
      id: item.id,
      at: item.at,
      state: item.state === 'running' ? 'running' : item.state === 'done' && result ? 'done' : 'error',
      conversations: (result?.items ?? []).slice(0, 50).map((entry) => ({
        conversationId: entry.conversationId ?? null,
        title: entry.conversationName ?? entry.title,
        status: entry.status,
        workspaceName: null,
        error: entry.error ? entry.error.slice(0, 1000) : null,
      })),
    }
  }

  private addPermission(open: OpenConversation, request: ChatPermissionRequest): void {
    open.permissions.set(request.id, {
      kind: 'permission',
      id: 'perm:' + request.id,
      at: new Date(this.now()).toISOString(),
      requestId: request.id,
      title: request.title,
      detail: request.resources.join(', ') || null,
      tool: permissionTool(request, open.messages),
      state: 'pending',
      resolvedAt: null,
    })
  }

  private items(open: OpenConversation): MobileChatItem[] {
    const permissions = [...open.permissions.values()].sort(compareFleetTranscriptItems)
    return [...this.project(open.id, open.messages, open.order), ...permissions]
  }

  private runtime(open: OpenConversation): MobileRuntime {
    let context: MobileRuntime['context'] = null
    for (let index = open.messages.length - 1; index >= 0 && !context; index--) {
      const snapshot = open.messages[index].contextSnapshot
      if (snapshot)
        context = {
          usedTokens: Math.max(0, Math.round(snapshot.usedTokens)),
          windowTokens:
            snapshot.modelContextWindow && snapshot.modelContextWindow > 0
              ? Math.round(snapshot.modelContextWindow)
              : null,
          quality: snapshot.quality,
        }
    }
    return { streaming: open.streaming, compacting: open.compacting, plan: open.plan, context }
  }

  // ---- What the host pushes ----

  private internal(channel: string, payload: unknown): void {
    if (this.disposed) return
    if (channel.startsWith('chat:delta:'))
      return this.delta(channel.slice('chat:delta:'.length), payload as ChatStreamEvent)
    if (channel.startsWith('chat:permission:'))
      return this.permission(channel.slice('chat:permission:'.length), payload as ChatPermissionEvent)
    if (channel === 'agent:status') {
      const value = payload as { agentId?: unknown; status?: unknown } | null
      if (typeof value?.agentId === 'string' && STATUSES.has(value.status as ConversationStatus))
        this.emit('status', { conversationId: value.agentId, status: value.status as ConversationStatus })
      return
    }
    if (
      channel === 'workspace:changed' ||
      channel === 'conversation:open' ||
      channel === 'conversation-dispatch:changed'
    )
      return this.listsChanged()
    if (channel === 'plan:received' || channel === 'plan:cleared') {
      const value = payload as { agentId?: string; plan?: string; title?: string; version?: number } | null
      const open = value?.agentId ? this.open.get(value.agentId) : undefined
      if (!open) return
      open.plan =
        channel === 'plan:received' && value?.plan
          ? { version: value.version ?? 1, title: value.title ?? null, text: value.plan }
          : null
      return this.schedule(open)
    }
    for (const prefix of ['chat:settings:', 'chat:mode:'])
      if (channel.startsWith(prefix)) return this.emit('setup', { conversationId: channel.slice(prefix.length) })
  }

  private delta(id: string, event: ChatStreamEvent): void {
    const open = this.open.get(id)
    if (!open || !event || typeof event !== 'object') return
    if (event.kind === 'message-start') open.streaming = true
    if (event.kind === 'finish' || event.kind === 'aborted' || event.kind === 'error') open.streaming = false
    if (event.kind === 'compaction-progress')
      open.compacting = event.progress.status === 'running' || event.progress.status === 'retrying'
    if (event.kind === 'compaction-finished') open.compacting = false
    try {
      open.messages = applyChatEvent(open.messages, event)
    } catch (error) {
      this.deps.log('warn', `Mobile mirror could not apply ${event.kind}: ${(error as Error).message}`)
    }
    // A turn's start and end can bring messages the stream does not carry (another computer's, the admitted input).
    if (STRUCTURAL.has(event.kind)) this.refetch(open)
    this.schedule(open)
  }

  private permission(id: string, event: ChatPermissionEvent): void {
    const open = this.open.get(id)
    if (!open || !event) return
    if (event.kind === 'request') this.addPermission(open, event.request)
    else {
      const item = open.permissions.get(event.requestId)
      if (item?.kind === 'permission')
        open.permissions.set(event.requestId, {
          ...item,
          state: event.decision === 'allow' ? 'approved' : 'denied',
          resolvedAt: new Date(this.now()).toISOString(),
        })
    }
    this.schedule(open)
  }

  private refetch(open: OpenConversation): void {
    if (open.refetchTimer) return
    open.refetchTimer = setTimeout(async () => {
      open.refetchTimer = null
      if (this.open.get(open.id) !== open) return
      try {
        const [page, runtime] = await Promise.all([
          this.call('chat:history:page', open.id, { limit: MOBILE_BRIDGE_LIMITS.pageSize }) as Promise<ChatHistoryPage>,
          this.call('chat:runtime', open.id) as Promise<ChatRuntimeState>,
        ])
        if (this.open.get(open.id) !== open) return
        open.messages = mergePendingChatQuestions(page?.messages ?? [], open.id, runtime?.pendingQuestions ?? [])
        open.streaming = runtime?.streaming === true
        open.compacting = runtime?.compacting === true
        this.schedule(open)
      } catch (error) {
        this.deps.log('warn', `Mobile mirror could not reload ${open.id}: ${(error as Error).message}`)
      }
    }, this.flushMs * 2)
  }

  private schedule(open: OpenConversation): void {
    open.dirty = true
    if (open.flushTimer) return
    open.flushTimer = setTimeout(() => {
      open.flushTimer = null
      this.flush(open)
    }, this.flushMs)
  }

  private flush(open: OpenConversation): void {
    if (!open.dirty || this.open.get(open.id) !== open) return
    open.dirty = false
    const items = this.items(open)
    const changed: MobileChatItem[] = []
    for (const item of items) {
      const json = JSON.stringify(item)
      if (open.sent.get(item.id) === json) continue
      open.sent.set(item.id, json)
      changed.push(item)
    }
    const present = new Set(items.map((item) => item.id))
    const kept = new Set(open.messages.map((message) => message.id))
    // An item of a message still shown disappeared (an answer withdrawn after an error): the phone reloads.
    const vanished = [...open.sent.keys()].some(
      (itemId) =>
        !present.has(itemId) && !itemId.startsWith('perm:') && kept.has(itemId.slice(0, itemId.lastIndexOf(':')))
    )
    if (vanished) {
      open.sent = new Map(items.map((item) => [item.id, JSON.stringify(item)]))
      this.emit('reset', { conversationId: open.id })
    } else if (changed.length) this.emit('items', { conversationId: open.id, items: changed })
    const runtime = this.runtime(open)
    const runtimeJson = JSON.stringify(runtime)
    if (runtimeJson !== open.lastRuntime) {
      open.lastRuntime = runtimeJson
      this.emit('runtime', { conversationId: open.id, runtime })
    }
  }
}

/** A phone's attachment as `chat:send` admits it: text inline, images and PDFs as bytes. */
function chatAttachment(attachment: MobileAttachment): ChatAttachmentInput {
  const bytes = Buffer.from(attachment.dataBase64, 'base64')
  if (attachment.kind === 'text')
    return { name: attachment.name, mediaType: 'text/plain', kind: 'text', data: bytes.toString('utf8') }
  return {
    name: attachment.name,
    mediaType: attachment.kind === 'pdf' ? 'application/pdf' : attachment.mediaType,
    kind: attachment.kind,
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  }
}
