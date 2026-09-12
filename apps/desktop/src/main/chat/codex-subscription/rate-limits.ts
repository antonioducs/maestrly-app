import { CodexAppServerRpcError } from './client'
import type { CodexAccountRateLimitWindow, CodexAccountRateLimits } from './protocol'

export const METHOD_NOT_FOUND_CODE = -32601

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Epoch seconds (~1e9) vs milliseconds (~1e12). Values below 1e12 are treated as seconds. */
function normalizeResetsAt(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.round(value)
    return rounded < 1e12 ? rounded * 1000 : rounded
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const asNumber = Number(trimmed)
    if (Number.isFinite(asNumber)) return normalizeResetsAt(asNumber)
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizeUsedPercent(value: unknown): number | null {
  if (value == null) return null
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number)) return null
  return Math.min(100, Math.max(0, number))
}

function normalizeWindowDurationMins(value: unknown): number | null {
  if (value == null) return null
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number) || number < 0) return null
  return number
}

function normalizeRateLimitReachedType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function parseWindow(value: unknown): CodexAccountRateLimitWindow | null {
  if (value == null) return null
  if (!isRecord(value)) return null
  const window: CodexAccountRateLimitWindow = { ...value }
  if ('usedPercent' in value) window.usedPercent = normalizeUsedPercent(value.usedPercent)
  if ('windowDurationMins' in value) window.windowDurationMins = normalizeWindowDurationMins(value.windowDurationMins)
  if ('resetsAt' in value) window.resetsAt = normalizeResetsAt(value.resetsAt)
  return window
}

function snapshotValue(value: Record<string, unknown>): Record<string, unknown> {
  // `rateLimits` is the account-wide snapshot. Per-limit entries have no established
  // global exhaustion semantics, so they are deliberately not folded into it.
  return isRecord(value.rateLimits) ? value.rateLimits : value
}

function mergeWindow(
  prev: CodexAccountRateLimitWindow | null | undefined,
  next: CodexAccountRateLimitWindow | null | undefined
): CodexAccountRateLimitWindow | null | undefined {
  if (next === undefined) return prev
  if (next === null) return null
  if (!prev) return next
  return { ...prev, ...next }
}

export function parseCodexRateLimits(value: unknown): CodexAccountRateLimits | null {
  if (!isRecord(value)) return null

  const snapshot = snapshotValue(value)
  const limits: CodexAccountRateLimits = { ...snapshot }
  if ('primary' in snapshot) limits.primary = parseWindow(snapshot.primary)
  if ('secondary' in snapshot) limits.secondary = parseWindow(snapshot.secondary)
  if ('rateLimitReachedType' in snapshot) {
    limits.rateLimitReachedType = normalizeRateLimitReachedType(snapshot.rateLimitReachedType)
  }
  if ('limitReached' in snapshot) {
    const raw = snapshot.limitReached
    if (raw === null || typeof raw === 'boolean' || typeof raw === 'string') {
      limits.limitReached = raw
    } else {
      limits.limitReached = null
    }
  }
  return limits
}

/** Sparse merge: absent fields on `next` keep the previous value. */
export function mergeRateLimits(prev: CodexAccountRateLimits, next: CodexAccountRateLimits): CodexAccountRateLimits {
  const merged: CodexAccountRateLimits = { ...prev, ...next }
  merged.primary = mergeWindow(prev.primary, next.primary)
  merged.secondary = mergeWindow(prev.secondary, next.secondary)
  if (!('credits' in next)) merged.credits = prev.credits
  if (!('rateLimitReachedType' in next)) merged.rateLimitReachedType = prev.rateLimitReachedType
  if (!('limitReached' in next)) merged.limitReached = prev.limitReached
  return merged
}

function limitReachedTruthy(value: boolean | string | null | undefined): boolean {
  if (value === true) return true
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === 'limit_reached' || normalized === 'reached'
}

