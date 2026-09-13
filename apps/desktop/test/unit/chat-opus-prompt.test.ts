import { describe, expect, it } from 'vitest'
import { harnessFor } from '../../src/main/chat/harness/execution'
import {
  buildMaestrlyBasePrompt,
  harnessCompactionSystem,
  harnessSubagentPrompt,
  harnessUltraGuidance,
} from '../../src/main/chat/harness/host-contracts'
import type { ChatBehavior } from '../../src/shared/conversation-experience'

const generic = harnessFor('anthropic', 'generic-model')
const fable = harnessFor('claude-subscription', 'claude-fable-5-1')
const opus = harnessFor('claude-subscription', 'claude-opus-5')

const prompt = (mode: ChatBehavior, harness = opus): string =>
  buildMaestrlyBasePrompt({ harness, cwd: '/repo', appToolsEnabled: true, mode, hasNotesTab: false })

describe('Opus prompt contracts', () => {
  it('leaves an unspecialized profile with the legacy compilation bytes', () => {
    expect(harnessCompactionSystem('base', generic)).toBe('base')
    expect(harnessSubagentPrompt('base', generic)).toBe('base')
  })

  it('keeps mode boundaries and required checks', () => {
    for (const mode of ['agent', 'ask', 'plan', 'design', 'maestro'] as const) {
      const compiled = prompt(mode)
      expect(compiled).toContain('maestrly-opus-5-v1')
      expect(compiled).toContain('required project checks')
      expect(compiled).not.toContain('maestrly-fable-5.1-v1')
    }
    expect(prompt('ask')).toContain('Do NOT edit project files or run commands')
    expect(prompt('plan')).toContain('Calling review_plan ENDS your turn')
    expect(harnessUltraGuidance(opus, 'maestro')).toContain('frozen Strategy and Pool')
    expect(harnessUltraGuidance(opus, 'agent')).toContain('do not automatically add extra reviewers')
  })

  it('does not inherit the Fable hook, progress mode or Ultra guidance', () => {
    expect(opus.progress).toBe('prompt-only')
    expect(opus.hooks).toEqual([])
    expect(harnessUltraGuidance(fable, 'agent')).toBeNull()
    expect(opus.prompts.environment.placement).toBe('last-user-message')
  })

  it('retains custom worker restrictions and continuity evidence', () => {
    const custom = 'Only inspect files. A security review is required.'
    expect(harnessSubagentPrompt(custom, opus).startsWith(custom)).toBe(true)
    expect(harnessSubagentPrompt(custom, opus)).toContain('including explicitly requested reviews')
    const compact = harnessCompactionSystem('base', opus)
    for (const fact of ['rejected attempts', 'remaining work', 'exact references', 'actual evidence', 'Never invent']) {
      expect(compact).toContain(fact)
    }
  })
})
