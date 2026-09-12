import { describe, expect, it, vi } from 'vitest'
import { createDefaultMaestroConfig, type MaestroStrategyProfileCatalogItem } from '../../src/shared/maestro'
import {
  maestroStrategyProfileOptions,
  mergeMaestroOrchestratorModelMeta,
} from '../../src/renderer/lib/maestro-strategy-profiles'

const t = vi.fn((key: string, values?: Record<string, unknown>) => {
  if (key === 'maestro.strategyProfiles.global') return 'Global default'
  if (key === 'maestro.strategyProfiles.summary') {
    return `${values?.strategy} · ${values?.model} · ${values?.count} agentes`
  }
  if (key === 'maestro.strategyProfiles.noOrchestrator') return 'no orchestrator'
  if (key.startsWith('maestro.strategies.')) return key.split('.').at(-1)!
  return key
}) as never

describe('Maestro strategy profile search options', () => {
  it('uses execution metadata as the effective fallback for orchestrator effort and Fast', () => {
    expect(
      mergeMaestroOrchestratorModelMeta(
        { reasoning: false, fastModeCapability: false, contextWindow: 128_000 },
        {
          status: 'available',
          meta: { reasoning: true, reasoningEfforts: ['high', 'xhigh'], fastModeCapability: true },
        }
      )
    ).toMatchObject({
      reasoning: true,
      reasoningEfforts: ['high', 'xhigh'],
      fastModeCapability: true,
      contextWindow: 128_000,
    })
  })

  it('indexes name, strategy, orchestrator, and all agents without cluttering the label', () => {
    const config = createDefaultMaestroConfig()
    config.strategy = 'best-quality'
    config.pool[0]!.label = 'Architecture Explorer'
    config.pool[0]!.candidates = [{ providerId: 'anthropic', modelId: 'claude-opus-4-1', effort: 'high' }]
    const item: MaestroStrategyProfileCatalogItem = {
      id: 'custom-quality',
      name: 'Frontend premium',
      source: 'custom',
      config,
      orchestrator: { providerId: 'openai', modelId: 'gpt-5.6', reasoning: 'xhigh', fastMode: false },
    }

    const option = maestroStrategyProfileOptions([item], t)[0]!
    expect(option.label).toBe('Frontend premium')
    expect(option.hint).toContain('gpt-5.6')
    expect(option.searchText).toContain('best-quality')
    expect(option.searchText).toContain('Architecture Explorer')
    expect(option.searchText).toContain('claude-opus-4-1')
    expect(option.disabled).toBe(false)
  })

  it('preserves large catalogs and disables only options without an orchestrator', () => {
    const items = Array.from(
      { length: 30 },
      (_, index): MaestroStrategyProfileCatalogItem => ({
        id: `custom-${index}`,
        name: `Strategy ${index}`,
        source: 'custom',
        config: createDefaultMaestroConfig(),
        orchestrator:
          index === 29 ? null : { providerId: 'openai', modelId: `model-${index}`, reasoning: 'off', fastMode: false },
      })
    )

    const options = maestroStrategyProfileOptions(items, t)
    expect(options).toHaveLength(30)
    expect(options[0]?.disabled).toBe(false)
    expect(options[29]?.disabled).toBe(true)
  })
})
