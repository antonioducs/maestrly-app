/**
 * One closed set of reasons for a failed model call, with what each implies: retry in place, move to another
 * model, compact first, and which circuit (account or model) the failure blames. Runtime classifiers that already
 * understand their own envelopes (Claude subscription quota and OAuth refresh, Codex quota) are consulted first.
 *
 * Only transport diagnostics and the provider's response are read, never the request, the prompt or model output.
 */
import {
  isClaudeAuthenticationRequired,
  isClaudeModelUnavailable,
  isClaudeOAuthRefreshContention,
} from '../claude-agent-sdk/errors'
import { classifyClaudeQuotaFailure } from '../claude-agent-sdk/quota-error'
import { CodexAppServerRpcError } from '../codex-subscription/client'
import { classifyCodexQuotaFailure, extractTurnCompletedError } from '../codex-subscription/quota-error'
import { errorText, statusOf, unwrapProviderError, type ErrorLike } from './error-signals'
import { isContextOverflowText, isPayloadTooLargeText, parseContextLimitFromError } from './overflow'
import { retryTimingFromError } from './retry-timing'

export const MODEL_FAILURE_REASONS = [
  'quota',
  'rate_limit',
  'billing',
  'auth',
  'auth_transient',
  'context_overflow',
  'payload_too_large',
  'overloaded',
  'server_error',
  'timeout',
  'model_not_found',
  'content_rejected',
  'format',
  'aborted',
  'unknown',
] as const

export type ModelFailureReason = (typeof MODEL_FAILURE_REASONS)[number]

export interface ModelFailureClassification {
  reason: ModelFailureReason
  /** Which circuit the failure blames: the provider account (key/subscription) or one model on it. */
  scope: 'account' | 'model'
  /** The same call may succeed after a short wait (the runner's own transient retry). */
  retryInPlace: boolean
  /** Another model may succeed where this one failed. */
  fallback: boolean
  /** The request was too large: compact (or pick a larger window) before trying again. */
  compact: boolean
  status?: number
  /** Instant the provider accepts requests again, when it said so. */
  retryAt?: number
  /** Auth failure that a new attempt cannot fix (revoked or deactivated credential). */
  permanent?: boolean
  contextLimit?: number
  observedTokens?: number
}

interface Shape {
  scope: ModelFailureClassification['scope']
  retryInPlace: boolean
  fallback: boolean
  compact: boolean
}

const SHAPES: Record<ModelFailureReason, Shape> = {
  quota: { scope: 'account', retryInPlace: false, fallback: true, compact: false },
  rate_limit: { scope: 'model', retryInPlace: true, fallback: true, compact: false },
  billing: { scope: 'account', retryInPlace: false, fallback: true, compact: false },
  auth: { scope: 'account', retryInPlace: false, fallback: true, compact: false },
  auth_transient: { scope: 'account', retryInPlace: true, fallback: false, compact: false },
  context_overflow: { scope: 'model', retryInPlace: false, fallback: true, compact: true },
  payload_too_large: { scope: 'model', retryInPlace: false, fallback: true, compact: true },
  overloaded: { scope: 'model', retryInPlace: true, fallback: true, compact: false },
  server_error: { scope: 'model', retryInPlace: true, fallback: true, compact: false },
  timeout: { scope: 'model', retryInPlace: true, fallback: true, compact: false },
  model_not_found: { scope: 'model', retryInPlace: false, fallback: true, compact: false },
  // Switching providers to get around a safety refusal is not a recovery.
  content_rejected: { scope: 'model', retryInPlace: false, fallback: false, compact: false },
  format: { scope: 'model', retryInPlace: false, fallback: false, compact: false },
  aborted: { scope: 'model', retryInPlace: false, fallback: false, compact: false },
  unknown: { scope: 'model', retryInPlace: false, fallback: false, compact: false },
}

const SUBSCRIPTION_EXHAUSTED_CODES = new Set(['claude-accounts-exhausted', 'codex-accounts-exhausted'])
const SUBSCRIPTION_UNAVAILABLE_CODES = new Set(['claude-runtime-unavailable', 'codex-runtime-unavailable'])

