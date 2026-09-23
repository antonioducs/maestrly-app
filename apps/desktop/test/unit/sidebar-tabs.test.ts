import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  conversationSidebarTab,
  crossTabMatches,
  nextSidebarTab,
  readSidebarTab,
  workspaceFilterCount,
} from '../../src/renderer/components/sidebar/sidebar-tabs'
import type { Conversation } from '../../src/shared/conversation'

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('sidebar tabs', () => {
  it('defaults to workspaces and resolves selected conversations', () => {
    expect(readSidebarTab(null)).toBe('workspaces')
    expect(readSidebarTab('invalid')).toBe('workspaces')
    expect(readSidebarTab('bots')).toBe('bots')
    expect(conversationSidebarTab({ scope: 'standalone' } as Conversation)).toBe('chats')
    expect(conversationSidebarTab({ scope: 'project' } as Conversation)).toBe('workspaces')
  })

  it('wraps arrow navigation and jumps to the ends', () => {
    expect(nextSidebarTab('chats', 'ArrowLeft')).toBe('bots')
    expect(nextSidebarTab('bots', 'ArrowRight')).toBe('chats')
    expect(nextSidebarTab('workspaces', 'Home')).toBe('chats')
    expect(nextSidebarTab('workspaces', 'End')).toBe('bots')
    expect(nextSidebarTab('chats', 'Escape')).toBeNull()
  })

  it('counts matching workspace names and conversations, then offers matches in other tabs', () => {
    expect(
      workspaceFilterCount(
        [
          {
            name: 'Alpha',
            conversations: [
              { name: 'Alpha fix', branch: 'main' },
              { name: 'Review', branch: 'alpha' },
            ],
          },
          { name: 'Beta', conversations: [{ name: 'Other', branch: null }] },
        ],
        'ALPHA'
      )
    ).toBe(3)
    expect(crossTabMatches('bots', { chats: 2, workspaces: 0, bots: 0 })).toEqual([{ tab: 'chats', count: 2 }])
  })

  it('connects each tab to a panel and persists the selected tab', () => {
    const header = source('src/renderer/components/sidebar/SidebarHeader.tsx')
    const sidebar = source('src/renderer/components/Sidebar.tsx')
    expect(header).toContain('role="tablist"')
    expect(header).toContain('role="tab"')
    expect(header).toContain('aria-selected={tab === item}')
    expect(header).toMatch(/aria-controls=\{`sidebar-panel-\$\{item\}`\}/)
    expect(sidebar.match(/role="tabpanel"/g)).toHaveLength(3)
    expect(sidebar).toContain("hidden={tab !== 'chats'}")
    expect(sidebar).toContain("hidden={tab !== 'workspaces'}")
    expect(sidebar).toContain("hidden={tab !== 'bots'}")
    expect(sidebar).toContain("localStorage.getItem('sidebar.tab')")
    expect(sidebar).toContain("localStorage.setItem('sidebar.tab', next)")
    expect(sidebar).toContain('conversationSidebarTab(selectedConversation)')
    expect(sidebar).toContain('[requestedTab?.requestId]')
  })
})
