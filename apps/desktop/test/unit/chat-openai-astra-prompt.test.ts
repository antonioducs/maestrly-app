import { describe, expect, it } from 'vitest'
import { buildHarnessPrompt, type BuildHarnessPromptInput } from '../../src/main/chat/harness/prompt-builder'
import { resolveChatHarness } from '../../src/main/chat/harness/execution'

/** The concise Astra layout now comes from the gpt-6-astra profile folder. */
const compileOpenAIAstraPrompt = (value: Omit<BuildHarnessPromptInput, 'harness'>) =>
  buildHarnessPrompt({ ...value, harness: astraHarness })
const astraHarness = resolveChatHarness('openai-responses', 'gpt-6-astra', 'https://api.openai.com/v1').harness

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
    expect(astraHarness.identity.promptIdentity).toBe('maestrly-openai-gpt-6-astra@v1')
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

  it('layers the versioned Design harness exactly once over Astra', () => {
    const prompt = compileOpenAIAstraPrompt({
      cwd: '/workspace',
      mode: 'design',
      appToolsEnabled: true,
      hasNotesTab: true,
      nativeTools: { localShell: true, applyPatch: true },
    })

    expect(prompt.instructions.match(/# Maestrly Design mode — design-v1/g)).toHaveLength(1)
    expect(prompt.instructions).toContain('Design mode: build a navigable visual prototype')
    expect(prompt.instructions).toContain('executable, interactive visual prototype')
    expect(prompt.instructions).not.toContain('Plan mode: investigate')
  })
})
