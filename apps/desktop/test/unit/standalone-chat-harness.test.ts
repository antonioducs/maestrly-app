import { buildHarnessPrompt } from '../../src/main/chat/harness/prompt-builder'
import { describe, expect, it, vi } from 'vitest'
import { buildMaestrlyBasePrompt } from '../../src/main/chat/harness/host-contracts'
import { harnessFor } from '../../src/main/chat/harness/execution'
import { codexAdapterCapabilities, resolveCodexThreadPolicy } from '../../src/main/chat/harness/adapters/codex'
import type { ChatProviderKind } from '../../src/shared/chat'

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
  expect(result.instructions).toContain('web_search')
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

describe('standalone conversation style', () => {
  const promptFor = (provider: ChatProviderKind, model: string, scope: 'project' | 'standalone') =>
    buildHarnessPrompt({
      harness: harnessFor(provider, model),
      cwd: '/private/chat',
      scope,
      mode: 'agent',
      appToolsEnabled: true,
      hasNotesTab: true,
    }).instructions

  it.each([
    ['claude-subscription', 'claude-sonnet-4'],
    ['claude-subscription', 'claude-opus-5'],
    ['claude-subscription', 'claude-fable-5-1'],
    ['openai-responses', 'gpt-5.6-sol'],
    ['openai-responses', 'gpt-6-astra'],
    ['codex-subscription', 'gpt-6-astra'],
    ['github-copilot-subscription', 'openai/gpt-5.6-sol'],
  ] as const)('gives %s %s a conversational voice and scopes the coding style to requested work', (provider, model) => {
    const prompt = promptFor(provider, model, 'standalone')
    expect(prompt).toContain('# Conversation style')
    expect(prompt).toContain("Match the user's register")
    expect(prompt).not.toMatch(/^# Style$/m)
    expect(prompt).not.toContain('# Working on the project')
  })

  it('places the conversation style before the profile style it takes precedence over', () => {
    const prompt = promptFor('claude-subscription', 'claude-opus-5', 'standalone')
    const voice = prompt.indexOf('# Conversation style')
    expect(voice).toBeGreaterThan(prompt.indexOf('general assistant'))
    expect(voice).toBeLessThan(prompt.indexOf('# Style for requested work'))
    expect(voice).toBeLessThan(prompt.indexOf('# Working on requested tasks'))
  })

  it('keeps project conversations on the coding style', () => {
    const prompt = promptFor('claude-subscription', 'claude-sonnet-4', 'project')
    expect(prompt).not.toContain('# Conversation style')
    expect(prompt).toMatch(/^# Style$/m)
    expect(prompt).toContain('senior engineer pairing')
  })

  it('keeps the profile style untouched when no chat style is resolved', () => {
    const original = harnessFor('claude-subscription', 'claude-sonnet-4')
    const prompt = buildMaestrlyBasePrompt({
      harness: { ...original, prompts: { ...original.prompts, chatStyle: null } },
      cwd: '/private/chat',
      scope: 'standalone',
      mode: 'agent',
      appToolsEnabled: true,
      hasNotesTab: true,
    })
    expect(prompt).not.toContain('# Conversation style')
    expect(prompt).toMatch(/^# Style$/m)
  })

  it('asks Codex for the friendly personality only in standalone chats that take a personality', () => {
    const facts = {
      eligibleChatGptSession: true,
      ephemeral: false,
      requestUserInputAsyncAvailable: true,
    }
    const policy = (model: string, standalone: boolean) =>
      resolveCodexThreadPolicy(
        harnessFor('codex-subscription', model, { adapterCapabilities: codexAdapterCapabilities(facts) }),
        { ...facts, standalone },
        'high'
      ).personality
    expect(policy('gpt-5.6-sol', true)).toBe('friendly')
    expect(policy('gpt-5.6-sol', false)).toBe('pragmatic')
    expect(policy('gpt-6-astra', true)).toBeUndefined()
    expect(policy('gpt-6-astra', false)).toBeUndefined()
  })
})

it.each(['unknown', 'gpt-5.6-sol', 'gpt-6-astra'])('does not advertise desktop-only tools to bots using %s', (model) => {
  vi.stubEnv('MAESTRLY_BOT_MODE', '1')
  try {
    const prompt = buildHarnessPrompt({
      harness: harnessFor('openai-responses', model),
      cwd: '/private/bot',
      mode: 'agent',
      appToolsEnabled: true,
      hasNotesTab: true,
    }).instructions
    expect(prompt).not.toContain('debug_*')
    expect(prompt).not.toContain('notes_*')
    expect(prompt).not.toContain('Project notes are available')
    expect(prompt).not.toContain('follow along in the UI')
  } finally {
    vi.unstubAllEnvs()
  }
})
