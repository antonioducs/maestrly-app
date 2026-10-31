import { randomUUID } from 'node:crypto'
import { computeCooldownUntil, FAILURE_COUNT_WINDOW_MS } from '../model-fallback/cooldown-policy'
import { failoverDiag } from './diag'
import type {
  AvailabilityLease,
  CircuitFailureKind,
  MarkExhaustedInfo,
  SubscriptionAccountExhaustion,
  SubscriptionAccountHealth,
  TryAdmitResult,
} from './types'

export type {
  AccountHealth,
  AccountHealthState,
  AvailabilityLease,
  ExhaustionInfo,
  MarkExhaustedInfo,
  SubscriptionAccountExhaustion,
  SubscriptionAccountHealth,
  SubscriptionAccountHealthState,
  TryAdmitResult,
} from './types'

/** Default backoff when exhaustion has no known resetsAt (never "forever"). */
export const DEFAULT_PROBE_TTL_MS = 5 * 60_000
/** How long `recoveryAt` gives a half-open probe in flight before its account is checked again. */
export const HALF_OPEN_RECHECK_MS = 30_000

/**
 * How long a caller with no other usable account waits for another caller's half-open probe. A probe closes at
 * its first model output, so this bound only matters for a probe that never answers.
 */
export const HALF_OPEN_PROBE_WAIT_MS = 60_000

/** Chain members that another caller is probing right now; accounts this caller already tried are excluded. */
export function probingCandidates(
  router: SubscriptionFailoverRouter,
  chain: readonly string[],
  attemptedProviderIds: ReadonlySet<string>
): string[] {
  return [...new Set(chain)].filter(
    (providerId) => !attemptedProviderIds.has(providerId) && router.getHealth(providerId).state === 'half-open'
  )
}

function unknownHealth(providerId: string): SubscriptionAccountHealth {
  return { providerId, state: 'unknown' }
}

interface ProbeWaiter {
  providerIds: ReadonlySet<string>
  resolve: (settled: boolean) => void
}

const exhaustedListeners = new Set<(providerId: string) => void>()

/** Called whenever an account's circuit opens; module-level so it survives router resets. */
export function onSubscriptionAccountExhausted(listener: (providerId: string) => void): () => void {
  exhaustedListeners.add(listener)
  return () => {
    exhaustedListeners.delete(listener)
  }
}

interface FailureStats {
  counts: Partial<Record<CircuitFailureKind, number>>
  lastFailureAt: number
}

export interface RecordFailureInfo {
  kind: CircuitFailureKind
  reason: string
  /** Provider-announced instant requests are accepted again. */
  retryAt?: number | null
  now?: number
}

/** Circuit key of one model on a provider/account; `::` never occurs in provider or model ids. */
export function modelCircuitKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

export class SubscriptionFailoverRouter {
  private readonly healthByProvider = new Map<string, SubscriptionAccountHealth>()
  private readonly probeWaiters = new Set<ProbeWaiter>()
  private readonly failureStats = new Map<string, FailureStats>()

  getHealth(providerId: string): SubscriptionAccountHealth {
    return this.healthByProvider.get(providerId) ?? unknownHealth(providerId)
  }

  /** A half-open probe whose lease expired (never settled) no longer blocks the circuit. */
  private expiredHalfOpen(health: SubscriptionAccountHealth, now: number): boolean {
    return health.state === 'half-open' && health.halfOpenExpiresAt !== undefined && now >= health.halfOpenExpiresAt
  }

  /**
   * Opens the circuit of `key` with the cooldown of `info.kind`, escalating with the same-kind failures seen inside
   * the counting window. Returns null when the policy keeps the circuit closed (rate limit without provider timing).
   */
  recordFailure(key: string, info: RecordFailureInfo): SubscriptionAccountHealth | null {
    const now = info.now ?? Date.now()
    const previous = this.failureStats.get(key)
    const stats: FailureStats =
      previous && now - previous.lastFailureAt <= FAILURE_COUNT_WINDOW_MS
        ? previous
        : { counts: {}, lastFailureAt: now }
    const count = (stats.counts[info.kind] ?? 0) + 1
    stats.counts[info.kind] = count
    stats.lastFailureAt = now
    this.failureStats.set(key, stats)
    const until = computeCooldownUntil(info.kind, count, now, info.retryAt)
    failoverDiag('record-failure', { key, kind: info.kind, count, until })
    if (until == null) return null
    // An open circuit with a later probe instant is never shortened by a new, briefer failure.
    const current = this.getHealth(key)
    if (current.state === 'exhausted' && (current.exhaustion?.nextProbeAt ?? 0) > until) return current
    return this.markExhausted(key, {
      reason: info.reason,
      source: 'model-fallback',
      kind: info.kind,
      ...(info.kind === 'quota' && info.retryAt != null ? { resetsAt: info.retryAt } : {}),
      cooldownUntil: until,
      now,
    })
  }

