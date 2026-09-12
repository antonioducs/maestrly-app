import { describe, expect, it } from 'vitest'
import { tFor } from '../../src/shared/i18n'
import type { SubagentRunMeta } from '../../src/shared/chat'
import {
  subagentCompactProfileLabel,
  subagentEffortLabel,
  subagentProfileDiagnostics,
  subagentProfileLabel,
  subagentRunCost,
  subagentRunDisplay,
} from '../../src/renderer/lib/subagent-profile-display'

const profile = {
  version: 1 as const,
  agentName: 'explore',
  effective: {
    providerId: 'openai',
    modelId: 'gpt-5',
    configuredEffort: 'ultra',
    sentEffort: 'high',
    source: 'global-default' as const,
    candidateIndex: 1,
  },
  attempts: [
    {
      source: 'global-default' as const,
      candidateIndex: 0,
      candidate: { providerId: 'missing', modelId: 'x', effort: 'high' },
      outcome: 'rejected' as const,
      diagnostics: [{ code: 'provider-missing' as const, severity: 'error' as const, message: 'missing' }],
    },
  ],
}

describe('subagent profile display', () => {
  it('uses four buckets and distinguishes zero cost from unknown cost', () => {
    const display = subagentRunDisplay({
      profile,
      usage: { input: 100, output: 20, cacheRead: 50, cacheCreate: 10 },
      durationMs: 500,
    })
    expect(display.totalTokens).toBe(180)
    expect(subagentRunCost(display, { inputPer1M: 0, outputPer1M: 0 })).toBe(0)
    expect(subagentRunCost(display, null)).toBeNull()
  })

  it('prioritizes the cost estimate returned by the subagent runtime', () => {
    const display = subagentRunDisplay({
      profile,
      usage: { input: 100, output: 20, cacheRead: 50, cacheCreate: 10 },
      runtimeEstimatedCostUsd: 0.0123,
    })
    expect(subagentRunCost(display, null)).toBe(0.0123)
    expect(subagentRunCost(display, { inputPer1M: 999, outputPer1M: 999 })).toBe(0.0123)
    expect(subagentRunCost(subagentRunDisplay({ runtimeEstimatedCostUsd: 0 }), null)).toBe(0)
  })

  it('prefers persisted sessions over initial delegate snapshots', () => {
    const initialSnapshot: SubagentRunMeta = { profile, startedAt: 1_000 }
    const display = subagentRunDisplay(initialSnapshot, {
      startedAt: 1_000,
      durationMs: 6_000,
      usage: { input: 6, output: 45_107, cacheRead: 529_020, cacheCreate: 45_717 },
      runtimeEstimatedCostUsd: 1.849385,
    })
    expect(display).toMatchObject({ input: 6, output: 45_107, cacheRead: 529_020, cacheCreate: 45_717 })
    expect(display.totalTokens).toBe(619_850)
    expect(display.durationMs).toBe(6_000)
    expect(subagentRunCost(display, null)).toBe(1.849385)
    // Legacy runs without sessions retain part snapshots.
    expect(
      subagentRunDisplay({ ...initialSnapshot, usage: { input: 1, output: 2, cacheRead: 0, cacheCreate: 0 } }, null)
    ).toMatchObject({ input: 1, output: 2 })
  })

  it('preserves timer origins with routedAt fallback for older runs', () => {
    const legacyMaestro = {
      routedAt: 1_000,
    } as unknown as NonNullable<SubagentRunMeta['maestro']>
    expect(subagentRunDisplay({ startedAt: 2_000, maestro: legacyMaestro }).startedAt).toBe(2_000)
    expect(subagentRunDisplay({ maestro: legacyMaestro }).startedAt).toBe(1_000)
    expect(subagentRunDisplay({ startedAt: Number.NaN }).startedAt).toBeNull()
  })

  it('formats translated Ultra, trace, and legacy values faithfully', () => {
    expect(subagentProfileLabel(profile)).toBe('openai · gpt-5 · ultra → high')
    const pt = tFor('pt-BR', 'chat')
    expect(subagentEffortLabel('high', pt)).toBe('Alto (high)')
    expect(subagentProfileLabel(profile, (effort) => subagentEffortLabel(effort, pt))).toBe(
      'openai · gpt-5 · Ultra — maior nível suportado → Alto (high)'
    )
    expect(subagentCompactProfileLabel(profile, (effort) => subagentEffortLabel(effort, pt))).toBe(
      'gpt-5 · Alto (high)'
    )
    // Discarded inherited efforts display degradation rather than raw configured values.
    expect(
      subagentProfileLabel({
        ...profile,
        effective: { ...profile.effective, configuredEffort: 'xhigh', sentEffort: null },
      })
    ).toBe('openai · gpt-5 · xhigh → off')
    expect(
      subagentProfileLabel({
        ...profile,
        effective: { ...profile.effective, configuredEffort: 'off', sentEffort: null },
      })
    ).toBe('openai · gpt-5 · off')
    expect(subagentCompactProfileLabel({ ...profile, effective: null })).toBeNull()
    expect(subagentProfileDiagnostics(profile)[0].code).toBe('provider-missing')
    expect(subagentRunDisplay({ inputTokens: 10, outputTokens: 2, durationMs: 3 })).toMatchObject({
      profile: null,
      input: 10,
      output: 2,
      totalTokens: 12,
    })
  })

  it('shows Fast only in effective snapshots', () => {
    const fastProfile = { ...profile, effective: { ...profile.effective, fastMode: true } }
    expect(subagentCompactProfileLabel(fastProfile)).toBe('gpt-5 · high · ⚡ Fast')
    expect(subagentProfileLabel(fastProfile)).toBe('openai · gpt-5 · ultra → high · ⚡ Fast')
    expect(subagentCompactProfileLabel(profile)).toBe('gpt-5 · high')
  })
})
