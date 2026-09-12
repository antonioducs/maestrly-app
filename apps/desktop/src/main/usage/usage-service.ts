/**
 * On-demand Chat Usage/Costs service backed by the local usage ledger. No boot/background work. Cache
 * snapshots for 60 seconds per period; refresh bypasses cache. Clamp aggregation to
 * USAGE_MAX_WINDOW_DAYS. Ledger data persists; this service holds only ephemeral snapshots.
 */
import type { IpcMainInvokeEvent } from 'electron'
import { aggregateChatUsage } from '../chat/chat-store'
import { USAGE_MAX_WINDOW_DAYS } from '../../shared/usage'
import type { UnifiedUsageStats, UsageModelRow } from '../../shared/usage'

const DAY_MS = 86_400_000
const CACHE_TTL_MS = 60_000

/** Clamp requested dates to the maximum window ending now; missing bounds use that window. */
export function clampUsageRange(
  opts: { since?: number; until?: number } = {},
  now = Date.now()
): { since: number; until: number } {
  const floor = now - USAGE_MAX_WINDOW_DAYS * DAY_MS
  const until = Math.min(typeof opts.until === 'number' ? opts.until : now, now)
  const since = Math.min(Math.max(typeof opts.since === 'number' ? opts.since : floor, floor), until)
  return { since, until }
}

let cache: { key: string; at: number; data: UnifiedUsageStats } | null = null

/** Period snapshot with a 60-second cache; force refresh invalidates it. */
export async function getUnifiedUsage(
  opts: { since?: number; until?: number; force?: boolean } = {}
): Promise<UnifiedUsageStats> {
  const range = clampUsageRange(opts)
  // Daily keys avoid a new cache entry for every millisecond of now.
  const key = `${Math.floor(range.since / DAY_MS)}|${Math.floor(range.until / DAY_MS)}`
  if (!opts.force && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.data

  const rows: UsageModelRow[] = []
  let firstAt: number | null = null
  let lastAt: number | null = null
  let chatTurns = 0

  const mergeBounds = (f: number | null, l: number | null): void => {
    if (f != null) firstAt = firstAt == null ? f : Math.min(firstAt, f)
    if (l != null) lastAt = lastAt == null ? l : Math.max(lastAt, l)
  }

  // Chat usage aggregation is synchronous over the ledger; renderer computes costs from provider/model
  // pricing.
  try {
    const chat = aggregateChatUsage({ since: range.since, until: range.until })
    for (const m of chat.perModel) {
      rows.push({
        source: 'chat',
        providerId: m.providerId,
        modelId: m.modelId,
        input: m.input,
        output: m.output,
        cacheRead: m.cacheRead,
        cacheCreate: m.cacheCreate,
        turns: m.turns,
        costUsd: m.runtimeEstimatedCostUsd ?? null,
        ...(m.runtimeEstimatedCostUsd != null
          ? {
              catalogInput: m.catalogInput ?? 0,
              catalogOutput: m.catalogOutput ?? 0,
              catalogCacheRead: m.catalogCacheRead ?? 0,
              catalogCacheCreate: m.catalogCacheCreate ?? 0,
            }
          : {}),
      })
    }
    chatTurns = chat.totalTurns
    mergeBounds(chat.firstAt, chat.lastAt)
  } catch (err) {
    console.warn('[usage] Chat usage source failed:', (err as Error).message)
  }

  const total = (r: UsageModelRow): number => r.input + r.output + r.cacheRead + r.cacheCreate
  rows.sort((a, b) => total(b) - total(a))

  const data: UnifiedUsageStats = { rows, chatTurns, firstAt, lastAt, generatedAt: Date.now() }
  cache = { key, at: Date.now(), data }
  return data
}

/** Invalidate in-memory cache after billable activity without importing Chat service. */
export function invalidateUnifiedUsageCache(): void {
  cache = null
}

/** Clear cache between tests. */
export function resetUsageCacheForTests(): void {
  invalidateUnifiedUsageCache()
}

export interface UsageIpcDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mhandle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void
}

export function registerUsageIpc(deps: UsageIpcDeps): void {
  deps.mhandle('usage:stats', (_e, opts?: { since?: number; until?: number; force?: boolean }) =>
    getUnifiedUsage({
      since: typeof opts?.since === 'number' ? opts.since : undefined,
      until: typeof opts?.until === 'number' ? opts.until : undefined,
      force: opts?.force === true,
    })
  )
}
