/**
 * Runs one model call (a helper, a subagent run) along the model fallback chain: the primary selection first,
 * then the configured fallbacks, moving on only for failures another model can fix. Account failover inside a
 * Claude/Codex subscription stays in its own layer: a candidate fails here only once that layer gave up.
 */
import type { ChatModelFallbackConfigV1, ChatSubscriptionFailoverEvent } from '../../../shared/chat'
import { getConvUiPrefs } from '../../store'
import { autonomousProviderAllowed } from '../autonomous'
import { getProvider, isSubscriptionProvider } from '../catalog'
import { hasApiKey } from '../credentials'
import { freezeFailoverChain } from '../subscription-failover/config'
import { getSubscriptionFailoverRouter, type SubscriptionFailoverRouter } from '../subscription-failover/router'
import {
  admitCandidate,
  candidateKey,
  firstAdmissibleCandidate,
  freezeModelChain,
  hasAccountFailoverLayer,
  MAX_MODEL_SWITCHES,
  recordCandidateFailure,
  recordCandidateSuccess,
  releaseCandidate,
  requiredTokensAfterOverflow,
  selectNextCandidate,
  settleSticky,
  transitionEvent,
  type ModelCandidate,
} from './chain'
import { getModelFallbackConfig } from './config'
import { classifyModelFailure, type ModelFailureClassification, type ModelFailureReason } from './error-classifier'

export interface ModelFallbackDeps {
  config: () => ChatModelFallbackConfigV1
  router: () => SubscriptionFailoverRouter
  accountChainOf: (providerId: string) => readonly string[]
  isProviderUsable: (providerId: string, conversationId?: string) => boolean
  classify: (error: unknown) => ModelFailureClassification
  windowOf?: (candidate: ModelCandidate) => Promise<number | undefined>
  now: () => number
}

export const defaultModelFallbackDeps: ModelFallbackDeps = {
  config: getModelFallbackConfig,
  router: getSubscriptionFailoverRouter,
  accountChainOf: (providerId) => (hasAccountFailoverLayer(providerId) ? freezeFailoverChain(providerId) : []),
  // A fallback must be able to run unattended: a BYOK provider needs its key.
  isProviderUsable: (providerId, conversationId) =>
    Boolean(getProvider(providerId)) &&
    (isSubscriptionProvider(providerId) || hasApiKey(providerId)) &&
    autonomousProviderAllowed(providerId, conversationId ?? ''),
  classify: (error) => classifyModelFailure(error),
  now: () => Date.now(),
}

/** Conversations running a frozen or isolated turn (review loops, bot commands): their children keep their model. */
const strictExecutions = new Map<string, number>()

