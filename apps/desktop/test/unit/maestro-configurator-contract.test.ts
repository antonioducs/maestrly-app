import { describe, expect, it } from 'vitest'
import { cloneMaestroConfig, createDefaultMaestroConfig } from '../../src/shared/maestro'
import { sanitizeMaestroDraftShape } from '../../src/shared/maestro-config-validation'
import {
  applyMaestroProposalUnits,
  diffMaestroConfigs,
  hashMaestroConfig,
  maestroProposalOutcomes,
  maestroProposalUnitKeys,
  maestroProposalUnits,
  prepareMaestroConfiguratorDraft,
  type MaestroConfiguratorMessage,
} from '../../src/shared/maestro-configurator'

describe('Maestro configurator shared contract', () => {
  const proposalFor = (base: ReturnType<typeof createDefaultMaestroConfig>) => {
    const proposed = cloneMaestroConfig(base)
    proposed.strategy = 'best-quality'
    proposed.pool[1].candidates = [{ providerId: 'claude', modelId: 'opus', effort: 'max' }]
    proposed.pool[3].description = 'Runs every check.'
    proposed.pool = proposed.pool.filter((resource) => resource.id !== 'reviewer')
    proposed.pool.splice(2, 0, {
      id: 'designer',
      label: 'Designer',
      enabled: true,
      description: 'Visual design.',
      capability: 'worker',
      specialties: ['design'],
      candidates: [],
    })
    return proposed
  }

  it('splits a proposal into the strategy and one unit per resource it touches', () => {
    const base = createDefaultMaestroConfig()
    const proposed = proposalFor(base)
    const units = maestroProposalUnits(base, proposed)
    expect(units.map((unit) => [unit.key, unit.kind])).toEqual([
      ['strategy', 'strategy'],
      ['resource:frontend', 'resource-changed'],
      ['resource:tester', 'resource-changed'],
      ['resource:reviewer', 'resource-removed'],
      ['resource:designer', 'resource-added'],
    ])
    // The keys recorded with a proposal name the same units, so the thread can count them without the draft.
    expect(new Set(maestroProposalUnitKeys(diffMaestroConfigs(base, proposed)))).toEqual(
      new Set(units.map((unit) => unit.key))
    )
  })

  it('applies only the selected units and yields the proposal itself when every unit is taken', () => {
    const draft = createDefaultMaestroConfig()
    // An unfinished row the user is still filling in on a resource the proposal does not touch.
    draft.pool[0].candidates = [{ providerId: 'claude', modelId: '', effort: '' }]
    const prepared = prepareMaestroConfiguratorDraft(draft)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const base = prepared.value.config
    const proposed = proposalFor(base)
    const keys = maestroProposalUnits(base, proposed).map((unit) => unit.key)

    expect(applyMaestroProposalUnits({ draft, base, proposed, selected: new Set(keys) })).toEqual(proposed)

    const partial = applyMaestroProposalUnits({
      draft,
      base,
      proposed,
      selected: new Set(['resource:frontend', 'resource:designer']),
    })
    expect(partial.strategy).toBe('balanced')
    expect(partial.pool.map((resource) => resource.id)).toEqual([
      'explorer',
      'frontend',
      'designer',
      'backend',
      'tester',
      'reviewer',
      'generalist',
    ])
    expect(partial.pool[1].candidates).toEqual([{ providerId: 'claude', modelId: 'opus', effort: 'max' }])
    expect(partial.pool[4].description).toBe(draft.pool[3].description)
    // A resource left out keeps the editor's own version, unfinished rows included.
    expect(partial.pool[0].candidates).toEqual(draft.pool[0].candidates)

    const none = applyMaestroProposalUnits({ draft, base, proposed, selected: new Set() })
    expect(none).toEqual(draft)
    expect(none.pool[0]).not.toBe(draft.pool[0])
  })

  it('reads what became of each proposal from the events recorded after it', () => {
    const proposal = (id: string): MaestroConfiguratorMessage => ({
      id: `m-${id}`,
      role: 'assistant',
      text: '',
      createdAt: 0,
      proposal: {
        id,
        baseHash: 'h',
        summary: id,
        config: createDefaultMaestroConfig(),
        changes: [],
        diagnostics: [],
        createdAt: 0,
      },
    })
    const event = (value: MaestroConfiguratorMessage['event']): MaestroConfiguratorMessage => ({
      id: `e-${JSON.stringify(value)}`,
      role: 'event',
      text: '',
      createdAt: 0,
      event: value,
    })
    const outcomes = maestroProposalOutcomes([
      proposal('a'),
      proposal('b'),
      event({ kind: 'proposal-applied', proposalId: 'b', skipped: ['strategy'] }),
      event({ kind: 'saved', target: 'global', profileName: 'Global default' }),
      proposal('c'),
      event({ kind: 'proposal-dismissed', proposalId: 'c' }),
      proposal('d'),
      event({ kind: 'proposal-applied', proposalId: 'd' }),
      event({ kind: 'draft-discarded', profileName: 'Global default' }),
      proposal('e'),
      event({ kind: 'proposal-applied', proposalId: 'unknown' }),
    ])
    expect(Object.fromEntries(outcomes)).toEqual({
      a: { status: 'superseded' },
      b: { status: 'applied', skipped: ['strategy'], state: 'saved' },
      c: { status: 'dismissed' },
      d: { status: 'applied', skipped: [], state: 'discarded' },
      e: { status: 'pending' },
    })
  })

  it('revisions the normalized draft, so casing and stray spaces in the editor never look stale', () => {
    const saved = createDefaultMaestroConfig()
    const typed = cloneMaestroConfig(saved)
    typed.pool[0] = { ...typed.pool[0], id: ' Explorer ', label: 'Explorer  ', specialties: ['Exploration', 'general'] }
    typed.pool[1] = { ...typed.pool[1], instructions: ' Prefer accessible markup. ' }
    const prepared = prepareMaestroConfiguratorDraft(typed)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.value.config.pool[0]).toMatchObject({ id: 'explorer', label: 'Explorer' })
    expect(prepared.value.config.pool[1].instructions).toBe('Prefer accessible markup.')
    // The raw hash would disagree with the main process; the prepared one is what both sides compare.
    expect(hashMaestroConfig(typed)).not.toBe(prepared.value.baseHash)
    expect(prepared.value.baseHash).toBe(hashMaestroConfig(prepared.value.config))
  })

  it('leaves candidate rows that are still being filled in out of the draft instead of rejecting it', () => {
    const draft = createDefaultMaestroConfig()
    draft.pool[0].candidates = [
      { providerId: 'claude', modelId: 'opus', effort: 'high' },
      { providerId: '', modelId: '', effort: '' },
      { providerId: 'codex', modelId: '', effort: '' },
    ]
    const prepared = prepareMaestroConfiguratorDraft(draft)
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        skippedCandidates: [
          { resourceId: 'explorer', label: 'Explorer', index: 1 },
          { resourceId: 'explorer', label: 'Explorer', index: 2 },
        ],
      },
    })
    if (prepared.ok) expect(prepared.value.config.pool[0].candidates).toEqual([draft.pool[0].candidates[0]])
    // Structural problems still fail: only unfinished rows are tolerated.
    const broken = cloneMaestroConfig(draft)
    broken.pool[1].label = ''
    expect(prepareMaestroConfiguratorDraft(broken).ok).toBe(false)
    const invalidEffort = cloneMaestroConfig(createDefaultMaestroConfig())
    invalidEffort.pool[0].candidates = [{ providerId: 'claude', modelId: 'opus', effort: 'maestrly-ultra' }]
    expect(prepareMaestroConfiguratorDraft(invalidEffort).ok).toBe(false)
  })

  it('keeps an unfinished editor draft intact in the session shape and rejects anything else', () => {
    const draft = createDefaultMaestroConfig()
    draft.pool[0].candidates = [{ providerId: 'claude', modelId: '', effort: '' }]
    draft.pool[0].label = ''
    expect(sanitizeMaestroDraftShape(draft)).toEqual(draft)
    expect(sanitizeMaestroDraftShape({ version: 2, strategy: 'balanced', pool: [] })).toBeNull()
    expect(sanitizeMaestroDraftShape({ version: 1, strategy: 'balanced', pool: ['x'] })).toBeNull()
    expect(sanitizeMaestroDraftShape('draft')).toBeNull()
  })

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
