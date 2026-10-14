import { afterEach, describe, expect, it, vi } from 'vitest'
import { maestrlyDeveloperInstructions } from '../../src/main/chat/codex-subscription/runner'
import { harnessFor } from '../../src/main/chat/harness/execution'
import { GENUI_PROMPT } from '../../src/main/chat/harness/genui-prompt'
import { buildMaestrlyBasePrompt, hostGenUiSection } from '../../src/main/chat/harness/host-contracts'
import { composeOpenAICodexPortPrompt } from '../../src/main/chat/harness/strategies/prompt-layout'
import { isGenUiFence, isPendingFence } from '../../src/renderer/genui/GenUiBlock'

describe('generated interfaces in the system prompt', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('adds the catalog only with MAESTRLY_GENUI=1', () => {
    expect(hostGenUiSection({})).toBe('')
    expect(hostGenUiSection({ MAESTRLY_GENUI: '0' })).toBe('')
    expect(hostGenUiSection({ MAESTRLY_GENUI: '1' })).toBe(`\n\n${GENUI_PROMPT}`)
  })

  it('reaches every runtime prompt when on, and none when off', () => {
    const prompts = () => [
      buildMaestrlyBasePrompt({
        harness: harnessFor('anthropic', 'generic-model'),
        cwd: '/repo',
        appToolsEnabled: true,
        mode: 'agent',
        hasNotesTab: true,
      }),
      maestrlyDeveloperInstructions('agent', [], []),
      composeOpenAICodexPortPrompt({
        base: 'Base.',
        cwd: '/repo',
        mode: 'agent',
        appToolsEnabled: true,
        hasNotesTab: true,
      }).instructions,
    ]
    for (const prompt of prompts()) expect(prompt).not.toContain('openui-lang')
    vi.stubEnv('MAESTRLY_GENUI', '1')
    for (const prompt of prompts()) expect(prompt).toContain(GENUI_PROMPT)
  })
})

describe('generated interface fences', () => {
  it('recognizes the interface fence and the ones that may still become it', () => {
    expect(isGenUiFence('language-openui-lang')).toBe(true)
    expect(isGenUiFence('hljs language-ts')).toBe(false)
    expect(isPendingFence('language-ope', 'root = ')).toBe(true)
    expect(isPendingFence('language-openui-', '')).toBe(true)
    expect(isPendingFence('', '')).toBe(true)
    expect(isPendingFence('language-ts', 'const a = 1')).toBe(false)
    expect(isPendingFence('language-openui-lang', 'root')).toBe(false)
  })
})
