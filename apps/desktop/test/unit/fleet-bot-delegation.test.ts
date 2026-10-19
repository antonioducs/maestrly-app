import { describe, expect, it } from 'vitest'
import { FLEET_BOT_DELEGATION_DEFAULT, type FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import {
  delegationModelGroups,
  delegationPreview,
  setDelegationModel,
  suggestedDelegationTier,
} from '../../src/renderer/lib/fleet/bot-delegation'

const claude = 'builtin_claude_subscription'
const option = (providerId: string, modelId: string, providerLabel = providerId): FleetSelectionOption => ({
  id: `${providerId}::${modelId}`,
  providerId,
  providerLabel,
  modelId,
  modelLabel: modelId,
  efforts: [],
  fastMode: false,
})
const options = [
  option(claude, 'haiku', 'Claude'),
  option(`${claude}@acc_x`, 'haiku', 'Claude (Studio)'),
  option(claude, 'sonnet', 'Claude'),
]
const haiku = { providerId: claude, modelId: 'haiku', tier: 'fast' as const }
const sonnet = { providerId: claude, modelId: 'sonnet', tier: 'balanced' as const }

describe('bot delegation settings', () => {
  it('guesses what each model is for from its name', () => {
    const cases: Array<[string, string]> = [
      ['haiku', 'fast'],
      ['gpt-6-mini', 'fast'],
      ['gemini-3-flash', 'fast'],
      ['sonnet', 'balanced'],
      ['opus', 'strong'],
      ['gpt-6-astra', 'strong'],
      ['gemini-3-pro', 'strong'],
    ]
    for (const [model, tier] of cases) expect([model, suggestedDelegationTier(model)]).toEqual([model, tier])
  })

  it('lists each model once per provider, with the accounts that offer it', () => {
    expect(delegationModelGroups(options)).toEqual([
      {
        providerId: claude,
        accounts: ['Claude', 'Claude (Studio)'],
        models: [
          { modelId: 'haiku', label: 'haiku' },
          { modelId: 'sonnet', label: 'sonnet' },
        ],
      },
    ])
  })

  it('allows, retypes and removes a model', () => {
    const allowed = setDelegationModel(FLEET_BOT_DELEGATION_DEFAULT, claude, 'haiku', 'fast')
    expect(allowed.models).toEqual([haiku])
    expect(setDelegationModel(allowed, claude, 'haiku', 'balanced').models).toEqual([{ ...haiku, tier: 'balanced' }])
    expect(setDelegationModel(allowed, claude, 'haiku', null).models).toEqual([])
  })

  it('previews where each difficulty goes, moving up or to the bot itself', () => {
    const both = { ...FLEET_BOT_DELEGATION_DEFAULT, models: [haiku, sonnet] }
    expect(delegationPreview(both, options)).toEqual([
      { complexity: 'simple', models: ['haiku'], upgradedFrom: null },
      { complexity: 'medium', models: ['sonnet'], upgradedFrom: null },
      { complexity: 'complex', models: [], upgradedFrom: null },
    ])
    expect(delegationPreview({ ...FLEET_BOT_DELEGATION_DEFAULT, models: [sonnet] }, options)[0]).toEqual({
      complexity: 'simple',
      models: ['sonnet'],
      upgradedFrom: 'fast',
    })
    const gone = {
      ...FLEET_BOT_DELEGATION_DEFAULT,
      models: [{ providerId: 'gone', modelId: 'x', tier: 'fast' as const }],
    }
    expect(delegationPreview(gone, options)[0]).toEqual({ complexity: 'simple', models: [], upgradedFrom: null })
  })
})
