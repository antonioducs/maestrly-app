import { buildHarnessPrompt } from '../../src/main/chat/harness/prompt-builder'
import { describe, expect, it } from 'vitest'
import { buildMaestrlyBasePrompt } from '../../src/main/chat/harness/host-contracts'
import { harnessFor } from '../../src/main/chat/harness/execution'

it('retains model behavior and reasoning guidance without a project-oriented identity', () => {
  const original = harnessFor('openai-responses', 'gpt-6-astra')
  const harness = {
    ...original,
    prompts: {
      ...original.prompts,
      styleAndWork: 'PROFILE STYLE: keep explanations concrete.',
      base: 'You are Maestrly, a coding agent in one shared workspace.\n\n# Personality\nPROFILE PERSONALITY: stay curious.\n\nUse Memory Center for project decisions.',
      layout: 'openai-astra' as const,
    },
  }
  const result = buildHarnessPrompt({
    harness,
    cwd: '/private/chat',
    scope: 'standalone',
    mode: 'ask',
    appToolsEnabled: false,
    hasNotesTab: true,
    ultraContext: 'PROFILE REASONING: verify assumptions.',
  })
  expect(result.layout).toBe('openai-astra')
  expect(result.instructions).toContain('PROFILE STYLE')
  expect(result.instructions).toContain('PROFILE PERSONALITY')
  expect(result.instructions).toContain('PROFILE REASONING')
  expect(result.instructions).not.toContain('a coding agent in one shared workspace')
  expect(result.instructions).not.toContain('Use Memory Center')
  expect(result.instructions).not.toContain('real project context')
  expect(result.instructions).toContain('webfetch')
})
describe('standalone general harness', () => {
  it('has general identity without project memory and retains Ask restrictions', () => {
    const prompt = buildMaestrlyBasePrompt({
      harness: harnessFor('openai', 'unknown'),
      cwd: '/private/chat',
      scope: 'standalone',
      appToolsEnabled: false,
      mode: 'ask',
      hasNotesTab: true,
    })
    expect(prompt).toContain('general assistant')
    expect(prompt).not.toContain('coding assistant')
    expect(prompt).not.toContain('Durable project memory')
    expect(prompt).toContain('Do NOT edit')
    expect(prompt).toContain('shell')
  })
})

it.each([
  'openai',
  'openai-responses',
  'anthropic',
  'codex-subscription',
  'claude-subscription',
  'github-copilot-subscription',
  'grok-subscription',
] as const)('uses the general host prompt for %s without changing its tools', (provider) => {
  const result = buildHarnessPrompt({
    harness: harnessFor(provider, 'gpt-5.6-sol'),
    cwd: '/private/chat',
    scope: 'standalone',
    mode: 'ask',
    appToolsEnabled: true,
    hasNotesTab: true,
    projectContext: 'MUST NOT INJECT PROJECT',
    skillsContext: 'GLOBAL SKILL',
  })
  expect(result.instructions).toContain('general assistant')
  expect(result.instructions).toContain('GLOBAL SKILL')
  expect(result.instructions).not.toContain('MUST NOT INJECT PROJECT')
  expect(result.instructions).not.toContain('# Durable project memory')
  expect(result.instructions).toContain('Do NOT edit')
})
