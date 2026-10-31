/**
 * When a provider says it will accept requests again. Explicit retry hints (Retry-After, body fields, Google
 * RetryInfo, "try again in 6s") win; the reset of an exhausted rate-limit bucket applies only without one. The
 * result is never capped here: a cooldown follows the provider exactly, and only an in-place wait is bounded.
 */
import { errorText, headerValue, responseBodyJson, responseHeadersOf, unwrapProviderError, type ErrorLike } from './error-signals'

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
}

const UNIT = '(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)'
const DURATION_PART = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT}(?![a-z])`, 'gi')

/** "6m0s", "1.5s", "200ms", "4h 5m", "4hr 5min" → milliseconds. */
export function parseDurationText(text: string): number | null {
  let total = 0
  let matched = false
  for (const match of text.matchAll(DURATION_PART)) {
    const unit = UNIT_MS[match[2]!.toLowerCase()]
    if (unit === undefined) continue
    total += Number(match[1]) * unit
    matched = true
  }
  return matched && Number.isFinite(total) ? total : null
}

/** `Retry-After`: delta seconds or an HTTP date. */
export function parseRetryAfterHeader(value: string | number | null | undefined, now = Date.now()): number | null {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? now + value * 1_000 : null
  const raw = value.trim()
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds >= 0 ? now + seconds * 1_000 : null
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(now, date) : null
}

/** An absolute reset value: epoch seconds or milliseconds, or an ISO / RFC 3339 date. */
function parseResetInstant(value: unknown, now: number): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1_000 : value
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return parseResetInstant(numeric, now)
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : null
}

/** A relative reset value: seconds as a number, or a duration string ("6m0s", "30s"). */
function parseRelative(value: unknown, now: number, unitMs = 1_000): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? now + value * unitMs : null
  if (typeof value !== 'string' || !value.trim()) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric >= 0 ? now + numeric * unitMs : null
  const duration = parseDurationText(value)
  return duration == null ? null : now + duration
}

function maxOf(values: Array<number | null | undefined>): number | null {
  let best: number | null = null
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) best = best == null ? value : Math.max(best, value)
  }
  return best
}

function explicitHeaderRetry(headersList: unknown[], now: number): number | null {
  const found: Array<number | null> = []
  for (const headers of headersList) {
    const ms = headerValue(headers, 'retry-after-ms')
    if (ms != null && Number.isFinite(Number(ms)) && Number(ms) >= 0) found.push(now + Number(ms))
    found.push(parseRetryAfterHeader(headerValue(headers, 'retry-after'), now))
  }
  return maxOf(found)
}

/** Reset of a bucket the provider reports as empty (`remaining` ≤ 0). */
function exhaustedBucketReset(headersList: unknown[], now: number): number | null {
  const found: Array<number | null> = []
  for (const headers of headersList) {
    for (const bucket of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
      const remaining = headerValue(headers, `anthropic-ratelimit-${bucket}-remaining`)
      if (remaining != null && Number(remaining) <= 0) {
        found.push(parseResetInstant(headerValue(headers, `anthropic-ratelimit-${bucket}-reset`), now))
      }
    }
    for (const bucket of ['requests', 'tokens', 'project-tokens']) {
      const remaining = headerValue(headers, `x-ratelimit-remaining-${bucket}`)
      if (remaining != null && Number(remaining) <= 0) {
        found.push(parseRelative(headerValue(headers, `x-ratelimit-reset-${bucket}`), now))
      }
    }
    const remaining = headerValue(headers, 'x-ratelimit-remaining')
    if (remaining != null && Number(remaining) <= 0) {
      const reset = headerValue(headers, 'x-ratelimit-reset')
      const asNumber = reset == null ? NaN : Number(reset)
      // Large values are epoch seconds; small ones are a delay in seconds.
      found.push(Number.isFinite(asNumber) && asNumber > 1e9 ? asNumber * 1_000 : parseRelative(reset, now))
    }
  }
  return maxOf(found)
}

function bodyRecords(body: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value == null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const record = value as Record<string, unknown>
    out.push(record)
    for (const key of ['error', 'details', 'detail', 'data']) visit(record[key], depth + 1)
  }
  visit(body, 0)
  return out
}

function explicitBodyRetry(body: unknown, now: number): number | null {
  const found: Array<number | null> = []
  for (const record of bodyRecords(body)) {
    found.push(parseRelative(record.retry_after_ms, now, 1))
    found.push(parseRelative(record.retry_after, now))
    found.push(parseRelative(record.retryAfter, now))
    found.push(parseRelative(record.resets_in_seconds, now))
    found.push(parseResetInstant(record.resets_at, now))
    found.push(parseResetInstant(record.reset_at, now))
    found.push(parseResetInstant(record.resetsAt, now))
    // google.rpc.RetryInfo
    if (typeof record['@type'] === 'string' && /RetryInfo$/.test(record['@type'])) {
      found.push(parseRelative(record.retryDelay, now))
    }
  }
  return maxOf(found)
}

const TEXT_HINTS = [
  new RegExp(`\\b(?:try|retry)(?:\\s+again)?\\s+(?:in|after)\\s+((?:\\d+(?:\\.\\d+)?\\s*${UNIT}\\s*,?\\s*(?:and\\s+)?)+)`, 'i'),
  new RegExp(`\\bresets?\\s+in\\s+((?:\\d+(?:\\.\\d+)?\\s*${UNIT}\\s*,?\\s*(?:and\\s+)?)+)`, 'i'),
  new RegExp(`\\bquotaResetDelay\\W+((?:\\d+(?:\\.\\d+)?\\s*${UNIT})+)`, 'i'),
]

function textRetry(text: string, now: number): number | null {
  const found: Array<number | null> = []
  for (const pattern of TEXT_HINTS) {
    const match = pattern.exec(text)
    if (!match) continue
    const duration = parseDurationText(match[1]!)
    if (duration != null) found.push(now + duration)
  }
  const atDate = /\b(?:try again|retry|resets?)\s+(?:at|after)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))/i.exec(text)
  if (atDate) found.push(parseResetInstant(atDate[1], now))
  return maxOf(found)
}

export interface RetryTiming {
  /** Absolute instant the provider accepts requests again. */
  retryAt: number
  source: 'explicit' | 'bucket-reset'
}

/** The provider's retry timing for `error`, or null when it gave none. */
export function retryTimingFromError(error: unknown, now = Date.now()): RetryTiming | null {
  const failure = unwrapProviderError(error)
  const headersList = [...responseHeadersOf(failure), ...(failure === error ? [] : responseHeadersOf(error))]
  const any = failure as ErrorLike
  const property =
    typeof any?.retryAfter === 'number' || typeof any?.retryAfter === 'string'
      ? parseRetryAfterHeader(any.retryAfter as number | string, now)
      : null
  const explicit = maxOf([
    property,
    explicitHeaderRetry(headersList, now),
    explicitBodyRetry(responseBodyJson(failure), now),
    textRetry(errorText(failure), now),
  ])
  if (explicit != null) return { retryAt: Math.max(now, explicit), source: 'explicit' }
  const reset = exhaustedBucketReset(headersList, now)
  if (reset != null && reset > now) return { retryAt: reset, source: 'bucket-reset' }
  return null
}

/** Milliseconds until the provider accepts requests again, or null. */
export function retryDelayFromError(error: unknown, now = Date.now()): number | null {
  const timing = retryTimingFromError(error, now)
  return timing ? Math.max(0, timing.retryAt - now) : null
}
