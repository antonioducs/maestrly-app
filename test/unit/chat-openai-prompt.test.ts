import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  OPENAI_CODEX_BASE_INSTRUCTIONS,
  OPENAI_CODEX_PROMPT_SOURCE,
  compileOpenAIPrompt,
  openAINativeToolsPromptOverlay,
  type CompileOpenAIPromptInput,
} from '../../src/main/chat/openai/prompt'

const input = (overrides: Partial<CompileOpenAIPromptInput> = {}): CompileOpenAIPromptInput => ({
  cwd: '/repo',
  mode: 'agent',
  appToolsEnabled: true,
  hasNotesTab: true,
  projectContext: 'Obey the root AGENTS.md.',
  skillsContext: '- release: package and verify releases',
  agentsContext: '- explore: read-only investigation',
  envContext: 'OS: macOS. Date: 2026-07-14.',
  ultraContext: 'Use maximum effort and verify the result.',
  nativeTools: { localShell: true, applyPatch: true },
  ...overrides,
})

describe('OpenAI Codex prompt port', () => {
  it('pins the adapted prompt bytes and records the exact upstream provenance', () => {
    const adaptedSha256 = createHash('sha256').update(OPENAI_CODEX_BASE_INSTRUCTIONS).digest('hex')

    expect(adaptedSha256).toBe('943523f664292da3295a28f49db749a11a9d01702280d0b77a3cd6527f77900a')
    expect(OPENAI_CODEX_PROMPT_SOURCE).toMatchObject({
      commit: '5bed6447998c754d154dbd796517310b8f04d4ce',
      model: 'gpt-5.6-sol',
      upstreamSha256: 'e9778714d505f3dd04d44db4394024c5fab5bf6554fc9faa3cdf9cf776b63bb9',
      adaptedSha256,
      license: 'Apache-2.0',
    })
    expect(OPENAI_CODEX_BASE_INSTRUCTIONS).toContain('until their goal is genuinely handled')
  })

  it('is deterministic and keeps volatile environment context last', () => {
    const first = compileOpenAIPrompt(input())
    const second = compileOpenAIPrompt(input())

    expect(first).toEqual(second)
    expect(first.instructions.startsWith(OPENAI_CODEX_BASE_INSTRUCTIONS)).toBe(true)
    expect(first.instructions).toBe(`${first.stablePrefix}\n\n${first.volatileSuffix}`)
    expect(first.volatileSuffix).toBe('# Environment\n\nOS: macOS. Date: 2026-07-14.')
    expect(first.instructions.endsWith(first.volatileSuffix)).toBe(true)
  })

  it('does not churn the stable prefix when only the environment changes', () => {
    const first = compileOpenAIPrompt(input())
    const nextTurn = compileOpenAIPrompt(input({ envContext: 'OS: macOS. Date: 2026-07-15.' }))

    expect(nextTurn.stablePrefix).toBe(first.stablePrefix)
    expect(nextTurn.volatileSuffix).not.toBe(first.volatileSuffix)
  })

  it('changes prompt identity for Design and restores the original Agent prefix when leaving it', () => {
    const agentBefore = compileOpenAIPrompt(input({ mode: 'agent' }))
    const design = compileOpenAIPrompt(input({ mode: 'design' }))
    const agentAfter = compileOpenAIPrompt(input({ mode: 'agent' }))

    expect(design.stablePrefix).not.toBe(agentBefore.stablePrefix)
    expect(design.stablePrefix.match(/# Maestrly Design mode — design-v1/g)).toHaveLength(1)
    expect(agentAfter.stablePrefix).toBe(agentBefore.stablePrefix)
    expect(agentAfter.stablePrefix).not.toContain('# Maestrly Design mode')
  })

  it('orders durable context before the volatile suffix', () => {
    const prompt = compileOpenAIPrompt(input()).instructions
    const project = prompt.indexOf('# Project instructions')
    const skills = prompt.indexOf('# Project skills')
    const agents = prompt.indexOf('# Subagents')
    const ultra = prompt.indexOf('# Ultra mode')
    const env = prompt.indexOf('# Environment')

    expect(project).toBeGreaterThan(0)
    expect(project).toBeLessThan(skills)
    expect(skills).toBeLessThan(agents)
    expect(agents).toBeLessThan(ultra)
    expect(ultra).toBeLessThan(env)
  })

  it('maps each mode only to capabilities Maestrly exposes', () => {
    const agent = compileOpenAIPrompt(input({ mode: 'agent' })).instructions
    const design = compileOpenAIPrompt(input({ mode: 'design' })).instructions
    const plan = compileOpenAIPrompt(input({ mode: 'plan' })).instructions
    const ask = compileOpenAIPrompt(input({ mode: 'ask' })).instructions

    expect(agent).toContain('AGENT MODE')
    expect(agent).toContain('todo_write')
    expect(design.match(/# Maestrly Design mode — design-v1/g)).toHaveLength(1)
    expect(design).toContain('DESIGN MODE uses Agent-equivalent capabilities')
    expect(design).toContain('todo_write')
    expect(design).toContain('notes_*')
    expect(design).toContain('`local_shell`')
    expect(design).toContain('`apply_patch`')
    expect(design).not.toContain('PLAN MODE')
    expect(design).not.toContain('ASK MODE')
    expect(plan).toContain('PLAN MODE')
    expect(plan).toContain('external MCP tools explicitly declared read-only')
    expect(plan).toContain('notes list/read/create/write/append')
    expect(plan).toContain('review_plan')
    expect(plan).not.toContain('todo_write')
    expect(ask).toContain('ASK MODE')
    expect(ask).toContain('external MCP tools explicitly declared read-only')
    expect(ask).toContain('terminal read')
    expect(ask).toContain('shell execution')
    expect(ask).toContain('page interaction through click/type/drag/key/mouse/evaluate')
    expect(ask).not.toContain('interactive browser actions')
    expect(ask).not.toContain('review_plan')
    for (const prompt of [agent, plan, ask]) expect(prompt).not.toContain('# Maestrly Design mode')
  })

  it('describes drawer tools by mode and respects the notes surface', () => {
    const withNotes = compileOpenAIPrompt(input()).instructions
    const withoutNotes = compileOpenAIPrompt(input({ hasNotesTab: false })).instructions
    const disabled = compileOpenAIPrompt(input({ appToolsEnabled: false })).instructions
    const ask = compileOpenAIPrompt(input({ mode: 'ask' })).instructions

    expect(withNotes).toContain('notes_*')
    expect(withoutNotes).not.toContain('notes_*')
    expect(disabled).toContain('Drawer tools are disabled')
    expect(ask).toContain('# Maestrly app tools')
    expect(ask).toContain('restricted catalog')
    for (const prompt of [withNotes, withoutNotes, disabled, ask]) {
      expect(prompt).toContain('# Durable project memory')
      expect(prompt).toContain('search memory before acting or asking the user to repeat context')
    }
  })

  it('uses the Maestrly skill loader and describes only native tools exposed by the harness', () => {
    const prompt = compileOpenAIPrompt(input()).instructions

    expect(prompt).toContain('call use_skill with its name')
    expect(prompt).not.toContain('skills.list')
    expect(prompt).toContain('`apply_patch`')
    expect(prompt).toContain('`local_shell`')
    expect(prompt).not.toContain('exec_command')
    expect(prompt).not.toContain('the `final` channel')

    const legacyTools = compileOpenAIPrompt(
      input({ nativeTools: { localShell: false, applyPatch: false } })
    ).instructions
    expect(legacyTools).not.toContain('# Active OpenAI workspace tools')
  })

  it('provides the same native-tool correction for the generic Responses prompt', () => {
    const both = openAINativeToolsPromptOverlay({ localShell: true, applyPatch: true }, 'agent')
    expect(both).toContain('`local_shell`')
    expect(both).toContain('legacy `bash` tool is not exposed')
    expect(both).toContain('`apply_patch`')
    expect(both).toContain('legacy `edit` and `write` tools are not exposed')
    expect(both).toContain('supersedes any earlier guidance')

    const patchOnly = openAINativeToolsPromptOverlay({ localShell: false, applyPatch: true }, 'agent')
    expect(patchOnly).not.toContain('`local_shell`')
    expect(patchOnly).not.toContain('legacy `bash`')
    expect(openAINativeToolsPromptOverlay({ localShell: true, applyPatch: true }, 'ask')).toBe('')
    expect(openAINativeToolsPromptOverlay({ localShell: true, applyPatch: true }, 'design')).toBe(both)
  })

  it('omits empty optional sections and rejects an empty workspace', () => {
    const prompt = compileOpenAIPrompt(
      input({ projectContext: ' ', skillsContext: null, agentsContext: '', envContext: null, ultraContext: undefined })
    )

    expect(prompt.instructions).toBe(prompt.stablePrefix)
    expect(prompt.volatileSuffix).toBe('')
    expect(prompt.instructions).not.toContain('undefined')
    expect(prompt.instructions).not.toContain('# Project instructions')
    expect(() => compileOpenAIPrompt(input({ cwd: ' ' }))).toThrow('cwd is required')
  })
})
