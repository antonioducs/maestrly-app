import { describe, expect, it, vi } from 'vitest'

const getConversation = vi.fn()
vi.mock('../../src/main/store', () => ({ getConversation: (id: string) => getConversation(id) }))

import { conversationTabAllowed, isRemoteConversation, panelSearch } from '../../src/main/drawer-scope'

const REMOTE = 'server-1/workspaces#conv-1'

describe('drawer scope', () => {
  it('admits every tool of a conversation of this computer but review in a chat', () => {
    getConversation.mockReturnValue({ scope: 'project' })
    for (const tab of ['browser', 'vscode', 'terminal', 'plan', 'review', 'notes', 'chatgpt'] as const)
      expect(conversationTabAllowed('conv-1', tab), tab).toBe(true)
    getConversation.mockReturnValue({ scope: 'standalone' })
    expect(conversationTabAllowed('conv-1', 'review')).toBe(false)
    expect(conversationTabAllowed('conv-1', 'terminal')).toBe(true)
    expect(conversationTabAllowed('conv-1', 'card' as never)).toBe(false)
  })

  it("admits only the panels of a remote host's conversation, without looking it up here", () => {
    getConversation.mockClear()
    expect(isRemoteConversation(REMOTE)).toBe(true)
    expect(isRemoteConversation('conv-1')).toBe(false)
    for (const tab of ['terminal', 'plan', 'review', 'notes'] as const)
      expect(conversationTabAllowed(REMOTE, tab), tab).toBe(true)
    // Its browser, editor and companion live on the host: this computer has no native view for them.
    for (const tab of ['browser', 'vscode', 'chatgpt'] as const)
      expect(conversationTabAllowed(REMOTE, tab), tab).toBe(false)
    expect(getConversation).not.toHaveBeenCalled()
  })

  it("tells a panel's page its host and the host's own id", () => {
    expect(panelSearch('terminal', 'conv-1')).toBe('?panel=terminal&conv=conv-1')
    expect(panelSearch('notes', REMOTE)).toBe('?panel=notes&conv=conv-1&host=server-1%2Fworkspaces')
    const params = new URLSearchParams(panelSearch('plan', 'server-1/workspaces#a b&c'))
    expect([params.get('panel'), params.get('conv'), params.get('host')]).toEqual([
      'plan',
      'a b&c',
      'server-1/workspaces',
    ])
  })
})
