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
    // A vertical rail: up and down move between tabs, and left and right still do.
    expect(nextSidebarTab('chats', 'ArrowUp')).toBe('bots')
    expect(nextSidebarTab('bots', 'ArrowDown')).toBe('chats')
    expect(nextSidebarTab('chats', 'ArrowDown')).toBe('workspaces')
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
    const rail = source('src/renderer/components/sidebar/SidebarRail.tsx')
    const sidebar = source('src/renderer/components/Sidebar.tsx')
    expect(rail).toContain('role="tablist"')
    expect(rail).toContain('aria-orientation="vertical"')
    expect(rail).toContain('role="tab"')
    expect(rail).toContain('aria-selected={tab === item}')
    expect(rail).toMatch(/aria-controls=\{`sidebar-panel-\$\{item\}`\}/)
    // The tab's name is its label alone: what needs attention is its description.
    expect(rail).toContain('<span className="sr-only">{label}</span>')
    expect(rail).toMatch(/aria-describedby=\{needsYou \? `sidebar-tab-\$\{item\}-attention` : undefined\}/)
    expect(sidebar.match(/role="tabpanel"/g)).toHaveLength(3)
    expect(sidebar).toContain("hidden={tab !== 'chats'}")
    expect(sidebar).toContain("hidden={tab !== 'workspaces'}")
    expect(sidebar).toContain("hidden={tab !== 'bots'}")
    expect(sidebar).toContain("localStorage.getItem('sidebar.tab')")
    expect(sidebar).toContain("localStorage.setItem('sidebar.tab', next)")
    expect(sidebar).toContain('conversationSidebarTab(selectedConversation)')
    expect(sidebar).toContain('[requestedTab?.requestId]')
  })

  it('lists one machine at a time, follows the open conversation to its machine and remembers the choice', () => {
    const sidebar = source('src/renderer/components/Sidebar.tsx')
    expect(sidebar).toContain("localStorage.getItem('sidebar.host')")
    expect(sidebar).toContain("localStorage.setItem('sidebar.host', next)")
    expect(sidebar).toContain('selectHost(hostOfKey(selectedConversation.id))')
    expect(sidebar).toContain('selectHost(hostOfKey(workspace.id))')
    // The switcher only exists beside another machine, and never in the Bots tab.
    expect(sidebar).toContain("multiHost && tab !== 'bots' && (")
    // Each list panel shows the chosen machine's section, never every machine's at once.
    expect(sidebar.match(/renderHostSection\(selectedSection, '(chats|workspaces)'\)/g)).toHaveLength(2)
    expect(sidebar).not.toContain('hostSections.map((section) => renderHostSection')
  })

  it('collapses to the icon rail, whose one toggle stays in place, and remembers it', () => {
    const app = source('src/renderer/DesktopApp.tsx')
    const sidebar = source('src/renderer/components/Sidebar.tsx')
    const rail = source('src/renderer/components/sidebar/SidebarRail.tsx')
    // The sidebar is always mounted: collapsing hides its panel, not the rail.
    expect(app).not.toContain('sidebarOpen && (')
    expect(app).toContain("localStorage.getItem('sidebar.collapsed') !== '1'")
    expect(app).toContain("localStorage.setItem('sidebar.collapsed', collapsed ? '1' : '0')")
    expect(sidebar).toContain("collapsed ? 'hidden' : 'flex'")
    // The toggle is the rail's, the same element open or collapsed, and says what it controls.
    expect(rail).toContain('aria-expanded={!collapsed}')
    expect(rail).toContain('aria-controls="sidebar-panel"')
    expect(sidebar).toContain('id="sidebar-panel"')
    // Clicking a section opens the panel on it; moving with the arrows does not.
    expect(sidebar).toContain('if (collapsed) onCollapsedChange(false)')
    expect(rail).toMatch(/onClick=\{\(\) => \{\s*hideQuickTooltip\(\)\s*onTabActivate\(item\)/)
    // Views no longer carry a button of their own to show the sidebar.
    for (const view of [
      'src/renderer/components/ProjectNotesView.tsx',
      'src/renderer/components/SettingsView.tsx',
      'src/renderer/components/artifacts/ArtifactsCenter.tsx',
      'src/renderer/components/memory/LocalMemoryPanel.tsx',
      'src/renderer/components/memory/PersonalMemoryPanel.tsx',
    ]) {
      expect(source(view), view).not.toContain('onShowSidebar')
      expect(source(view), view).toContain('pl-[var(--view-header-inset)]')
    }
  })
})
