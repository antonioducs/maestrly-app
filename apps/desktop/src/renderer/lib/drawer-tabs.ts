import type { DrawerTab } from '../../shared/tool-tabs'

export type { DrawerTab }

export const DEFAULT_MAIN_ORDER: DrawerTab[] = [
  'browser',
  'vscode',
  'terminal',
  'plan',
  'review',
  'notes',
  'chatgpt',
]

export function mainTabsForFeatures(order: DrawerTab[], chatGptWebEnabled: boolean): DrawerTab[] {
  return chatGptWebEnabled ? order : order.filter((tab) => tab !== 'chatgpt')
}

export function tabAvailableInContext(
  tab: DrawerTab,
  conv: unknown,
  chatGptWebEnabled = true
): boolean {
  if (tab === 'chatgpt' && !chatGptWebEnabled) return false
  return tab !== 'notes' || Boolean(conv)
}

export function mainTabsForContext(
  order: DrawerTab[],
  conv: unknown,
  chatGptWebEnabled = true
): DrawerTab[] {
  return order.filter((tab) => tabAvailableInContext(tab, conv, chatGptWebEnabled))
}

export function reorderVisibleTabs(
  fullOrder: DrawerTab[],
  visibleOrder: DrawerTab[],
  from: number,
  to: number
): DrawerTab[] {
  if (from < 0 || from >= visibleOrder.length || to < 0 || to >= visibleOrder.length || from === to) {
    return fullOrder
  }
  const reordered = [...visibleOrder]
  const [moved] = reordered.splice(from, 1)
  reordered.splice(to, 0, moved)
  const visible = new Set(visibleOrder)
  let index = 0
  return fullOrder.map((tab) => (visible.has(tab) ? reordered[index++] : tab))
}

/** Keeps only valid, available, non-duplicated tabs from a persisted open-tab list. */
export function sanitizeOpenTabs(raw: unknown, conv: unknown, chatGptWebEnabled = true): DrawerTab[] {
  const arr = Array.isArray(raw) ? (raw as unknown[]) : []
  const seen = new Set<DrawerTab>()
  const out: DrawerTab[] = []
  for (const t of arr) {
    if (!DEFAULT_MAIN_ORDER.includes(t as DrawerTab) || seen.has(t as DrawerTab)) continue
    if (!tabAvailableInContext(t as DrawerTab, conv, chatGptWebEnabled)) continue
    seen.add(t as DrawerTab)
    out.push(t as DrawerTab)
  }
  return out
}

/** Appends the tab when it is not open yet; returns the same array when nothing changes. */
export function openTabInList(list: DrawerTab[], tab: DrawerTab): DrawerTab[] {
  return list.includes(tab) ? list : [...list, tab]
}

/**
 * Removes a tab and picks the next active one: the right neighbour, else the left one, else null.
 * When the closed tab was not active, the active tab is preserved.
 */
export function closeTabInList(
  list: DrawerTab[],
  tab: DrawerTab,
  active: DrawerTab | null
): { list: DrawerTab[]; active: DrawerTab | null } {
  const i = list.indexOf(tab)
  if (i < 0) return { list, active }
  const next = list.filter((t) => t !== tab)
  if (active !== tab) return { list: next, active: active && next.includes(active) ? active : (next[0] ?? null) }
  return { list: next, active: next[i] ?? next[i - 1] ?? null }
}

export function moveOpenTab(list: DrawerTab[], from: number, to: number): DrawerTab[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function sanitizeMainOrder(order: unknown, conv?: unknown): DrawerTab[] {
  const arr = Array.isArray(order) ? (order as DrawerTab[]) : []
  const seen = new Set<DrawerTab>()
  const valid = arr.filter((t): t is DrawerTab => {
    if (!DEFAULT_MAIN_ORDER.includes(t) || seen.has(t)) return false
    seen.add(t)
    return true
  })
  const full = [...valid, ...DEFAULT_MAIN_ORDER.filter((t) => !seen.has(t))]
  return conv === undefined ? full : mainTabsForContext(full, conv)
}
