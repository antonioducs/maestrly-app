import {
  compareFleetTranscriptItems,
  type MobileBridgeState,
  type MobileChatItem,
  type MobileChatPage,
  type MobileChatSetup,
  type MobileConversation,
  type MobileConversationStatus,
  type MobileLists,
  type MobileResult,
  type MobileRuntime,
} from '@maestrly/bot-fleet-protocol'
import type { ChatOutboxEntry } from './outbox'

export type ChatView = {
  conversation: MobileConversation | null
  /** The conversation an agent started this one from. */
  sourceConversationId: string | null
  items: MobileChatItem[]
  before: string | null
  runtime: MobileRuntime
  loading: boolean
  loaded: boolean
  failed: boolean
  /** The host said the history changed beyond updates: the open view loads it again. */
  stale: boolean
}

export type ChatsState = {
  /** The server has a workspaces host, so it has chats to show. */
  hosted: boolean
  bridge: MobileBridgeState
  /** When the bridge tries again, while it is retrying or waiting for the host. */
  retryAt: number | null
  /** The host's version, when it refused this app. */
  hostVersion: string | null
  lists: MobileLists | null
  views: Record<string, ChatView>
  setups: Record<string, MobileChatSetup>
  models: MobileResult<'models'> | null
  outbox: ChatOutboxEntry[]
}

export type ChatsAction =
  | { type: 'hosted'; hosted: boolean }
  | { type: 'bridge'; state: MobileBridgeState; retryAt: number | null; hostVersion: string | null }
  | { type: 'lists'; lists: MobileLists }
  | { type: 'conversation'; conversation: MobileConversation }
  | { type: 'removed'; conversationId: string }
  | { type: 'status'; conversationId: string; status: MobileConversationStatus }
  | { type: 'view-loading'; conversationId: string }
  | { type: 'view-failed'; conversationId: string }
  /** An older page did not load; what the view shows stays. */
  | { type: 'view-idle'; conversationId: string }
  | { type: 'view-open'; conversationId: string; result: MobileResult<'open'> }
  | { type: 'view-older'; conversationId: string; page: MobileChatPage }
  | { type: 'items'; conversationId: string; items: MobileChatItem[] }
  | { type: 'runtime'; conversationId: string; runtime: MobileRuntime }
  | { type: 'reset'; conversationId: string }
  | { type: 'setup'; conversationId: string; setup: MobileChatSetup }
  | { type: 'models'; models: MobileResult<'models'> }
  | { type: 'outbox'; entries: ChatOutboxEntry[] }

export const idleRuntime: MobileRuntime = { streaming: false, compacting: false, plan: null, context: null }

export const initialChatsState: ChatsState = {
  hosted: false,
  bridge: 'closed',
  retryAt: null,
  hostVersion: null,
  lists: null,
  views: {},
  setups: {},
  models: null,
  outbox: [],
}

const emptyView: ChatView = {
  conversation: null,
  sourceConversationId: null,
  items: [],
  before: null,
  runtime: idleRuntime,
  loading: false,
  loaded: false,
  failed: false,
  stale: false,
}

function merge(existing: MobileChatItem[], incoming: MobileChatItem[]): MobileChatItem[] {
  const items = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) items.set(item.id, item)
  return [...items.values()].sort(compareFleetTranscriptItems)
}

/** Every conversation the lists hold, wherever it is. */
export function allConversations(lists: MobileLists | null): MobileConversation[] {
  if (!lists) return []
  return [...lists.chats, ...lists.workspaces.flatMap((workspace) => workspace.conversations)]
}

/** The lists with one conversation replaced, or added where it belongs. */
function upsertConversation(lists: MobileLists | null, conversation: MobileConversation): MobileLists | null {
  if (!lists) return lists
  const replace = (list: MobileConversation[]) =>
    list.some((item) => item.id === conversation.id)
      ? list.map((item) => (item.id === conversation.id ? conversation : item))
      : [...list, conversation]
  if (conversation.workspaceId === null) return { ...lists, chats: replace(lists.chats) }
  return {
    ...lists,
    workspaces: lists.workspaces.map((workspace) =>
      workspace.id === conversation.workspaceId
        ? { ...workspace, conversations: replace(workspace.conversations) }
        : workspace
    ),
  }
}

