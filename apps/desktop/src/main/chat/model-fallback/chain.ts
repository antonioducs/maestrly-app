/**
 * The model fallback chain of one execution: the selection it started with, then the configured fallbacks, frozen
 * at its start. Candidates are admitted against the shared failover router (a model circuit, plus the account
 * circuit or, for Claude/Codex subscriptions, their own account chain), reordered by context fit after an
 * overflow, and their outcomes settle those circuits.
 */
import { isSubscriptionFailoverProviderId, type ChatModelFallbackConfigV1 } from '../../../shared/chat'
import type { SubscriptionFailoverRouter } from '../subscription-failover/router'
import { modelCircuitKey } from '../subscription-failover/router'
import type { AvailabilityLease } from '../subscription-failover/types'
import { cooldownKindFor } from './cooldown-policy'
import type { ModelFailureClassification, ModelFailureReason } from './error-classifier'
import { clearStickyWinner, recordStickyWinner, stickyWinner, touchStickyWinner, type StickyModelRef } from './sticky'

/** Most model switches one execution makes before giving up. */
export const MAX_MODEL_SWITCHES = 4

export interface ModelCandidate {
  providerId: string
  modelId: string
  reasoning?: string
  fastMode?: boolean
  /** The selection the execution started with: its effort and Fast mode come from its own settings. */
  primary?: boolean
}

export interface FreezeModelChainInput {
  primary: { providerId: string; modelId: string }
  config: ChatModelFallbackConfigV1
  /** Pinned conversation, frozen or isolated execution: only the primary may run. */
  strict?: boolean
  /** Whether a provider can run at all (exists, allowed by the autonomous/remote policy). */
  isProviderUsable?: (providerId: string) => boolean
  /** Sticky scope; when set, a live sticky winner runs first and the primary second. */
  stickyScope?: string
  now?: number
}

export const candidateKey = (candidate: StickyModelRef): string =>
  modelCircuitKey(candidate.providerId, candidate.modelId)

function sameModel(a: StickyModelRef, b: StickyModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId
}

/** [primary, ...fallbacks] for one execution; a single entry when fallback does not apply. */
export function freezeModelChain(input: FreezeModelChainInput): ModelCandidate[] {
  const primary: ModelCandidate = {
    providerId: input.primary.providerId,
    modelId: input.primary.modelId,
    primary: true,
  }
  if (input.strict || !input.config.enabled || input.config.fallbacks.length === 0) return [primary]
  const usable = input.isProviderUsable ?? (() => true)
  const chain: ModelCandidate[] = [primary]
  for (const fallback of input.config.fallbacks) {
    if (sameModel(fallback, primary) || chain.some((entry) => sameModel(entry, fallback))) continue
    if (!usable(fallback.providerId)) continue
    chain.push({
      providerId: fallback.providerId,
      modelId: fallback.modelId,
      ...(fallback.reasoning ? { reasoning: fallback.reasoning } : {}),
      ...(fallback.fastMode ? { fastMode: true } : {}),
    })
  }
  if (chain.length === 1 || !input.stickyScope) return chain
  const winner = stickyWinner(input.stickyScope, primary, input.now)
  const index = winner ? chain.findIndex((entry) => sameModel(entry, winner)) : -1
  if (index <= 0) return chain
  return [chain[index]!, ...chain.filter((_, position) => position !== index)]
}

export interface CandidateAdmissionDeps {
  router: SubscriptionFailoverRouter
  /** Physical accounts of a Claude/Codex subscription provider (its account failover chain). */
  accountChainOf: (providerId: string) => readonly string[]
  now?: number
}

/** Whether `candidate` may run now: its model circuit and its account(s) are not cooling down. */
export function isCandidateAdmissible(candidate: ModelCandidate, deps: CandidateAdmissionDeps): boolean {
  const now = deps.now ?? Date.now()
  if (!deps.router.isAdmissible(candidateKey(candidate), now)) return false
  if (isSubscriptionFailoverProviderId(candidate.providerId)) {
    // The account layer owns these circuits; it also waits for a half-open probe instead of failing.
    const accounts = deps.accountChainOf(candidate.providerId)
    const chain = accounts.length ? accounts : [candidate.providerId]
    return chain.some(
      (providerId) =>
        deps.router.isAdmissible(providerId, now) || deps.router.getHealth(providerId).state === 'half-open'
    )
  }
  return deps.router.isAdmissible(candidate.providerId, now)
}

/**
 * Stable context-fit order after an overflow: candidates whose known window holds `requiredTokens` first, then those
 * with an unknown window, then those known to be smaller (still eligible: compaction may make room).
 */
export async function orderByContextFit<T extends ModelCandidate>(
  candidates: readonly T[],
  requiredTokens: number | undefined,
  windowOf: (candidate: T) => Promise<number | undefined>
): Promise<T[]> {
  if (!requiredTokens || requiredTokens <= 0 || candidates.length < 2) return [...candidates]
  const fits: T[] = []
  const unknown: T[] = []
  const small: T[] = []
  for (const candidate of candidates) {
    const window = await windowOf(candidate).catch(() => undefined)
    if (!window || window <= 0) unknown.push(candidate)
    else if (window >= requiredTokens) fits.push(candidate)
    else small.push(candidate)
  }
  return [...fits, ...unknown, ...small]
}

/** Tokens a candidate must hold after an overflow: the provider's count, else just past the failed window. */
export function requiredTokensAfterOverflow(
  classification: Pick<ModelFailureClassification, 'observedTokens' | 'contextLimit'>,
  failedWindow?: number
): number | undefined {
  if (classification.observedTokens) return classification.observedTokens
  const window = classification.contextLimit ?? failedWindow
  return window ? window + 1 : undefined
}

