import { describe, expect, it, vi } from 'vitest'
import type { ChatSubscriptionUsage } from '../../src/shared/chat'
import type { MaestroConfiguratorCatalog } from '../../src/shared/maestro-configurator'
import type { UnifiedUsageStats, UsageModelRow } from '../../src/shared/usage'
import {
  buildMaestroConfiguratorUsage,
  normalizeMaestroUsageDays,
  type MaestroConfiguratorUsageDependencies,
} from '../../src/main/chat/maestro-configurator-usage'

const NOW = Date.UTC(2026, 10, 12)
const DAY = 86_400_000

const model = (id: string) => ({ id, reasoning: true, reasoningEfforts: ['high'], fastModeCapability: false })

const catalog: MaestroConfiguratorCatalog = {
  generatedAt: NOW,
  providers: [
    { id: 'builtin_claude_subscription', name: 'Claude', catalogStatus: 'available', models: [model('opus')] },
    {
      id: 'builtin_claude_subscription@~active',
      name: 'Claude — Active account',
      catalogStatus: 'available',
      models: [model('opus')],
    },
    { id: 'builtin_codex_subscription@acc_1', name: 'ChatGPT work', catalogStatus: 'available', models: [] },
    { id: 'builtin_antigravity_subscription', name: 'Google AI', catalogStatus: 'available', models: [] },
    { id: 'byok-1', name: 'OpenRouter', catalogStatus: 'available', models: [model('gpt-x')] },
  ],
}

const row = (overrides: Partial<UsageModelRow> & Pick<UsageModelRow, 'providerId' | 'modelId'>): UsageModelRow => ({
  source: 'chat',
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  turns: 0,
  costUsd: null,
  ...overrides,
})

const stats = (rows: UsageModelRow[]): UnifiedUsageStats => ({
  rows,
  chatTurns: rows.reduce((sum, entry) => sum + entry.turns, 0),
  firstAt: rows.length ? NOW - 3 * DAY : null,
  lastAt: rows.length ? NOW - DAY : null,
  generatedAt: NOW,
})

function deps(overrides: Partial<MaestroConfiguratorUsageDependencies> = {}): MaestroConfiguratorUsageDependencies {
  return {
    stats: vi.fn(async () => stats([])),
    pricing: vi.fn(async () => null),
    quota: vi.fn(
      async (providerKind, accountId): Promise<ChatSubscriptionUsage> => ({
        state: 'unsupported',
        providerKind,
        accountId,
      })
    ),
    activeAccount: () => 'builtin_claude_subscription',
    now: () => NOW,
    quotaTimeoutMs: 5,
    ...overrides,
  }
}