const CONTENT_REJECTED =
  /\b(?:content[_ ]policy(?:[_ ]violation)?|content[_ ]filter(?:ing)?|violat(?:es|ing) (?:our|the) (?:usage|content) polic(?:y|ies)|safety (?:system|filter)s?|responsible ai polic|flagged (?:as|for) (?:potentially )?(?:harmful|unsafe|possible)|invalid_prompt|output blocked by content|data_inspection_failed|prohibited content)\b/i
const QUOTA_TEXT =
  /\b(?:insufficient[_ -]?quota|quota[_ ]exceeded|exceeded your current quota|usage limit|account(?:'s)? rate limit|would exceed (?:your )?account(?:'s)? rate limit|resource[_ ]exhausted)\b/i
const BILLING_TEXT =
  /\b(?:credit balance|insufficient (?:credits?|balance|funds)|payment required|billing (?:hard )?limit|spend(?:ing)? limit|prepayment credits|out of credits|budget (?:limit )?exceeded|top up your|add (?:more )?(?:funds|credits))\b/i
const RESET_SIGNAL = /\b(?:try again|retry (?:in|after)|resets? (?:in|at))\b/i
const PERMANENT_AUTH =
  /\b(?:revoked|deactivated|disabled|suspended|has been banned|account (?:is )?(?:inactive|closed))\b/i
const AUTH_TEXT =
  /\b(?:invalid[_ ]api[_ ]key|incorrect api key|invalid x-api-key|unauthori[sz]ed|authentication[_ ]error|permission[_ ]denied|no api key|api key (?:is )?(?:missing|invalid|expired))\b/i
const OVERLOADED_TEXT =
  /\b(?:overloaded(?:_error)?|server overloaded|model (?:is )?(?:currently )?(?:at|over) capacity|service unavailable|temporarily unavailable|high demand|engine is currently overloaded)\b/i
const RATE_LIMIT_TEXT = /\b(?:rate[_ -]?limit(?:ed|_error)?|too many requests|throttl(?:ed|ing))\b/i
const TIMEOUT_TEXT =
  /\b(?:timeout|timed out|deadline exceeded|etimedout|econnreset|econnrefused|econnaborted|enotfound|eai_again|epipe|und_err_socket|socket hang up|premature close|fetch failed|network error|connection (?:reset|refused|closed))\b/i
