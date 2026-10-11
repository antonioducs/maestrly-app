import { type HostId, isRemoteHostId, parseHostKey } from '../../shared/host-key'
import type { DrawerTab } from '../../shared/tool-tabs'

export type { DrawerTab }

export const DEFAULT_MAIN_ORDER: DrawerTab[] = [
  'browser',
  'vscode',
  'terminal',
  'files',
  'plan',
  'review',
  'notes',
  'chatgpt',
]

export function mainTabsForFeatures(order: DrawerTab[], chatGptWebEnabled: boolean): DrawerTab[] {
  return chatGptWebEnabled ? order : order.filter((tab) => tab !== 'chatgpt')
}

/** The tools a conversation of any remote host shows on this computer. */
const REMOTE_HOST_TABS: ReadonlySet<DrawerTab> = new Set(['terminal', 'files', 'plan', 'review', 'notes'])

/**
 * Whether a remote host serves one of the tools it offers only when it says so: its browser (streamed here,
 * RemoteHostInfo.browser) and its editor (RemoteHostInfo.editor).
 */
export type RemoteToolHosts = (hostId: HostId, tab: 'browser' | 'vscode') => boolean
const NO_REMOTE_TOOLS: RemoteToolHosts = () => false

/** The remote host of a conversation, from the window's id of it; null for this computer's. */
const remoteHostOf = (conv: unknown): HostId | null => {
  const id = (conv as { id?: unknown } | null)?.id
  if (typeof id !== 'string') return null
  const { hostId } = parseHostKey(id)
  return isRemoteHostId(hostId) ? hostId : null
}

export function tabAvailableInContext(
  tab: DrawerTab,
  conv: unknown,
  chatGptWebEnabled = true,
  remoteTools: RemoteToolHosts = NO_REMOTE_TOOLS
): boolean {
  const remoteHost = remoteHostOf(conv)
  if (remoteHost !== null && !REMOTE_HOST_TABS.has(tab)) {
    // A remote host's browser and editor are shown here once the host says it serves them.
    if ((tab !== 'browser' && tab !== 'vscode') || !remoteTools(remoteHost, tab)) return false
  }
  // Files moves files to and from a host: a conversation of this computer has its files at hand.
  if (tab === 'files' && remoteHost === null) return false
  if (tab === 'review' && (conv as { scope?: string } | null)?.scope === 'standalone') return false
  if (tab === 'chatgpt' && !chatGptWebEnabled) return false
  return tab !== 'notes' || Boolean(conv)
}

export function mainTabsForContext(
  order: DrawerTab[],
  conv: unknown,
  chatGptWebEnabled = true,
  remoteTools: RemoteToolHosts = NO_REMOTE_TOOLS
): DrawerTab[] {
  return order.filter((tab) => tabAvailableInContext(tab, conv, chatGptWebEnabled, remoteTools))
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
export function sanitizeOpenTabs(
  raw: unknown,
  conv: unknown,
  chatGptWebEnabled = true,
  remoteTools: RemoteToolHosts = NO_REMOTE_TOOLS
): DrawerTab[] {
  const arr = Array.isArray(raw) ? (raw as unknown[]) : []
  const seen = new Set<DrawerTab>()
  const out: DrawerTab[] = []
  for (const t of arr) {
    if (!DEFAULT_MAIN_ORDER.includes(t as DrawerTab) || seen.has(t as DrawerTab)) continue
    if (!tabAvailableInContext(t as DrawerTab, conv, chatGptWebEnabled, remoteTools)) continue
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
