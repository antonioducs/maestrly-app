import { HttpTransport } from '@maestrly/client-sdk'
import { linkedBoardReadTools, type LinkedBoardToolName } from '@maestrly/protocol'
import { getConversation, getConvUiPrefs } from '../store'
import { isWebManagedConversation } from '../chat/remote-policy'
import { platformProjectBindings } from './project-bindings'
import { platformConnections } from './connection-service'
import { linkedBoardCatalog } from './board-tool-catalog'
import { normalizeChatMode } from '../../shared/chat-mode'
import { resolveChatBehavior } from '../../shared/conversation-experience'
import { requireProjectConversation } from '../../shared/conversation-scope'

/** No path inference: conversations and their worktrees inherit the exact workspace binding. */
export function linkedConversationBinding(conversationId: string) {
  if (isWebManagedConversation(conversationId)) return null
  const conversation = getConversation(conversationId)
  return conversation && conversation.scope !== 'standalone'
    ? platformProjectBindings.forWorkspace(conversation.workspaceId)
    : null
}
const identity = (binding: ReturnType<typeof linkedConversationBinding>) =>
  binding
    ? JSON.stringify([
        binding.workspaceId,
        binding.connectionId,
        binding.organizationId,
        binding.projectId,
        binding.boardId,
        binding.revision,
      ])
    : ''

export function linkedBoardScopeIdentity(conversationId: string) {
  const binding = linkedConversationBinding(conversationId)
  const connection = binding && platformConnections.list().find((c) => c.id === binding.connectionId)
  return JSON.stringify([identity(binding), connection?.url, connection?.identity?.userId])
}

export function createLinkedBoardAccess(conversationId: string, access: 'read' | 'write' = 'write') {
  const original = linkedBoardScopeIdentity(conversationId)
  const current = () => {
    const conversation = getConversation(conversationId)
    if (conversation) requireProjectConversation(conversation)
    const binding = linkedConversationBinding(conversationId)
    if (!binding) throw new Error('Link this workspace to a Kanban project in Settings → Platform first.')
    if (linkedBoardScopeIdentity(conversationId) !== original)
      throw new Error('The Kanban link changed. Start a new turn or reconnect GPT Web.')
    return binding
  }
  const canWrite = () => {
    const mode = resolveChatBehavior(
      getConversation(conversationId)?.experience,
      normalizeChatMode(getConvUiPrefs(conversationId).chat?.mode)
    )
    return access === 'write' && mode !== 'ask' && mode !== 'plan'
  }
  const assertAccess = (name: LinkedBoardToolName) => {
    if (!linkedBoardReadTools.has(name) && !canWrite()) throw new Error('Kanban is read-only in this conversation.')
  }
  const context = () => {
    const binding = current()
    const connection = platformConnections.list().find((c) => c.id === binding.connectionId)
    return {
      projectId: binding.projectId,
      projectName: binding.projectName,
      organizationId: binding.organizationId,
      boardId: binding.boardId,
      access: canWrite() ? 'write' : 'read',
      connected: connection?.state === 'connected',
      instructions:
        'Use board_list_boards and board_list_cards to discover IDs. Read versions before changes. This link applies to all conversations and worktrees in the workspace. Finishing a response does not complete a card.',
    }
  }
  const call = async (name: LinkedBoardToolName, input: Record<string, unknown>, signal?: AbortSignal) => {
    const binding = current()
    const definition = linkedBoardCatalog.find((tool) => tool.name === name)
    if (!definition) throw new Error('Unknown Kanban tool.')
    const parsed = definition.schema.parse(input) as Record<string, unknown>
    assertAccess(name)
    signal?.throwIfAborted()
    const connection = platformConnections.list().find((c) => c.id === binding.connectionId)
    if (!connection) throw new Error('Kanban connection no longer exists.')
    const token = await platformConnections.authenticatedToken(binding.connectionId)
    if (!token) throw new Error('Sign in to the Kanban platform again.')
    current()
    assertAccess(name)
    signal?.throwIfAborted()
    const { idempotencyKey, ...body } = parsed
    return new HttpTransport({
      baseUrl: connection.url,
      authentication: {
        headers: () => ({ authorization: `Bearer ${token}`, 'x-maestrly-conversation-id': conversationId }),
      },
    }).request('POST', `/api/v1/organizations/${binding.organizationId}/projects/${binding.projectId}/board-tools`, {
      body: { name, input: body },
      idempotencyKey: idempotencyKey as string | undefined,
      signal,
    })
  }
  return { context, call }
}