const MODEL_NOT_FOUND_TEXT =
  /\b(?:model[_ ]not[_ ]found|unknown model|no such model|model (?:\S+ )?(?:does not exist|not found|is not available)|invalid model|unsupported model|the model `[^`]*` does not exist)\b/i
const SERVER_ERROR_TEXT = /\b(?:internal server error|bad gateway|upstream (?:error|connect)|server_error|api_error)\b/i

function shaped(
  reason: ModelFailureReason,
  extra: Partial<Omit<ModelFailureClassification, 'reason'>> = {}
): ModelFailureClassification {
  const shape = SHAPES[reason]
  const out: ModelFailureClassification = { reason, ...shape }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value
  }
  return out
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const any = error as ErrorLike
  return any.name === 'AbortError' || any.code === 'ABORT_ERR'
}

function resetsAtOf(error: unknown): number | undefined {
  const value = (error as { resetsAt?: unknown } | null)?.resetsAt
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value < 1e12 ? value * 1_000 : value
}

export interface ClassifyModelFailureOptions {
  now?: number
}

/** Classifies a failed model call (thrown error, stream error part or runtime envelope). */
export function classifyModelFailure(
  error: unknown,
  options: ClassifyModelFailureOptions = {}
): ModelFailureClassification {
  const now = options.now ?? Date.now()
  if (isAbortError(error)) return shaped('aborted')

  const code = (error as ErrorLike | null)?.code
  // Layer-1 account failover already walked every account of the chain: only another model can continue.
  if (typeof code === 'string' && SUBSCRIPTION_EXHAUSTED_CODES.has(code)) {
    const resetsAt = resetsAtOf(error)
    return shaped('quota', { retryInPlace: false, ...(resetsAt && resetsAt > now ? { retryAt: resetsAt } : {}) })
  }
  if (code === 'claude-authentication-required') {
    // A lost OAuth refresh race also ends with "sign in again": the credential is still valid.
    return isClaudeOAuthRefreshContention(error) ? shaped('auth_transient') : shaped('auth', { retryInPlace: false })
  }
  if (typeof code === 'string' && SUBSCRIPTION_UNAVAILABLE_CODES.has(code)) {
    const reason = (error as { reason?: unknown }).reason
    if (reason === 'not-authenticated') return shaped('auth', { retryInPlace: false })
    if (reason === 'incompatible') return shaped('model_not_found')
    return shaped('server_error', { scope: 'account', retryInPlace: false })
  }

  // Claude Code serializes OAuth refreshes; losing that race is transient and the credential is still valid.
  if (isClaudeOAuthRefreshContention(error)) return shaped('auth_transient')

  const claudeQuota = classifyClaudeQuotaFailure(error)
  if (claudeQuota.kind === 'quota') {
    const resetsAt = claudeQuota.info.resetsAt ?? undefined
    return shaped('quota', typeof resetsAt === 'number' && resetsAt > now ? { retryAt: resetsAt } : {})
  }
  // Codex app-server envelopes (RPC errors, failed `turn/completed`) carry their own usage-limit markers.
  if (error instanceof CodexAppServerRpcError || extractTurnCompletedError(error)) {
    const codex = classifyCodexQuotaFailure(error)
    if (codex.kind === 'quota') {
      const resetsAt = codex.resetsAt ?? undefined
      return shaped('quota', typeof resetsAt === 'number' && resetsAt > now ? { retryAt: resetsAt } : {})
    }
  }

  const failure = unwrapProviderError(error)
  const status = statusOf(failure) ?? undefined
  const text = errorText(failure)
  const timing = retryTimingFromError(error, now)
  const retryAt = timing?.retryAt
  const withStatus = (reason: ModelFailureReason, extra: Partial<ModelFailureClassification> = {}) =>
    shaped(reason, { status, ...extra })

  if (CONTENT_REJECTED.test(text)) return withStatus('content_rejected')

  if (isContextOverflowText(text, status) && (status == null || (status >= 400 && status < 600))) {
    const hint = parseContextLimitFromError(text)
    return withStatus('context_overflow', { contextLimit: hint.limit, observedTokens: hint.observed })
  }
  if (isPayloadTooLargeText(text, status)) return withStatus('payload_too_large')

  if (status === 402) {
    if (RESET_SIGNAL.test(text) && retryAt) return withStatus('rate_limit', { retryAt })
    return withStatus('billing')
  }
  const quotaText = QUOTA_TEXT.test(text)
  const billingText = BILLING_TEXT.test(text)
  if ((quotaText || billingText) && (status == null || status === 429)) {
    // A reset the provider announces makes it a (long) rate limit, not an empty balance.
    if (!billingText && retryAt && RESET_SIGNAL.test(text)) return withStatus('rate_limit', { retryAt })
    return withStatus(billingText ? 'billing' : 'quota', retryAt ? { retryAt } : {})
  }
  if (billingText && (status === 400 || status === 403)) return withStatus('billing')

  if (
    isClaudeAuthenticationRequired(failure) ||
    status === 401 ||
    (status === 403 && !MODEL_NOT_FOUND_TEXT.test(text))
  ) {
    return withStatus('auth', PERMANENT_AUTH.test(text) ? { permanent: true } : {})
  }
  if (status === 404 || MODEL_NOT_FOUND_TEXT.test(text) || isClaudeModelUnavailable(failure)) {
    return withStatus('model_not_found')
  }
  if (status === 429) return withStatus('rate_limit', retryAt ? { retryAt } : {})
  if (status === 529 || status === 503 || OVERLOADED_TEXT.test(text)) {
    return withStatus('overloaded', retryAt ? { retryAt } : {})
  }
  if (status === 408 || status === 504 || status === 425) return withStatus('timeout')
  if (status === 409 || (status != null && status >= 500)) return withStatus('server_error', retryAt ? { retryAt } : {})
  if (RATE_LIMIT_TEXT.test(text)) return withStatus('rate_limit', retryAt ? { retryAt } : {})
  if (TIMEOUT_TEXT.test(text)) return withStatus('timeout')
  if (AUTH_TEXT.test(text)) return withStatus('auth', PERMANENT_AUTH.test(text) ? { permanent: true } : {})
  if (SERVER_ERROR_TEXT.test(text)) return withStatus('server_error')
  if (status === 400 || status === 422) return withStatus('format')
  return withStatus('unknown')
}

/** Whether a failure of this reason may move the work to another model. */
export function isFallbackEligible(classification: ModelFailureClassification): boolean {
  return classification.fallback
}
