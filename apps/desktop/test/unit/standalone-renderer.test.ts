import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mainTabsForContext, sanitizeOpenTabs, DEFAULT_MAIN_ORDER } from '../../src/renderer/lib/drawer-tabs'
import { filterStandaloneConversations } from '../../src/renderer/lib/standalone-conversations'

describe('standalone renderer scope', () => {
  it('retains generic tools and excludes project review', () => {
    expect(mainTabsForContext(DEFAULT_MAIN_ORDER, { scope: 'standalone' })).toEqual([
      'browser',
      'vscode',
      'terminal',
      'plan',
      'notes',
      'chatgpt',
    ])
    expect(mainTabsForContext(DEFAULT_MAIN_ORDER, { scope: 'project' })).toEqual(DEFAULT_MAIN_ORDER)
  })
  it('restores on-demand tabs without reopening project-only tools', () => {
    expect(sanitizeOpenTabs(['terminal', 'review', 'notes'], { scope: 'standalone' })).toEqual(['terminal', 'notes'])
  })
  // Open-tab hydration must cover standalone chats, which live outside workspaces.
  it('hydrates open tabs from every conversation scope', () => {
    const source = readFileSync(new URL('../../src/renderer/DesktopApp.tsx', import.meta.url), 'utf8')
    expect(source).toContain('hydrateOpenTabs(\n      allConversations.map((conv) => ({')
  })
  it('searches names without accessing a null branch', () => {
    const chats = [
      { id: 'a', name: 'Alpha', branch: null },
      { id: 'b', name: 'Beta', branch: null },
    ]
    expect(filterStandaloneConversations(chats, ' ALP ')).toEqual([chats[0]])
    expect(filterStandaloneConversations(chats, '')).toBe(chats)
  })
})
