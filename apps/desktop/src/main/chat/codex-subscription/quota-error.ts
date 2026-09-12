import {
  CodexAppServerAbortError,
  CodexAppServerClosedError,
  CodexAppServerProcessError,
  CodexAppServerRpcError,
  CodexAppServerTimeoutError,
} from './client'
import { isRateLimitExhausted } from './rate-limits'
import type { CodexAccountRateLimits } from './protocol'

export type CodexQuotaClassification =
  | {
      kind: 'quota'
      confidence: 'structured' | 'strong-marker' | 'rate-limits-confirmed'
      message: string
      resetsAt?: number | null
    }
  | { kind: 'not-quota'; reason: 'auth' | 'abort' | 'network' | 'transient-429' | 'other'; message: string }
  | { kind: 'suspect'; message: string } // force rateLimits/read

const STRONG_QUOTA_MARKER = /UsageLimitExceeded|usage limit|quota exceeded/i
const AUTH_MARKER = /authentication|unauthorized|login required|not authenticated|auth required/i
const ABORT_MARKER = /\baborted\b|AbortError/i
const NETWORK_MARKER =
  /\btimeout\b|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network|exited unexpectedly|disconnected/i
const RATE_LIMIT_ISH = /rate\s*limit|ratelimit|too many requests|\b429\b/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeDataSnippet(data: unknown): string | null {
  if (data == null) return null
  try {
    const raw = typeof data === 'string' ? data : JSON.stringify(data)
    if (!raw) return null
    // Defensive: never echo tokens/emails from RPC data blobs into classification messages.
    return raw
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]')
      .slice(0, 500)
  } catch {
    return null
  }
}

function describeError(error: unknown): string {
  if (error instanceof CodexAppServerRpcError) {
    const parts = [error.message || 'Codex RPC error', `code=${error.code}`, `method=${error.method}`]
    const data = safeDataSnippet(error.data)
    if (data) parts.push(`data=${data}`)
    return parts.join(' ')
  }
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  if (isRecord(error)) {
    const message = typeof error.message === 'string' ? error.message : ''
    const code = error.code != null ? `code=${String(error.code)}` : ''
    const method = typeof error.method === 'string' ? `method=${error.method}` : ''
    return [message, code, method].filter(Boolean).join(' ') || JSON.stringify(error)
  }
  return String(error)
}

/** Extract errors from `turn/completed` payloads with `turn.status === 'failed'`. */
export function extractTurnCompletedError(turnParams: unknown): {
  message: string
  status: string
  structured: true
} | null {
  if (!isRecord(turnParams)) return null
  const turn = isRecord(turnParams.turn)
    ? turnParams.turn
    : 'status' in turnParams && ('error' in turnParams || turnParams.status === 'failed')
      ? turnParams
      : null
  if (!turn) return null
  const status = typeof turn.status === 'string' ? turn.status : ''
  if (status !== 'failed') return null
  const error = turn.error
  let message = 'Codex turn failed'
  if (typeof error === 'string' && error.trim()) message = error.trim()
  else if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    message = error.message.trim()
  } else if (typeof turn.message === 'string' && turn.message.trim()) {
    message = turn.message.trim()
  }
  return { message, status, structured: true }
}

export function classifyCodexQuotaFailure(
  error: unknown,
  opts?: { rateLimits?: CodexAccountRateLimits | null }
): CodexQuotaClassification {
  const structured = extractTurnCompletedError(error)
  const message = structured ? structured.message : describeError(error)

  if (
    error instanceof CodexAppServerAbortError ||
    (error instanceof Error && error.name === 'AbortError') ||
    ABORT_MARKER.test(message)
  ) {
    return { kind: 'not-quota', reason: 'abort', message }
  }

  if (AUTH_MARKER.test(message)) {
    return { kind: 'not-quota', reason: 'auth', message }
  }

  if (
    error instanceof CodexAppServerProcessError ||
    error instanceof CodexAppServerTimeoutError ||
    error instanceof CodexAppServerClosedError ||
    NETWORK_MARKER.test(message)
  ) {
    // Network/process noise can mention "rate" incidentally; keep as network unless strong quota markers win below.
    if (!STRONG_QUOTA_MARKER.test(message)) {
      return { kind: 'not-quota', reason: 'network', message }
    }
  }

  let healthyRateLimitsSnapshot = false
  if (opts?.rateLimits) {
    const exhausted = isRateLimitExhausted(opts.rateLimits)
    if (exhausted.exhausted) {
      return {
        kind: 'quota',
        confidence: 'rate-limits-confirmed',
        message: exhausted.reason ? `${message} (${exhausted.reason})` : message,
        resetsAt: exhausted.resetsAt ?? null,
      }
    }
    healthyRateLimitsSnapshot = true
  }

  if (STRONG_QUOTA_MARKER.test(message)) {
    return {
      kind: 'quota',
      confidence: structured ? 'structured' : 'strong-marker',
      message,
    }
  }

  const has429 =
    /\b429\b/.test(message) ||
    (error instanceof CodexAppServerRpcError && error.code === 429) ||
    (isRecord(error) && error.code === 429)

  if (has429 || /too many requests/i.test(message)) {
    // Without usage/quota wording: plain 429 is transient; rate-limit-ish copy is suspect (probe rateLimits/read).
    if (/rate\s*limit|ratelimit/i.test(message)) {
      if (healthyRateLimitsSnapshot) return { kind: 'not-quota', reason: 'transient-429', message }
      return { kind: 'suspect', message }
    }
    return { kind: 'not-quota', reason: 'transient-429', message }
  }

  if (RATE_LIMIT_ISH.test(message) && !STRONG_QUOTA_MARKER.test(message)) {
    if (healthyRateLimitsSnapshot) return { kind: 'not-quota', reason: 'other', message }
    return { kind: 'suspect', message }
  }

  return { kind: 'not-quota', reason: 'other', message }
}

/**
 * Classifies a failure and, when necessary, refreshes rate limits to enrich a confirmed quota.
 * A healthy snapshot cannot override a strong/structured quota marker, and read failures keep the
 * original classification so failover remains conservative.
 */
export async function classifyCodexQuotaFailureWithRateLimits(
  error: unknown,
  readRateLimits: () => Promise<CodexAccountRateLimits | null>
): Promise<CodexQuotaClassification> {
  const classification = classifyCodexQuotaFailure(error)
  const shouldRead =
    classification.kind === 'suspect' || (classification.kind === 'quota' && classification.resetsAt == null)
  if (!shouldRead) return classification

  try {
    const rateLimits = await readRateLimits()
    const snapshotClassification = classifyCodexQuotaFailure(error, { rateLimits })
    if (classification.kind === 'suspect') return snapshotClassification
    return snapshotClassification.kind === 'quota' ? snapshotClassification : classification
  } catch {
    return classification
  }
}
