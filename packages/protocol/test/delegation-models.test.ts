import { describe, expect, it } from 'vitest'
import {
  agentStageSettingsSchema,
  assertStageSettingsStillValid,
  delegationCatalogRevision,
  delegationModelCatalogSchema,
  delegationModelEntrySchema,
  DelegationSettingsError,
  matchSelectionAlias,
  resolveStageSettings,
  type DelegationModelCatalog,
} from '../src/index.js'

const features = {
  checks: [],
  github: { available: true, login: 'octocat', issue: null },
  preview: { available: true, issue: null },
  maestro: true,
  subagents: true,
  browserInspect: true,
  browserInteract: false,
}

const entry = (overrides: Record<string, unknown>) =>
  delegationModelEntrySchema.parse({
    selectionId: 'selection',
    modelLabel: 'model',
    accountLabel: 'Account',
    efforts: [],
    fastMode: false,
    executionModes: ['standard'],
    delegationProfiles: [],
    harnessProfileId: null,
    harnessHash: null,
    ...overrides,
  })

function catalog(models: ReturnType<typeof entry>[], overrides: Partial<DelegationModelCatalog> = {}) {
  return delegationModelCatalogSchema.parse({
    capability: 'delegation:stages:v1',
    enabled: true,
    revision: delegationCatalogRevision({ models, features }),
    generatedAt: '2026-09-20T00:00:00.000Z',
    workspaces: [],
    models,
    features,
    issues: [],
    ...overrides,
  })
}

const opusPersonal = entry({
  selectionId: 'sel-opus-personal',
  modelLabel: 'claude-opus-5',
  accountLabel: 'Claude · personal',
  efforts: ['low', 'medium', 'high'],
  fastMode: true,
  executionModes: ['standard', 'maestro'],
  delegationProfiles: ['backend', 'reviewer'],
})
const opusTeam = entry({
  selectionId: 'sel-opus-team',
  modelLabel: 'claude-opus-5',
  accountLabel: 'Claude · team',
  efforts: ['medium'],
})
const astra = entry({
  selectionId: 'sel-astra',
  modelLabel: 'gpt-6-astra',
  accountLabel: 'Codex · personal',
  efforts: ['medium', 'high', 'xhigh'],
  fastMode: false,
  harnessProfileId: 'openai-gpt-6-astra-v1',
})

