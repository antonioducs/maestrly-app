/** Shared types for subscription account failover (circuit breaker). */

export type SubscriptionFailoverScope = 'root' | 'subagent' | 'helper'
export type SubscriptionAccountHealthState = 'unknown' | 'available' | 'exhausted' | 'half-open'
export type SubscriptionExhaustionSource =
  | 'structured-error'
  | 'rate-limits'
  | 'usage-limit-marker'
  | 'probe'
  | 'model-fallback'

/** Failure kinds with their own cooldown rules (see model-fallback/cooldown-policy). Absent = subscription quota. */
export type CircuitFailureKind =
  | 'quota'
  | 'rate_limit'
  | 'billing'
  | 'auth'
  | 'overloaded'
  | 'server_error'
  | 'timeout'
  | 'model_not_found'

export interface SubscriptionAccountExhaustion {
  resetsAt?: number | null
  nextProbeAt: number
  reason: string
  source: SubscriptionExhaustionSource
  generation: number
  kind?: CircuitFailureKind
}

export interface SubscriptionAccountHealth {
  /** Circuit key: a provider/account id, or `providerId::modelId` for one model on it. */
  providerId: string
  state: SubscriptionAccountHealthState
  exhaustion?: SubscriptionAccountExhaustion
  halfOpenLeaseId?: string
  /** A half-open lease that was never settled stops blocking the circuit at this instant (only when set). */
  halfOpenExpiresAt?: number
}

/** Aliases matching the circuit-breaker plan naming. */
export type AccountHealthState = SubscriptionAccountHealthState
export type ExhaustionSource = SubscriptionExhaustionSource
export type ExhaustionInfo = SubscriptionAccountExhaustion
export type AccountHealth = SubscriptionAccountHealth

export interface AvailabilityLease {
  leaseId: string
  generation: number
}

export type TryAdmitResult = { ok: true; lease?: AvailabilityLease } | { ok: false; reason: string }

export interface MarkExhaustedInfo {
  reason: string
  source: SubscriptionExhaustionSource
  resetsAt?: number | null
  now?: number
  kind?: CircuitFailureKind
  /** Probe instant computed by a cooldown policy; used instead of the default backoff when no reset is known. */
  cooldownUntil?: number
}
