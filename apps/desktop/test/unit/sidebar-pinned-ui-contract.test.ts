import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import en from '../../src/shared/i18n/en/ui'
import ptBR from '../../src/shared/i18n/pt-BR/ui'

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

/** Sidebar pinned-section source contract: verify UI conditions and instance identities without mounting React. Pure collectPinnedConversations tests cover data ordering and filtering separately. */
describe('sidebar pinned UI contract', () => {
  it('shows the pinned section only with pins and outside search, avoiding duplicate results', () => {
    const sidebar = source('src/renderer/components/Sidebar.tsx')
    // Require an empty search and at least one pin.
    expect(sidebar).toContain('!q && pinned.length > 0')
    expect(sidebar).toContain('collectPinnedConversations(workspaces)')
    expect(sidebar).toContain("t('sidebar.pinnedConversations')")
    // Exactly one pinned.map prevents a duplicate section in the search branch.
    expect(sidebar.match(/pinned\.map\(\(item\) =>/g)).toHaveLength(1)
  })

  it('pinned shortcuts use convItem with pinned:<id> instance keys and project context, without DnD', () => {
    const sidebar = source('src/renderer/components/Sidebar.tsx')
    const start = sidebar.indexOf('pinned.map((item) =>')
    const contextTooltip = 'contextTooltip: item.workspace.path'
    const end = sidebar.indexOf(contextTooltip) + contextTooltip.length
    const pinnedBlock = sidebar.slice(start, end)

    expect(pinnedBlock).toContain("pl: 'pl-6'")
    expect(pinnedBlock).toContain('instanceKey: `pinned:${item.conversation.id}`')
    expect(pinnedBlock).toContain('contextLabel: pinnedWorkspaceLabels.get(item.workspace.id) ?? item.workspace.name')
    expect(pinnedBlock).toContain(contextTooltip)
    // Shortcuts are independent of folders and collapsed workspace trees.
    expect(pinnedBlock).not.toContain('dnd')
    expect(pinnedBlock).not.toContain('buildConvTopNodes')
    expect(pinnedBlock).not.toContain('WorkspaceConvList')
  })

  it('project context appears in a subtitle with icon and path tooltip, including during rename', () => {
    const rows = source('src/renderer/components/sidebar/conv-rows.tsx')
    const renameStart = rows.indexOf('{isRenaming ? (')
    const contextStart = rows.indexOf('{contextLabel && (', renameStart)

    expect(rows).toContain("contextLabel ? 'items-start' : 'items-center'")
    expect(rows).toContain(
      'className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-3 text-muted-foreground/80"'
    )
    expect(rows).toContain('<Folder className="size-3 shrink-0 opacity-70" />')
    expect(rows).toContain('showQuickTooltip(e, contextTooltip ?? contextLabel)')
    // Subtitle follows the input/title conditional, preserving project identity during rename.
    expect(contextStart).toBeGreaterThan(rows.indexOf(') : (', renameStart))
  })

  it('workspace trees retain original entries and collapse hides only the tree', () => {
    const sidebar = source('src/renderer/components/Sidebar.tsx')
    // The tree receives all ws.conversations without filtering pinned entries.
    expect(sidebar).toContain('buildConvTopNodes(ws.conversations)')
    // Tree occurrences use tree:<id>, distinct from pinned:<id>, allowing one input per occurrence.
    expect(sidebar).toContain('instanceKey: `tree:${conv.id}`')
    // Workspace collapse hides only its tree list; the pinned section is outside that condition.
    expect(sidebar).toContain('const isCollapsed = ws.collapsed && !q')
    expect(sidebar).toContain('!isCollapsed && (')
  })

  it('rename has one input per instanceKey and both menus use the same occurrence', () => {
    const sidebar = source('src/renderer/components/Sidebar.tsx')
    const rows = source('src/renderer/components/sidebar/conv-rows.tsx')
    // Persist only the renaming instance; ignore late Escape or blur from another occurrence.
    expect(sidebar).toContain('if (renaming?.instanceKey !== instanceKey) return')
    // Open the input only for the renaming tree or pinned occurrence.
    expect(rows).toContain('const isRenaming = renaming?.instanceKey === opts.instanceKey')
    expect(rows).toContain('{isRenaming ? (')
    // Dropdown and context menus receive the same instanceKey; renaming updates both occurrences.
    expect(rows).toContain('convMenuItems(conv, isArchived, opts.instanceKey, dropdownKit)')
    expect(rows).toContain('convMenuItems(conv, isArchived, opts.instanceKey, contextKit)')
    expect(rows).toContain('instanceKey: `tree:${c.id}`')
  })

  it('shared menus select Pin or PinOff from pinnedAt and omit the action for archived conversations', () => {
    const menus = source('src/renderer/components/sidebar/use-sidebar-menus.tsx')
    // Toggle pinnedAt to null to unpin; archived conversations offer no pin action.
    expect(menus).toContain('if (isArchived) return null')
    expect(menus).toContain('const pinned = conv.pinnedAt !== null')
    expect(menus).toContain('Promise.resolve(onPinConversation(conv, !pinned)).catch((error) => {')
    expect(menus).toContain('{pinned ? <PinOff /> : <Pin />}')
    expect(menus).toContain("t('sidebar.pinConversation')")
    expect(menus).toContain("t('sidebar.unpinConversation')")
    // Both dropdown and context menus share convMenuItems and expose pinning.
    expect(menus).toContain(
      'const convMenuItems = (conv: Conversation, isArchived: boolean, instanceKey: string, m: MenuKit) => ('
    )
  })

  it('pin labels exist in both English and Brazilian Portuguese catalogs', () => {
    expect(en.sidebar.pinnedConversations).toBe('Pinned')
    expect(en.sidebar.pinConversation).toBe('Pin conversation')
    expect(en.sidebar.unpinConversation).toBe('Unpin conversation')
    expect(ptBR.sidebar.pinnedConversations).toBe('Fixadas')
    expect(ptBR.sidebar.pinConversation).toBe('Fixar conversa')
    expect(ptBR.sidebar.unpinConversation).toBe('Desfixar conversa')
  })
})
