/**
 * User-defined MANUAL context limit per provider+model, capping below the actual ceiling
 * (e.g. 100k on a 1M model to save cost). Persisted as JSON in `app_settings` (`chat.contextLimits`)
 * mapping `"<providerId>::<modelId>" → tokens`. Includes provider because actual windows depend on it
 * (the same ID can have different windows per gateway). CLAMP to the actual ceiling (provider ?? models.dev)
 * in the consumer (chat:model-meta), not here — this module stores only user intent.
 */
import { getAppSetting, setAppSetting } from '../store'

const KEY = 'chat.contextLimits'

/** `"<providerId>::<modelId>"` — separator `::` does not occur in IDs, so cannot collide. */
function pairKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

/** Reads the persisted map. DEFENSIVE parsing: absent/invalid JSON → {}; discard nonpositive values. */
function readAll(): Record<string, number> {
  const raw = getAppSetting(KEY)
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Manual token limit for provider+model, or undefined if absent. */
export function getContextLimit(providerId: string, modelId: string): number | undefined {
  if (!providerId || !modelId) return undefined
  return readAll()[pairKey(providerId, modelId)]
}

/** Writes (or removes with null/0) the provider+model manual limit. Rounds to an integer. */
export function setContextLimit(providerId: string, modelId: string, value: number | null): void {
  if (!providerId || !modelId) return
  const all = readAll()
  const k = pairKey(providerId, modelId)
  if (value == null || !Number.isFinite(value) || value <= 0) delete all[k]
  else all[k] = Math.round(value)
  setAppSetting(KEY, JSON.stringify(all))
}

/**
 * EFFECTIVE window by precedence (PURE, testable): `ceiling = providerWindow ?? catalogWindow`; if a user
 * limit exists, use `min(limit, ceiling)` (clamped — never above actual); without a known ceiling, honor
 * the limit as-is; without a limit, use the ceiling. Returns undefined when no source is known.
 */
export function resolveContextWindow(inputs: {
  limit?: number
  providerWindow?: number
  catalogWindow?: number
}): number | undefined {
  const ceiling = inputs.providerWindow ?? inputs.catalogWindow
  const { limit } = inputs
  if (limit != null && limit > 0) return ceiling != null ? Math.min(limit, ceiling) : limit
  return ceiling
}
