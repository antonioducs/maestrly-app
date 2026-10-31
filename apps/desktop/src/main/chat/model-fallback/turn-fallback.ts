/**
 * Model fallback of a conversation turn. The chain is frozen when the person's turn starts and travels with its
 * host continuations. The turn starts on the first admissible candidate (a sticky winner, else the primary);
 * when admission fails for lack of a usable account, the next candidate is admitted instead; when the turn fails
 * with a reason another model can fix, the host continues the same turn on the next candidate in a new bubble.
 * The conversation's own selection is never written: the next turn starts from the primary again.
 */
import type { ChatSubscriptionFailoverEvent } from '../../../shared/chat'
import {
  admitCandidate,
  candidateKey,
  firstAdmissibleCandidate,
  freezeModelChain,
  MAX_MODEL_SWITCHES,
  recordCandidateFailure,
  recordCandidateSuccess,
  releaseCandidate,
  requiredTokensAfterOverflow,
  selectNextCandidate,
  settleSticky,
  transitionEvent,
  type CandidateLease,
  type ModelCandidate,
} from './chain'

export { transitionEvent }
import type { ModelFailureClassification, ModelFailureReason } from './error-classifier'
import { defaultModelFallbackDeps, isModelFallbackPinned, type ModelFallbackDeps } from './run-with-fallback'

/** Hidden prompt of the continuation that resumes a failed turn on the next model. */
export const MODEL_FALLBACK_CONTINUE_PROMPT =
  'Continue the same assistant turn: the previous model stopped before finishing. Do not repeat completed work, ' +
  'tool calls that already ran, or prior progress updates.'

/** Admission failures that mean "this provider cannot run now", so another candidate may. */
const ADMISSION_FALLBACK_ERRORS = new Set([
  'claude-accounts-exhausted',
  'codex-accounts-exhausted',
  'unavailable',
  'no-key',
])

export interface RootModelFallbackState {
  readonly conversationId: string
  readonly scope: string
  readonly chain: readonly ModelCandidate[]
  readonly attempted: readonly string[]
  readonly failed: readonly ModelCandidate[]
  readonly switches: number
  readonly current: ModelCandidate
  readonly primaryFailureReason?: ModelFailureReason
  /** The same model already got its one retry after revealing a smaller context window. */
  readonly sameModelRetryUsed?: boolean
  /** Model-circuit probe slot held by the current attempt. */
  lease?: CandidateLease
}

export interface RootFallbackDeps extends ModelFallbackDeps {
  /** Context window of a candidate as preflight would see it (manual and learned limits included). */
  windowOf: (candidate: ModelCandidate) => Promise<number | undefined>
  /** Persists a limit the provider revealed, so preflight compacts the next attempt (only lower values are kept). */
  learnContextLimit?: (candidate: ModelCandidate, limit: number) => void
}

function withDefaults(deps?: Partial<RootFallbackDeps>): RootFallbackDeps {
  return { windowOf: async () => undefined, ...defaultModelFallbackDeps, ...deps }
}

export function rootFallbackScope(conversationId: string): string {
  return `conv:${conversationId}`
}

/**
 * Freezes the chain of a person's turn. Null when the turn must stay on its selection: fallback disabled or empty,
 * a pinned conversation, or a strict (frozen/isolated) execution.
 */
export async function beginRootModelFallback(input: {
  conversationId: string
  primary: { providerId: string; modelId: string }
  strict?: boolean
  deps?: Partial<RootFallbackDeps>
}): Promise<RootModelFallbackState | null> {
  if (!input.primary.providerId) return null
  const deps = withDefaults(input.deps)
  const scope = rootFallbackScope(input.conversationId)
  const now = deps.now()
  const chain = freezeModelChain({
    primary: input.primary,
    config: deps.config(),
    strict: input.strict === true || isModelFallbackPinned(input.conversationId),
    isProviderUsable: (providerId) => deps.isProviderUsable(providerId, input.conversationId),
    stickyScope: scope,
    now,
  })
  if (chain.length < 2) return null
  const current =
    (await selectNextCandidate({
      router: deps.router(),
      accountChainOf: deps.accountChainOf,
      chain,
      attempted: new Set(),
      now,
    })) ?? chain[0]!
  return { conversationId: input.conversationId, scope, chain, attempted: [], failed: [], switches: 0, current }
}

