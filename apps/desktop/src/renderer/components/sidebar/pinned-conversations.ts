import type { Conversation, WorkspaceWithConversations } from '../../../preload'

export interface PinnedConversationItem {
  conversation: Conversation
  workspace: WorkspaceWithConversations
  originalIndex: number
}

export function buildPinnedWorkspaceLabels(workspaces: WorkspaceWithConversations[]): Map<string, string> {
  const nameCounts = new Map<string, number>()
  for (const workspace of workspaces) {
    nameCounts.set(workspace.name, (nameCounts.get(workspace.name) ?? 0) + 1)
  }

  const labels = new Map<string, string>()
  for (const workspace of workspaces) {
    if ((nameCounts.get(workspace.name) ?? 0) < 2) {
      labels.set(workspace.id, workspace.name)
      continue
    }

    const segments = workspace.path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean)
    const parent = segments.length > 1 ? segments.at(-2) : null
    labels.set(workspace.id, parent ? `${parent} / ${workspace.name}` : workspace.name)
  }
  return labels
}

export function collectPinnedConversations(workspaces: WorkspaceWithConversations[]): PinnedConversationItem[] {
  const items: PinnedConversationItem[] = []
  let globalIndex = 0
  for (const workspace of workspaces) {
    for (const conversation of workspace.conversations) {
      const originalIndex = globalIndex
      globalIndex += 1
      if (conversation.archived !== 0 || conversation.pinnedAt === null) {
        continue
      }
      items.push({ conversation, workspace, originalIndex })
    }
  }
  items.sort((a, b) => {
    const pinnedA = a.conversation.pinnedAt ?? 0
    const pinnedB = b.conversation.pinnedAt ?? 0
    if (pinnedA !== pinnedB) return pinnedB - pinnedA
    return a.originalIndex - b.originalIndex
  })
  return items
}
