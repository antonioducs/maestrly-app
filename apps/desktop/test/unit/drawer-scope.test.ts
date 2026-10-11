import { describe, expect, it, vi } from 'vitest'

const getConversation = vi.fn()
vi.mock('../../src/main/store', () => ({ getConversation: (id: string) => getConversation(id) }))

import {
  conversationTabAllowed,
  isRemoteConversation,
  panelSearch,
  setRemoteEditorHosts,
} from '../../src/main/drawer-scope'

const REMOTE = 'server-1/workspaces#conv-1'

describe('drawer scope', () => {
  it('admits every tool of a conversation of this computer but review in a chat, and files', () => {
    getConversation.mockReturnValue({ scope: 'project' })
    for (const tab of ['browser', 'vscode', 'terminal', 'plan', 'review', 'notes', 'chatgpt'] as const)
      expect(conversationTabAllowed('conv-1', tab), tab).toBe(true)
    // Its files are at hand on this computer: the Files tab moves files to and from a host.
    expect(conversationTabAllowed('conv-1', 'files')).toBe(false)
    getConversation.mockReturnValue({ scope: 'standalone' })
    expect(conversationTabAllowed('conv-1', 'review')).toBe(false)
    expect(conversationTabAllowed('conv-1', 'terminal')).toBe(true)
    expect(conversationTabAllowed('conv-1', 'card' as never)).toBe(false)
  })

  it("admits only the panels of a remote host's conversation, without looking it up here", () => {
    getConversation.mockClear()
    expect(isRemoteConversation(REMOTE)).toBe(true)
    expect(isRemoteConversation('conv-1')).toBe(false)
    for (const tab of ['terminal', 'files', 'plan', 'review', 'notes'] as const)
      expect(conversationTabAllowed(REMOTE, tab), tab).toBe(true)
    // Its browser, editor and companion live on the host: this computer has no native view for them.
    for (const tab of ['browser', 'vscode', 'chatgpt'] as const)
      expect(conversationTabAllowed(REMOTE, tab), tab).toBe(false)
    expect(getConversation).not.toHaveBeenCalled()
  })

  it("admits the editor of a remote host's conversation once its host serves one", () => {
    setRemoteEditorHosts((hostId) => hostId === 'server-1/workspaces')
    try {
      expect(conversationTabAllowed(REMOTE, 'vscode')).toBe(true)
      expect(conversationTabAllowed('server-2/workspaces#conv-1', 'vscode')).toBe(false)
      // Its browser is streamed into the DOM, not a native view of this computer; its companion stays local only.
      expect(conversationTabAllowed(REMOTE, 'browser')).toBe(false)
      expect(conversationTabAllowed(REMOTE, 'chatgpt')).toBe(false)
    } finally {
      setRemoteEditorHosts(() => false)
    }
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