function nearestResetAt(limits: CodexAccountRateLimits): number | null {
  const resetsAt = [limits.primary?.resetsAt, limits.secondary?.resetsAt].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  )
  return resetsAt.length > 0 ? Math.min(...resetsAt) : null
}

function resetAtForReachedType(limits: CodexAccountRateLimits, reachedType: string): number | null {
  const normalized = reachedType.trim().toLowerCase()
  const preferred = normalized === 'secondary' ? limits.secondary : normalized === 'primary' ? limits.primary : null
  return preferred?.resetsAt ?? nearestResetAt(limits)
}

export interface CodexRateLimitExhaustion {
  exhausted: boolean
  resetsAt?: number | null
  reason?: string
}

/**
 * Backend-classified exhaustion only. Usage percentages are intentionally excluded: snapshots can be stale
 * or represent a window that is not the one currently governing the next request.
 */
export function getExplicitRateLimitExhaustion(
  limits: CodexAccountRateLimits | null | undefined
): CodexRateLimitExhaustion {
  if (!limits) return { exhausted: false }

  const rateLimitReachedType = normalizeRateLimitReachedType(limits.rateLimitReachedType)
  if (rateLimitReachedType) {
    return {
      exhausted: true,
      resetsAt: resetAtForReachedType(limits, rateLimitReachedType),
      reason: 'rateLimitReachedType',
    }
  }

  if (limitReachedTruthy(limits.limitReached)) {
    return {
      exhausted: true,
      resetsAt: limits.primary?.resetsAt ?? limits.secondary?.resetsAt ?? null,
      reason: 'limitReached',
    }
  }

  return { exhausted: false }
}

/**
 * Proactive wiring may observe a cached explicit marker after its reset window has elapsed. Treat only that
 * finite, expired marker as stale; an explicit marker without a reset remains conservative. This must stay
 * separate from `getExplicitRateLimitExhaustion` because a real failed request remains authoritative.
 */
export function getProactiveRateLimitExhaustion(
  limits: CodexAccountRateLimits | null | undefined,
  now = Date.now()
): CodexRateLimitExhaustion {
  const explicit = getExplicitRateLimitExhaustion(limits)
  if (
    explicit.exhausted &&
    typeof explicit.resetsAt === 'number' &&
    Number.isFinite(explicit.resetsAt) &&
    explicit.resetsAt <= now
  ) {
    return { exhausted: false }
  }
  return explicit
}

/**
 * Full snapshot classification used while enriching a concrete quota error. This may use usedPercent because
 * an actual failed request remains the authority; proactive router wiring must use
 * getProactiveRateLimitExhaustion.
 */
export function isRateLimitExhausted(limits: CodexAccountRateLimits | null | undefined): CodexRateLimitExhaustion {
  const explicit = getExplicitRateLimitExhaustion(limits)
  if (explicit.exhausted) return explicit
  if (!limits) return { exhausted: false }

  const primaryUsed = limits.primary?.usedPercent
  if (typeof primaryUsed === 'number' && primaryUsed >= 100) {
    return { exhausted: true, resetsAt: limits.primary?.resetsAt ?? null, reason: 'primary usedPercent >= 100' }
  }

  const secondaryUsed = limits.secondary?.usedPercent
  if (typeof secondaryUsed === 'number' && secondaryUsed >= 100) {
    return { exhausted: true, resetsAt: limits.secondary?.resetsAt ?? null, reason: 'secondary usedPercent >= 100' }
  }

  return { exhausted: false }
}

export function isMethodNotFoundError(error: unknown): boolean {
  if (error instanceof CodexAppServerRpcError) {
    if (error.code === METHOD_NOT_FOUND_CODE) return true
    if (/method not found/i.test(error.message)) return true
  }
  if (error instanceof Error && /method not found/i.test(error.message)) return true
  if (isRecord(error)) {
    if (error.code === METHOD_NOT_FOUND_CODE) return true
    if (typeof error.message === 'string' && /method not found/i.test(error.message)) return true
  }
  return false
}
