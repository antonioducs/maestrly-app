import { describe, expect, it } from 'vitest'
import { capabilityBehaviorFor } from '../../src/shared/chat-mode'
import { createDefaultMaestroConfig, type MaestroTurnSnapshotV1 } from '../../src/shared/maestro'
import { appToolAllowed } from '../../src/main/chat/tool-policy'
import { builtinToolNamesForMode } from '../../src/main/chat/tools'
import { harnessFor } from '../../src/main/chat/harness/execution'
import { harnessUltraGuidance, hostCapabilitySection } from '../../src/main/chat/harness/host-contracts'
import {
  MAESTRO_SWARM_CONTRACT,
  maestroStrategyGuidance,
  renderMaestroPoolCatalog,
  renderMaestroSwarmSection,
} from '../../src/main/chat/maestro-prompt'

function makeTurn(overrides: Partial<MaestroTurnSnapshotV1> = {}): MaestroTurnSnapshotV1 {
  const base = createDefaultMaestroConfig()
  return {
    version: base.version,
    strategy: base.strategy,
    pool: base.pool,
    source: 'safe-default',
    diagnostics: [],
    frozenAt: 1,
    ...overrides,
  }
}

describe('Maestro Agent capabilities and swarm prompt', () => {
  it('treats maestro as agent for capabilities, app tools, built-in tools, host capability section, and ultra guidance', () => {
    expect(capabilityBehaviorFor('maestro')).toBe('agent')
    expect(appToolAllowed('maestro', 'browser_navigate')).toBe(true)

    const maestroTools = builtinToolNamesForMode('maestro')
    const agentTools = builtinToolNamesForMode('agent')
    expect([...maestroTools].sort()).toEqual([...agentTools].sort())
    expect(maestroTools.has('edit')).toBe(true)
    expect(maestroTools.has('write')).toBe(true)
    expect(maestroTools.has('bash')).toBe(true)
    expect(maestroTools.has('todo_write')).toBe(true)

    expect(hostCapabilitySection('maestro')).toBe(hostCapabilitySection('agent'))

    const opus = harnessFor('claude-subscription', 'claude-opus-5')
    expect(harnessUltraGuidance(opus, 'maestro')).toBe(harnessUltraGuidance(opus, 'agent'))
  })

  it('renders the swarm contract, enabled pool catalog, and frozen strategy guidance without legacy delegate wording', () => {
    const turn = makeTurn({
      strategy: 'balanced',
      pool: [
        {
          id: 'coder',
          label: 'Coder',
          enabled: true,
          mode: 'agent',
          description: 'Implements features cleanly.',
          specialties: ['backend', 'typescript'],
          candidates: [
            { providerId: 'openai', modelId: 'gpt-5', effort: 'high', fastMode: true },
            { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', effort: 'medium', fastMode: false },
          ],
          instructions: 'Line 1\nLine 2\n' + 'x'.repeat(350),
        },
        {
          id: 'helper',
          label: 'Helper',
          enabled: true,
          mode: 'ask',
          description: 'Answers architecture questions.',
          specialties: [],
          candidates: [],
        },
        {
          id: 'disabled-agent',
          label: 'Disabled',
          enabled: false,
          mode: 'design',
          description: 'Should not appear.',
          specialties: ['ui'],
          candidates: [],
        },
      ],
    })

    const section = renderMaestroSwarmSection(turn)
    expect(section).toContain('# Maestro swarm contract')
    expect(section).toContain(MAESTRO_SWARM_CONTRACT)
    expect(section).toContain('# Maestro Agent Pool')
    expect(section).toContain('- coder (Coder)')
    expect(section).toContain('  mode: agent')
    expect(section).toContain('  description: Implements features cleanly.')
    expect(section).toContain('  specialties: backend, typescript')
    expect(section).toContain(
      '  models: openai/gpt-5 effort=high Fast=on | anthropic/claude-sonnet-4-5 effort=medium Fast=off'
    )
    expect(section).toContain(`  instructions: ${'Line 1 Line 2 ' + 'x'.repeat(300 - 'Line 1 Line 2 '.length)}…`)
    expect(section).toContain('- helper (Helper)')
    expect(section).toContain('  mode: ask')
    expect(section).toContain('  specialties: general')
    expect(section).toContain('  models: inherits the orchestrator')
    expect(section).toContain('  instructions: (none)')
    expect(section).not.toContain('disabled-agent')
    expect(section).toContain('# Frozen Maestro Strategy\nStrategy: balanced\n' + maestroStrategyGuidance('balanced'))
    expect(section.toLowerCase()).not.toContain('delegate')
    expect(MAESTRO_SWARM_CONTRACT).toContain('never dispatch work that is already done')
    expect(MAESTRO_SWARM_CONTRACT).toContain('Pass prototype paths to the implementers as their reference')
  })

  it('returns the exact strategy guidance for every MaestroStrategy', () => {
    expect(maestroStrategyGuidance('best-quality')).toBe(
      'Prefer the strongest suitable resources. Review every delivered task in depth before merging; send important findings back to the author and review again.'
    )
    expect(maestroStrategyGuidance('fast')).toBe(
      'Favor fast suitable resources and dispatch every independent task at once. Keep the review of each delivery; never skip the quality gate.'
    )
    expect(maestroStrategyGuidance('economy')).toBe(
      'Prefer economical resources. Escalate to a stronger resource only after a failure, a hard uncertainty or an important finding, and say so.'
    )
    expect(maestroStrategyGuidance('balanced')).toBe(
      'Balance quality, speed and cost: lighter resources for closed-contract tasks, stronger ones for uncertain or cross-cutting work; review depth follows risk.'
    )
  })

  it('renders renderMaestroPoolCatalog for enabled resources in the default pool', () => {
    const turn = makeTurn()
    const catalog = renderMaestroPoolCatalog(turn)
    expect(catalog).toContain('# Maestro Agent Pool')
    expect(catalog).toContain('start_conversations')
    for (const resource of turn.pool.filter((r) => r.enabled)) {
      expect(catalog).toContain(`- ${resource.id} (${resource.label})`)
      expect(catalog).toContain(`  mode: ${resource.mode}`)
    }
  })
})
