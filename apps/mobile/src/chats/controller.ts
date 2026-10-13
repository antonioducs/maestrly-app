import {
  MobileBridgeError,
  type MobileArgs,
  type MobileChannelKey,
  type MobileChatSetupPatch,
  type MobileConversation,
  type MobileResult,
} from '@maestrly/bot-fleet-protocol'
import { sentMediaType, type OutboxAttachment } from '../fleet/attachments'
import { MissingFileError } from '../fleet/outbox'
import type { KeyValueStore } from '../servers/registry'
import { afterChatSendFailure, chatOutboxEntriesSchema, nextChatsToSend, type ChatOutboxEntry } from './outbox'
import type { ChatsConnection, ChatsHandlers, ChatsSource } from './source'
import { allConversations, chatsReducer, initialChatsState, type ChatsAction, type ChatsState } from './state'

export type ChatsControllerOptions = {
  uuid: () => string
  now?: () => number
  /** How long a waiting message waits before trying again. */
  retryMs?: number
  /** How long a burst of list changes waits before the lists are read again. */
  listsMs?: number
}

const IMAGES_KEPT = 60
export const chatOutboxKey = (serverId: string) => `chat-outbox.${serverId}`

/**
 * Keeps one server's chats live on the phone: the bridge to its workspaces host while the app is on screen, the lists,
 * the open chat, and the messages written while offline or while a chat's turn runs, which it sends in order.
 */
