/**
 * Keeps a winning fallback in front for a while after the primary hit a capacity limit, so consecutive turns do
 * not alternate between models (every switch restarts a native session and throws its prompt cache away).
 * In memory only: a restart simply tries the primary again.
 */
import type { ModelFailureReason } from './error-classifier'

/** Reuse within this idle window keeps the winner in front. */
export const STICKY_IDLE_MS = 10 * 60_000
/** Hard cap from the first stick, however often the winner is reused. */
export const STICKY_MAX_MS = 30 * 60_000
const MAX_ENTRIES = 1_024

/** Reasons that make the primary unlikely to recover within minutes. */
const STICKY_REASONS: ReadonlySet<ModelFailureReason> = new Set(['rate_limit', 'quota', 'billing', 'overloaded'])

export interface StickyModelRef {
  providerId: string
  modelId: string
}

interface StickyEntry {
  primaryKey: string
  winner: StickyModelRef
  firstAt: number
  lastUsedAt: number
}

const entries = new Map<string, StickyEntry>()

const refKey = (ref: StickyModelRef): string => `${ref.providerId}::${ref.modelId}`

export function isStickyReason(reason: ModelFailureReason): boolean {
  return STICKY_REASONS.has(reason)
}

/** Records the fallback that served `scope` after `primary` failed for `reason`; other reasons are ignored. */
export function recordStickyWinner(
  scope: string,
  primary: StickyModelRef,
  winner: StickyModelRef,
  reason: ModelFailureReason,
  now = Date.now()
): void {
  if (!scope || !isStickyReason(reason) || refKey(primary) === refKey(winner)) return
  const existing = entries.get(scope)
  const firstAt =
    existing && existing.primaryKey === refKey(primary) && refKey(existing.winner) === refKey(winner)
      ? existing.firstAt
      : now
  entries.delete(scope)
  entries.set(scope, { primaryKey: refKey(primary), winner: { ...winner }, firstAt, lastUsedAt: now })
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!)
}

/** The live sticky winner for `scope` and this primary, or null (expired entries are dropped). */
export function stickyWinner(scope: string, primary: StickyModelRef, now = Date.now()): StickyModelRef | null {
  const entry = entries.get(scope)
  if (!entry) return null
  if (
    entry.primaryKey !== refKey(primary) ||
    now - entry.lastUsedAt > STICKY_IDLE_MS ||
    now - entry.firstAt > STICKY_MAX_MS
  ) {
    entries.delete(scope)
    return null
  }
  return { ...entry.winner }
}

/** The sticky winner served `scope` again: refresh its idle window (the hard cap still counts from the start). */
export function touchStickyWinner(scope: string, winner: StickyModelRef, now = Date.now()): void {
  const entry = entries.get(scope)
  if (entry && refKey(entry.winner) === refKey(winner)) entry.lastUsedAt = now
}

/** Drops the sticky winner of `scope` (it failed, or the scope became strict). */
export function clearStickyWinner(scope: string): void {
  entries.delete(scope)
}

export function resetStickyWinnersForTests(): void {
  entries.clear()
}
