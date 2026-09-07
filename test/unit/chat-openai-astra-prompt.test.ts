import { describe, expect, it } from 'vitest'
import { compileOpenAIAstraPrompt } from '../../src/main/chat/openai/astra-prompt'

describe('OpenAI Astra prompt profile', () => {
  it.each(['agent', 'plan', 'ask'] as const)('compiles a concise %s prompt with a stable prefix', (mode) => {
    const first = compileOpenAIAstraPrompt({
      cwd: '/workspace',
      mode,
      appToolsEnabled: true,
      hasNotesTab: true,
      projectContext: 'PROJECT-RULES',
      skillsContext: 'SKILLS',
      agentsContext: 'AGENTS',
      envContext: 'ENV-A',
      nativeTools: { localShell: true, applyPatch: true },
    })
    const second = compileOpenAIAstraPrompt({
      cwd: '/workspace',
      mode,
      appToolsEnabled: true,
      hasNotesTab: true,
      projectContext: 'PROJECT-RULES',
      skillsContext: 'SKILLS',
      agentsContext: 'AGENTS',
      envContext: 'ENV-B',
      nativeTools: { localShell: true, applyPatch: true },
    })
    expect(first.profile.id).toBe('maestrly-openai-gpt-6-astra@v1')
    expect(first.stablePrefix).toBe(second.stablePrefix)
    expect(first.volatileSuffix).not.toBe(second.volatileSuffix)
    expect(first.instructions).toContain('Maestrly\'s task tool is the only delegation surface')
    expect(first.instructions).toContain('Verify in proportion to risk')
    expect(first.instructions).toContain('PROJECT-RULES')
    expect(first.instructions).toMatchSnapshot()
  })

  it('does not append a synthetic ultra policy unless the host explicitly supplies one', () => {
    const prompt = compileOpenAIAstraPrompt({
      cwd: '/workspace',
      mode: 'agent',
      appToolsEnabled: false,
      hasNotesTab: false,
      ultraContext: null,
    })
    expect(prompt.instructions).not.toContain('ULTRA MODE')
  })
})
