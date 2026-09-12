const TRANSIENT_STATUS = new Set([408, 409, 425, 429])
const DEFAULT_RETRY_DELAY_MS = 1_500
const MAX_RETRY_DELAY_MS = 5 * 60_000
export const AI_SDK_MAX_RETRIES = 0

export type StreamRetryDecision =
  | { retryable: true; reason: 'transient'; delayMs: number }
  | { retryable: false; reason: 'quota' | 'fatal'; delayMs: 0 }

type ErrorLike = {
  name?: unknown
  code?: unknown
  type?: unknown
  status?: unknown
  statusCode?: unknown
  message?: unknown
  responseBody?: unknown
  data?: unknown
  cause?: unknown
  headers?: unknown
  responseHeaders?: unknown
  retryAfter?: unknown
}

function errorText(error: unknown): string {
  const any = error as ErrorLike
  const parts = [any?.name, any?.code, any?.type, any?.message, any?.responseBody, any?.data]
  if (error instanceof Error) parts.push(error.message)
  try {
    parts.push(JSON.stringify(error))
  } catch {
    /* best effort */
  }
  return parts.filter((value) => value != null).join(' ')
}

function statusOf(error: unknown): number | null {
  const any = error as ErrorLike
  for (const value of [any?.statusCode, any?.status]) {
    const parsed = typeof value === 'string' ? Number(value) : value
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed
  }
  return null
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null
  const get = (headers as { get?: unknown }).get
  if (typeof get === 'function') {
    const value = get.call(headers, name)
    return typeof value === 'string' ? value : null
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue
    if (typeof value === 'string' || typeof value === 'number') return String(value)
  }
  return null
}

function retryAfterMs(error: unknown, now = Date.now()): number | null {
  const any = error as ErrorLike
  const raw =
    any?.retryAfter ??
    headerValue(any?.responseHeaders, 'retry-after') ??
    headerValue(any?.headers, 'retry-after')
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, raw * 1_000))
  }
  if (typeof raw !== 'string' || !raw.trim()) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, seconds * 1_000))
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, timestamp - now)) : null
}

export function classifyStreamRetry(error: unknown): StreamRetryDecision {
  const status = statusOf(error)
  const hay = errorText(error)
  const quota =
    /\b(?:insufficient[_ -]?quota|quota exceeded|credit balance|billing limit|spending limit|usage limit)\b/i.test(
      hay
    ) ||
    /\b(?:account(?:'s)? rate limit|would exceed (?:your )?account(?:'s)? rate limit)\b/i.test(hay)
  if (quota && (status == null || status === 429)) return { retryable: false, reason: 'quota', delayMs: 0 }

  const transient =
    (status != null && (TRANSIENT_STATUS.has(status) || status >= 500)) ||
    /\b(?:overloaded_error|rate[_ -]?limit(?:ed)?|temporarily unavailable|timeout|timed out|etimedout|econnreset|econnaborted|epipe|und_err_socket|socket hang up|premature close|fetch failed|network error|server overloaded)\b/i.test(
      hay
    )
  if (!transient) return { retryable: false, reason: 'fatal', delayMs: 0 }
  return {
    retryable: true,
    reason: 'transient',
    delayMs: Math.max(DEFAULT_RETRY_DELAY_MS, retryAfterMs(error) ?? 0),
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