  /** Same-kind failure count of `key` inside the counting window (diagnostics and tests). */
  failureCount(key: string, kind: CircuitFailureKind, now = Date.now()): number {
    const stats = this.failureStats.get(key)
    if (!stats || now - stats.lastFailureAt > FAILURE_COUNT_WINDOW_MS) return 0
    return stats.counts[kind] ?? 0
  }

  private store(health: SubscriptionAccountHealth): void {
    this.healthByProvider.set(health.providerId, health)
    this.wakeProbeWaiters(health.providerId)
  }

  private wakeProbeWaiters(providerId: string): void {
    if (this.getHealth(providerId).state === 'half-open') return
    for (const waiter of [...this.probeWaiters]) {
      if (waiter.providerIds.has(providerId)) waiter.resolve(true)
    }
  }

  /**
   * Waits until one of the providers leaves its half-open probe (recovered, exhausted again, or released).
   * Resolves false on timeout or abort; true immediately when none of them is half-open.
   */
  waitForProbeSettlement(providerIds: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const watched = new Set(providerIds)
    if (![...watched].some((id) => this.getHealth(id).state === 'half-open')) return Promise.resolve(true)
    if (signal?.aborted || timeoutMs <= 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const waiter: ProbeWaiter = {
        providerIds: watched,
        resolve: (settled) => {
          if (!this.probeWaiters.delete(waiter)) return
          if (timer) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(settled)
        },
      }
      const onAbort = () => waiter.resolve(false)
      this.probeWaiters.add(waiter)
      timer = setTimeout(() => waiter.resolve(false), timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Model output observed on a physical account proves it is serving again. A half-open probe therefore closes
   * its circuit at the first output instead of when its (possibly long) turn ends, which would keep every other
   * caller off a recovered account. The probe's own settlement still applies afterwards: a later quota reopens
   * the circuit, success/other become no-ops. Outside half-open the signal is ignored, because an exhausted
   * circuit may still be draining output from requests admitted before the exhaustion.
   */
  confirmServing(providerId: string): void {
    const current = this.getHealth(providerId)
    if (current.state !== 'half-open') return
    failoverDiag('half-open-serving', {
      providerId,
      leaseId: current.halfOpenLeaseId ?? null,
      generation: current.exhaustion?.generation ?? null,
    })
    this.markAvailable(providerId, { generation: current.exhaustion?.generation })
  }

  /**
   * Immediately open the circuit. Always sets nextProbeAt (a future resetsAt when known, else now+TTL).
   * A finite reset at or before this observation is stale and falls back to the default backoff.
   * Bumps generation so in-flight successes from before this exhaustion cannot re-close the circuit.
   */
  markExhausted(providerId: string, info: MarkExhaustedInfo): SubscriptionAccountHealth {
    const now = info.now ?? Date.now()
    const previous = this.getHealth(providerId)
    const previousGeneration = previous.exhaustion?.generation ?? 0
    const generation = previousGeneration + 1
    const resetsAt = info.resetsAt === undefined ? undefined : info.resetsAt
    const nextProbeAt =
      typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > now
        ? resetsAt
        : typeof info.cooldownUntil === 'number' && Number.isFinite(info.cooldownUntil) && info.cooldownUntil > now
          ? info.cooldownUntil
          : now + DEFAULT_PROBE_TTL_MS

    const exhaustion: SubscriptionAccountExhaustion = {
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      nextProbeAt,
      reason: info.reason,
      source: info.source,
      generation,
      ...(info.kind ? { kind: info.kind } : {}),
    }

    const health: SubscriptionAccountHealth = {
      providerId,
      state: 'exhausted',
      exhaustion,
    }
    this.store(health)
    failoverDiag('mark-exhausted', {
      providerId,
      generation,
      nextProbeAt,
      resetsAt: resetsAt ?? null,
      source: info.source,
      reason: info.reason,
    })
    for (const listener of [...exhaustedListeners]) {
      try {
        listener(providerId)
      } catch {
        // A policy listener must not break circuit bookkeeping.
      }
    }
    return health
  }

  /**
   * Close the circuit only when generation is unspecified (explicit clear of non-open state) or
   * matches the current exhaustion generation. Stale successes must not clear a newer exhaustion.
   */
  markAvailable(providerId: string, opts?: { generation?: number; now?: number }): SubscriptionAccountHealth {
    void opts?.now
    const current = this.getHealth(providerId)

    if (opts?.generation !== undefined) {
      const currentGeneration = current.exhaustion?.generation
      if (currentGeneration !== undefined && currentGeneration !== opts.generation) {
        failoverDiag('mark-available-stale', {
          providerId,
          offeredGeneration: opts.generation,
          currentGeneration,
          state: current.state,
        })
        return current
      }
    } else if (current.state === 'exhausted' || current.state === 'half-open') {
      // Without a generation, refuse to clear an open/half-open circuit (race with newer quota).
      failoverDiag('mark-available-refused', { providerId, state: current.state })
      return current
    }

    const health: SubscriptionAccountHealth = { providerId, state: 'available' }
    this.store(health)
    this.failureStats.delete(providerId)
    failoverDiag('mark-available', {
      providerId,
      generation: opts?.generation ?? null,
      previousState: current.state,
    })
    return health
  }

  /**
   * Singleflight half-open probe. When exhausted and due, transitions to half-open with one lease.
   * Already half-open → deny. available/unknown → allow without lease.
   */
  beginHalfOpenProbe(
    providerId: string,
    now = Date.now(),
    opts?: { leaseTtlMs?: number }
  ): { allowed: boolean; leaseId?: string; generation?: number } {
    const current = this.getHealth(providerId)

    if (current.state === 'available' || current.state === 'unknown') {
      return { allowed: true }
    }

    if (current.state === 'half-open' && !this.expiredHalfOpen(current, now)) {
      return { allowed: false }
    }

    const nextProbeAt = current.exhaustion?.nextProbeAt ?? 0
    if (now < nextProbeAt) {
      return { allowed: false }
    }

    const generation = current.exhaustion!.generation
    const leaseId = randomUUID()
    const leaseTtlMs = opts?.leaseTtlMs
    const health: SubscriptionAccountHealth = {
      providerId,
      state: 'half-open',
      exhaustion: current.exhaustion,
      halfOpenLeaseId: leaseId,
      ...(typeof leaseTtlMs === 'number' && leaseTtlMs > 0 ? { halfOpenExpiresAt: now + leaseTtlMs } : {}),
    }
    this.store(health)
    failoverDiag('half-open-begin', { providerId, leaseId, generation, now })
    return { allowed: true, leaseId, generation }
  }

  releaseHalfOpenProbe(
    providerId: string,
    leaseId: string,
    result: 'success' | 'quota' | 'other',
    exhaustionInfo?: Omit<MarkExhaustedInfo, 'now'> & { now?: number }
  ): void {
    const current = this.getHealth(providerId)
    if (current.state !== 'half-open' || current.halfOpenLeaseId !== leaseId) {
      failoverDiag('half-open-release-stale', {
        providerId,
        leaseId,
        state: current.state,
        result,
      })
      return
    }

    if (result === 'success') {
      this.markAvailable(providerId, { generation: current.exhaustion?.generation })
      return
    }

    if (result === 'quota') {
      this.markExhausted(providerId, {
        reason: exhaustionInfo?.reason ?? 'quota during half-open probe',
        source: exhaustionInfo?.source ?? 'probe',
        resetsAt: exhaustionInfo?.resetsAt,
        now: exhaustionInfo?.now,
      })
      return
    }

    // A non-quota result only releases the singleflight lease. Restore the exhausted snapshot that
    // admitted this probe; creating a new exhaustion would extend a cooldown for an account that did
    // not prove a new quota failure.
    const health: SubscriptionAccountHealth = {
      providerId,
      state: 'exhausted',
      exhaustion: current.exhaustion,
    }
    this.store(health)
    failoverDiag('half-open-release-other', {
      providerId,
      leaseId,
      generation: current.exhaustion?.generation ?? null,
      nextProbeAt: current.exhaustion?.nextProbeAt ?? null,
    })
  }

  /**
   * True when the provider is not hard-blocked. Does NOT consume a half-open lease.
   * Hard-blocked = exhausted && now < nextProbeAt. Half-open without a lease is not admissible.
   */
  isAdmissible(providerId: string, now = Date.now()): boolean {
    const current = this.getHealth(providerId)
    if (current.state === 'available' || current.state === 'unknown') return true
    if (current.state === 'half-open') return this.expiredHalfOpen(current, now)
    const nextProbeAt = current.exhaustion?.nextProbeAt ?? 0
    return now >= nextProbeAt
  }

  /**
   * Admit an attempt: available/unknown without lease; exhausted-due → half-open lease (singleflight).
   * `leaseTtlMs` bounds a lease whose holder might never settle it (model circuits); account leases have none.
   */
  tryAdmit(providerId: string, now = Date.now(), opts?: { leaseTtlMs?: number }): TryAdmitResult {
    const current = this.getHealth(providerId)

    if (current.state === 'available' || current.state === 'unknown') {
      return { ok: true }
    }

    if (current.state === 'half-open' && !this.expiredHalfOpen(current, now)) {
      return { ok: false, reason: 'half-open-probe-in-flight' }
    }

    const nextProbeAt = current.exhaustion?.nextProbeAt ?? 0
    if (now < nextProbeAt) {
      return { ok: false, reason: 'exhausted-backoff' }
    }

    const probe = this.beginHalfOpenProbe(providerId, now, opts)
    if (!probe.allowed || !probe.leaseId || probe.generation === undefined) {
      return { ok: false, reason: 'half-open-probe-denied' }
    }

    return { ok: true, lease: { leaseId: probe.leaseId, generation: probe.generation } }
  }

  confirmAttemptSuccess(providerId: string, lease?: AvailabilityLease): void {
    if (lease) {
      const current = this.getHealth(providerId)
      if (current.state === 'half-open') {
        if (current.halfOpenLeaseId !== lease.leaseId || current.exhaustion?.generation !== lease.generation) {
          failoverDiag('confirm-success-stale-lease', {
            providerId,
            leaseId: lease.leaseId,
            generation: lease.generation,
          })
          return
        }
        this.releaseHalfOpenProbe(providerId, lease.leaseId, 'success')
        return
      }
      this.markAvailable(providerId, { generation: lease.generation })
      return
    }

    const current = this.getHealth(providerId)
    if (current.state === 'exhausted' || current.state === 'half-open') {
      failoverDiag('confirm-success-ignored-open-circuit', {
        providerId,
        state: current.state,
      })
      return
    }
    this.markAvailable(providerId)
  }

  confirmAttemptQuota(
    providerId: string,
    lease: AvailabilityLease | undefined,
    exhaustionInfo: MarkExhaustedInfo
  ): void {
    if (lease) {
      const current = this.getHealth(providerId)
      if (
        current.state === 'half-open' &&
        current.halfOpenLeaseId === lease.leaseId &&
        current.exhaustion?.generation === lease.generation
      ) {
        this.releaseHalfOpenProbe(providerId, lease.leaseId, 'quota', exhaustionInfo)
        return
      }
    }
    // Quota always opens the circuit before any slow refresh.
    this.markExhausted(providerId, exhaustionInfo)
  }

  /**
   * Settle a half-open probe that ended without proving quota or availability.
   * Ordinary attempts must not change circuit state on a common error.
   */
  confirmAttemptOther(providerId: string, lease?: AvailabilityLease): void {
    if (!lease) return

    const current = this.getHealth(providerId)
    if (
      current.state === 'half-open' &&
      current.halfOpenLeaseId === lease.leaseId &&
      current.exhaustion?.generation === lease.generation
    ) {
      this.releaseHalfOpenProbe(providerId, lease.leaseId, 'other')
      return
    }

    failoverDiag('confirm-other-stale-lease', {
      providerId,
      leaseId: lease.leaseId,
      generation: lease.generation,
      state: current.state,
    })
  }

  /**
   * The earliest time an account of `chain` may be admitted again: `now` when one already may. An account whose
   * half-open probe is in flight is checked again `HALF_OPEN_RECHECK_MS` later, when that probe has likely settled.
   */
  recoveryAt(chain: readonly string[], now = Date.now()): number {
    let earliest = Number.POSITIVE_INFINITY
    for (const providerId of chain) {
      const current = this.getHealth(providerId)
      if (current.state === 'available' || current.state === 'unknown') return now
      const at = current.state === 'half-open' ? now + HALF_OPEN_RECHECK_MS : (current.exhaustion?.nextProbeAt ?? now)
      earliest = Math.min(earliest, Math.max(now, at))
    }
    return Number.isFinite(earliest) ? earliest : now
  }

  /** Forget the circuit state for one physical provider after its identity has been drained. */
  resetProvider(providerId: string): void {
    this.healthByProvider.delete(providerId)
    this.failureStats.delete(providerId)
    this.wakeProbeWaiters(providerId)
  }

  /**
   * Walk the failover chain, skipping attempted / non-admissible / ineligible candidates.
   * Does not consume a half-open lease — caller must tryAdmit before executing.
   */
  async selectNextProviderId(
    chain: readonly string[],
    attempted: ReadonlySet<string>,
    isCandidateEligible: (id: string) => boolean | Promise<boolean>,
    now = Date.now()
  ): Promise<string | null> {
    for (const providerId of chain) {
      if (attempted.has(providerId)) continue
      if (!this.isAdmissible(providerId, now)) continue
      const eligible = await isCandidateEligible(providerId)
      if (!eligible) continue
      return providerId
    }
    return null
  }

  /** Test helper — wipe all health state. */
  reset(): void {
    this.healthByProvider.clear()
    this.failureStats.clear()
    for (const waiter of [...this.probeWaiters]) waiter.resolve(true)
  }
}

let singleton: SubscriptionFailoverRouter | null = null

export function getSubscriptionFailoverRouter(): SubscriptionFailoverRouter {
  if (!singleton) singleton = new SubscriptionFailoverRouter()
  return singleton
}

export function resetSubscriptionFailoverRouterForTests(): void {
  singleton?.reset()
  singleton = null
}