/** Selection the attempt runs on, when it is not the conversation's own. */
export function fallbackSelectionOverride(
  state: RootModelFallbackState | undefined
): { providerId: string; modelId: string } | null {
  if (!state || state.current.primary) return null
  return { providerId: state.current.providerId, modelId: state.current.modelId }
}

/** Effort and Fast mode of a fallback candidate (its own, never the primary's); null for the primary. */
export function fallbackAxes(
  state: RootModelFallbackState | undefined
): { reasoning?: string; fastMode: boolean } | null {
  if (!state || state.current.primary) return null
  return {
    ...(state.current.reasoning ? { reasoning: state.current.reasoning } : {}),
    fastMode: state.current.fastMode === true,
  }
}

/** Takes the model-circuit slot of the current candidate before its attempt. */
export function admitRootCandidate(state: RootModelFallbackState, deps?: Partial<RootFallbackDeps>): void {
  const resolved = withDefaults(deps)
  const slot = admitCandidate(resolved.router(), state.current, resolved.now())
  state.lease = slot.ok ? slot.lease : undefined
}

function advance(
  state: RootModelFallbackState,
  next: ModelCandidate,
  failed: ModelCandidate | null,
  extra: Partial<RootModelFallbackState> = {}
): RootModelFallbackState {
  return {
    ...state,
    attempted: [...state.attempted, candidateKey(state.current)],
    failed: failed ? [...state.failed, failed] : state.failed,
    switches: state.switches + 1,
    current: next,
    lease: undefined,
    ...extra,
  }
}

/** After an admission failure: the state of the next candidate to admit, or null to report the failure. */
export async function nextAfterAdmissionFailure(
  state: RootModelFallbackState,
  error: string | undefined,
  deps?: Partial<RootFallbackDeps>
): Promise<RootModelFallbackState | null> {
  const resolved = withDefaults(deps)
  const router = resolved.router()
  releaseCandidate(router, state.lease)
  state.lease = undefined
  if (!error || !ADMISSION_FALLBACK_ERRORS.has(error) || state.switches >= MAX_MODEL_SWITCHES) return null
  const attempted = new Set([...state.attempted, candidateKey(state.current)])
  const next = await selectNextCandidate({
    router,
    accountChainOf: resolved.accountChainOf,
    chain: state.chain,
    attempted,
    now: resolved.now(),
  })
  if (!next) return null
  const quota = error.endsWith('-accounts-exhausted')
  return advance(state, next, state.current, {
    ...(state.current.primary && !state.primaryFailureReason && quota
      ? { primaryFailureReason: 'quota' as const }
      : {}),
  })
}

/** Whether a fallback is waiting, so a long provider wait should end the attempt instead of sleeping in place. */
export function hasNextCandidate(state: RootModelFallbackState, deps?: Partial<RootFallbackDeps>): boolean {
  const resolved = withDefaults(deps)
  if (state.switches >= MAX_MODEL_SWITCHES) return false
  return (
    firstAdmissibleCandidate({
      router: resolved.router(),
      accountChainOf: resolved.accountChainOf,
      chain: state.chain,
      attempted: new Set([...state.attempted, candidateKey(state.current)]),
      now: resolved.now(),
    }) != null
  )
}

/** In-place retry gate of the current attempt (see `retryInPlaceAllowed`). */
export function shouldRetryInPlaceFor(
  state: RootModelFallbackState,
  error: unknown,
  deps?: Partial<RootFallbackDeps>
): boolean {
  const resolved = withDefaults(deps)
  const classification = resolved.classify(error)
  return retryInPlaceAllowed(classification, hasNextCandidate(state, deps), resolved.now())
}

/** Provider waits beyond this switch models instead of sleeping in place. */
export const SWITCH_INSTEAD_OF_WAIT_MS = 60_000

/** In-place retry gate: false when a fallback waits and the provider asked for a long wait (or has no quota). */
export function retryInPlaceAllowed(
  classification: ModelFailureClassification,
  fallbackAvailable: boolean,
  now = Date.now()
): boolean {
  if (!fallbackAvailable || !classification.fallback) return true
  if (classification.reason === 'quota' || classification.reason === 'billing') return false
  return classification.retryAt == null || classification.retryAt - now <= SWITCH_INSTEAD_OF_WAIT_MS
}

