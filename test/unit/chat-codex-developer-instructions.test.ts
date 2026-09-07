import { describe, expect, it } from 'vitest'
import type { ChatAgent } from '../../src/main/chat/agents'
import {
  maestrlyDeveloperInstructions,
  SUBAGENT_CATALOG_DESCRIPTION_MAX_CHARS,
} from '../../src/main/chat/codex-subscription/runner'
import { SUBAGENT_DISPATCH_SELECTION_RULES } from '../../src/main/chat/subagent-dispatch-catalog'

const agents: ChatAgent[] = [
  {
    name: 'explore',
    description: 'Read-only search agent for broad sweeps.',
    prompt: 'p',
    source: 'built-in',
  },
  {
    name: 'general-purpose',
    description: 'Worker agent with FULL tools.',
    tools: ['bash', 'write', 'edit', 'read'],
    prompt: 'p',
    source: 'built-in',
  },
]

/**
 * Native Codex favors direct execution; explicit developer guidance is needed so
 * the model almost never used the dynamic task tool (observed in production with the subscription provider).
 */
describe('developer instructions subagent catalog', () => {
  it('includes deliberate memory policy in every mode', () => {
    for (const mode of ['agent', 'plan', 'ask'] as const) {
      const out = maestrlyDeveloperInstructions(mode, [], [])
      expect(out).toContain('# Durable project memory')
      expect(out).toContain('Do not search for trivial or self-contained requests')
      expect(out).toContain('repository AGENTS.md/CLAUDE.md files prevail')
    }
  })

  it('includes delegation guidance with available agents', () => {
    const out = maestrlyDeveloperInstructions('agent', [], agents)
    expect(out).toContain('`task` tool')
    expect(out).toContain(SUBAGENT_DISPATCH_SELECTION_RULES)
    expect(out).toContain(
      '- explore [specialist, read-only, inherited profile]: Read-only search agent for broad sweeps.'
    )
    expect(out).toContain(
      '- general-purpose [generic fallback, worker, inherited profile]: Worker agent with FULL tools.'
    )
    expect(out).toContain('run in parallel')
    expect(out).not.toContain('providerId')
    expect(out).not.toContain('modelId')
  })

  it('keeps Design identity exactly once with the Agent subagent catalog', () => {
    const out = maestrlyDeveloperInstructions('design', [], agents)

    expect(out.match(/# Maestrly Design mode — design-v1/g)).toHaveLength(1)
    expect(out).toContain('This turn is Design mode with Agent-equivalent capabilities')
    expect(out).toContain(
      '- general-purpose [generic fallback, worker, inherited profile]: Worker agent with FULL tools.'
    )
    expect(out).not.toContain('This turn is Plan mode')
    expect(out).not.toContain('This turn is Ask mode')
    expect(maestrlyDeveloperInstructions('agent', [], agents)).not.toContain('# Maestrly Design mode')
  })

  it('omits agent blocks when no agents exist', () => {
    const out = maestrlyDeveloperInstructions('ask', [], [])
    expect(out).not.toContain('`task` tool')
    expect(out).not.toContain('Available agents:')
  })

  it('normalizes and truncates long catalog descriptions', () => {
    const noisy: ChatAgent[] = [
      { name: 'big', description: `multi\n  line   ${'x'.repeat(600)}`, prompt: 'p', source: 's' },
    ]
    const out = maestrlyDeveloperInstructions('agent', [], noisy)
    expect(out).toContain('- big [specialist, read-only, inherited profile]: multi line')
    expect(out).not.toContain('\n  line')
    const retained = SUBAGENT_CATALOG_DESCRIPTION_MAX_CHARS - 'multi line '.length
    expect(out).toContain('x'.repeat(retained))
    expect(out).not.toContain('x'.repeat(retained + 1))
  })
})
