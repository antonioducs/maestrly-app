import {
  compareFleetTranscriptItems,
  MOBILE_BRIDGE_LIMITS,
  MOBILE_CHANNELS,
  MobileBridgeError,
  type MobileArgs,
  type MobileChannelKey,
  type MobileChatItem,
  type MobileChatSetup,
  type MobileConversation,
  type MobileConversationStatus,
  type MobileEvent,
  type MobileEventKey,
  type MobileEventPayload,
  type MobileExperience,
  type MobileResult,
  type MobileRuntime,
} from '@maestrly/bot-fleet-protocol'
import type { ChatsHandlers, ChatsSource } from '../chats/source'
import {
  chatReply,
  DEMO_CHATS,
  DEMO_DEFAULTS,
  DEMO_MCP,
  DEMO_MODEL_INFO,
  DEMO_SKILLS,
  DEMO_WORKSPACES,
  PLAN_REVISE,
  workspaceReply,
  type ChatStep,
  type DemoSetup,
} from './chat-fixtures'
import { DEMO_SERVER } from './demo-source'
import { DEMO_OPTIONS } from './fixtures'

const PLACEHOLDER_IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+7dfwAJYAPdTr4y2gAAAABJRU5ErkJggg=='

type Pending =
  | { kind: 'permission'; itemId: string; allow: ChatStep[]; deny: ChatStep[] }
  | { kind: 'question'; itemId: string; next: (answer: string) => ChatStep[] }

type Chat = {
  conversation: MobileConversation
  sourceConversationId: string | null
  items: MobileChatItem[]
  setup: DemoSetup
  skills: Map<string, 'on' | 'off'>
  /** MCP servers this chat turned on or off, apart from the host's defaults. */
  mcp: Map<string, boolean>
  tools: { app: boolean; imageGen: boolean; subagents: boolean }
  usedTokens: number
  streaming: boolean
  compacting: boolean
  plan: { version: number; title: string; text: string; build: ChatStep[] } | null
  pending: Map<string, Pending>
  run: number
  sent: string[]
  named: boolean
}

const firstWords = (text: string) => {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ')
  return words.length > 48 ? `${words.slice(0, 47)}…` : words || 'New chat'
}

/**
 * A workspaces host that lives in memory, with the prototype's chats and workspaces and scripted replies. It answers
 * the mobile API as a real host does over the bridge, so the chat screens work in the web preview and in the demo.
 */
