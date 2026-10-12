/** Which memory center a link opens, for the conversations and memories of every host the window shows. */
import type { Conversation, WorkspaceWithConversations } from '../../preload'
import { type HostId, hostKey, LOCAL_HOST_ID, parseHostKey } from '../../shared/host-key'
import { PERSONAL_MEMORY_SPACE_ID } from '../../shared/memory'

/** The memory center shown: the personal memory of a host, or a workspace's memory (its window key names its host). */
export type MemoryTarget = { kind: 'personal'; hostId: HostId } | { kind: 'workspace'; workspaceId: string }

/** What opens the memory center (`maestrly:open-memory`). A conversation id is keyed for the window (host-key). */
export interface OpenMemoryRequest {
  conversationId?: string
  memoryId?: string
  /** The personal memory of `hostId` (this computer by default), rather than a conversation's. */
  personal?: boolean
  hostId?: HostId
}

/** The memory center's key in the panels' state: a workspace's window key, or a host's personal memory. */
export const personalMemoryKey = (hostId: HostId): string => hostKey(hostId, PERSONAL_MEMORY_SPACE_ID)

export function memoryTargetOf(key: string | null): MemoryTarget | null {
  if (!key) return null
  const { hostId, id } = parseHostKey(key)
  return id === PERSONAL_MEMORY_SPACE_ID ? { kind: 'personal', hostId } : { kind: 'workspace', workspaceId: key }
}

/**
 * Which memory center a request opens, given the conversations of every host keyed for the window: the workspace of
 * the conversation, or the personal memory of its host for a chat; null when the conversation is not known here.
 */
export function memoryKeyFor(
  request: OpenMemoryRequest,
  workspaces: WorkspaceWithConversations[],
  standaloneConversations: Conversation[]
): string | null {
  const conversationId = request.conversationId
  const hostId = request.hostId ?? (conversationId ? parseHostKey(conversationId).hostId : LOCAL_HOST_ID)
  if (request.personal) return personalMemoryKey(hostId)
  if (!conversationId) return null
  const workspace = workspaces.find((item) =>
    item.conversations.some((conversation) => conversation.id === conversationId)
  )
  if (workspace) return workspace.id
  const chat = standaloneConversations.some(
    (conversation) => conversation.id === conversationId && !conversation.botOrigin
  )
  return chat ? personalMemoryKey(hostId) : null
}
