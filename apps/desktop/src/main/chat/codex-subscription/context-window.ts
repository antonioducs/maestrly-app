/**
 * Codex catalog window metadata. `contextWindow` is the effective window used by the runtime;
 * `nominalContextWindow` is the nominal setting from which it was derived.
 */
export interface CodexContextWindowModel {
  contextWindow?: number | null
  nominalContextWindow?: number | null
  maxContextWindow?: number | null
  effectiveContextWindowPercent?: number | null
}

/** A runtime observation is reusable only for the same nominal setting. */
export interface CodexContextWindowObservation {
  contextWindow: number
  requestedNominal: number | null
}

export interface ResolveCodexContextWindowInput {
  model: CodexContextWindowModel | null | undefined
  userLimit?: number | null
  /** Pass the returned observation for the same `requestedNominal`; other settings are ignored. */
  sameRequestObservation?: CodexContextWindowObservation | null
}

export interface CodexContextWindowResolution {
  /** Requesting a nominal setting is safe only when the runtime publishes the nominal ceiling. */
  configurable: boolean
  maxNominal: number | null
  requestedNominal: number | null
  effectiveEstimate: number | null
}

const MAX_SAFE_TOKENS = Number.MAX_SAFE_INTEGER

function finiteNumericValue(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

/** Normalize token counts without ever fabricating a zero window. */
export function normalizeCodexContextWindowTokens(value: unknown): number | null {
  const numeric = finiteNumericValue(value)
  if (numeric === null || numeric <= 0) return null
  return Math.max(1, Math.min(MAX_SAFE_TOKENS, Math.floor(numeric)))
}

/** Runtime-published percentages may be fractional, but values outside (0, 100] are invalid. */
export function normalizeCodexContextWindowPercent(value: unknown): number | null {
  const numeric = finiteNumericValue(value)
  if (numeric === null || numeric <= 0 || numeric > 100) return null
  return numeric
}

/** Bootstrap estimate before a public `thread/tokenUsage/updated` observation is available. */
export function estimateCodexEffectiveContextWindow(
  nominalContextWindow: unknown,
  effectiveContextWindowPercent: unknown
): number | null {
  const nominal = normalizeCodexContextWindowTokens(nominalContextWindow)
  if (!nominal) return null
  const percent = normalizeCodexContextWindowPercent(effectiveContextWindowPercent) ?? 100
  return Math.max(1, Math.min(MAX_SAFE_TOKENS, Math.floor((nominal / 100) * percent)))
}

function observedForRequest(
  value: CodexContextWindowObservation | null | undefined,
  requestedNominal: number | null
): number | null {
  if (!value || requestedNominal === null) return null
  if (normalizeCodexContextWindowTokens(value.requestedNominal) !== requestedNominal) return null
  return normalizeCodexContextWindowTokens(value.contextWindow)
}

/**
 * Resolve the contract between the configurable nominal ceiling and the runtime's effective window. Without
 * `maxContextWindow`, requesting 1M is unsafe: keep the known active window and leave `requestedNominal` null so
 * consumers omit app-server overrides.
 */
export function resolveCodexContextWindow({
  model,
  userLimit,
  sameRequestObservation,
}: ResolveCodexContextWindowInput): CodexContextWindowResolution {
  const active = normalizeCodexContextWindowTokens(model?.contextWindow)
  const maxNominal = normalizeCodexContextWindowTokens(model?.maxContextWindow)

  if (!maxNominal) {
    return {
      configurable: false,
      maxNominal: null,
      requestedNominal: null,
      effectiveEstimate: active,
    }
  }

  // The active/bootstrap value (for example 272k) is deliberately not the default request once the
  // runtime advertises a configurable ceiling. Removing a manual limit must return to that ceiling.
  const normalizedUserLimit = normalizeCodexContextWindowTokens(userLimit)
  const requestedNominal = Math.min(normalizedUserLimit ?? maxNominal, maxNominal)

  const observed = observedForRequest(sameRequestObservation, requestedNominal)
  const estimated = estimateCodexEffectiveContextWindow(requestedNominal, model?.effectiveContextWindowPercent)
  return {
    configurable: true,
    maxNominal,
    requestedNominal,
    // A runtime observation can only make a future host preflight more conservative. A surprising larger
    // notification never inflates the denominator beyond the catalog estimate that was admitted.
    effectiveEstimate:
      observed != null && estimated != null ? Math.min(observed, estimated) : (observed ?? estimated ?? active),
  }
}
