import { getConversation } from '../store'
import { isWorkspaceMemoryEnabled } from './access'
import type { MemoryScopeRoot } from './index'

/** The one memory space of a bot container: the bot's own durable memory. */
export const BOT_MEMORY_SPACE_ID = 'bot-self'
export type MemorySpaceKind = 'workspace' | 'bot'
export interface MemorySpace {
  id: string
  kind: MemorySpaceKind
  roots: MemoryScopeRoot[]
}

const registered = new Map<string, { id: string; kind: 'bot' }>()

/** A host (the bot runtime) gives a conversation without a workspace its own memory space. */
export function registerConversationMemorySpace(conversationId: string, space: { id: string; kind: 'bot' }): void {
  registered.set(conversationId, space)
}

export function clearConversationMemorySpace(conversationId: string): void {
  registered.delete(conversationId)
}

export function memorySpaceForConversation(conversationId: string): MemorySpace | null {
  const bound = registered.get(conversationId)
  if (bound) return { ...bound, roots: [] }
  const conversation = getConversation(conversationId)
  if (conversation?.scope !== 'project' || !conversation.workspaceId) return null
  if (!isWorkspaceMemoryEnabled(conversation.workspaceId)) return null
  return {
    id: conversation.workspaceId,
    kind: 'workspace',
    roots: conversation.isMulti
      ? (conversation.repos ?? []).map((repo) => ({ root: repo.worktreePath, linkName: repo.linkName }))
      : [{ root: conversation.cwd }],
  }
}
