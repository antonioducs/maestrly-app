import type { Conversation } from '../../preload'
import { CHAT_VIEW_COLD_TTL_MS, MAX_MOUNTED_CHAT_VIEWS, MAX_SAFE_HOT_CHAT_VIEWS } from '../../shared/memory-policy'

export { MAX_MOUNTED_CHAT_VIEWS, CHAT_VIEW_COLD_TTL_MS }
export const MAX_SAFE_MOUNTED_CHAT_VIEWS = MAX_SAFE_HOT_CHAT_VIEWS

export interface ChatMountMeta {
  lastVisibleAt?: number
  estimatedBytes?: number
}

export interface PruneMountedChatViewsOptions {
  autoReclaimEnabled?: boolean
  now?: number
  ttlMs?: number
  hardPressure?: boolean
  lastVisibleAt?: Readonly<Record<string, number>>
  estimatedBytes?: Readonly<Record<string, number>>
  maxSafe?: number
  /** Host-managed surfaces that must stay mounted together (for example both panes of a paired review). */
  protectedIds?: ReadonlySet<string>
}

export function pruneMountedChatViews(
  conversations: readonly Conversation[],
  _statuses: Readonly<Record<string, string>>,
  activeId: string | null,
  unsafeIds: ReadonlySet<string> = new Set(),
  max = MAX_MOUNTED_CHAT_VIEWS,
  _maxTerminal = 0,
  options: PruneMountedChatViewsOptions = {}
): Conversation[] {
  if (options.autoReclaimEnabled === false) return conversations as Conversation[]
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? CHAT_VIEW_COLD_TTL_MS
  const maxSafe = options.maxSafe ?? MAX_SAFE_MOUNTED_CHAT_VIEWS
  const protectedChatIds = new Set<string>()
  if (activeId) {
    protectedChatIds.add(activeId)
  }
  for (const id of options.protectedIds ?? []) protectedChatIds.add(id)

  for (const conversation of conversations) {
    if (unsafeIds.has(conversation.id)) protectedChatIds.add(conversation.id)
  }

  const chatIds = conversations.map((conversation) => conversation.id)
  const evicted = new Set<string>()
  const hiddenSafe = chatIds.filter((id) => !protectedChatIds.has(id))

  if (options.hardPressure) {
    for (const id of hiddenSafe) evicted.add(id)
  } else {
    for (const id of hiddenSafe) {
      const lastVisibleAt = options.lastVisibleAt?.[id]
      if (lastVisibleAt != null && now - lastVisibleAt >= ttlMs) evicted.add(id)
    }
    const remainingSafe = hiddenSafe.filter((id) => !evicted.has(id))
    if (remainingSafe.length > maxSafe) {
      const weighted = remainingSafe
        .map((id) => ({
          id,
          lastVisibleAt: options.lastVisibleAt?.[id] ?? 0,
          bytes: options.estimatedBytes?.[id] ?? 0,
        }))
        .sort((a, b) => a.lastVisibleAt - b.lastVisibleAt || a.bytes - b.bytes)
      for (const item of weighted.slice(0, remainingSafe.length - maxSafe)) evicted.add(item.id)
    }
  }

  const remainingChats = chatIds.filter((id) => !evicted.has(id))
  if (remainingChats.length > max) {
    const extra = remainingChats.filter((id) => !protectedChatIds.has(id)).slice(0, remainingChats.length - max)
    for (const id of extra) evicted.add(id)
  }

  return evicted.size === 0
    ? (conversations as Conversation[])
    : conversations.filter((conversation) => !evicted.has(conversation.id))
}
