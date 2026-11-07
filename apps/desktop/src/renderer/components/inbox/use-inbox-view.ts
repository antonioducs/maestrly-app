import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  filterInbox,
  type InboxEntry,
  type InboxGroup,
  type InboxItem,
  type InboxSource,
  inboxPlaces,
  inboxSourceCounts,
  withStickyGroup,
} from '@/lib/inbox/inbox-model'

/** What the owner can do to the center's items; each acts on the item's own host or server too. */
export interface InboxActions {
  open: (item: InboxItem) => void
  /** Opens the item and shows it where it lives: Workspaces, Chats or Bots. */
  reveal: (item: InboxItem) => void
  markRead: (items: readonly InboxItem[]) => void
  dismiss: (item: InboxItem) => InboxEntry | undefined
  restore: (key: string, entry: InboxEntry | undefined) => void
  /** Answers a bot's request for approval from the list. */
  resolveBotRequest: (item: InboxItem, reply: 'once' | 'reject') => Promise<void>
}

const UNDO_MS = 6_000

/**
 * The center as the panel shows it: filtered by place, source and the sidebar's text filter, with the opened item kept
 * in its group while it is open, and what an undo needs after a dismissal.
 */
export function useInboxView(items: readonly InboxItem[], query: string, actions: InboxActions) {
  const [place, setPlace] = useState<string | null>(null)
  const [source, setSource] = useState<InboxSource | null>(null)
  const [collapsed, setCollapsed] = useState<Partial<Record<InboxGroup, boolean>>>({})
  const [sticky, setSticky] = useState<{ key: string; group: InboxGroup } | null>(null)
  const [undo, setUndo] = useState<{ item: InboxItem; entry: InboxEntry | undefined } | null>(null)

  const shown = useMemo(() => withStickyGroup([...items], sticky), [items, sticky])
  const places = useMemo(() => inboxPlaces(shown), [shown])
  // A place no item belongs to anymore is no filter.
  const placeShown = place !== null && places.some((item) => item.key === place) ? place : null
  const inPlace = useMemo(
    () => filterInbox(shown, { place: placeShown, source: null, query }),
    [shown, placeShown, query]
  )
  const sourceCounts = useMemo(() => inboxSourceCounts(inPlace), [inPlace])
  const visible = useMemo(
    () => (source === null ? inPlace : inPlace.filter((item) => item.source === source)),
    [inPlace, source]
  )

  const undoTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    },
    []
  )

  const open = useCallback(
    (item: InboxItem) => {
      setSticky((current) => (current?.key === item.key ? current : { key: item.key, group: item.group }))
      actions.open(item)
    },
    [actions]
  )
  const dismiss = useCallback(
    (item: InboxItem) => {
      const entry = actions.dismiss(item)
      setSticky((current) => (current?.key === item.key ? null : current))
      setUndo({ item, entry })
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
      undoTimer.current = window.setTimeout(() => setUndo(null), UNDO_MS)
    },
    [actions]
  )
  const undoDismiss = useCallback(() => {
    if (!undo) return
    actions.restore(undo.item.key, undo.entry)
    setUndo(null)
  }, [actions, undo])
  const unreadVisible = visible.filter((item) => item.unread)
  const markAllRead = useCallback(() => actions.markRead(unreadVisible), [actions, unreadVisible])

  return {
    items: visible,
    total: items.length,
    places,
    place: placeShown,
    setPlace,
    source,
    setSource,
    sourceCounts,
    collapsed,
    toggleGroup: (group: InboxGroup) => setCollapsed((current) => ({ ...current, [group]: !current[group] })),
    clearFilters: () => {
      setPlace(null)
      setSource(null)
    },
    open,
    dismiss,
    undo,
    undoDismiss,
    unreadCount: unreadVisible.length,
    markAllRead,
    actions,
  }
}

export type InboxViewState = ReturnType<typeof useInboxView>
