import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { createDefaultMaestroConfig, type MaestroOrchestratorProfileV1 } from '../../src/shared/maestro'
import {
  createMaestroStrategyProfile,
  deleteMaestroStrategyProfile,
  listMaestroStrategyProfiles,
  resolveMaestroStrategyProfile,
  setLastUsedMaestroStrategyProfile,
  updateMaestroStrategyProfile,
} from '../../src/main/chat/maestro-strategy-profiles'

const orchestrator: MaestroOrchestratorProfileV1 = {
  providerId: 'builtin_codex_subscription',
  modelId: 'gpt-5.6-codex',
  reasoning: 'high',
  fastMode: true,
}

describe('Maestro strategy profile catalog', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('exposes global and four virtual presets without duplicating them in the store', () => {
    const catalog = listMaestroStrategyProfiles(orchestrator)

    expect(catalog.lastUsedId).toBe('global')
    expect(catalog.items.map((item) => item.id)).toEqual([
      'global',
      'builtin:balanced',
      'builtin:best-quality',
      'builtin:fast',
      'builtin:economy',
    ])
    expect(catalog.items.find((item) => item.id === 'builtin:fast')).toMatchObject({
      source: 'builtin',
      config: { strategy: 'fast' },
      orchestrator,
    })
  })

  it('creates, updates, and resolves a complete custom profile with a stable ID', () => {
    const config = createDefaultMaestroConfig()
    config.strategy = 'best-quality'
    config.pool[0]!.label = 'Deep Explorer'

    const created = createMaestroStrategyProfile({ name: 'Frontend premium', config, orchestrator }, orchestrator)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.profile.id
    expect(created.profile).toMatchObject({
      id,
      name: 'Frontend premium',
      config: {
        strategy: 'best-quality',
        pool: expect.arrayContaining([expect.objectContaining({ label: 'Deep Explorer' })]),
      },
      orchestrator,
    })

    const updatedConfig = createDefaultMaestroConfig()
    updatedConfig.strategy = 'economy'
    const updated = updateMaestroStrategyProfile(
      id,
      { name: 'Budget frontend', config: updatedConfig, orchestrator: { ...orchestrator, fastMode: false } },
      orchestrator
    )
    expect(updated.ok).toBe(true)
    expect(resolveMaestroStrategyProfile(id, orchestrator)).toMatchObject({
      id,
      name: 'Budget frontend',
      source: 'custom',
      config: { strategy: 'economy' },
      orchestrator: { fastMode: false },
    })
  })

  it('rejects duplicate names and entries without a valid orchestrator', () => {
    const config = createDefaultMaestroConfig()
    expect(createMaestroStrategyProfile({ name: 'Quality', config, orchestrator }, orchestrator).ok).toBe(true)
    expect(createMaestroStrategyProfile({ name: 'quality', config, orchestrator }, orchestrator)).toEqual({
      ok: false,
      error: 'maestro-strategy-profile-name-duplicate',
    })
    expect(
      createMaestroStrategyProfile(
        { name: 'Broken', config, orchestrator: { ...orchestrator, modelId: '' } },
        orchestrator
      )
    ).toEqual({ ok: false, error: 'maestro-strategy-profile-orchestrator-invalid' })
  })

  it('deletion resets the last-used profile to global without affecting copied snapshots', () => {
    const created = createMaestroStrategyProfile(
      { name: 'Disposable', config: createDefaultMaestroConfig(), orchestrator },
      orchestrator
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const snapshot = resolveMaestroStrategyProfile(created.profile.id, orchestrator)!
    setLastUsedMaestroStrategyProfile(created.profile.id)
    expect(listMaestroStrategyProfiles(orchestrator).lastUsedId).toBe(created.profile.id)

    expect(deleteMaestroStrategyProfile(created.profile.id)).toBe(true)
    expect(listMaestroStrategyProfiles(orchestrator).lastUsedId).toBe('global')
    expect(snapshot.config.pool.length).toBeGreaterThan(0)
  })
})
