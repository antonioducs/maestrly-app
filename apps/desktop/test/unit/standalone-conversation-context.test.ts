import { expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ conversation: vi.fn(), workspace: vi.fn() }))
vi.mock('../../src/main/store', () => ({ getConversation: h.conversation, getWorkspace: h.workspace }))
import { resolveConversationContext } from '../../src/main/conversation-context'
import { permissionScopeKey } from '../../src/shared/conversation-scope'
it('resolves standalone identity without a workspace lookup or project capabilities', () => {
  h.workspace.mockClear()
  h.conversation.mockReturnValue({ id: 'chat', scope: 'standalone', cwd: '/private/chat', workspaceId: null })
  const context = resolveConversationContext('chat')
  expect(context).toMatchObject({
    cwd: '/private/chat',
    workspace: null,
    projectId: null,
    permissionScope: { kind: 'conversation', id: 'chat' },
    capabilities: { git: false, maestro: false, browser: true, terminal: true },
  })
  expect(h.workspace).not.toHaveBeenCalled()
  expect(permissionScopeKey(context.permissionScope)).toBe('conversation:chat')
})
it('retains project permission keys and resolves workspace identity', () => {
  h.conversation.mockReturnValue({ id: 'chat', scope: 'project', cwd: '/repo', workspaceId: 'ws' })
  h.workspace.mockReturnValue({ id: 'ws', path: '/repo' })
  const context = resolveConversationContext('chat')
  expect(context).toMatchObject({
    projectId: 'ws',
    workspace: { id: 'ws' },
    permissionScope: { kind: 'project', id: 'ws' },
    capabilities: { git: true },
  })
  expect(permissionScopeKey(context.permissionScope)).toBe('ws')
})
it('fails clearly for a missing conversation', () => {
  h.conversation.mockReturnValue(undefined)
  expect(() => resolveConversationContext('missing')).toThrow('Conversation not found')
})
