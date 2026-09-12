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
