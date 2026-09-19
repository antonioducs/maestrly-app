import type { Conversation } from './conversation'

export type { Conversation, ProjectConversation, StandaloneConversation } from './conversation'
export type ConversationScope = Conversation['scope']

export function isProjectConversation<T extends { scope: ConversationScope }>(
  conversation: T
): conversation is T & { scope: 'project' } {
  return conversation.scope === 'project'
}

export function isStandaloneConversation<T extends { scope: ConversationScope }>(
  conversation: T
): conversation is T & { scope: 'standalone' } {
  return conversation.scope === 'standalone'
}

export function requireProjectConversation<T extends { scope: ConversationScope }>(
  conversation: T,
  _operation?: string
): T & { scope: 'project' } {
  if (!isProjectConversation(conversation)) throw new Error('project-required')
  return conversation
}

/** UI/tool availability only; provider permission modes remain independent. */
export function getConversationCapabilities(conversation: Pick<Conversation, 'scope'>) {
  const project = conversation.scope === 'project'
  return {
    project,
    projectContext: project,
    projectMemory: project,
    board: project,
    git: project,
    worktree: project,
    repositories: project,
    terminal: true,
    browser: true,
    preview: project,
    maestro: project,
    migration: project,
    siblings: project,
    chat: true,
    files: true,
  } as const
}

export type PermissionScope = { kind: 'project'; id: string } | { kind: 'conversation'; id: string }

export function conversationPermissionScope(conversation: Conversation): PermissionScope {
  return conversation.scope === 'project'
    ? { kind: 'project', id: conversation.workspaceId }
    : { kind: 'conversation', id: conversation.id }
}

/** Keep existing workspace keys stable and namespace standalone permission decisions. */
export function permissionScopeKey(scope: PermissionScope): string {
  return scope.kind === 'project' ? scope.id : `conversation:${scope.id}`
}
