import { describe, expect, it } from 'vitest'
import { cloneMaestroConfig, createDefaultMaestroConfig } from '../../src/shared/maestro'
import { diffMaestroConfigs, hashMaestroConfig } from '../../src/shared/maestro-configurator'

describe('Maestro configurator shared contract', () => {
  it('produces a deterministic revision independent of object key insertion order', () => {
    const config = createDefaultMaestroConfig()
    const reordered = JSON.parse(JSON.stringify(config))
    reordered.pool[0] = Object.fromEntries(Object.entries(reordered.pool[0]).reverse())
    expect(hashMaestroConfig(config)).toBe(hashMaestroConfig(reordered))
    expect(hashMaestroConfig(config)).toMatch(/^maestro-v1-[0-9a-f]{8}$/)
  })

  it('reports semantic strategy, resource and candidate changes', () => {
    const before = createDefaultMaestroConfig()
    const after = cloneMaestroConfig(before)
    after.strategy = 'best-quality'
    after.pool[0].label = 'Deep Explorer'
    after.pool[0].candidates = [{ providerId: 'claude', modelId: 'fable', effort: 'high' }]
    after.pool.push({
      ...after.pool[0],
      id: 'architect',
      label: 'Architect',
      candidates: [],
    })

    const changes = diffMaestroConfigs(before, after)
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'strategy', after: 'best-quality' }),
        expect.objectContaining({ kind: 'resource-field', resourceId: 'explorer', field: 'label' }),
        expect.objectContaining({ kind: 'candidate-added', resourceId: 'explorer' }),
        expect.objectContaining({ kind: 'resource-added', resourceId: 'architect' }),
      ])
    )
  })

  it('describes a bulk Grok to Terra replacement and changes the stale hash', () => {
    const before = createDefaultMaestroConfig()
    for (const resource of before.pool) {
      resource.candidates = [{ providerId: 'grok', modelId: 'grok-4', effort: 'high', fastMode: true }]
    }
    const after = cloneMaestroConfig(before)
    for (const resource of after.pool) {
      resource.candidates = [{ providerId: 'openai', modelId: 'terra', effort: 'high' }]
    }
    const replacements = diffMaestroConfigs(before, after).filter((change) => change.kind === 'candidate-replaced')
    expect(replacements).toHaveLength(before.pool.length)
    expect(
      replacements.every((change) => change.kind === 'candidate-replaced' && change.after.modelId === 'terra')
    ).toBe(true)
    expect(hashMaestroConfig(after)).not.toBe(hashMaestroConfig(before))
  })
})