export interface SelectNextCandidateInput extends CandidateAdmissionDeps {
  chain: readonly ModelCandidate[]
  attempted: ReadonlySet<string>
  requiredTokens?: number
  windowOf?: (candidate: ModelCandidate) => Promise<number | undefined>
}

/** First admissible, not yet attempted candidate in chain order; null when none. */
export function firstAdmissibleCandidate(
  input: Omit<SelectNextCandidateInput, 'requiredTokens' | 'windowOf'>
): ModelCandidate | null {
  return (
    input.chain.find(
      (candidate) => !input.attempted.has(candidateKey(candidate)) && isCandidateAdmissible(candidate, input)
    ) ?? null
  )
}

/** First admissible, not yet attempted candidate (context-fit ordered after an overflow); null when none. */
export async function selectNextCandidate(input: SelectNextCandidateInput): Promise<ModelCandidate | null> {
  if (!input.requiredTokens || !input.windowOf) return firstAdmissibleCandidate(input)
  const remaining = input.chain.filter((candidate) => !input.attempted.has(candidateKey(candidate)))
  const ordered = await orderByContextFit(remaining, input.requiredTokens, input.windowOf)
  return ordered.find((candidate) => isCandidateAdmissible(candidate, input)) ?? null
}

/** A model circuit whose cooldown was due is probed by one caller at a time; an unsettled lease lapses after this. */
export const MODEL_PROBE_LEASE_TTL_MS = 10 * 60_000

export interface CandidateLease {
  key: string
  lease: AvailabilityLease
}

/** Takes the attempt slot of `candidate`'s model circuit: a half-open lease when its cooldown was due. */
export function admitCandidate(
  router: SubscriptionFailoverRouter,
  candidate: ModelCandidate,
  now = Date.now()
): { ok: true; lease?: CandidateLease } | { ok: false } {
  const key = candidateKey(candidate)
  const admission = router.tryAdmit(key, now, { leaseTtlMs: MODEL_PROBE_LEASE_TTL_MS })
  if (!admission.ok) return { ok: false }
  return admission.lease ? { ok: true, lease: { key, lease: admission.lease } } : { ok: true }
}

/** Opens the circuit the failure blames. Subscription accounts are settled by their own account layer. */
export function recordCandidateFailure(
  router: SubscriptionFailoverRouter,
  candidate: ModelCandidate,
  classification: ModelFailureClassification,
  lease?: CandidateLease,
  now = Date.now()
): void {
  const kind = cooldownKindFor(classification)
  const modelBlamed = kind != null && classification.scope === 'model'
  if (lease && !modelBlamed) router.confirmAttemptOther(lease.key, lease.lease)
  if (!kind) return
  const info = { kind, reason: classification.reason, retryAt: classification.retryAt, now }
  if (classification.scope === 'account') {
    if (!isSubscriptionFailoverProviderId(candidate.providerId)) router.recordFailure(candidate.providerId, info)
    return
  }
  router.recordFailure(candidateKey(candidate), info)
}

/** Closes a circuit that was admitted because its cooldown was due, now that a call succeeded on it. */
function closeDueCircuit(router: SubscriptionFailoverRouter, key: string, now: number): void {
  const health = router.getHealth(key)
  if (health.state === 'exhausted' && health.exhaustion && now >= health.exhaustion.nextProbeAt) {
    router.markAvailable(key, { generation: health.exhaustion.generation })
    return
  }
  if (health.state === 'available' || health.state === 'unknown') router.confirmAttemptSuccess(key)
}

export function recordCandidateSuccess(
  router: SubscriptionFailoverRouter,
  candidate: ModelCandidate,
  lease?: CandidateLease,
  now = Date.now()
): void {
  if (lease) router.confirmAttemptSuccess(lease.key, lease.lease)
  else closeDueCircuit(router, candidateKey(candidate), now)
  if (!isSubscriptionFailoverProviderId(candidate.providerId)) closeDueCircuit(router, candidate.providerId, now)
}

/** Releases an attempt slot without blaming anyone (abort, cancelled admission). */
export function releaseCandidate(router: SubscriptionFailoverRouter, lease?: CandidateLease): void {
  if (lease) router.confirmAttemptOther(lease.key, lease.lease)
}

/**
 * Sticky bookkeeping once an execution settles. A fallback that served after the primary failed for a capacity
 * reason stays in front; a sticky winner that served again refreshes its idle window; one that failed is dropped.
 */
export function settleSticky(input: {
  scope: string | undefined
  chain: readonly ModelCandidate[]
  served: ModelCandidate | null
  failed: readonly ModelCandidate[]
  primaryFailureReason?: ModelFailureReason
  now?: number
}): void {
  if (!input.scope) return
  const primary = input.chain.find((candidate) => candidate.primary) ?? input.chain[0]
  if (!primary) return
  const now = input.now ?? Date.now()
  const winner = stickyWinner(input.scope, primary, now)
  if (winner && input.failed.some((candidate) => sameModel(candidate, winner))) clearStickyWinner(input.scope)
  if (!input.served || input.served.primary) return
  if (winner && sameModel(winner, input.served)) {
    touchStickyWinner(input.scope, input.served, now)
    return
  }
  if (input.primaryFailureReason)
    recordStickyWinner(input.scope, primary, input.served, input.primaryFailureReason, now)
}
