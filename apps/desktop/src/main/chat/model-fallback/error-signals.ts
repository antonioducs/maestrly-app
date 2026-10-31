/**
 * Field-by-field reading of a failed model call. Shared by the retry policy and the fallback classifier so both
 * apply the same rule: classify by the provider's response, never by the request that was sent.
 *
 * APICallError carries the whole request: its prompt and tool descriptions mention words like "timeout",
 * as does a `Keep-Alive: timeout=5` header. Matching them made every failure, a fatal 401 or 402 included,
 * look transient and get retried. Headers are read field by field (Retry-After) instead.
 */

export type ErrorLike = {
  name?: unknown
  code?: unknown
  type?: unknown
  status?: unknown
  statusCode?: unknown
  message?: unknown
  responseBody?: unknown
  data?: unknown
  cause?: unknown
  lastError?: unknown
  headers?: unknown
  responseHeaders?: unknown
  retryAfter?: unknown
}

const NOT_THE_FAILURE = new Set(['requestBodyValues', 'url', 'responseHeaders'])
const omitRequest = (key: string, value: unknown): unknown => (NOT_THE_FAILURE.has(key) ? undefined : value)
const MAX_UNWRAP_DEPTH = 4

/** Diagnostic text of a failure: its name, code, message and response body, never the request. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  const any = error as ErrorLike
  const parts = [any?.name, any?.code, any?.type, any?.message, any?.responseBody, any?.data]
  if (error instanceof Error) parts.push(error.message)
  try {
    parts.push(JSON.stringify(error, omitRequest))
  } catch {
    /* best effort */
  }
  return parts
    .filter((value) => value != null)
    .map((value) => (typeof value === 'string' ? value : safeJson(value)))
    .join(' ')
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'object' ? (JSON.stringify(value, omitRequest) ?? '') : String(value)
  } catch {
    return String(value)
  }
}

export function statusOf(error: unknown): number | null {
  const any = error as ErrorLike
  for (const value of [any?.statusCode, any?.status]) {
    const parsed = typeof value === 'string' && /^\d{3}$/.test(value.trim()) ? Number(value) : value
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed
  }
  return null
}

export function headerValue(headers: unknown, name: string): string | null {
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

/** Response headers of a failure, wherever the SDK put them. */
export function responseHeadersOf(error: unknown): unknown[] {
  const any = error as ErrorLike
  return [any?.responseHeaders, any?.headers].filter((headers) => headers && typeof headers === 'object')
}

/**
 * The failure that carries the provider response: retry wrappers (`lastError`) and causes are unwrapped until an
 * error with an HTTP status appears; without one, the outermost error stands.
 */
export function unwrapProviderError(error: unknown): unknown {
  let current = error
  for (let depth = 0; depth <= MAX_UNWRAP_DEPTH && current != null && typeof current === 'object'; depth++) {
    if (statusOf(current) != null) return current
    const wrapper = current as ErrorLike
    const next = wrapper.lastError ?? wrapper.cause
    if (next == null || next === current) break
    current = next
  }
  return error
}

/** Parsed JSON response body, when the provider sent one. */
export function responseBodyJson(error: unknown): unknown {
  const any = error as ErrorLike
  if (any?.data && typeof any.data === 'object') return any.data
  const body = typeof any?.responseBody === 'string' ? any.responseBody.trim() : ''
  if (!body || (body[0] !== '{' && body[0] !== '[')) return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}