describe('Maestro configurator usage summary', () => {
  it('clamps the period to 1..90 days and defaults to 30', () => {
    expect(normalizeMaestroUsageDays(undefined)).toBe(30)
    expect(normalizeMaestroUsageDays('abc')).toBe(30)
    expect(normalizeMaestroUsageDays('14')).toBe(14)
    expect(normalizeMaestroUsageDays(2.6)).toBe(3)
    expect(normalizeMaestroUsageDays(0)).toBe(1)
    expect(normalizeMaestroUsageDays(500)).toBe(90)
  })

  it('prices each model as Settings → Usage does, sorted by tokens', async () => {
    const dependencies = deps({
      stats: vi.fn(async () =>
        stats([
          row({ providerId: 'byok-1', modelId: 'mystery', input: 100_000 }),
          row({
            providerId: 'builtin_claude_subscription',
            modelId: 'opus',
            input: 1_000_000,
            output: 100_000,
            turns: 10,
          }),
          row({
            providerId: 'byok-1',
            modelId: 'gpt-x',
            input: 200_000,
            output: 50_000,
            turns: 3,
            costUsd: 1.23456789,
          }),
        ])
      ),
      pricing: vi.fn(async (_providerId: string, modelId: string) =>
        modelId === 'opus' ? { inputPer1M: 5, outputPer1M: 25 } : null
      ),
    })
    const summary = await buildMaestroConfiguratorUsage({ days: 7, catalog, dependencies })

    expect(dependencies.stats).toHaveBeenCalledWith({ since: NOW - 7 * DAY, until: NOW })
    expect(summary.period).toEqual({
      days: 7,
      since: new Date(NOW - 7 * DAY).toISOString(),
      until: new Date(NOW).toISOString(),
      firstActivity: new Date(NOW - 3 * DAY).toISOString(),
      lastActivity: new Date(NOW - DAY).toISOString(),
    })
    expect(summary.models).toEqual([
      {
        providerId: 'builtin_claude_subscription',
        provider: 'Claude',
        modelId: 'opus',
        billing: 'subscription',
        inCatalog: true,
        turns: 10,
        tokens: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheCreate: 0, total: 1_100_000 },
        tokenShare: 0.759,
        estimatedCostUsd: 7.5,
      },
      expect.objectContaining({ modelId: 'gpt-x', billing: 'api', inCatalog: true, estimatedCostUsd: 1.2346 }),
      expect.objectContaining({ modelId: 'mystery', provider: 'OpenRouter', inCatalog: false, estimatedCostUsd: null }),
    ])
    expect(summary.totals).toEqual({ turns: 13, tokens: 1_450_000, estimatedCostUsd: 8.7346, unpricedModels: 1 })
    expect(summary.omittedModels).toBeUndefined()
  })

  it('reads the quota of each physical subscription account and maps active-account entries', async () => {
    const resetsAt = NOW + 2 * 3_600_000
    const quota = vi.fn(async (providerKind, accountId): Promise<ChatSubscriptionUsage> => {
      if (providerKind === 'claude-subscription') {
        return {
          state: 'ready',
          providerKind,
          accountId,
          fetchedAt: NOW,
          windows: [{ id: 'five-hour', kind: 'five-hour', usedPercent: 40, resetsAt, durationMins: 300 }],
        }
      }
      if (providerKind === 'codex-subscription') return new Promise<never>(() => {})
      return { state: 'unsupported', providerKind, accountId, reason: 'unavailable' }
    }) as MaestroConfiguratorUsageDependencies['quota']
    const summary = await buildMaestroConfiguratorUsage({ catalog, dependencies: deps({ quota }) })

    expect(quota).toHaveBeenCalledTimes(3)
    expect(quota).toHaveBeenCalledWith('claude-subscription', null)
    expect(quota).toHaveBeenCalledWith('codex-subscription', 'acc_1')
    expect(quota).toHaveBeenCalledWith('antigravity-subscription', null)
    expect(summary.subscriptionQuotas).toEqual([
      {
        providerId: 'builtin_claude_subscription',
        provider: 'Claude',
        state: 'ready',
        windows: [{ kind: 'five-hour', usedPercent: 40, resetsAt: new Date(resetsAt).toISOString() }],
      },
      {
        providerId: 'builtin_codex_subscription@acc_1',
        provider: 'ChatGPT work',
        state: 'error',
        error: 'Quota read timed out.',
      },
      { providerId: 'builtin_antigravity_subscription', provider: 'Google AI', state: 'unavailable' },
    ])
    expect(summary.activeAccounts).toEqual([
      {
        providerId: 'builtin_claude_subscription@~active',
        provider: 'Claude — Active account',
        runsOn: { providerId: 'builtin_claude_subscription', provider: 'Claude' },
      },
    ])
  })

  it('reports a failed quota read without failing the summary', async () => {
    const summary = await buildMaestroConfiguratorUsage({
      catalog: { generatedAt: NOW, providers: [catalog.providers[0]] },
      dependencies: deps({
        quota: vi.fn(async () => {
          throw new Error('offline')
        }),
      }),
    })
    expect(summary.subscriptionQuotas).toEqual([
      { providerId: 'builtin_claude_subscription', provider: 'Claude', state: 'error', error: 'offline' },
    ])
  })

  it('caps the model list and says when nothing was recorded', async () => {
    const many = Array.from({ length: 45 }, (_, index) =>
      row({ providerId: 'byok-1', modelId: `m-${index}`, input: 1_000 + index })
    )
    const capped = await buildMaestroConfiguratorUsage({
      catalog,
      dependencies: deps({ stats: vi.fn(async () => stats(many)) }),
    })
    expect(capped.models).toHaveLength(40)
    expect(capped.models[0].modelId).toBe('m-44')
    expect(capped.omittedModels).toBe(5)
    expect(capped.totals.unpricedModels).toBe(45)
    expect(capped.totals.estimatedCostUsd).toBeNull()

    const empty = await buildMaestroConfiguratorUsage({ catalog, dependencies: deps() })
    expect(empty.models).toEqual([])
    expect(empty.totals).toEqual({ turns: 0, tokens: 0, estimatedCostUsd: null, unpricedModels: 0 })
    expect(empty.notes).toContain('No usage was recorded in this period.')
  })
})
