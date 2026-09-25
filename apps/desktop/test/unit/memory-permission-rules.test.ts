import { describe, expect, it } from 'vitest'
import { AUTO_RULESET, BOT_MEMORY_WRITE_RULES, BYOK_DEFAULT_RULESET, ruleEffect } from '../../src/main/chat/permission'

describe('memory permission rules', () => {
  it('never prompts for memory and history reads, but still asks for writes on the desktop', () => {
    for (const tool of ['memory_search', 'memory_list', 'memory_read', 'history_search', 'history_read'])
      expect(ruleEffect('mcp', tool, BYOK_DEFAULT_RULESET)).toBe('allow')
    expect(ruleEffect('mcp', 'memory_upsert', BYOK_DEFAULT_RULESET)).toBe('ask')
    expect(ruleEffect('mcp', 'some_external_tool', BYOK_DEFAULT_RULESET)).toBe('ask')
  })
  it('lets a bot write its memory and report routines without prompting, except permanent deletion', () => {
    const bot = [...BYOK_DEFAULT_RULESET, ...BOT_MEMORY_WRITE_RULES]
    for (const tool of [
      'memory_upsert',
      'memory_archive',
      'memory_restore',
      'owner_memory_save',
      'owner_memory_forget',
      'routine_report',
    ])
      expect(ruleEffect('mcp', tool, bot)).toBe('allow')
    expect(ruleEffect('mcp', 'memory_forget', bot)).toBe('ask')
    expect(ruleEffect('mcp', 'memory_forget', AUTO_RULESET)).toBe('allow')
  })
})