function mapConversations(lists: MobileLists | null, update: (item: MobileConversation) => MobileConversation | null) {
  if (!lists) return lists
  const apply = (list: MobileConversation[]) =>
    list.flatMap((item) => {
      const next = update(item)
      return next ? [next] : []
    })
  return {
    chats: apply(lists.chats),
    workspaces: lists.workspaces.map((workspace) => ({ ...workspace, conversations: apply(workspace.conversations) })),
  }
}

function withView(state: ChatsState, id: string, update: (view: ChatView) => ChatView): ChatsState {
  return { ...state, views: { ...state.views, [id]: update(state.views[id] ?? emptyView) } }
}

export function chatsReducer(state: ChatsState, action: ChatsAction): ChatsState {
  switch (action.type) {
    case 'hosted':
      return action.hosted ? { ...state, hosted: true } : { ...initialChatsState, outbox: state.outbox }
    case 'bridge':
      return { ...state, bridge: action.state, retryAt: action.retryAt, hostVersion: action.hostVersion }
    case 'lists':
      return { ...state, lists: action.lists }
    case 'conversation': {
      const view = state.views[action.conversation.id]
      return {
        ...state,
        lists: upsertConversation(state.lists, action.conversation),
        views: view
          ? { ...state.views, [action.conversation.id]: { ...view, conversation: action.conversation } }
          : state.views,
      }
    }
    case 'removed': {
      const { [action.conversationId]: _view, ...views } = state.views
      return {
        ...state,
        views,
        lists: mapConversations(state.lists, (item) => (item.id === action.conversationId ? null : item)),
      }
    }
    case 'status': {
      const lists = mapConversations(state.lists, (item) =>
        item.id === action.conversationId ? { ...item, status: action.status } : item
      )
      const view = state.views[action.conversationId]
      return {
        ...state,
        lists,
        views: view?.conversation
          ? {
              ...state.views,
              [action.conversationId]: { ...view, conversation: { ...view.conversation, status: action.status } },
            }
          : state.views,
      }
    }
    case 'view-loading':
      return withView(state, action.conversationId, (view) => ({ ...view, loading: true, failed: false }))
    case 'view-failed':
      return withView(state, action.conversationId, (view) => ({ ...view, loading: false, failed: true }))
    case 'view-idle':
      return withView(state, action.conversationId, (view) => ({ ...view, loading: false }))
    case 'view-open': {
      const { conversation, sourceConversationId, page, runtime } = action.result
      return {
        ...withView(state, action.conversationId, () => ({
          conversation,
          sourceConversationId,
          items: [...page.items].sort(compareFleetTranscriptItems),
          before: page.before,
          runtime,
          loading: false,
          loaded: true,
          failed: false,
          stale: false,
        })),
        lists: upsertConversation(state.lists, conversation),
      }
    }
    case 'view-older':
      return withView(state, action.conversationId, (view) => ({
        ...view,
        items: merge(view.items, action.page.items),
        before: action.page.before,
        loading: false,
      }))
    case 'items': {
      const view = state.views[action.conversationId]
      if (!view?.loaded) return state
      return withView(state, action.conversationId, () => ({ ...view, items: merge(view.items, action.items) }))
    }
    case 'runtime': {
      const view = state.views[action.conversationId]
      if (!view) return state
      return withView(state, action.conversationId, () => ({ ...view, runtime: action.runtime }))
    }
    case 'reset': {
      const view = state.views[action.conversationId]
      if (!view) return state
      return withView(state, action.conversationId, () => ({ ...view, stale: true }))
    }
    case 'setup':
      return { ...state, setups: { ...state.setups, [action.conversationId]: action.setup } }
    case 'models':
      return { ...state, models: action.models }
    case 'outbox':
      return { ...state, outbox: action.entries }
  }
}