export function createChatsController(
  source: ChatsSource,
  persistence: KeyValueStore,
  options: ChatsControllerOptions
) {
  const now = options.now ?? Date.now
  const retryMs = options.retryMs ?? 4_000
  const listsMs = options.listsMs ?? 250
  const outboxKey = chatOutboxKey(source.serverId)
  let state: ChatsState = initialChatsState
  const listeners = new Set<() => void>()
  let connection: ChatsConnection | null = null
  let active = false
  let openId: string | null = null
  let listsTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let flushing = false
  let saving: Promise<void> = Promise.resolve()
  const images = new Map<string, Promise<{ mediaType: string; dataBase64: string }>>()

  const dispatch = (action: ChatsAction) => {
    state = chatsReducer(state, action)
    for (const listener of listeners) listener()
  }

  const persist = () => {
    const snapshot = JSON.stringify(state.outbox)
    saving = saving.then(() => persistence.set(outboxKey, snapshot)).catch(() => {})
    return saving
  }
  const setOutbox = (entries: ChatOutboxEntry[]) => {
    dispatch({ type: 'outbox', entries })
    return persist()
  }
  const replaceEntry = (entry: ChatOutboxEntry) =>
    setOutbox(state.outbox.map((item) => (item.id === entry.id ? entry : item)))

  async function loadOutbox() {
    const raw = await persistence.get(outboxKey).catch(() => null)
    if (!raw) return
    try {
      const parsed = chatOutboxEntriesSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) return
      // A send cut off by the app closing goes again: the host knows its send key and does not send it twice.
      dispatch({
        type: 'outbox',
        entries: parsed.data
          .filter((entry) => entry.serverId === source.serverId)
          .map((entry) => (entry.state === 'sending' ? { ...entry, state: 'waiting' } : entry)),
      })
    } catch {
      // A damaged list is dropped rather than blocking the app.
    }
  }

  function invoke<K extends MobileChannelKey>(key: K, args: MobileArgs<K>): Promise<MobileResult<K>> {
    if (!connection) return Promise.reject(new MobileBridgeError('DISCONNECTED', 'Not connected to the host', true))
    return connection.invoke(key, args)
  }

  async function refreshLists() {
    try {
      dispatch({ type: 'lists', lists: await invoke('lists', {}) })
    } catch {
      // The next welcome or list change reads them again.
    }
  }
  const scheduleLists = () => {
    if (listsTimer) return
    listsTimer = setTimeout(() => {
      listsTimer = null
      void refreshLists()
    }, listsMs)
  }

  async function loadLatest(conversationId: string) {
    dispatch({ type: 'view-loading', conversationId })
    try {
      const result = await invoke('open', { conversationId })
      dispatch({ type: 'view-open', conversationId, result })
    } catch (error) {
      dispatch({ type: 'view-failed', conversationId })
      if (error instanceof MobileBridgeError && error.code === 'not-found')
        dispatch({ type: 'removed', conversationId })
    }
  }

  async function loadSetup(conversationId: string) {
    const setup = await invoke('setup', { conversationId })
    dispatch({ type: 'setup', conversationId, setup })
    return setup
  }

  const handlers: ChatsHandlers = {
    onState(next, detail) {
      dispatch({
        type: 'bridge',
        state: next,
        retryAt: detail?.retryInMs !== undefined ? now() + detail.retryInMs : null,
        hostVersion: detail?.hostVersion ?? null,
      })
    },
    onReady() {
      void refreshLists()
      if (openId) void loadLatest(openId)
      void flush()
    },
    onEvent(event) {
      switch (event.key) {
        case 'items':
          dispatch({ type: 'items', conversationId: event.payload.conversationId, items: event.payload.items })
          return
        case 'runtime':
          dispatch({ type: 'runtime', conversationId: event.payload.conversationId, runtime: event.payload.runtime })
          if (!event.payload.runtime.streaming) void flush()
          return
        case 'status':
          // A chat the phone has not listed yet started (another computer, or an agent that started it).
          if (!allConversations(state.lists).some((item) => item.id === event.payload.conversationId)) scheduleLists()
          dispatch({ type: 'status', conversationId: event.payload.conversationId, status: event.payload.status })
          if (event.payload.status !== 'working') void flush()
          return
        case 'lists':
          scheduleLists()
          return
        case 'setup':
          if (state.setups[event.payload.conversationId]) void loadSetup(event.payload.conversationId).catch(() => {})
          return
        case 'reset':
          dispatch({ type: 'reset', conversationId: event.payload.conversationId })
          if (event.payload.conversationId === openId) void loadLatest(event.payload.conversationId)
          return
      }
    },
  }

  const busy = (conversationId: string) => {
    const runtime = state.views[conversationId]?.runtime
    return runtime?.streaming === true || runtime?.compacting === true
  }

  async function sendOne(entry: ChatOutboxEntry) {
    await replaceEntry({ ...entry, state: 'sending' })
    try {
      const attachments = await Promise.all(
        entry.attachments.map(async (item) => {
          const dataBase64 = await source.readAttachment(item.uri).catch(() => {
            throw new MissingFileError(item.name)
          })
          return { name: item.name, kind: item.kind, mediaType: sentMediaType(item), dataBase64 }
        })
      )
      await invoke('send', { conversationId: entry.conversationId, text: entry.text, attachments, clientId: entry.id })
      await setOutbox(state.outbox.filter((item) => item.id !== entry.id))
    } catch (error) {
      const current = state.outbox.find((item) => item.id === entry.id)
      if (current) await replaceEntry({ ...afterChatSendFailure(current, error), attempts: current.attempts + 1 })
    }
  }

  async function flush() {
    if (flushing || state.bridge !== 'open') return
    flushing = true
    const tried = new Set<string>()
    try {
      for (;;) {
        const batch = nextChatsToSend(state.outbox, source.serverId, busy).filter((entry) => !tried.has(entry.id))
        if (batch.length === 0 || state.bridge !== 'open') break
        for (const entry of batch) tried.add(entry.id)
        await Promise.all(batch.map(sendOne))
      }
    } finally {
      flushing = false
    }
    // A chat that was busy, or a send the connection cut, tries again shortly; a turn's end also flushes at once.
    const waiting = state.outbox.some((entry) => entry.serverId === source.serverId && entry.state === 'waiting')
    if (waiting && !retryTimer && state.bridge === 'open')
      retryTimer = setTimeout(() => {
        retryTimer = null
        void flush()
      }, retryMs)
  }

  function connect() {
    if (connection || !active || !state.hosted) return
    connection = source.connect(handlers)
  }
  function disconnect() {
    const current = connection
    connection = null
    current?.close()
    if (retryTimer) clearTimeout(retryTimer)
    if (listsTimer) clearTimeout(listsTimer)
    retryTimer = listsTimer = null
  }

  const assertOk = (result: { ok: boolean; error?: string }) => {
    if (!result.ok) throw new MobileBridgeError(result.error ?? 'failed', result.error ?? 'The host refused it')
    return result
  }

  return {
    store: {
      getState: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    async start() {
      await loadOutbox()
      active = true
      connect()
    },
    stop() {
      active = false
      disconnect()
    },
    /** Whether the server has a workspaces host; the bridge runs only while it does. */
    setHosted(hosted: boolean) {
      if (hosted === state.hosted) return
      if (!hosted) disconnect()
      dispatch({ type: 'hosted', hosted })
      if (hosted) connect()
    },
    foreground() {
      active = true
      if (connection) connection.reconnectNow()
      else connect()
    },
    background() {
      active = false
      disconnect()
    },
    /** Reads the lists again, such as when the menu opens: renames and new activity elsewhere are not announced. */
    refreshLists() {
      if (state.bridge === 'open') scheduleLists()
    },
    reconnectNow() {
      if (connection && (state.bridge === 'retrying' || state.bridge === 'unavailable')) connection.reconnectNow()
      else if (!connection) connect()
    },
    openConversation(conversationId: string) {
      const previous = openId
      openId = conversationId
      if (previous && previous !== conversationId) void invoke('close', { conversationId: previous }).catch(() => {})
      void loadLatest(conversationId)
    },
    closeConversation(conversationId: string) {
      if (openId !== conversationId) return
      openId = null
      void invoke('close', { conversationId }).catch(() => {})
    },
    async loadOlder(conversationId: string) {
      const view = state.views[conversationId]
      if (!view?.loaded || view.loading || !view.before) return
      dispatch({ type: 'view-loading', conversationId })
      try {
        dispatch({
          type: 'view-older',
          conversationId,
          page: await invoke('page', { conversationId, before: view.before }),
        })
      } catch {
        dispatch({ type: 'view-idle', conversationId })
      }
    },
    async create(args: MobileArgs<'create'>): Promise<MobileConversation> {
      const conversation = await invoke('create', args)
      dispatch({ type: 'conversation', conversation })
      return conversation
    },
    async send(conversationId: string, text: string, attachments: OutboxAttachment[]): Promise<ChatOutboxEntry> {
      const entry: ChatOutboxEntry = {
        id: options.uuid(),
        serverId: source.serverId,
        conversationId,
        text,
        attachments,
        createdAt: new Date(now()).toISOString(),
        state: 'waiting',
        error: null,
        attempts: 0,
      }
      await setOutbox([...state.outbox, entry])
      void flush()
      return entry
    },
    async retryOutbox(id: string) {
      const entry = state.outbox.find((item) => item.id === id)
      if (!entry) return
      await replaceEntry({ ...entry, state: 'waiting', error: null, attempts: 0 })
      void flush()
    },
    deleteOutbox(id: string) {
      return setOutbox(state.outbox.filter((item) => item.id !== id))
    },
    stopTurn(conversationId: string) {
      return invoke('stop', { conversationId })
    },
    respondPermission(conversationId: string, requestId: string, reply: 'once' | 'always' | 'reject') {
      return invoke('permission', { conversationId, requestId, reply })
    },
    /** No answers dismisses the question. */
    answerQuestion(conversationId: string, toolCallId: string, answers: string[][]) {
      return invoke('question', { conversationId, toolCallId, answers })
    },
    async decidePlan(conversationId: string, action: 'approve' | 'revise' | 'discard', feedback?: string) {
      return assertOk(await invoke('plan', { conversationId, action, ...(feedback ? { feedback } : {}) }))
    },
    loadSetup,
    async patchSetup(conversationId: string, patch: MobileChatSetupPatch) {
      const setup = await invoke('setSetup', { conversationId, patch })
      dispatch({ type: 'setup', conversationId, setup })
      return setup
    },
    async loadModels(force = false) {
      if (state.models && !force) return state.models
      const models = await invoke('models', {})
      dispatch({ type: 'models', models })
      return models
    },
    defaults: () => invoke('defaults', {}),
    setDefaults: (args: MobileArgs<'setDefaults'>) => invoke('setDefaults', args),
    async compact(conversationId: string) {
      return assertOk(await invoke('compact', { conversationId }))
    },
    async rename(conversationId: string, name: string) {
      await invoke('rename', { conversationId, name })
      const conversation = state.views[conversationId]?.conversation
      if (conversation) dispatch({ type: 'conversation', conversation: { ...conversation, name } })
      scheduleLists()
    },
    async archive(conversationId: string) {
      await invoke('archive', { conversationId, archived: true })
      if (openId === conversationId) openId = null
      dispatch({ type: 'removed', conversationId })
    },
    /** An image a chat item shows, kept for the next time it is drawn. */
    image(conversationId: string, imageId: string) {
      const key = `${conversationId}\0${imageId}`
      let image = images.get(key)
      if (!image) {
        image = invoke('image', { conversationId, imageId })
        images.set(key, image)
        image.catch(() => images.delete(key))
        if (images.size > IMAGES_KEPT) images.delete(images.keys().next().value as string)
      }
      return image
    },
  }
}

export type ChatsController = ReturnType<typeof createChatsController>
