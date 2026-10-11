import { describe, expect, it } from 'vitest'
import { APP_TOOL_POLICY } from '../../src/main/chat/tool-policy'
import { buildMaestrlyBasePrompt, hostAppToolsSection } from '../../src/main/chat/harness/host-contracts'
import { composeOpenAICodexPortPrompt } from '../../src/main/chat/harness/strategies/prompt-layout'
import { harnessFor } from '../../src/main/chat/harness/execution'
import { APP_TOOL_GROUPS, appToolGroupOf, sanitizeAppToolGroupPatch } from '../../src/shared/app-tool-groups'

/** Tools that only exist in bot instances, where every app tool is always on. */
const BOT_ONLY =
  /^(computer_|bot_peers_|bot_routines_|bot_share_file$|owner_memory_|routine_report$|request_owner_help$|desktop_)/

describe('app-tool groups', () => {
  it('assigns every desktop app tool to exactly one group', () => {
    const ungrouped = Object.keys(APP_TOOL_POLICY).filter((name) => appToolGroupOf(name) === null)
    expect(ungrouped.filter((name) => !BOT_ONLY.test(name))).toEqual([])
    for (const name of ungrouped) expect(BOT_ONLY.test(name), name).toBe(true)

    const used = new Set(Object.keys(APP_TOOL_POLICY).map(appToolGroupOf).filter(Boolean))
    expect([...used].sort()).toEqual([...APP_TOOL_GROUPS].sort())
    expect(appToolGroupOf('project_notes_read_page')).toBe('notes')
    expect(appToolGroupOf('get_linked_kanban')).toBe('board')
    expect(appToolGroupOf('owner_memory_save')).toBeNull()
  })

  it('keeps only known groups with boolean values from untrusted patches', () => {
    expect(sanitizeAppToolGroupPatch({ debug: false, browser: true, computer: false, memory: 'off' })).toEqual({
      debug: false,
      browser: true,
    })
    expect(sanitizeAppToolGroupPatch(null)).toEqual({})
    expect(sanitizeAppToolGroupPatch(['debug'])).toEqual({})
  })
})

describe('app-tool prompts', () => {
  const harness = harnessFor('anthropic', 'generic-model')

  it('stops naming the groups the user turned off and says so', () => {
    const agent = hostAppToolsSection(true, true, 'agent', ['browser', 'history'])
    expect(agent).toContain('Maestrly app tools (terminal, notes, memory, debug):')
    expect(agent).toContain('(terminal_*, notes_*, memory_*, debug_*)')
    expect(agent).not.toContain('browser_*,')
    expect(agent).toContain('The user turned off browser_* and history_* in this conversation')

    const ask = hostAppToolsSection(true, true, 'ask', ['notes', 'terminal'])
    expect(ask).toContain('restricted catalog: memory search/list/read and browser navigation/read.')

    const none = hostAppToolsSection(true, false, 'agent', ['terminal', 'browser', 'memory', 'debug'])
    expect(none).toContain('Maestrly app tools: ON — use only the app tools actually exposed in your tool set.')
    expect(none).not.toContain('PREFER')
  })

  it('keeps the default prompt identical when no group is off', () => {
    for (const mode of ['agent', 'ask', 'plan', 'maestro'] as const) {
      const input = { harness, cwd: '/repo', appToolsEnabled: true, mode, hasNotesTab: true }
      expect(buildMaestrlyBasePrompt({ ...input, disabledAppToolGroups: [] })).toBe(buildMaestrlyBasePrompt(input))
    }
  })

  it('applies the same rule to the Responses layout', () => {
    const input = { base: 'Base.', cwd: '/repo', mode: 'agent' as const, appToolsEnabled: true, hasNotesTab: true }
    const full = composeOpenAICodexPortPrompt(input).instructions
    expect(full).toContain('Drawer tools are available as terminal_*, browser_*, notes_*, memory_*, and debug_*.')
    expect(composeOpenAICodexPortPrompt({ ...input, disabledAppToolGroups: [] }).instructions).toBe(full)

    const reduced = composeOpenAICodexPortPrompt({ ...input, disabledAppToolGroups: ['debug', 'notes'] }).instructions
    expect(reduced).toContain('Drawer tools are available as terminal_*, browser_*, and memory_*.')
    expect(reduced).toContain('Prefer terminal_* and memory_* over equivalent native tools')
    expect(reduced).toContain('The user turned off notes_*/project_notes_* and debug_* in this conversation')
  })
})
