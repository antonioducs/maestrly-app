/**
 * What the Maestro configurator knows about how the person actually spends: tokens and estimated cost per model over a
 * recent period (the same figures as Settings → Usage) and the quota left on each subscription account it can run.
 * Read-only and local; the configurator calls it only when cost, quota or usage patterns matter to a proposal.
 */
import {
  estimatedCostOfUsage,
  isActiveAccountProviderId,
  subscriptionAccountId,
  totalTokensOf,
  type ChatModelMeta,
  type ChatSubscriptionProviderKind,
  type ChatSubscriptionUsage,
} from '../../shared/chat'
import type { MaestroConfiguratorCatalog } from '../../shared/maestro-configurator'
import { USAGE_MAX_WINDOW_DAYS, type UnifiedUsageStats } from '../../shared/usage'
import { getUnifiedUsage } from '../usage/usage-service'
import {
  isAntigravitySubscriptionProvider,
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isSubscriptionProvider,
} from './catalog'
import { resolveAccountPoolProviderId } from './subscription-failover/account-pool'

const DAY_MS = 86_400_000
export const MAESTRO_USAGE_DEFAULT_DAYS = 30
const MAX_MODEL_ROWS = 40
const QUOTA_TIMEOUT_MS = 10_000

export interface MaestroConfiguratorUsageDependencies {
  stats: (range: { since: number; until: number }) => Promise<UnifiedUsageStats>
  pricing: (providerId: string, modelId: string) => Promise<ChatModelMeta | null>
  quota: (providerKind: ChatSubscriptionProviderKind, accountId: string | null) => Promise<ChatSubscriptionUsage>
  /** The physical account an "Active account" entry runs on right now. */
  activeAccount: (providerId: string) => string
  now: () => number
  quotaTimeoutMs?: number
}

export const DEFAULT_MAESTRO_USAGE_DEPENDENCIES: MaestroConfiguratorUsageDependencies = {
  stats: (range) => getUnifiedUsage(range),
  // service.ts imports the configurator, so its pricing resolver loads on first use.
  pricing: async (providerId, modelId) =>
    (await (await import('./service')).effectiveModelMeta(modelId, providerId)).meta,
  // Not forced: the account managers keep their own cache, as the quota cards in Settings do.
  quota: async (providerKind, accountId) =>
    (await import('./subscription-usage')).readSubscriptionUsage({ providerKind, accountId }),
  activeAccount: resolveAccountPoolProviderId,
  now: Date.now,
}

export interface MaestroUsageModelSummary {
  providerId: string
  provider: string
  modelId: string
  billing: 'subscription' | 'api'
  inCatalog: boolean
  turns: number
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number; total: number }
  /** Share of every token in the period, 0..1. */
  tokenShare: number
  estimatedCostUsd: number | null
}

export interface MaestroUsageQuotaWindow {
  kind: string
  label?: string
  usedPercent: number
  resetsAt: string | null
}

export interface MaestroUsageQuotaSummary {
  providerId: string
  provider: string
  state: 'ready' | 'unavailable' | 'error'
  windows?: MaestroUsageQuotaWindow[]
  error?: string
}

export interface MaestroConfiguratorUsageSummary {
  period: { days: number; since: string; until: string; firstActivity: string | null; lastActivity: string | null }
  totals: { turns: number; tokens: number; estimatedCostUsd: number | null; unpricedModels: number }
  models: MaestroUsageModelSummary[]
  omittedModels?: number
  subscriptionQuotas: MaestroUsageQuotaSummary[]
  activeAccounts?: Array<{ providerId: string; provider: string; runsOn: { providerId: string; provider: string } }>
  notes: string[]
}

export function normalizeMaestroUsageDays(value: unknown): number {
  const days = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(days)) return MAESTRO_USAGE_DEFAULT_DAYS
  return Math.min(USAGE_MAX_WINDOW_DAYS, Math.max(1, Math.round(days)))
}

function quotaKind(providerId: string): ChatSubscriptionProviderKind | null {
  if (isClaudeSubscriptionProvider(providerId)) return 'claude-subscription'
  if (isCodexSubscriptionProvider(providerId)) return 'codex-subscription'
  if (isAntigravitySubscriptionProvider(providerId)) return 'antigravity-subscription'
  return null
}

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString())
const roundUsd = (value: number): number => Math.round(value * 10_000) / 10_000

async function withTimeout<T>(promise: Promise<T>, ms: number, timedOut: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timedOut()), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function readQuota(
  providerId: string,
  provider: string,
  kind: ChatSubscriptionProviderKind,
  deps: MaestroConfiguratorUsageDependencies
): Promise<MaestroUsageQuotaSummary> {
  const accountId = subscriptionAccountId(providerId)
  const usage = await withTimeout(
    deps.quota(kind, accountId).catch(
      (error): ChatSubscriptionUsage => ({
        state: 'error',
        providerKind: kind,
        accountId,
        error: error instanceof Error ? error.message : String(error),
      })
    ),
    deps.quotaTimeoutMs ?? QUOTA_TIMEOUT_MS,
    (): ChatSubscriptionUsage => ({ state: 'error', providerKind: kind, accountId, error: 'Quota read timed out.' })
  )
  if (usage.state === 'error') return { providerId, provider, state: 'error', error: usage.error }
  if (usage.state === 'unsupported' || usage.windows.length === 0) return { providerId, provider, state: 'unavailable' }
  return {
    providerId,
    provider,
    state: 'ready',
    windows: usage.windows.map((window) => ({
      kind: window.kind,
      ...(window.label ? { label: window.label } : {}),
      usedPercent: window.usedPercent,
      resetsAt: iso(window.resetsAt),
    })),
  }
}

