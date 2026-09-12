/** Shared types for subscription account failover (circuit breaker). */

export type SubscriptionFailoverScope = 'root' | 'subagent' | 'helper'
export type SubscriptionAccountHealthState = 'unknown' | 'available' | 'exhausted' | 'half-open'
export type SubscriptionExhaustionSource = 'structured-error' | 'rate-limits' | 'usage-limit-marker' | 'probe'

export interface SubscriptionAccountExhaustion {
  resetsAt?: number | null
  nextProbeAt: number
  reason: string
  source: SubscriptionExhaustionSource
  generation: number
}

export interface SubscriptionAccountHealth {
  providerId: string
  state: SubscriptionAccountHealthState
  exhaustion?: SubscriptionAccountExhaustion
  halfOpenLeaseId?: string
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
}
