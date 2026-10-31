/**
 * Runs one model call (a helper, a subagent run) along the model fallback chain: the primary selection first,
 * then the configured fallbacks, moving on only for failures another model can fix. Account failover inside a
 * Claude/Codex subscription stays in its own layer: a candidate fails here only once that layer gave up.
 */
import { isSubscriptionFailoverProviderId, type ChatModelFallbackConfigV1 } from '../../../shared/chat'
import { getConvUiPrefs } from '../../store'
import { autonomousProviderAllowed } from '../autonomous'
import { getProvider } from '../catalog'
import { freezeFailoverChain } from '../subscription-failover/config'
import { getSubscriptionFailoverRouter, type SubscriptionFailoverRouter } from '../subscription-failover/router'
import {
  admitCandidate,
  candidateKey,
  freezeModelChain,
  MAX_MODEL_SWITCHES,
  recordCandidateFailure,
  recordCandidateSuccess,
  releaseCandidate,
  requiredTokensAfterOverflow,
  selectNextCandidate,
  settleSticky,
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
  accountChainOf: (providerId) => (isSubscriptionFailoverProviderId(providerId) ? freezeFailoverChain(providerId) : []),
  isProviderUsable: (providerId, conversationId) =>
    Boolean(getProvider(providerId)) && autonomousProviderAllowed(providerId, conversationId ?? ''),
  classify: (error) => classifyModelFailure(error),
  now: () => Date.now(),
}

/** A conversation the person pinned to its model never falls back. */
export function isModelFallbackPinned(conversationId: string | undefined): boolean {
  if (!conversationId) return false
  try {
    return getConvUiPrefs(conversationId).chat?.modelFallbackPinned === true
  } catch {
    return false
  }
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
  run: (candidate: ModelCandidate, attempt: number) => Promise<T>
  /** Veto a switch after a failure (e.g. a side effect that cannot be replayed already happened). */
  canFallback?: (error: unknown, classification: ModelFailureClassification) => boolean
  onSwitch?: (info: ModelFallbackSwitch) => void
  deps?: Partial<ModelFallbackDeps>
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
  if (chain.length === 1) return args.run(chain[0]!, 1)

  const router = deps.router()
  const admission = { router, accountChainOf: deps.accountChainOf }
  const attempted = new Set<string>()
  const failed: ModelCandidate[] = []
  let primaryFailureReason: ModelFailureReason | undefined
  let switches = 0
  let candidate: ModelCandidate =
    (await selectNextCandidate({ ...admission, chain, attempted, now })) ??
    // Every candidate is cooling down: try the first anyway rather than fail without a call.
    chain[0]!
  for (let attempt = 1; ; attempt++) {
    attempted.add(candidateKey(candidate))
    const slot = admitCandidate(router, candidate, deps.now())
    const lease = slot.ok ? slot.lease : undefined
    try {
      const result = await args.run(candidate, attempt)
      recordCandidateSuccess(router, candidate, lease, deps.now())
      settleSticky({ scope: args.scope, chain, served: candidate, failed, primaryFailureReason, now: deps.now() })
      return result
    } catch (error) {
      if (args.signal?.aborted) {
        releaseCandidate(router, lease)
        throw error
      }
      const classification = deps.classify(error)
      recordCandidateFailure(router, candidate, classification, lease, deps.now())
      failed.push(candidate)
      if (candidate.primary && !primaryFailureReason) primaryFailureReason = classification.reason
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
      if (!next) {
        settleSticky({ scope: args.scope, chain, served: null, failed, now: deps.now() })
        throw error
      }
      switches++
      args.onSwitch?.({ from: candidate, to: next, classification })
      candidate = next
    }
  }
}
