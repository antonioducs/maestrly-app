import { classifyModelFailure, type ModelFailureClassification } from './model-fallback/error-classifier'

const DEFAULT_RETRY_DELAY_MS = 1_500
const MAX_RETRY_DELAY_MS = 5 * 60_000
export const AI_SDK_MAX_RETRIES = 0

export type StreamRetryDecision =
  | { retryable: true; reason: 'transient'; delayMs: number }
  | { retryable: false; reason: 'quota' | 'fatal'; delayMs: 0 }

/**
 * In-place retry decision for a stream failure, derived from the shared failure classifier (which reads the
 * provider's response field by field and never the request that was sent). An empty balance or exhausted quota
 * answered as a throttle (429, or no status) reports `quota`; every other non-transient failure is `fatal`.
 */
export function classifyStreamRetry(error: unknown, now = Date.now()): StreamRetryDecision {
  return streamRetryFromClassification(classifyModelFailure(error, { now }), now)
}

export function streamRetryFromClassification(
  classification: ModelFailureClassification,
  now = Date.now()
): StreamRetryDecision {
  const throttleStatus = classification.status == null || classification.status === 429
  if (classification.reason === 'quota' || (classification.reason === 'billing' && throttleStatus)) {
    return { retryable: false, reason: 'quota', delayMs: 0 }
  }
  if (!classification.retryInPlace) return { retryable: false, reason: 'fatal', delayMs: 0 }
  const hinted = classification.retryAt == null ? 0 : Math.max(0, classification.retryAt - now)
  return {
    retryable: true,
    reason: 'transient',
    delayMs: Math.max(DEFAULT_RETRY_DELAY_MS, Math.min(MAX_RETRY_DELAY_MS, hinted)),
  }
}

export function isRetryableStreamError(error: unknown): boolean {
  return classifyStreamRetry(error).retryable
}

export const HIGH_USAGE_RETRY_STEP_LIMIT = 8
export const HIGH_USAGE_RETRY_CONTEXT_MULTIPLIER = 2

export function shouldBlockHighUsageRetry(args: {
  steps: number
  totalInput: number
  contextWindow?: number | null
}): boolean {
  if (args.steps >= HIGH_USAGE_RETRY_STEP_LIMIT) return true
  const contextWindow = Math.max(0, Number(args.contextWindow) || 0)
  return contextWindow > 0 && args.totalInput >= contextWindow * HIGH_USAGE_RETRY_CONTEXT_MULTIPLIER
}