describe('delegation model catalog', () => {
  it('resolves an exact selection with the effort and Fast the account offers', () => {
    const resolved = resolveStageSettings(catalog([opusPersonal, astra]), {
      selectionId: 'sel-opus-personal',
      reasoning: 'high',
      fastMode: false,
    })
    expect(resolved.settings).toEqual(
      agentStageSettingsSchema.parse({
        selectionId: 'sel-opus-personal',
        reasoning: 'high',
        fastMode: false,
        executionMode: 'standard',
        delegationProfiles: [],
      })
    )
    expect(resolved.selection.accountLabel).toBe('Claude · personal')
  })

  it('refuses an effort the model does not offer instead of approximating it', () => {
    expect(() =>
      resolveStageSettings(catalog([astra]), { selectionId: 'sel-astra', reasoning: 'low' })
    ).toThrowError(DelegationSettingsError)
    try {
      resolveStageSettings(catalog([astra]), { selectionId: 'sel-astra', reasoning: 'low' })
    } catch (error) {
      expect((error as DelegationSettingsError).code).toBe('UNSUPPORTED_SETTING')
      expect((error as DelegationSettingsError).details).toMatchObject({ supported: ['medium', 'high', 'xhigh'] })
    }
  })

  it('refuses Fast when the model does not support it and resolves "if-available" from the catalog', () => {
    expect(() => resolveStageSettings(catalog([astra]), { selectionId: 'sel-astra', fastMode: true })).toThrowError(
      /Fast mode is unavailable/
    )
    expect(
      resolveStageSettings(catalog([astra]), { selectionId: 'sel-astra', fastMode: 'if-available' }).settings.fastMode
    ).toBe(false)
    expect(
      resolveStageSettings(catalog([opusPersonal]), { selectionId: 'sel-opus-personal', fastMode: 'if-available' })
        .settings.fastMode
    ).toBe(true)
  })

  it('never carries an unsupported effort across a model switch', () => {
    const base = resolveStageSettings(catalog([opusPersonal, astra]), {
      selectionId: 'sel-opus-personal',
      reasoning: 'low',
    }).settings
    expect(() =>
      resolveStageSettings(catalog([opusPersonal, astra]), { selectionId: 'sel-astra' }, base)
    ).toThrowError(/previous reasoning effort is unavailable/)
    const explicit = resolveStageSettings(
      catalog([opusPersonal, astra]),
      { selectionId: 'sel-astra', reasoning: 'high' },
      base
    )
    expect(explicit.settings).toMatchObject({ selectionId: 'sel-astra', reasoning: 'high' })
    const cleared = resolveStageSettings(
      catalog([opusPersonal, astra]),
      { selectionId: 'sel-astra', reasoning: null },
      base
    )
    expect(cleared.settings.reasoning).toBeNull()
  })

  it('keeps an explicit false and does not let a default turn Fast back on', () => {
    const base = resolveStageSettings(catalog([opusPersonal]), {
      selectionId: 'sel-opus-personal',
      fastMode: false,
    }).settings
    expect(resolveStageSettings(catalog([opusPersonal]), {}, base).settings.fastMode).toBe(false)
  })

  it('rejects an unknown selection and an unavailable capability', () => {
    expect(() => resolveStageSettings(catalog([opusPersonal]), { selectionId: 'ghost' })).toThrowError(
      /no longer available/
    )
    const withoutMaestro = catalog([opusPersonal], {
      features: { ...features, maestro: false },
    })
    expect(() =>
      resolveStageSettings(withoutMaestro, { selectionId: 'sel-opus-personal', executionMode: 'maestro' })
    ).toThrowError(/does not offer Maestro/)
    expect(() =>
      resolveStageSettings(catalog([opusPersonal]), {
        selectionId: 'sel-opus-personal',
        delegationProfiles: ['unknown-profile'],
      })
    ).toThrowError(/Unknown subagent profile/)
  })

  it('blocks a queued snapshot when the model disappears from the catalog', () => {
    const settings = resolveStageSettings(catalog([opusPersonal]), {
      selectionId: 'sel-opus-personal',
      reasoning: 'high',
      fastMode: true,
    })
    expect(
      assertStageSettingsStillValid(catalog([opusPersonal]), settings.settings, settings.catalogRevision).selectionId
    ).toBe('sel-opus-personal')
    expect(() => assertStageSettingsStillValid(catalog([astra]), settings.settings, settings.catalogRevision)).toThrowError(
      /no longer available/
    )
    const narrowed = catalog([entry({ ...opusPersonal, efforts: ['low'], fastMode: true })])
    expect(() => assertStageSettingsStillValid(narrowed, settings.settings, settings.catalogRevision)).toThrowError(
      /reasoning effort chosen for this stage disappeared/
    )
  })

  it('computes a stable revision that changes with the advertised capability', () => {
    const first = delegationCatalogRevision({ models: [opusPersonal, astra], features })
    const reordered = delegationCatalogRevision({ models: [opusPersonal, astra], features })
    expect(reordered).toBe(first)
    expect(delegationCatalogRevision({ models: [astra, opusPersonal], features })).not.toBe(first)
    expect(delegationCatalogRevision({ models: [opusPersonal, astra], features: { ...features, maestro: false } })).not.toBe(
      first
    )
    expect(first).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns candidates when an alias matches more than one account', () => {
    const value = catalog([opusPersonal, opusTeam, astra])
    expect(matchSelectionAlias(value, 'astra')).toEqual({ selectionId: 'sel-astra' })
    const ambiguous = matchSelectionAlias(value, 'opus')
    expect('candidates' in ambiguous && ambiguous.candidates.map((item) => item.selectionId)).toEqual([
      'sel-opus-personal',
      'sel-opus-team',
    ])
    expect(matchSelectionAlias(value, 'opus', { opus: 'sel-opus-team' })).toEqual({ selectionId: 'sel-opus-team' })
    // An empty catalog cannot authorize inventing a model.
    expect(matchSelectionAlias(catalog([]), 'opus')).toEqual({ candidates: [] })
  })
})