export interface FallbackContinuation {
  state: RootModelFallbackState
  classification: ModelFailureClassification
  event: ChatSubscriptionFailoverEvent
}

/**
 * After a turn failed: records the failure on its circuits, then picks where the same turn continues. Null when the
 * failure is not one another model can fix, the chain is spent, or the turn was cancelled or submitted a plan.
 */
export async function continuationAfterFailure(
  state: RootModelFallbackState,
  failure: unknown,
  context: { aborted: boolean; planSubmitted: boolean; failedWindow?: number },
  deps?: Partial<RootFallbackDeps>
): Promise<FallbackContinuation | null> {
  const resolved = withDefaults(deps)
  const router = resolved.router()
  const now = resolved.now()
  if (context.aborted) {
    releaseCandidate(router, state.lease)
    state.lease = undefined
    return null
  }
  const classification = resolved.classify(failure)
  recordCandidateFailure(router, state.current, classification, state.lease, now)
  state.lease = undefined
  if (context.planSubmitted || !classification.fallback) return null

  // The provider revealed a smaller window than Maestrly knew: compact on the same model once before moving on.
  if (
    classification.compact &&
    classification.contextLimit &&
    resolved.learnContextLimit &&
    !state.sameModelRetryUsed &&
    (context.failedWindow == null || classification.contextLimit < context.failedWindow)
  ) {
    resolved.learnContextLimit(state.current, classification.contextLimit)
    const next = { ...state, sameModelRetryUsed: true, lease: undefined }
    return { state: next, classification, event: transitionEvent(state.current, state.current, classification) }
  }
  if (state.switches >= MAX_MODEL_SWITCHES) return null
  const attempted = new Set([...state.attempted, candidateKey(state.current)])
  const candidate = await selectNextCandidate({
    router,
    accountChainOf: resolved.accountChainOf,
    chain: state.chain,
    attempted,
    now: resolved.now(),
    ...(classification.compact
      ? {
          requiredTokens: requiredTokensAfterOverflow(classification, context.failedWindow),
          windowOf: resolved.windowOf,
        }
      : {}),
  })
  if (!candidate) return null
  const next = advance(state, candidate, state.current, {
    ...(state.current.primary && !state.primaryFailureReason ? { primaryFailureReason: classification.reason } : {}),
  })
  return { state: next, classification, event: transitionEvent(state.current, candidate, classification) }
}

/**
 * The notice for a turn that starts on a fallback because the primary is cooling down (not for a sticky winner,
 * which the chain put in front on purpose). Null when the turn starts on the primary.
 */
export function startedOffPrimaryEvent(
  state: RootModelFallbackState,
  deps?: Partial<RootFallbackDeps>
): ChatSubscriptionFailoverEvent | null {
  const primary = state.chain[0]
  if (!primary?.primary || state.current.primary) return null
  const router = withDefaults(deps).router()
  const health = [candidateKey(primary), primary.providerId]
    .map((key) => router.getHealth(key))
    .find((entry) => entry.state === 'exhausted' || entry.state === 'half-open')
  const kind = health?.exhaustion?.kind ?? 'quota'
  return transitionEvent(primary, state.current, { reason: kind, retryAt: health?.exhaustion?.nextProbeAt })
}

/** Settles the circuits and stickiness once the turn on `state.current` ended without continuing. */
export function settleRootModelFallback(
  state: RootModelFallbackState,
  outcome: 'success' | 'error' | 'cancelled',
  deps?: Partial<RootFallbackDeps>
): void {
  const resolved = withDefaults(deps)
  const router = resolved.router()
  const now = resolved.now()
  if (outcome === 'success') {
    recordCandidateSuccess(router, state.current, state.lease, now)
    state.lease = undefined
    settleSticky({
      scope: state.scope,
      chain: state.chain,
      served: state.current,
      failed: state.failed,
      primaryFailureReason: state.primaryFailureReason,
      now,
    })
    return
  }
  releaseCandidate(router, state.lease)
  state.lease = undefined
  if (outcome === 'error') {
    settleSticky({
      scope: state.scope,
      chain: state.chain,
      served: null,
      failed: [...state.failed, state.current],
      now,
    })
  }
}
