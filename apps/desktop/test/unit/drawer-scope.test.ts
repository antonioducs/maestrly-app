import { describe, expect, it, vi } from 'vitest'

const getConversation = vi.fn()
vi.mock('../../src/main/store', () => ({ getConversation: (id: string) => getConversation(id) }))

import {
  conversationTabAllowed,
  isRemoteConversation,
  panelSearch,
  setRemoteToolHosts,
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
    // Its browser, editor and companion live on the host: this computer shows none it was not told the host serves.
    for (const tab of ['browser', 'vscode', 'chatgpt'] as const)
      expect(conversationTabAllowed(REMOTE, tab), tab).toBe(false)
    // Its computer is drawn by the window from its video: never a native view, here or for this computer's own.
    expect(conversationTabAllowed(REMOTE, 'computer')).toBe(false)
    expect(conversationTabAllowed('conv-1', 'computer')).toBe(false)
    expect(getConversation).not.toHaveBeenCalled()
  })

  it("admits the browser and the editor of a remote host's conversation once its host serves each", () => {
    setRemoteToolHosts((hostId, tool) => hostId === 'server-1/workspaces' && tool === 'vscode')
    try {
      expect(conversationTabAllowed(REMOTE, 'vscode')).toBe(true)
      expect(conversationTabAllowed(REMOTE, 'browser')).toBe(false)
      expect(conversationTabAllowed('server-2/workspaces#conv-1', 'vscode')).toBe(false)
      setRemoteToolHosts((hostId, tool) => hostId === 'server-1/workspaces' && tool === 'browser')
      // The host streams its browser here, into the drawer, a popup or a floating window.
      expect(conversationTabAllowed(REMOTE, 'browser')).toBe(true)
      expect(conversationTabAllowed(REMOTE, 'vscode')).toBe(false)
      // Its companion stays local only.
      setRemoteToolHosts(() => true)
      expect(conversationTabAllowed(REMOTE, 'chatgpt')).toBe(false)
    } finally {
      setRemoteToolHosts(() => false)
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
