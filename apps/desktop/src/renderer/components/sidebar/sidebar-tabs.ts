import type { Conversation } from '../../../shared/conversation'

export const sidebarTabs = ['chats', 'workspaces', 'bots'] as const
export type SidebarTab = (typeof sidebarTabs)[number]

export function readSidebarTab(value: string | null): SidebarTab {
  return sidebarTabs.find((tab) => tab === value) ?? 'workspaces'
}

export function conversationSidebarTab(conversation: Conversation): SidebarTab {
  return conversation.scope === 'standalone' ? 'chats' : 'workspaces'
}

export function nextSidebarTab(current: SidebarTab, key: string): SidebarTab | null {
  const index = sidebarTabs.indexOf(current)
  if (key === 'Home') return sidebarTabs[0]
  if (key === 'End') return sidebarTabs[sidebarTabs.length - 1]
  if (key === 'ArrowRight') return sidebarTabs[(index + 1) % sidebarTabs.length]
  if (key === 'ArrowLeft') return sidebarTabs[(index - 1 + sidebarTabs.length) % sidebarTabs.length]
  return null
}

export function workspaceFilterCount<
  T extends { name: string; conversations: { name: string; branch: string | null }[] },
>(workspaces: T[], query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  return workspaces.reduce(
    (count, workspace) =>
      count +
      (workspace.name.toLowerCase().includes(q) ? 1 : 0) +
      workspace.conversations.filter(
        (conversation) =>
          conversation.name.toLowerCase().includes(q) || (conversation.branch ?? '').toLowerCase().includes(q)
      ).length,
    0
  )
}

export function crossTabMatches(
  current: SidebarTab,
  counts: Record<SidebarTab, number>
): { tab: SidebarTab; count: number }[] {
  return sidebarTabs.filter((tab) => tab !== current && counts[tab] > 0).map((tab) => ({ tab, count: counts[tab] }))
}
