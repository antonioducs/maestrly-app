import { describe, expect, it } from 'vitest'
import { compileClaudeCompactionSystem, compileClaudeSubagentPrompt } from '../../src/main/chat/behavior-prompt'
import { compileFableCompactionSystem, compileFableSubagentPrompt } from '../../src/main/chat/fable/prompt'
import { FABLE_51_BEHAVIOR_PROFILE as fable } from '../../src/main/chat/fable/profile'
import { OPUS_5_BEHAVIOR_PROFILE as opus } from '../../src/main/chat/opus/profile'
import { opusUltraGuidance } from '../../src/main/chat/opus/prompt'
import { SYSTEM_PROMPT } from '../../src/main/chat/runner'

describe('Opus prompt contracts', () => {
  it('preserves legacy and Fable compilation bytes', () => {
    for (const profile of [null, fable]) {
      expect(compileClaudeCompactionSystem('base', profile)).toBe(compileFableCompactionSystem('base', profile))
      expect(compileClaudeSubagentPrompt('base', profile)).toBe(compileFableSubagentPrompt('base', profile))
    }
  })
  it('keeps mode boundaries and required checks', () => {
    for (const mode of ['agent', 'ask', 'plan', 'design', 'maestro'] as const) {
      const prompt = SYSTEM_PROMPT('/repo', true, mode, false, opus)
      expect(prompt).toContain(opus.id)
      expect(prompt).toContain('required project checks')
      expect(prompt).not.toContain(fable.id)
    }
    expect(SYSTEM_PROMPT('/repo', true, 'ask', false, opus)).toContain('Do NOT edit project files or run commands')
    expect(SYSTEM_PROMPT('/repo', true, 'plan', false, opus)).toContain('Calling review_plan ENDS your turn')
    expect(opusUltraGuidance('maestro')).toContain('frozen Strategy and Pool')
    expect(opusUltraGuidance('agent')).toContain('do not automatically add extra reviewers')
  })
  it('retains custom worker restrictions and continuity evidence', () => {
    const custom = 'Only inspect files. A security review is required.'
    expect(compileClaudeSubagentPrompt(custom, opus).startsWith(custom)).toBe(true)
    expect(compileClaudeSubagentPrompt(custom, opus)).toContain('including explicitly requested reviews')
    const compact = compileClaudeCompactionSystem('base', opus)
    for (const fact of ['rejected attempts', 'remaining work', 'exact references', 'actual evidence', 'Never invent']) {
      expect(compact).toContain(fact)
    }
  })
})
