import { describe, expect, it } from 'vitest'
import {
  AUTO_RULESET,
  BOT_MEMORY_WRITE_RULES,
  BOT_SKILL_READ_RULES,
  BYOK_DEFAULT_RULESET,
  YOLO_RULESET,
  ruleEffect,
} from '../../src/main/chat/permission'

describe('memory permission rules', () => {
  it('never prompts for memory and history reads, but still asks for writes on the desktop', () => {
    for (const tool of ['memory_search', 'memory_list', 'memory_read', 'history_search', 'history_read', 'plan_read'])
      expect(ruleEffect('mcp', tool, BYOK_DEFAULT_RULESET)).toBe('allow')
    expect(ruleEffect('mcp', 'memory_upsert', BYOK_DEFAULT_RULESET)).toBe('ask')
    expect(ruleEffect('mcp', 'some_external_tool', BYOK_DEFAULT_RULESET)).toBe('ask')
  })
  it('never prompts for artifact reads, but asks before publishing, opening or answering comments', () => {
    for (const tool of ['artifact_get', 'artifact_list', 'artifact_comments', 'artifact_responses'])
      expect(ruleEffect('mcp', tool, BYOK_DEFAULT_RULESET)).toBe('allow')
    for (const tool of [
      'artifact_create',
      'artifact_update',
      'artifact_open',
      'artifact_comment_reply',
      'artifact_comment_resolve',
    ])
      expect(ruleEffect('mcp', tool, BYOK_DEFAULT_RULESET)).toBe('ask')
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
  it('lets a bot read skills without prompting, while changing its own skills follows its ceiling', () => {
    const ask = [...BYOK_DEFAULT_RULESET, ...BOT_MEMORY_WRITE_RULES, ...BOT_SKILL_READ_RULES]
    for (const tool of ['skill_list', 'skill_view']) expect(ruleEffect('mcp', tool, ask)).toBe('allow')
    const writes = ['skill_create', 'skill_patch', 'skill_write_file', 'skill_archive', 'skill_proposal']
    for (const tool of writes) {
      expect(ruleEffect('mcp', tool, ask)).toBe('ask')
      expect(ruleEffect('mcp', tool, [...AUTO_RULESET, ...BOT_SKILL_READ_RULES])).toBe('allow')
      expect(ruleEffect('mcp', tool, [...YOLO_RULESET, ...BOT_SKILL_READ_RULES])).toBe('allow')
    }
  })
})