export async function buildMaestroConfiguratorUsage(args: {
  days?: unknown
  catalog: MaestroConfiguratorCatalog
  dependencies?: MaestroConfiguratorUsageDependencies
}): Promise<MaestroConfiguratorUsageSummary> {
  const deps = args.dependencies ?? DEFAULT_MAESTRO_USAGE_DEPENDENCIES
  const days = normalizeMaestroUsageDays(args.days)
  const until = deps.now()
  const since = until - days * DAY_MS
  const names = new Map(args.catalog.providers.map((provider) => [provider.id, provider.name]))
  const nameOf = (providerId: string): string => names.get(providerId) ?? providerId
  const runnable = (providerId: string, modelId: string): boolean =>
    args.catalog.providers.some(
      (provider) =>
        provider.id === providerId &&
        provider.models.some((model) => model.id === modelId || model.id.split('/').pop() === modelId)
    )

  const quotaTargets = args.catalog.providers.flatMap((provider) => {
    if (isActiveAccountProviderId(provider.id)) return []
    const kind = quotaKind(provider.id)
    return kind ? [{ provider, kind }] : []
  })
  const [stats, subscriptionQuotas] = await Promise.all([
    deps.stats({ since, until }),
    Promise.all(quotaTargets.map(({ provider, kind }) => readQuota(provider.id, provider.name, kind, deps))),
  ])

  const priced = await Promise.all(
    stats.rows.map(async (row) => {
      const meta = await deps.pricing(row.providerId, row.modelId).catch(() => null)
      const cost = estimatedCostOfUsage(row, meta, row.costUsd, {
        input: row.catalogInput ?? 0,
        output: row.catalogOutput ?? 0,
        cacheRead: row.catalogCacheRead ?? 0,
        cacheCreate: row.catalogCacheCreate ?? 0,
      })
      return { row, total: totalTokensOf(row), cost }
    })
  )
  const totalTokens = priced.reduce((sum, entry) => sum + entry.total, 0)
  const pricedCosts = priced.filter((entry) => entry.cost != null)
  const models = [...priced]
    .sort((left, right) => right.total - left.total)
    .map(
      ({ row, total, cost }): MaestroUsageModelSummary => ({
        providerId: row.providerId,
        provider: nameOf(row.providerId),
        modelId: row.modelId,
        billing: isSubscriptionProvider(row.providerId) ? 'subscription' : 'api',
        inCatalog: runnable(row.providerId, row.modelId),
        turns: row.turns,
        tokens: {
          input: row.input,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheCreate: row.cacheCreate,
          total,
        },
        tokenShare: totalTokens > 0 ? Math.round((total / totalTokens) * 1000) / 1000 : 0,
        estimatedCostUsd: cost == null ? null : roundUsd(cost),
      })
    )

  const activeAccounts = args.catalog.providers
    .filter((provider) => isActiveAccountProviderId(provider.id))
    .map((provider) => {
      const runsOn = deps.activeAccount(provider.id)
      return {
        providerId: provider.id,
        provider: provider.name,
        runsOn: { providerId: runsOn, provider: nameOf(runsOn) },
      }
    })

  const notes = [
    'estimatedCostUsd uses the cost the runtime reported when there is one and public models.dev API prices otherwise, as Settings → Usage does; it can differ from the invoice. For billing "subscription" it is the API-price equivalent of the tokens, not what the plan charges. null means no public price is known.',
    'turns counts main conversation turns: a model used only by subagents or Maestro workers has tokens and 0 turns.',
    'inCatalog false means the model is not runnable in the live catalog now; never propose it from usage alone.',
    ...(subscriptionQuotas.length
      ? [
          'subscriptionQuotas is a snapshot: usedPercent of each window (five-hour, weekly or other), which starts over at resetsAt.',
        ]
      : []),
    ...(models.length === 0 ? ['No usage was recorded in this period.'] : []),
  ]

  return {
    period: {
      days,
      since: iso(since)!,
      until: iso(until)!,
      firstActivity: iso(stats.firstAt),
      lastActivity: iso(stats.lastAt),
    },
    totals: {
      turns: stats.chatTurns,
      tokens: totalTokens,
      estimatedCostUsd: pricedCosts.length ? roundUsd(pricedCosts.reduce((sum, entry) => sum + entry.cost!, 0)) : null,
      unpricedModels: priced.filter((entry) => entry.cost == null && entry.total > 0).length,
    },
    models: models.slice(0, MAX_MODEL_ROWS),
    ...(models.length > MAX_MODEL_ROWS ? { omittedModels: models.length - MAX_MODEL_ROWS } : {}),
    subscriptionQuotas,
    ...(activeAccounts.length ? { activeAccounts } : {}),
    notes,
  }
}
