import type { Conversation } from '../shared/conversation'
import { conversationPermissionScope, getConversationCapabilities } from '../shared/conversation-scope'
import { getConversation, getWorkspace } from './store'

/** Resolve execution identity without manufacturing a project for standalone chats. */
export function resolveConversationContext(input: string | Conversation) {
  const conversation = typeof input === 'string' ? getConversation(input) : input
  if (!conversation) throw new Error('Conversation not found.')
  const projectId = conversation.scope === 'project' ? conversation.workspaceId : null
  const workspace = projectId === null ? null : (getWorkspace(projectId) ?? null)
  return {
    conversation,
    conversationId: conversation.id,
    scope: conversation.scope,
    cwd: conversation.cwd,
    workspace,
    workspaceId: projectId,
    projectId,
    projectRoot: workspace?.path ?? null,
    permissionScope: conversationPermissionScope(conversation),
    capabilities: getConversationCapabilities(conversation),
    artifactsDirectory: conversation.cwd,
  }
}

export type ConversationContext = ReturnType<typeof resolveConversationContext>
export const getConversationContext = resolveConversationContext
export const resolveConversationExecutionContext = resolveConversationContext
export {
  conversationPermissionScope,
  getConversationCapabilities,
  requireProjectConversation,
} from '../shared/conversation-scope'
export type { PermissionScope } from '../shared/conversation-scope'
