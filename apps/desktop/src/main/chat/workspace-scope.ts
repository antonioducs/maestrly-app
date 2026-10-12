import type { PluginScope } from '../../shared/plugins'
import { getConversation } from '../store'

/** Workspaces of a project conversation (every repository of a multi-repository one); none for standalone chats. */
export function conversationWorkspaceIds(conversationId: string | null | undefined): string[] {
  if (!conversationId) return []
  const conversation = getConversation(conversationId)
  if (!conversation || conversation.scope === 'standalone') return []
  return [conversation.workspaceId, ...(conversation.repos ?? []).map((repo) => repo.workspaceId)]
}

/**
 * Whether something scoped to all conversations or to selected projects applies to a conversation. `undefined` is
 * Settings, which sees everything; `null` (no conversation) and standalone chats see only what applies everywhere.
 */
export function scopeAppliesTo(scope: PluginScope, conversationId: string | null | undefined): boolean {
  if (conversationId === undefined || scope.kind === 'global') return true
  return conversationWorkspaceIds(conversationId).some((id) => scope.workspaceIds.includes(id))
}
