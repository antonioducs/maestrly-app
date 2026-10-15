import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIN_ORDER,
  closeTabInList,
  mainTabsForFeatures,
  moveOpenTab,
  openTabInList,
  reorderVisibleTabs,
  sanitizeMainOrder,
  sanitizeOpenTabs,
  tabAvailableInContext,
  mainTabsForContext,
} from '../../src/renderer/lib/drawer-tabs'

describe('on-demand open tabs', () => {
  it('sanitizes persisted open tabs: drops unknown, duplicated and unavailable entries', () => {
    expect(sanitizeOpenTabs(['terminal', 'card', 'terminal', 'chatgpt', 'notes'], { id: 'c' }, false)).toEqual([
      'terminal',
      'notes',
    ])
    expect(sanitizeOpenTabs(['notes'], null)).toEqual([])
    expect(sanitizeOpenTabs(undefined, { id: 'c' })).toEqual([])
  })

  it('opens a tab only once, keeping the array identity when already open', () => {
    const list = ['browser'] as const
    expect(openTabInList([...list], 'terminal')).toEqual(['browser', 'terminal'])
    const same = [...list]
    expect(openTabInList(same, 'browser')).toBe(same)
  })

  it('closing the active tab activates the right neighbour, then the left, then null', () => {
    expect(closeTabInList(['a', 'b', 'c'] as never, 'b' as never, 'b' as never)).toEqual({
      list: ['a', 'c'],
      active: 'c',
    })
    expect(closeTabInList(['a', 'b'] as never, 'b' as never, 'b' as never)).toEqual({ list: ['a'], active: 'a' })
    expect(closeTabInList(['a'] as never, 'a' as never, 'a' as never)).toEqual({ list: [], active: null })
  })

  it('closing an inactive tab keeps the active one', () => {
    expect(closeTabInList(['browser', 'terminal', 'plan'], 'plan', 'browser')).toEqual({
      list: ['browser', 'terminal'],
      active: 'browser',
    })
    expect(closeTabInList(['browser'], 'plan', 'browser')).toEqual({ list: ['browser'], active: 'browser' })
  })

  it('moves open tabs and ignores out-of-range indexes', () => {
    const list = ['browser', 'terminal', 'plan'] as const
    expect(moveOpenTab([...list], 0, 2)).toEqual(['terminal', 'plan', 'browser'])
    const same = [...list]
    expect(moveOpenTab(same, 0, 5)).toBe(same)
    expect(moveOpenTab(same, 1, 1)).toBe(same)
  })
})

describe('conditional drawer tabs', () => {
  it('hides ChatGPT when the feature is disabled and retains it when enabled', () => {
    expect(mainTabsForFeatures(DEFAULT_MAIN_ORDER, false)).not.toContain('chatgpt')
    expect(mainTabsForFeatures(DEFAULT_MAIN_ORDER, true)).toContain('chatgpt')
  })

  it('reorders visible tabs without moving the hidden experimental tab', () => {
    const full = ['browser', 'chatgpt', 'terminal', 'plan'] as const
    const visible = mainTabsForFeatures([...full], false)
    expect(reorderVisibleTabs([...full], visible, 0, 2)).toEqual(['terminal', 'chatgpt', 'plan', 'browser'])
  })

  it('removes the legacy delegations tab from persisted preferences', () => {
    expect(sanitizeMainOrder(['terminal', 'delegations', 'browser'])).not.toContain('delegations')
  })
})

describe("tools of a remote host's conversation", () => {
  const remote = { id: 'server-1/workspaces#conv-1', scope: 'project' }

  it('offers its panels and its files, and neither the browser nor the editor nor the companion', () => {
    expect(mainTabsForContext(DEFAULT_MAIN_ORDER, remote, true)).toEqual([
      'terminal',
      'files',
      'plan',
      'review',
      'notes',
    ])
    expect(tabAvailableInContext('files', { id: 'conv-1', scope: 'project' })).toBe(false)
    expect(tabAvailableInContext('browser', remote)).toBe(false)
    expect(tabAvailableInContext('vscode', { id: remote.id })).toBe(false)
    expect(tabAvailableInContext('terminal', { id: remote.id })).toBe(true)
    // A chat has no review, there as here.
    expect(tabAvailableInContext('review', { ...remote, scope: 'standalone' })).toBe(false)
  })

  it("offers a conversation's computer only on a host that gives its conversations computers", () => {
    expect(DEFAULT_MAIN_ORDER[1]).toBe('computer')
    const computers = (hostId: string, tab: 'browser' | 'vscode' | 'computer') =>
      hostId === 'server-1/workspaces' && tab !== 'vscode'
    expect(mainTabsForContext(DEFAULT_MAIN_ORDER, remote, true, computers)).toEqual([
      'browser',
      'computer',
      'terminal',
      'files',
      'plan',
      'review',
      'notes',
    ])
    expect(tabAvailableInContext('computer', remote, true, computers)).toBe(true)
    expect(tabAvailableInContext('computer', { id: 'server-2/workspaces#conv-1' }, true, computers)).toBe(false)
    expect(tabAvailableInContext('computer', remote)).toBe(false)
    // This computer is the owner's own: its conversations need no computer tab.
    expect(tabAvailableInContext('computer', { id: 'conv-1', scope: 'project' }, true, computers)).toBe(false)
    expect(sanitizeOpenTabs(['computer', 'notes'], remote, true, computers)).toEqual(['computer', 'notes'])
    expect(sanitizeOpenTabs(['computer', 'notes'], { id: 'conv-1' }, true, computers)).toEqual(['notes'])
  })

  it('drops tabs persisted by the host that this computer cannot show', () => {
    expect(sanitizeOpenTabs(['browser', 'terminal', 'vscode', 'notes'], remote)).toEqual(['terminal', 'notes'])
    expect(sanitizeOpenTabs(['browser', 'terminal'], { id: 'conv-1' })).toEqual(['browser', 'terminal'])
  })

  it('offers the browser of a host that streams it, and its editor only when it serves one', () => {
    const streams = (hostId: string, tab: 'browser' | 'vscode' | 'computer') =>
      hostId === 'server-1/workspaces' && tab === 'browser'
    expect(mainTabsForContext(DEFAULT_MAIN_ORDER, remote, true, streams)).toEqual([
      'browser',
      'terminal',
      'files',
      'plan',
      'review',
      'notes',
    ])
    expect(tabAvailableInContext('browser', remote, true, streams)).toBe(true)
    expect(tabAvailableInContext('browser', { id: 'server-2/workspaces#conv-1' }, true, streams)).toBe(false)
    expect(tabAvailableInContext('vscode', remote, true, streams)).toBe(false)
    expect(sanitizeOpenTabs(['browser', 'vscode', 'notes'], remote, true, streams)).toEqual(['browser', 'notes'])
  })

  it('offers the editor of a host that serves it, never the companion', () => {
    const serves = (hostId: string, tab: 'browser' | 'vscode' | 'computer') =>
      hostId === 'server-1/workspaces' && tab !== 'computer'
    expect(mainTabsForContext(DEFAULT_MAIN_ORDER, remote, true, serves)).toEqual([
      'browser',
      'vscode',
      'terminal',
      'files',
      'plan',
      'review',
      'notes',
    ])
    expect(tabAvailableInContext('vscode', { id: 'server-2/workspaces#conv-1' }, true, serves)).toBe(false)
    expect(tabAvailableInContext('chatgpt', remote, true, serves)).toBe(false)
    expect(sanitizeOpenTabs(['vscode', 'terminal'], remote, true, serves)).toEqual(['vscode', 'terminal'])
  })
})
