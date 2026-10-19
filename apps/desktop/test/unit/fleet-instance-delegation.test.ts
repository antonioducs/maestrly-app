import { describe, expect, it } from 'vitest'
import { FLEET_BOT_DELEGATION_DEFAULT, type FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import { headroomOf } from '../../src/main/fleet/instance/account-headroom'
import {
  delegationPolicyPrompt,
  effortForTier,
  routeDelegatedTask,
  type DelegationRouterDeps,
} from '../../src/main/fleet/instance/delegation'

const option = (providerId: string, modelId: string, efforts: string[]): FleetSelectionOption => ({
  id: `${providerId}::${modelId}`,
  providerId,
  providerLabel: providerId,
  modelId,
  modelLabel: modelId,
  efforts,
  fastMode: false,
})
const claude = 'builtin_claude_subscription'
const options = [
  option(claude, 'haiku', ['low', 'medium', 'high']),
  option(`${claude}@acc_studio`, 'haiku', ['low', 'medium', 'high']),
  option(claude, 'sonnet', ['low', 'medium', 'high', 'max']),
  option('builtin_codex_subscription', 'gpt-6-astra', ['low', 'medium', 'high', 'xhigh']),
]
const deps = (overrides: Partial<DelegationRouterDeps> = {}): DelegationRouterDeps => ({
  settings: () => ({
    ...FLEET_BOT_DELEGATION_DEFAULT,
    mode: 'delegate',
    models: [
      { providerId: claude, modelId: 'haiku', tier: 'fast' },
      { providerId: claude, modelId: 'sonnet', tier: 'balanced' },
    ],
  }),
  options: () => options,
  headroom: (id) => (id === claude ? 0.2 : 0.7),
  admissible: () => true,
  ...overrides,
})

describe('bot delegation routing', () => {
  it('reads the tightest window, ignoring windows that already reset', () => {
    const now = 1_000
    expect(
      headroomOf(
        [
          { id: '5h', kind: 'five-hour', usedPercent: 80, resetsAt: 5_000, durationMins: 300 },
          { id: 'w', kind: 'weekly', usedPercent: 30, resetsAt: 9_000, durationMins: 10_080 },
        ],
        now
      )
    ).toBeCloseTo(0.2)
    expect(headroomOf([{ id: '5h', kind: 'five-hour', usedPercent: 90, resetsAt: 500, durationMins: 300 }], now)).toBe(
      1
    )
    expect(headroomOf([], now)).toBeNull()
  })

  it('maps tiers to efforts the model accepts', () => {
    expect(effortForTier('fast', ['minimal', 'low', 'medium'])).toBe('low')
    expect(effortForTier('strong', ['low', 'medium', 'high', 'xhigh'])).toBe('high')
    expect(effortForTier('balanced', [])).toBe('off')
  })

  it('sends a simple task to a fast model on the account with the most headroom', () => {
    const route = routeDelegatedTask('simple', deps())
    expect(route.info).toEqual({ complexity: 'simple', declared: true, tier: 'fast', upgraded: false })
    expect(route.candidates.map((c) => c.providerId)).toEqual([`${claude}@acc_studio`, claude])
    expect(route.candidates[0]).toMatchObject({ modelId: 'haiku', effort: 'low' })
  })

  it('keeps the allowed order when spreading is off and skips exhausted accounts', () => {
    const settings = { ...deps().settings(), spreadAccounts: false }
    expect(
      routeDelegatedTask('simple', deps({ settings: () => settings })).candidates.map((c) => c.providerId)
    ).toEqual([claude, `${claude}@acc_studio`])
    expect(
      routeDelegatedTask('simple', deps({ admissible: (id) => id !== `${claude}@acc_studio` })).candidates.map(
        (c) => c.providerId
      )
    ).toEqual([claude])
  })

  it('moves up a tier, counts a missing complexity as medium, and gives up past the strongest', () => {
    expect(routeDelegatedTask(null, deps()).info).toEqual({
      complexity: 'medium',
      declared: false,
      tier: 'balanced',
      upgraded: false,
    })
    const route = routeDelegatedTask('complex', deps())
    expect(route.info).toEqual({ complexity: 'complex', declared: true, tier: null, upgraded: false })
    expect(route.candidates).toEqual([])
  })

  it('ignores allowed models that no connected account offers', () => {
    const settings = {
      ...deps().settings(),
      models: [{ providerId: 'gone', modelId: 'x', tier: 'fast' as const }],
    }
    expect(routeDelegatedTask('simple', deps({ settings: () => settings })).info.tier).toBeNull()
  })

  it('tells the bot which model serves each difficulty and when to do work itself', () => {
    const text = delegationPolicyPrompt(deps())
    expect(text).toContain('# Tasks: delegate')
    expect(text).toContain('simple')
    expect(text).toContain('haiku')
    expect(text).toContain('complex')
    expect(text).toContain('do this work yourself')
    expect(text).toContain('run it once more with the next complexity')
  })
})
