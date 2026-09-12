/**
 * DYNAMIC provider model discovery: `GET {baseURL}/models` (OpenAI-compatible) → IDs.
 * Replaces the hardcoded catalog — users connect any provider and obtain its models.
 *
 * TWO cache levels: memory (per provider) + DISK (app_settings), surviving app restart —
 * reopening displays the list IMMEDIATELY (no "loading models…") and revalidates in the BACKGROUND
 * (stale-while-revalidate). Invalidate on key changes (compare key FINGERPRINTS, never raw keys).
 * Errors (no /models, 404, network) → [] (UI falls back to manual model-ID entry).
 */
import { net } from 'electron'
import { createHash } from 'node:crypto'
import { getProvider, getProviderKind } from './catalog'
import { getApiKey } from './credentials'
import { getAppSetting, setAppSetting } from '../store'

interface CacheEntry {
  fp: string // Key fingerprint (sha256[0:16]) — detects changes WITHOUT storing the key.
  at: number // Fetch timestamp (ms).
  models: string[]
  /** Infer legacy cache without status as available only if it contains models. */
  status?: 'available' | 'unavailable'
  /** Context window per modelId when provider /models reports it (context_length etc.). OPTIONAL
   * field → old cache entries load without errors (backward compatible). */
  windows?: Record<string, number>
}

const CACHE_TTL_MS = 5 * 60 * 1000 // Freshness window; afterward stale (return + background revalidate).
const PERSIST_KEY = 'chat.modelsCache'
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<string[]>>() // Deduplicate concurrent refreshes per provider.
let seeded = false

/** Stable irreversible key fingerprint — safe to persist without exposing the secret. Empty string without a key. */
function keyFp(apiKey: string): string {
  return apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : ''
}

/** Loads disk cache into memory (once, lazily). Tolerates missing/corrupt JSON. */
function seedFromDisk(): void {
  if (seeded) return
  seeded = true
  try {
    const raw = getAppSetting(PERSIST_KEY)
    if (!raw) return
    const obj = JSON.parse(raw) as Record<string, CacheEntry>
    for (const [id, e] of Object.entries(obj)) {
      if (e && typeof e.fp === 'string' && typeof e.at === 'number' && Array.isArray(e.models)) {
        cache.set(id, {
          fp: e.fp,
          at: e.at,
          models: e.models.filter((m): m is string => typeof m === 'string'),
          status: e.status === 'available' || e.status === 'unavailable' ? e.status : e.models.length ? 'available' : 'unavailable',
          windows: sanitizeWindows(e.windows), // Absent in old cache → undefined (backward compatible).
        })
      }
    }
  } catch {
    /* Corrupt disk cache → ignore (revalidate from scratch). */
  }
}

function persistToDisk(): void {
  try {
    setAppSetting(PERSIST_KEY, JSON.stringify(Object.fromEntries(cache)))
  } catch {
    /* Best-effort persistence — memory cache remains valid for the session. */
  }
}

/** Fetches provider /models, updates memory+disk. Deduplicates per provider (inflight). */
function refresh(providerId: string, baseURL: string, apiKey: string, fp: string, anthropic: boolean): Promise<string[]> {
  const existing = inflight.get(providerId)
  if (existing) return existing
  const p = (async (): Promise<string[]> => {
    const url = `${baseURL.replace(/\/+$/, '')}/models`
    // Native Anthropic uses x-api-key + anthropic-version (not Bearer); same {data:[{id}]} shape,
    // so extractModels serves both. Other providers use OpenAI-compatible Bearer auth.
    const headers: Record<string, string> = apiKey
      ? anthropic
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        : { Authorization: `Bearer ${apiKey}` }
      : {}
    try {
      const res = await net.fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`models HTTP ${res.status}`)
      const { models, windows } = extractCatalog(await res.json())
      cache.set(providerId, { fp, at: Date.now(), models, windows, status: 'available' })
      persistToDisk()
      return models
    } catch {
      cache.set(providerId, { fp, at: Date.now(), models: [], windows: {}, status: 'unavailable' })
      persistToDisk()
      return []
    } finally {
      inflight.delete(providerId)
    }
  })()
  inflight.set(providerId, p)
  return p
}

/** Finite number > 0 or undefined (invalid/missing windows do not count). */
function posNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

