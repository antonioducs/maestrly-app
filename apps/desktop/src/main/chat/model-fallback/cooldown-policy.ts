/**
 * How long a circuit stays open after a failure of each kind. A rate limit follows the provider's own timing
 * exactly and never gets an invented backoff; billing and auth failures escalate, because retrying them early
 * only fails again; transient server trouble backs off briefly.
 */
import type { CircuitFailureKind } from '../subscription-failover/types'
import type { ModelFailureClassification } from './error-classifier'

export type CooldownKind = CircuitFailureKind

export const COOLDOWN_KINDS = [
  'quota',
  'rate_limit',
  'billing',
  'auth',
  'overloaded',
  'server_error',
  'timeout',
  'model_not_found',
] as const satisfies readonly CooldownKind[]

/** Same-kind failure counters reset when the previous failure is older than this (or after a success). */
export const FAILURE_COUNT_WINDOW_MS = 24 * 3_600_000
/** Backoff of a subscription quota without a known reset (mirrors the account router default). */
export const QUOTA_DEFAULT_COOLDOWN_MS = 5 * 60_000

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const ESCALATING: Partial<Record<CooldownKind, { baseMs: number; maxMs: number }>> = {
  billing: { baseMs: 10 * MINUTE, maxMs: 24 * HOUR },
  auth: { baseMs: 10 * MINUTE, maxMs: HOUR },
}

const STEPPED_MS = [30_000, 60_000, 5 * MINUTE] as const

export function isCooldownKind(value: unknown): value is CooldownKind {
  return typeof value === 'string' && (COOLDOWN_KINDS as readonly string[]).includes(value)
}

/** The cooldown kind of a classified failure; null when it must not open any circuit. */
export function cooldownKindFor(classification: Pick<ModelFailureClassification, 'reason'>): CooldownKind | null {
  return isCooldownKind(classification.reason) ? classification.reason : null
}

/**
 * Instant the circuit may be probed again, or null when the failure must not open it (a rate limit without
 * provider timing: the turn moves on, and stickiness keeps it from coming straight back).
 * `count` is the 1-based number of same-kind failures inside the counting window, this one included.
 */
export function computeCooldownUntil(kind: CooldownKind, count: number, now: number, retryAt?: number | null): number | null {
  const announced = typeof retryAt === 'number' && Number.isFinite(retryAt) && retryAt > now ? retryAt : null
  if (kind === 'rate_limit') return announced
  if (kind === 'quota') return announced ?? now + QUOTA_DEFAULT_COOLDOWN_MS
  const n = Math.max(1, Math.floor(count))
  const escalating = ESCALATING[kind]
  const computed = escalating
    ? now + Math.min(escalating.maxMs, escalating.baseMs * 2 ** Math.min(n - 1, 16))
    : now + STEPPED_MS[Math.min(n - 1, STEPPED_MS.length - 1)]!
  return announced != null ? Math.max(announced, computed) : computed
}