export function createDemoChatsSource(
  options: { stepMs?: number; readFile?: (uri: string) => Promise<string> } = {}
): ChatsSource {
  const scale = (options.stepMs ?? 1000) / 1000
  const start = Date.now()
  const listeners = new Set<ChatsHandlers>()
  const chats = new Map<string, Chat>()
  const images = new Map<string, { mediaType: string; dataBase64: string }>()
  const workspaces = DEMO_WORKSPACES
  let defaults = { ...DEMO_DEFAULTS }
  let seq = 0
  let clock = start

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms * scale))
  const stamp = () => {
    clock = Math.max(clock + 1, Date.now())
    return new Date(clock).toISOString()
  }
  const nextId = (chatId: string) => `${chatId}-x${++seq}`
  const emit = <K extends MobileEventKey>(key: K, payload: MobileEventPayload<K>) => {
    for (const listener of listeners) listener.onEvent({ key, payload } as MobileEvent)
  }

  for (const fixture of DEMO_CHATS) {
    const workspace = workspaces.find((item) => item.id === fixture.workspaceId)
    const base = start - fixture.minutesAgo * 60_000
    chats.set(fixture.id, {
      conversation: {
        id: fixture.id,
        name: fixture.name,
        workspaceId: fixture.workspaceId,
        workspaceName: workspace?.name ?? null,
        branch: fixture.branch,
        status: 'idle',
        lastActivityAt: new Date(base).toISOString(),
        pinned: false,
        experience: fixture.experience,
      },
      sourceConversationId: fixture.sourceConversationId ?? null,
      items: fixture.items.map(
        (item, index) =>
          ({
            ...item,
            id: `${fixture.id}-${index}`,
            at: new Date(base - (fixture.items.length - index) * 30_000).toISOString(),
          }) as MobileChatItem
      ),
      setup: { ...fixture.setup },
      skills: new Map(),
      mcp: new Map(),
      tools: { app: true, imageGen: true, subagents: true },
      usedTokens: fixture.usedTokens,
      streaming: false,
      compacting: false,
      plan: null,
      pending: new Map(),
      run: 0,
      sent: [],
      named: true,
    })
  }

  const requireChat = (id: string): Chat => {
    const chat = chats.get(id)
    if (!chat) throw new MobileBridgeError('not-found', 'Unknown conversation')
    return chat
  }
  const modelLabel = (setup: DemoSetup) => {
    const selection = setup.providerId ? setup : defaults
    return (
      DEMO_OPTIONS.find((option) => option.providerId === selection.providerId && option.modelId === selection.modelId)
        ?.modelLabel ?? 'the model'
    )
  }
  const runtimeOf = (chat: Chat): MobileRuntime => {
    const selection = chat.setup.providerId ? chat.setup : defaults
    return {
      streaming: chat.streaming,
      compacting: chat.compacting,
      plan: chat.plan ? { version: chat.plan.version, title: chat.plan.title, text: chat.plan.text } : null,
      context: {
        usedTokens: chat.usedTokens,
        windowTokens: DEMO_MODEL_INFO[`${selection.providerId}::${selection.modelId}`]?.window ?? null,
        quality: 'measured',
      },
    }
  }
  const sendRuntime = (chat: Chat) =>
    emit('runtime', { conversationId: chat.conversation.id, runtime: runtimeOf(chat) })
  const setStatus = (chat: Chat, status: MobileConversationStatus) => {
    chat.conversation = { ...chat.conversation, status, lastActivityAt: stamp() }
    emit('status', { conversationId: chat.conversation.id, status })
  }
  const upsert = (chat: Chat, item: MobileChatItem) => {
    const at = chat.items.findIndex((existing) => existing.id === item.id)
    if (at < 0) chat.items.push(item)
    else chat.items[at] = item
    chat.items.sort(compareFleetTranscriptItems)
    emit('items', { conversationId: chat.conversation.id, items: [item] })
  }

  async function stream(chat: Chat, text: string, alive: () => boolean) {
    const item = {
      id: nextId(chat.conversation.id),
      at: stamp(),
      kind: 'assistant' as const,
      text: '',
      streaming: true,
    }
    const words = text.match(/\s*\S+/g) ?? []
    for (let at = 0; at < words.length && alive(); at += 3) {
      item.text += words.slice(at, at + 3).join('')
      upsert(chat, { ...item })
      await sleep(45)
    }
    upsert(chat, { ...item, text: alive() ? text : item.text, streaming: false })
    chat.usedTokens += Math.round(text.length / 3)
  }

  function finish(chat: Chat, status: MobileConversationStatus) {
    chat.streaming = false
    setStatus(chat, status)
    sendRuntime(chat)
  }

  function dispatch(source: Chat, workspaceId: string, title: string, plan: string): MobileChatItem {
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0]
    const created = createChat(workspace.id, title, 'standard', source.setup)
    created.sourceConversationId = source.conversation.id
    created.named = true
    created.setup = { ...source.setup, mode: 'agent' }
    const userItem: MobileChatItem = {
      id: nextId(created.conversation.id),
      at: stamp(),
      kind: 'user',
      text: plan,
      source: 'owner',
      queued: false,
      memories: [],
      images: [],
    }
    created.items.push(userItem)
    emit('lists', {})
    void run(created, workspaceReply(workspace.name, 'agent', 'standard', plan))
    return {
      id: nextId(source.conversation.id),
      at: stamp(),
      kind: 'dispatch',
      state: 'done',
      conversations: [
        {
          conversationId: created.conversation.id,
          title,
          status: 'started',
          workspaceName: workspace.name,
          error: null,
        },
      ],
    }
  }

  async function run(chat: Chat, steps: ChatStep[]) {
    const token = ++chat.run
    const alive = () => chat.run === token
    chat.streaming = true
    setStatus(chat, 'working')
    sendRuntime(chat)
    for (const step of steps) {
      if (!alive()) return
      if ('think' in step) await sleep(step.think)
      else if ('tool' in step) {
        const tool = {
          id: nextId(chat.conversation.id),
          at: stamp(),
          kind: 'tool' as const,
          name: step.tool.name,
          target: step.tool.target,
          state: 'running' as const,
          output: null,
          images: [],
        }
        upsert(chat, tool)
        await sleep(step.ms ?? 1200)
        if (!alive()) return
        upsert(chat, { ...tool, state: step.fail ? 'error' : 'done', output: step.tool.output ?? null })
        chat.usedTokens += 1_500
      } else if ('todos' in step) {
        const lastUser = chat.items.map((item) => item.kind === 'user').lastIndexOf(true)
        const existing = chat.items
          .slice(lastUser + 1)
          .find((item) => item.kind === 'tool' && item.name === 'todo_write')
        upsert(chat, {
          ...(existing?.kind === 'tool'
            ? existing
            : {
                id: nextId(chat.conversation.id),
                at: stamp(),
                kind: 'tool' as const,
                name: 'todo_write',
                target: null,
                state: 'done' as const,
                output: null,
                images: [],
              }),
          todos: step.todos,
        })
      } else if ('say' in step) await stream(chat, step.say, alive)
      else if ('dispatch' in step) {
        const running: MobileChatItem = {
          id: nextId(chat.conversation.id),
          at: stamp(),
          kind: 'dispatch',
          state: 'running',
          conversations: [],
        }
        upsert(chat, running)
        await sleep(900)
        if (!alive()) return
        const done = dispatch(chat, step.dispatch.workspaceId, step.dispatch.title, step.dispatch.plan)
        upsert(chat, { ...done, id: running.id, at: running.at })
      } else if ('permission' in step) {
        const requestId = nextId(chat.conversation.id)
        const itemId = `perm:${requestId}`
        chat.pending.set(requestId, {
          kind: 'permission',
          itemId,
          allow: step.permission.allow,
          deny: step.permission.deny,
        })
        upsert(chat, {
          id: itemId,
          at: stamp(),
          kind: 'permission',
          requestId,
          title: step.permission.title,
          detail: step.permission.detail,
          tool: { name: 'bash', target: step.permission.target },
          state: 'pending',
          resolvedAt: null,
        })
        chat.streaming = true
        setStatus(chat, 'waiting')
        return
      } else if ('question' in step) {
        const toolCallId = nextId(chat.conversation.id)
        const itemId = nextId(chat.conversation.id)
        chat.pending.set(toolCallId, { kind: 'question', itemId, next: step.question.next })
        upsert(chat, {
          id: itemId,
          at: stamp(),
          kind: 'question',
          toolCallId,
          questions: step.question.questions,
          state: 'pending',
          answers: null,
        })
        setStatus(chat, 'asking')
        return
      } else if ('plan' in step) {
        chat.plan = { version: (chat.plan?.version ?? 0) + 1, ...step.plan }
        await stream(chat, 'The plan is ready for you to review.', alive)
        finish(chat, 'ready')
        return
      }
    }
    if (alive()) finish(chat, 'ready')
  }

  function cancel(chat: Chat) {
    chat.run++
    for (const item of chat.items) {
      if (item.kind === 'tool' && item.state === 'running') upsert(chat, { ...item, state: 'interrupted' })
      if (item.kind === 'assistant' && item.streaming) upsert(chat, { ...item, streaming: false })
    }
    for (const [id, pending] of chat.pending) {
      const item = chat.items.find((existing) => existing.id === pending.itemId)
      if (item?.kind === 'permission') upsert(chat, { ...item, state: 'expired', resolvedAt: stamp() })
      if (item?.kind === 'question') upsert(chat, { ...item, state: 'dismissed' })
      chat.pending.delete(id)
    }
    upsert(chat, {
      id: nextId(chat.conversation.id),
      at: stamp(),
      kind: 'system',
      code: 'turn_cancelled',
      text: null,
      durationMs: null,
    })
    finish(chat, 'idle')
  }

  function createChat(
    workspaceId: string | null,
    name: string | undefined,
    experience: MobileExperience,
    setup?: DemoSetup
  ): Chat {
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? null
    if (workspaceId !== null && !workspace) throw new MobileBridgeError('not-found', 'Unknown workspace')
    const id = `c-new-${++seq}`
    const slug =
      (name ?? 'chat')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30) || 'chat'
    const chat: Chat = {
      conversation: {
        id,
        name: name ?? 'New chat',
        workspaceId: workspace?.id ?? null,
        workspaceName: workspace?.name ?? null,
        branch: workspace ? `chat/${slug}-${id.slice(-4)}` : null,
        status: 'idle',
        lastActivityAt: stamp(),
        pinned: false,
        experience,
      },
      sourceConversationId: null,
      items: [],
      setup: setup ? { ...setup } : { ...defaults, mode: 'agent', permMode: 'ask' },
      skills: new Map(),
      mcp: new Map(),
      tools: { app: true, imageGen: true, subagents: true },
      usedTokens: 0,
      streaming: false,
      compacting: false,
      plan: null,
      pending: new Map(),
      run: 0,
      sent: [],
      named: name !== undefined,
    }
    chats.set(id, chat)
    return chat
  }

  function setupOf(chat: Chat): MobileChatSetup {
    const selection =
      chat.setup.providerId && chat.setup.modelId
        ? { providerId: chat.setup.providerId, modelId: chat.setup.modelId }
        : null
    const info = DEMO_MODEL_INFO[`${(selection ?? defaults).providerId}::${(selection ?? defaults).modelId}`]
    return {
      selection,
      reasoning: chat.setup.reasoning,
      fastMode: chat.setup.fastMode,
      mode: chat.setup.mode,
      permMode: chat.setup.permMode,
      experience: chat.conversation.experience,
      ultra: info?.ultra ?? 'maestrly',
      tools: { ...chat.tools },
      contextLimit: selection
        ? {
            limit: limits.get(`${selection.providerId}::${selection.modelId}`) ?? null,
            window: info?.window ?? null,
            editable: true,
          }
        : null,
      mcp: DEMO_MCP.map((server) => ({
        id: server.id,
        name: server.name,
        enabled: chat.mcp.get(server.id) ?? server.on,
      })),
      skills: DEMO_SKILLS.map((skill) => {
        const override = chat.skills.get(skill.name) ?? null
        return {
          name: skill.name,
          description: skill.description,
          enabled: override ? override === 'on' : skill.on,
          override,
        }
      }),
    }
  }
  const limits = new Map<string, number | null>()

  const lists = (): MobileResult<'lists'> => {
    const visible = [...chats.values()].map((chat) => chat.conversation)
    return {
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        defaultBranch: workspace.defaultBranch,
        conversations: visible.filter((conversation) => conversation.workspaceId === workspace.id),
      })),
      chats: visible.filter((conversation) => conversation.workspaceId === null),
    }
  }

  const page = (chat: Chat, before: string | null) => {
    const end = before ? chat.items.findIndex((item) => item.id === before) : chat.items.length
    const stop = end < 0 ? chat.items.length : end
    const items = chat.items.slice(Math.max(0, stop - MOBILE_BRIDGE_LIMITS.pageSize), stop)
    return { items, before: items.length && stop - items.length > 0 ? items[0].id : null }
  }

  function send(args: MobileArgs<'send'>): MobileResult<'send'> {
    const chat = requireChat(args.conversationId)
    if (chat.sent.includes(args.clientId)) return { status: 'duplicate' }
    if (chat.streaming || chat.compacting) throw new MobileBridgeError('busy', 'busy')
    chat.sent.push(args.clientId)
    const itemId = nextId(chat.conversation.id)
    const imagesOut = args.attachments
      .filter((attachment) => attachment.kind === 'image')
      .map((attachment, index) => {
        const id = `${itemId}-img${index}`
        images.set(id, { mediaType: attachment.mediaType, dataBase64: attachment.dataBase64 })
        return {
          id,
          mediaType: attachment.mediaType as 'image/png',
          byteSize: Math.floor((attachment.dataBase64.length * 3) / 4),
          name: attachment.name,
        }
      })
    const files = args.attachments
      .filter((attachment) => attachment.kind !== 'image')
      .map((attachment, index) => ({
        id: `${itemId}-file${index}`,
        name: attachment.name,
        mediaType: attachment.kind === 'pdf' ? 'application/pdf' : 'text/plain',
        byteSize: Math.floor((attachment.dataBase64.length * 3) / 4),
      }))
    upsert(chat, {
      id: itemId,
      at: stamp(),
      kind: 'user',
      text: args.text,
      source: 'owner',
      queued: false,
      memories: [],
      images: imagesOut,
      ...(files.length ? { files } : {}),
    })
    if (!chat.named) {
      chat.named = true
      chat.conversation = { ...chat.conversation, name: firstWords(args.text) }
      emit('lists', {})
    }
    const workspace = chat.conversation.workspaceName
    void run(
      chat,
      workspace
        ? workspaceReply(workspace, chat.setup.mode, chat.conversation.experience, args.text)
        : chatReply(args.text, modelLabel(chat.setup))
    )
    return { status: 'started' }
  }

  function resolvePermission(chat: Chat, requestId: string, reply: 'once' | 'always' | 'reject') {
    const pending = chat.pending.get(requestId)
    if (pending?.kind !== 'permission') return
    chat.pending.delete(requestId)
    const item = chat.items.find((existing) => existing.id === pending.itemId)
    const allowed = reply !== 'reject'
    if (item?.kind === 'permission')
      upsert(chat, { ...item, state: allowed ? 'approved' : 'denied', resolvedAt: stamp() })
    void run(chat, allowed ? pending.allow : pending.deny)
  }

  function answer(chat: Chat, toolCallId: string, answers: string[][]) {
    const pending = chat.pending.get(toolCallId)
    if (pending?.kind !== 'question') return
    chat.pending.delete(toolCallId)
    const item = chat.items.find((existing) => existing.id === pending.itemId)
    if (item?.kind === 'question')
      upsert(chat, answers.length ? { ...item, state: 'answered', answers } : { ...item, state: 'dismissed' })
    void run(
      chat,
      answers.length ? pending.next(answers.flat().join(', ')) : [{ say: "Okay, I'll leave it as it is." }]
    )
  }

  async function handle<K extends MobileChannelKey>(key: K, raw: MobileArgs<K>): Promise<MobileResult<K>> {
    // Arguments are checked as the host would, so a mistake in the app shows here too.
    const args: unknown = MOBILE_CHANNELS[key].args.parse(raw)
    const result = await answerCall(key, args)
    return MOBILE_CHANNELS[key].result.parse(result ?? null) as MobileResult<K>
  }

  async function answerCall(key: MobileChannelKey, args: unknown): Promise<unknown> {
    const a = args as Record<string, unknown>
    const chat = () => requireChat(String(a.conversationId))
    switch (key) {
      case 'lists':
        return lists()
      case 'create': {
        const experience = (a.experience as MobileExperience | undefined) ?? 'standard'
        if (a.workspaceId === null && experience === 'maestro')
          throw new MobileBridgeError('invalid', 'Maestro needs a workspace')
        const created = createChat(a.workspaceId as string | null, a.name as string | undefined, experience)
        emit('lists', {})
        return created.conversation
      }
      case 'open': {
        const current = chat()
        return {
          conversation: current.conversation,
          sourceConversationId: current.sourceConversationId,
          page: page(current, null),
          runtime: runtimeOf(current),
        }
      }
      case 'close':
        chat()
        return null
      case 'page':
        return page(chat(), String(a.before))
      case 'send':
        return send(args as MobileArgs<'send'>)
      case 'stop': {
        const current = chat()
        if (current.streaming) cancel(current)
        return null
      }
      case 'rename':
        chat().conversation = { ...chat().conversation, name: String(a.name) }
        chat().named = true
        emit('lists', {})
        return null
      case 'archive':
        chat()
        if (a.archived) chats.delete(String(a.conversationId))
        emit('lists', {})
        return null
      case 'permission':
        resolvePermission(chat(), String(a.requestId), a.reply as 'once' | 'always' | 'reject')
        return null
      case 'question':
        answer(chat(), String(a.toolCallId), a.answers as string[][])
        return null
      case 'plan': {
        const current = chat()
        const plan = current.plan
        if (!plan) return { ok: false, error: 'No plan to decide' }
        current.plan = null
        sendRuntime(current)
        if (a.action === 'approve') {
          current.setup = { ...current.setup, mode: 'agent' }
          emit('setup', { conversationId: current.conversation.id })
          void run(current, plan.build)
        } else if (a.action === 'revise') {
          if (a.feedback)
            upsert(current, {
              id: nextId(current.conversation.id),
              at: stamp(),
              kind: 'user',
              text: String(a.feedback),
              source: 'owner',
              queued: false,
              memories: [],
              images: [],
            })
          void run(current, PLAN_REVISE)
        }
        return { ok: true }
      }
      case 'setup':
        return setupOf(chat())
      case 'setSetup': {
        const current = chat()
        const patch = a.patch as MobileArgs<'setSetup'>['patch']
        if (patch.mode && current.conversation.experience === 'maestro')
          throw new MobileBridgeError('maestro-experience', 'maestro-experience')
        if (patch.selection)
          current.setup = { ...current.setup, providerId: patch.selection.providerId, modelId: patch.selection.modelId }
        if (patch.reasoning) current.setup.reasoning = patch.reasoning
        if (patch.fastMode !== undefined) current.setup.fastMode = patch.fastMode
        if (patch.mode) current.setup.mode = patch.mode
        if (patch.permMode) current.setup.permMode = patch.permMode
        if (patch.mcp) current.mcp.set(patch.mcp.id, patch.mcp.enabled)
        if (patch.skill) {
          if (patch.skill.state === 'inherit') current.skills.delete(patch.skill.name)
          else current.skills.set(patch.skill.name, patch.skill.state)
        }
        if (patch.skillsReset) current.skills.clear()
        if (patch.tools)
          current.tools = {
            ...current.tools,
            ...Object.fromEntries(Object.entries(patch.tools).filter(([, value]) => value !== undefined)),
          }
        if (patch.contextLimit !== undefined) {
          const selection = current.setup.providerId ? current.setup : null
          if (!selection) throw new MobileBridgeError('invalid', 'Choose a model before setting its context limit')
          limits.set(`${selection.providerId}::${selection.modelId}`, patch.contextLimit)
        }
        return setupOf(current)
      }
      case 'models':
        return {
          options: DEMO_OPTIONS,
          defaultSelection: { providerId: defaults.providerId, modelId: defaults.modelId },
        }
      case 'defaults':
        return {
          selection: { providerId: defaults.providerId, modelId: defaults.modelId },
          reasoning: defaults.reasoning,
          fastMode: defaults.fastMode,
        }
      case 'setDefaults': {
        const value = args as MobileArgs<'setDefaults'>
        defaults = {
          ...defaults,
          ...(value.selection ?? {}),
          ...(value.reasoning ? { reasoning: value.reasoning } : {}),
          ...(value.fastMode !== undefined ? { fastMode: value.fastMode } : {}),
        }
        return {
          selection: { providerId: defaults.providerId, modelId: defaults.modelId },
          reasoning: defaults.reasoning,
          fastMode: defaults.fastMode,
        }
      }
      case 'compact': {
        const current = chat()
        if (current.streaming) return { ok: false, error: 'busy' }
        if (current.usedTokens < 20_000) return { ok: false, error: 'nothing-to-compact' }
        current.compacting = true
        sendRuntime(current)
        setTimeout(() => {
          current.compacting = false
          current.usedTokens = Math.round(current.usedTokens * 0.2)
          upsert(current, {
            id: nextId(current.conversation.id),
            at: stamp(),
            kind: 'compaction',
            origin: 'manual',
            summary: null,
            truncated: false,
          })
          sendRuntime(current)
        }, 1600 * scale)
        return { ok: true }
      }
      case 'image': {
        chat()
        return images.get(String(a.imageId)) ?? { mediaType: 'image/png', dataBase64: PLACEHOLDER_IMAGE }
      }
    }
  }

  return {
    serverId: DEMO_SERVER.id,
    connect(handlers) {
      listeners.add(handlers)
      setTimeout(() => {
        if (!listeners.has(handlers)) return
        handlers.onState('open')
        handlers.onReady()
      }, 0)
      return {
        invoke: (key, args) =>
          listeners.has(handlers)
            ? handle(key, args)
            : Promise.reject(new MobileBridgeError('DISCONNECTED', 'Not connected to the host', true)),
        reconnectNow: () => {},
        close() {
          listeners.delete(handlers)
          handlers.onState('closed')
        },
      }
    },
    // The demo keeps what it is sent in memory, so photos show as they were taken.
    readAttachment: async (uri) => {
      if (uri.startsWith('data:')) return uri.slice(uri.indexOf(',') + 1)
      try {
        return options.readFile ? await options.readFile(uri) : PLACEHOLDER_IMAGE
      } catch {
        return PLACEHOLDER_IMAGE
      }
    },
  }
}