/** Discovers the context window of ONE /models entry, tolerating OpenAI-compatible provider field variants:
 * `context_length` (OpenRouter), `context_window`, `max_context_tokens`, and
 * nested `top_provider` (OpenRouter) or `limit.context` (models.dev style). First match wins. */
function readWindow(m: Record<string, unknown>): number | undefined {
  const top = m.top_provider as Record<string, unknown> | undefined
  const limit = m.limit as Record<string, unknown> | undefined
  return (
    posNum(m.context_length) ??
    posNum(m.context_window) ??
    posNum(m.max_context_tokens) ??
    posNum(top?.context_length) ??
    posNum(limit?.context)
  )
}

/** Filters persisted window maps to string keys → valid numbers (guards corrupt JSON). */
function sanitizeWindows(w: unknown): Record<string, number> | undefined {
  if (!w || typeof w !== 'object') return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(w as Record<string, unknown>)) {
    const n = posNum(v)
    if (n != null) out[k] = n
  }
  return Object.keys(out).length ? out : undefined
}

/** Extracts IDs + reported context windows from /models response. Accepts raw arrays or {data:[…]}.
 * Exported for unit tests (pure parsing). */
export function extractCatalog(json: unknown): { models: string[]; windows: Record<string, number> } {
  const data = Array.isArray(json) ? json : ((json as { data?: Array<Record<string, unknown>> })?.data ?? [])
  const windows: Record<string, number> = {}
  const models = data
    .map((m) => {
      const id = typeof m?.id === 'string' ? m.id : ''
      if (id) {
        const win = readWindow(m as Record<string, unknown>)
        if (win != null) windows[id] = win
      }
      return id
    })
    .filter((id): id is string => id.length > 0)
    .sort((a, b) => a.localeCompare(b))
  return { models, windows }
}

/**
 * Provider model IDs (via /models), with memory+disk cache and stale-while-revalidate.
 * force=true bypasses cache and awaits fresh data. No cache → await fetch. Fresh cache → return.
 * Stale cache (same key) → return IMMEDIATELY and revalidate in background (no restart "loading…").
 */
export interface FetchModelsResult {
  status: 'available' | 'unavailable'
  models: string[]
}

/** List + explicit catalog availability, distinguishing offline from unlisted model IDs. */
export async function fetchModelsWithStatus(providerId: string, force = false): Promise<FetchModelsResult> {
  const provider = getProvider(providerId)
  if (!provider) return { status: 'unavailable', models: [] }
  const models = await fetchModels(providerId, force)
  return { status: cache.get(providerId)?.status ?? 'unavailable', models }
}

export async function fetchModels(providerId: string, force = false): Promise<string[]> {
  seedFromDisk()
  const provider = getProvider(providerId)
  if (!provider) return []
  const apiKey = getApiKey(providerId) ?? ''
  const fp = keyFp(apiKey)
  const anthropic = getProviderKind(provider) === 'anthropic'
  const cached = cache.get(providerId)

  if (!force && cached && cached.fp === fp) {
    if (Date.now() - cached.at < CACHE_TTL_MS) return cached.models // Fresh.
    void refresh(providerId, provider.baseURL, apiKey, fp, anthropic).catch(() => {}) // Stale → background revalidate.
    return cached.models
  }
  // No cache, changed key, or force → fetch and await.
  return refresh(providerId, provider.baseURL, apiKey, fp, anthropic)
}

/**
 * Context window reported by the provider ITSELF (via /models), or undefined if absent.
 * Ensures populated cache (reuses fetchModels — same dedup/stale-while-revalidate; NO additional fetch
 * beyond list fetching). Overrides models.dev's "canonical" window when the actual provider
 * limits context (e.g. a gateway serving the same ID with a smaller window). Matches exact IDs and basenames.
 */
export async function fetchModelWindow(providerId: string, modelId: string): Promise<number | undefined> {
  if (typeof providerId !== 'string' || typeof modelId !== 'string' || !modelId) return undefined
  await fetchModels(providerId) // Populate/update cache (including windows).
  const w = cache.get(providerId)?.windows
  if (!w) return undefined
  return w[modelId] ?? w[modelId.split('/').pop() ?? ''] ?? undefined
}

/** Invalidates model cache after key change/removal or provider edit — memory AND disk. */
export function invalidateModels(providerId?: string): void {
  seedFromDisk()
  if (providerId) cache.delete(providerId)
  else cache.clear()
  persistToDisk()
}