/** Marks the conversation strict until the returned release runs (idempotent). */
export function holdStrictModelSelection(conversationId: string): () => void {
  strictExecutions.set(conversationId, (strictExecutions.get(conversationId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (strictExecutions.get(conversationId) ?? 1) - 1
    if (count > 0) strictExecutions.set(conversationId, count)
    else strictExecutions.delete(conversationId)
  }
}

/** A conversation the person pinned to its model, or one running a strict turn, never falls back. */
export function isModelFallbackPinned(conversationId: string | undefined): boolean {
  if (!conversationId) return false
  if (strictExecutions.has(conversationId)) return true
  try {
    return getConvUiPrefs(conversationId).chat?.modelFallbackPinned === true
  } catch {
    return false
  }
}

/**
 * Thrown by `run` when a fallback candidate cannot serve this kind of call at all (signed out, no vision): the
 * chain moves on without blaming the candidate's circuits.
 */
export class ModelCandidateUnsuitable extends Error {
  constructor(message = 'This model cannot serve the request.') {
    super(message)
    this.name = 'ModelCandidateUnsuitable'
  }
}

const UNSUITABLE: ModelFailureClassification = {
  reason: 'model_not_found',
  scope: 'model',
  retryInPlace: false,
  fallback: true,
  compact: false,
}

export interface ModelFallbackSwitch {
  from: ModelCandidate
  to: ModelCandidate
  classification: ModelFailureClassification
}

export interface RunWithModelFallbackArgs<T> {
  primary: { providerId: string; modelId: string }
  /** Sticky scope of this kind of call (`helper:<agent>`, `subagent:<rule>`). */
  scope: string
  conversationId?: string
  /** Frozen or isolated execution: the primary only. */
  strict?: boolean
  signal?: AbortSignal
  /** `hasNext` tells whether another candidate is ready, so a long provider wait can end the attempt instead. */
  run: (candidate: ModelCandidate, attempt: number, context: { hasNext: () => boolean }) => Promise<T>
  /** Veto a switch after a failure (e.g. a side effect that cannot be replayed already happened). */
  canFallback?: (error: unknown, classification: ModelFailureClassification) => boolean
  onSwitch?: (info: ModelFallbackSwitch) => void
  deps?: Partial<ModelFallbackDeps>
}

/** Announces a switch of a subagent or helper to the conversation's window (same channel as account switches). */
export function emitModelFallbackSwitch(
  conversationId: string | undefined,
  event: ChatSubscriptionFailoverEvent
): void {
  if (!conversationId) return
  void import('../subscription-failover/ephemeral')
    .then(({ emitSubscriptionFailoverEvent }) => emitSubscriptionFailoverEvent(conversationId, event))
    .catch(() => undefined)
}

export interface HelperModelSelection {
  providerId: string
  modelId: string
  effort?: string
  fastMode?: boolean
}

/**
 * A helper call (memory extraction, image description, compaction summary) along the model fallback list. The
 * primary keeps its own effort; a fallback runs with the effort configured for it.
 */
export function runHelperWithModelFallback<T>(args: {
  selection: HelperModelSelection
  agent: string
  conversationId?: string
  strict?: boolean
  signal?: AbortSignal
  run: (selection: HelperModelSelection) => Promise<T>
  canFallback?: RunWithModelFallbackArgs<T>['canFallback']
  deps?: Partial<ModelFallbackDeps>
}): Promise<T> {
  return runWithModelFallback({
    primary: { providerId: args.selection.providerId, modelId: args.selection.modelId },
    scope: `helper:${args.agent}`,
    conversationId: args.conversationId,
    strict: args.strict,
    signal: args.signal,
    ...(args.canFallback ? { canFallback: args.canFallback } : {}),
    run: (candidate) =>
      args.run(
        candidate.primary
          ? args.selection
          : {
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              ...(candidate.reasoning ? { effort: candidate.reasoning } : {}),
              ...(candidate.fastMode ? { fastMode: true } : {}),
            }
      ),
    onSwitch: ({ from, to, classification }) =>
      emitModelFallbackSwitch(args.conversationId, transitionEvent(from, to, classification, 'helper')),
    deps: args.deps,
  })
}

/** Whether a fallback of `primary` could run now (for runtimes that hand a failed run over to the executor). */
export function hasAdmissibleModelFallback(
  primary: { providerId: string; modelId: string },
  conversationId: string | undefined,
  deps?: Partial<ModelFallbackDeps>
): boolean {
  const resolved: ModelFallbackDeps = { ...defaultModelFallbackDeps, ...deps }
  if (isModelFallbackPinned(conversationId)) return false
  const chain = freezeModelChain({
    primary,
    config: resolved.config(),
    isProviderUsable: (providerId) => resolved.isProviderUsable(providerId, conversationId),
  })
  const first = firstAdmissibleCandidate({
    router: resolved.router(),
    accountChainOf: resolved.accountChainOf,
    chain,
    attempted: new Set(),
    now: resolved.now(),
  })
  return first != null && !first.primary
}

export async function runWithModelFallback<T>(args: RunWithModelFallbackArgs<T>): Promise<T> {
  const deps: ModelFallbackDeps = { ...defaultModelFallbackDeps, ...args.deps }
  const now = deps.now()
  const strict = args.strict === true || isModelFallbackPinned(args.conversationId)
  const chain = freezeModelChain({
    primary: args.primary,
    config: deps.config(),
    strict,
    isProviderUsable: (providerId) => deps.isProviderUsable(providerId, args.conversationId),
    stickyScope: args.scope,
    now,
  })
  if (chain.length === 1) return args.run(chain[0]!, 1, { hasNext: () => false })

  const router = deps.router()
  const admission = { router, accountChainOf: deps.accountChainOf }
  const attempted = new Set<string>()
  const failed: ModelCandidate[] = []
  let primaryFailureReason: ModelFailureReason | undefined
  let switches = 0
  // An unsuitable candidate is skipped: the person hears about, and finally gets, the last real failure.
  let lastReal: { error: unknown; candidate: ModelCandidate; classification: ModelFailureClassification } | undefined
  let candidate: ModelCandidate =
    (await selectNextCandidate({ ...admission, chain, attempted, now })) ??
    // Every candidate is cooling down: try the first anyway rather than fail without a call.
    chain[0]!
  const hasNext = (): boolean =>
    switches < MAX_MODEL_SWITCHES &&
    firstAdmissibleCandidate({ ...admission, chain, attempted, now: deps.now() }) != null
  for (let attempt = 1; ; attempt++) {
    attempted.add(candidateKey(candidate))
    const slot = admitCandidate(router, candidate, deps.now())
    const lease = slot.ok ? slot.lease : undefined
    try {
      const result = await args.run(candidate, attempt, { hasNext })
      recordCandidateSuccess(router, candidate, lease, deps.now())
      settleSticky({ scope: args.scope, chain, served: candidate, failed, primaryFailureReason, now: deps.now() })
      return result
    } catch (error) {
      if (args.signal?.aborted) {
        releaseCandidate(router, lease)
        throw error
      }
      const unsuitable = error instanceof ModelCandidateUnsuitable
      const classification = unsuitable ? UNSUITABLE : deps.classify(error)
      if (unsuitable) releaseCandidate(router, lease)
      else {
        recordCandidateFailure(router, candidate, classification, lease, deps.now())
        failed.push(candidate)
        if (candidate.primary && !primaryFailureReason) primaryFailureReason = classification.reason
      }
      const vetoed = args.canFallback ? !args.canFallback(error, classification) : false
      const next =
        classification.fallback && !vetoed && switches < MAX_MODEL_SWITCHES
          ? await selectNextCandidate({
              ...admission,
              chain,
              attempted,
              now: deps.now(),
              ...(classification.compact
                ? { requiredTokens: requiredTokensAfterOverflow(classification), windowOf: deps.windowOf }
                : {}),
            })
          : null
      if (!unsuitable) {
        lastReal = { error, candidate, classification }
      }
      if (!next) {
        settleSticky({ scope: args.scope, chain, served: null, failed, now: deps.now() })
        throw lastReal ? lastReal.error : error
      }
      switches++
      // After a skipped candidate, the notice names the model that really failed.
      args.onSwitch?.({
        from: lastReal?.candidate ?? candidate,
        to: next,
        classification: lastReal?.classification ?? classification,
      })
      candidate = next
    }
  }
}
