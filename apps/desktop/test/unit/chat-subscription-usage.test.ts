import { describe, expect, it, vi } from 'vitest'
import {
  normalizeClaudeSubscriptionUsage,
  normalizeCodexSubscriptionUsage,
  readSubscriptionUsage,
  type SubscriptionUsageDependencies,
} from '../../src/main/chat/subscription-usage'

describe('subscription usage normalization', () => {
  it('normalizes Codex 5-hour, weekly and future windows without guessing unknown durations', () => {
    expect(
      normalizeCodexSubscriptionUsage({
        primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: '12', windowDurationMins: '10080', resetsAt: '2026-09-01T12:00:00Z' },
        monthly_preview: { usedPercent: 101, windowDurationMins: 43_200, resetsAt: null },
        credits: { balance: 4 },
      })
    ).toEqual([
      {
        id: 'primary',
        kind: 'five-hour',
        usedPercent: 34,
        resetsAt: 1_800_000_000_000,
        durationMins: 300,
      },
      {
        id: 'secondary',
        kind: 'weekly',
        usedPercent: 12,
        resetsAt: Date.parse('2026-09-01T12:00:00Z'),
        durationMins: 10_080,
      },
      {
        id: 'monthly-preview',
        kind: 'other',
        usedPercent: 100,
        resetsAt: null,
        durationMins: 43_200,
      },
    ])
  })

  it('ignores malformed or percentage-less Codex windows', () => {
    expect(
      normalizeCodexSubscriptionUsage({
        primary: { usedPercent: 'not-a-number', windowDurationMins: 300 },
        secondary: { usedPercent: ' ', resetsAt: Date.now() },
      })
    ).toEqual([])
    expect(normalizeCodexSubscriptionUsage(null)).toEqual([])
  })

  it('normalizes Claude 5-hour, weekly, known/future model buckets and server model labels', () => {
    expect(
      normalizeClaudeSubscriptionUsage({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 34.4, resets_at: '2026-08-29T18:00:00Z' },
          seven_day: { utilization: 12, resets_at: '2026-09-03T08:00:00Z' },
          seven_day_opus: { utilization: 54, resets_at: null },
          seven_day_fable_preview: { utilization: '7', resets_at: '2026-09-04T08:00:00Z' },
          model_scoped: [
            { display_name: 'Claude Design', utilization: 8, resets_at: '2026-09-02T08:00:00Z' },
            { display_name: 'Missing percent', utilization: null, resets_at: null },
          ],
          extra_usage: { utilization: 22 },
        },
      })
    ).toEqual([
      {
        id: 'five-hour',
        kind: 'five-hour',
        usedPercent: 34.4,
        resetsAt: Date.parse('2026-08-29T18:00:00Z'),
        durationMins: 300,
      },
      {
        id: 'weekly',
        kind: 'weekly',
        usedPercent: 12,
        resetsAt: Date.parse('2026-09-03T08:00:00Z'),
        durationMins: 10_080,
      },
      {
        id: 'weekly-opus',
        kind: 'weekly-model',
        usedPercent: 54,
        resetsAt: null,
        durationMins: 10_080,
        label: 'Opus',
      },
      {
        id: 'weekly-fable-preview',
        kind: 'weekly-model',
        usedPercent: 7,
        resetsAt: Date.parse('2026-09-04T08:00:00Z'),
        durationMins: 10_080,
        label: 'Fable Preview',
      },
      {
        id: 'weekly-model-claude-design',
        kind: 'weekly-model',
        usedPercent: 8,
        resetsAt: Date.parse('2026-09-02T08:00:00Z'),
        durationMins: 10_080,
        label: 'Claude Design',
      },
    ])
  })

  it('degrades unavailable or malformed Claude rate-limit responses to no windows', () => {
    expect(normalizeClaudeSubscriptionUsage({ rate_limits_available: false, rate_limits: {} })).toEqual([])
    expect(normalizeClaudeSubscriptionUsage({ rate_limits_available: true, rate_limits: null })).toEqual([])
    expect(normalizeClaudeSubscriptionUsage({ rate_limits_available: true, rate_limits: { five_hour: {} } })).toEqual(
      []
    )
  })
})

describe('subscription usage adapters', () => {
  function dependencies(): SubscriptionUsageDependencies & {
    codexAccounts: (string | null)[]
    claudeAccounts: (string | null)[]
  } {
    const codexAccounts: (string | null)[] = []
    const claudeAccounts: (string | null)[] = []
    return {
      codexAccounts,
      claudeAccounts,
      now: () => 1_800_000_000_000,
      getCodexManager: (accountId) => {
        codexAccounts.push(accountId)
        return {
          getRateLimits: vi.fn(async () => ({
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_001_000_000 },
          })),
        }
      },
      getClaudeManager: (accountId) => {
        claudeAccounts.push(accountId)
        return {
          getUsage: vi.fn(
            async () =>
              ({
                rate_limits_available: true,
                rate_limits: { seven_day: { utilization: 15, resets_at: '2026-09-03T08:00:00Z' } },
              }) as never
          ),
        }
      },
    }
  }

  it('routes the default and additional accounts to their isolated managers', async () => {
    const deps = dependencies()

    const codex = await readSubscriptionUsage({ providerKind: 'codex-subscription' }, deps)
    const claude = await readSubscriptionUsage(
      { providerKind: 'claude-subscription', accountId: 'acc_work', force: true },
      deps
    )

    expect(deps.codexAccounts).toEqual([null])
    expect(deps.claudeAccounts).toEqual(['acc_work'])
    expect(codex).toMatchObject({
      state: 'ready',
      providerKind: 'codex-subscription',
      accountId: null,
      fetchedAt: 1_800_000_000_000,
    })
    expect(claude).toMatchObject({
      state: 'ready',
      providerKind: 'claude-subscription',
      accountId: 'acc_work',
      fetchedAt: 1_800_000_000_000,
    })
  })

  it('does not touch managers for unsupported providers', async () => {
    const deps = dependencies()

    await expect(readSubscriptionUsage({ providerKind: 'github-copilot-subscription' }, deps)).resolves.toEqual({
      state: 'unsupported',
      providerKind: 'github-copilot-subscription',
      accountId: null,
      reason: 'provider',
    })
    expect(deps.codexAccounts).toEqual([])
    expect(deps.claudeAccounts).toEqual([])
  })

  it('contains provider failures in an error result for the originating account', async () => {
    const deps = dependencies()
    deps.getClaudeManager = () => ({
      getUsage: vi.fn(async () => {
        throw new Error('usage probe failed: Bearer oauth-supersecret')
      }),
    })

    await expect(
      readSubscriptionUsage({ providerKind: 'claude-subscription', accountId: 'acc_work' }, deps)
    ).resolves.toEqual({
      state: 'error',
      providerKind: 'claude-subscription',
      accountId: 'acc_work',
      error: 'usage probe failed: Bearer [REDACTED]',
    })
  })
})
