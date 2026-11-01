/**
 * Context windows of local and custom OpenAI-compatible servers, which models.dev does not know and whose `/models`
 * rarely says. Two sources: a live probe of the server's own metadata (Ollama, LM Studio, llama.cpp), and the limit a
 * provider revealed in an overflow error, persisted so the next turn compacts in time.
 *
 * Probes go only to the configured base URL's origin, with a short timeout and one request in flight per model.
 */
import { net } from 'electron'
import { getAppSetting, setAppSetting } from '../store'
import { getProvider } from './catalog'
import { catalogProviderForBaseURL } from './model-meta'
import { parseContextLimitFromError, isContextOverflowText } from './model-fallback/overflow'

const LEARNED_KEY = 'chat.learnedContextWindows.v1'
const MIN_WINDOW = 1_024
const MAX_WINDOW = 10_000_000
const PROBE_TIMEOUT_MS = 2_500
const PROBE_TTL_MS = 5 * 60_000
const NEGATIVE_PROBE_TTL_MS = 60_000

interface LearnedWindow {
  tokens: number
  /** What a live probe reported when the limit was learned; a different probe value means the server changed. */
  probed?: number
  at: number
}

const validWindow = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_WINDOW && n <= MAX_WINDOW ? n : undefined
}

const pairKey = (providerId: string, modelId: string): string => `${providerId}::${modelId}`

function readLearned(): Record<string, LearnedWindow> {
  const raw = getAppSetting(LEARNED_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, LearnedWindow> = {}
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      const tokens = validWindow(entry.tokens)
      if (!tokens) continue
      const probed = validWindow(entry.probed)
      out[key] = { tokens, ...(probed ? { probed } : {}), at: typeof entry.at === 'number' ? entry.at : 0 }
    }
    return out
  } catch {
    return {}
  }
}

function writeLearned(all: Record<string, LearnedWindow>): void {
  try {
    setAppSetting(LEARNED_KEY, JSON.stringify(all))
  } catch {
    /* best effort: the limit is learned again on the next overflow */
  }
}

/** The window a provider revealed for this model, if any. */
export function getLearnedContextWindow(providerId: string, modelId: string): number | undefined {
  if (!providerId || !modelId) return undefined
  return readLearned()[pairKey(providerId, modelId)]?.tokens
}

/**
 * Records a limit the provider revealed. Only a smaller value is kept, so a later, larger number from an unrelated
 * message cannot raise it. Returns true when the stored window went down.
 */
export function learnContextLimitFromError(providerId: string, modelId: string, limit: number): boolean {
  const tokens = validWindow(limit)
  if (!providerId || !modelId || !tokens) return false
  const all = readLearned()
  const key = pairKey(providerId, modelId)
  const existing = all[key]
  if (existing && existing.tokens <= tokens) return false
  const probed = probeCache.get(key)
  all[key] = { tokens, ...(probed?.window ? { probed: probed.window } : {}), at: Date.now() }
  writeLearned(all)
  return true
}

/** Learns the limit named in an overflow error's text (the redacted message the turn showed). */
export function learnContextLimitFromFailureText(providerId: string, modelId: string, text: string): boolean {
  if (!text || !isContextOverflowText(text)) return false
  const { limit } = parseContextLimitFromError(text)
  return limit ? learnContextLimitFromError(providerId, modelId, limit) : false
}

export function forgetLearnedContextWindow(providerId: string, modelId?: string): void {
  const all = readLearned()
  let changed = false
  for (const key of Object.keys(all)) {
    if (modelId ? key === pairKey(providerId, modelId) : key.startsWith(`${providerId}::`)) {
      delete all[key]
      changed = true
    }
  }
  if (changed) writeLearned(all)
}

const LOCAL_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^.]+\.local|host\.docker\.internal)$/i

/** A base URL on this machine or the local network. */
export function isLocalBaseURL(baseURL: string): boolean {
  try {
    return LOCAL_HOST.test(new URL(baseURL).hostname)
  } catch {
    return false
  }
}

/** A base URL served by a local or custom server (not a provider models.dev maps). */
export function isLocalOrCustomBaseURL(baseURL: string): boolean {
  if (isLocalBaseURL(baseURL)) return true
  try {
    new URL(baseURL)
  } catch {
    return false
  }
  return catalogProviderForBaseURL(baseURL) == null
}

type Fetcher = (
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; json(): Promise<unknown> }>

const defaultFetch: Fetcher = (url, init) => net.fetch(url, init)

function originOf(baseURL: string): string | null {
  try {
    return new URL(baseURL).origin
  } catch {
    return null
  }
}

async function fetchJson(
  fetcher: Fetcher,
  url: string,
  init: { method?: string; body?: string } = {}
): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    ...(init.body ? { headers: { 'content-type': 'application/json' } } : {}),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  return response.json()
}

const sameModel = (candidate: unknown, modelId: string): boolean =>
  typeof candidate === 'string' && (candidate === modelId || candidate.split('/').pop() === modelId.split('/').pop())

/** Ollama: the runtime `num_ctx` (what the server allocates) wins over the model's trained maximum. */
export function ollamaWindowFromShow(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  if (typeof record.parameters === 'string') {
    const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(record.parameters)
    const runtime = validWindow(match?.[1])
    if (runtime) return runtime
  }
  const info = record.model_info
  if (info && typeof info === 'object') {
    for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
      if (key.endsWith('.context_length')) {
        const trained = validWindow(value)
        if (trained) return trained
      }
    }
  }
  return undefined
}

/** LM Studio: the loaded instance's context length, else the model's maximum. */
export function lmStudioWindowFromModels(body: unknown, modelId: string): number | undefined {
  const list =
    (body as { models?: unknown; data?: unknown } | null)?.models ?? (body as { data?: unknown } | null)?.data
  if (!Array.isArray(list)) return undefined
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (!sameModel(entry.key, modelId) && !sameModel(entry.id, modelId)) continue
    const loaded = Array.isArray(entry.loaded_instances) ? entry.loaded_instances : []
    const loadedWindows = loaded
      .map((instance) => validWindow((instance as { config?: { context_length?: unknown } })?.config?.context_length))
      .filter((value): value is number => value != null)
    if (loadedWindows.length) return Math.min(...loadedWindows)
    return validWindow(entry.loaded_context_length) ?? validWindow(entry.max_context_length)
  }
  return undefined
}

/** llama.cpp: the slot context the server was started with. */
export function llamaCppWindowFromProps(body: unknown): number | undefined {
  const settings = (body as { default_generation_settings?: { n_ctx?: unknown } } | null)?.default_generation_settings
  return validWindow(settings?.n_ctx) ?? validWindow((body as { n_ctx?: unknown } | null)?.n_ctx)
}

/** Probes a local/custom server for the model's window; Ollama, then LM Studio, then llama.cpp win in that order. */
export async function probeServerContextWindow(
  baseURL: string,
  modelId: string,
  fetcher: Fetcher = defaultFetch
): Promise<number | undefined> {
  const origin = originOf(baseURL)
  if (!origin || !modelId) return undefined
  // In parallel: an unreachable server costs one timeout, not one per kind of server.
  const results = await Promise.all(
    [
      async () =>
        ollamaWindowFromShow(
          await fetchJson(fetcher, `${origin}/api/show`, { method: 'POST', body: JSON.stringify({ model: modelId }) })
        ),
      async () => lmStudioWindowFromModels(await fetchJson(fetcher, `${origin}/api/v1/models`), modelId),
      async () => lmStudioWindowFromModels(await fetchJson(fetcher, `${origin}/api/v0/models`), modelId),
      async () => llamaCppWindowFromProps(await fetchJson(fetcher, `${origin}/props`)),
    ].map((attempt) => attempt().catch(() => undefined))
  )
  return results.find((window) => window != null)
}

const probeCache = new Map<string, { window?: number; at: number }>()
const probeInflight = new Map<string, Promise<number | undefined>>()

/** Live window of a local/custom provider's model (cached 5 min; one probe in flight per model). */
export async function discoverContextWindow(
  providerId: string,
  modelId: string,
  fetcher: Fetcher = defaultFetch,
  now = Date.now()
): Promise<number | undefined> {
  const provider = getProvider(providerId)
  if (!provider?.baseURL || !modelId || !isLocalOrCustomBaseURL(provider.baseURL)) return undefined
  const key = pairKey(providerId, modelId)
  const cached = probeCache.get(key)
  if (cached && now - cached.at < (cached.window ? PROBE_TTL_MS : NEGATIVE_PROBE_TTL_MS)) return cached.window
  const running = probeInflight.get(key)
  if (running) return running
  const probe = probeServerContextWindow(provider.baseURL, modelId, fetcher)
    .catch(() => undefined)
    .then((window) => {
      probeCache.set(key, { ...(window ? { window } : {}), at: Date.now() })
      return window
    })
    .finally(() => probeInflight.delete(key))
  probeInflight.set(key, probe)
  return probe
}

/**
 * Provider-side window of a BYOK model, by precedence: the limit an overflow revealed (dropped once a live probe
 * shows the server was reconfigured), then the live probe, then the provider's `/models`.
 * The person's manual limit still caps the result in the caller.
 */
export async function resolveProviderContextWindow(
  providerId: string,
  modelId: string,
  fromModelsEndpoint: () => Promise<number | undefined>,
  fetcher: Fetcher = defaultFetch
): Promise<number | undefined> {
  const listed = await fromModelsEndpoint().catch(() => undefined)
  const baseURL = getProvider(providerId)?.baseURL ?? ''
  // A remote custom gateway is probed only when its `/models` is silent; a local server always (its runtime
  // window can be smaller than what it lists).
  const probed =
    isLocalBaseURL(baseURL) || !listed
      ? await discoverContextWindow(providerId, modelId, fetcher).catch(() => undefined)
      : undefined
  const learnedEntry = readLearned()[pairKey(providerId, modelId)]
  if (learnedEntry && probed && learnedEntry.probed && learnedEntry.probed !== probed) {
    forgetLearnedContextWindow(providerId, modelId)
  } else if (learnedEntry) {
    const live = probed ?? listed
    return live ? Math.min(learnedEntry.tokens, live) : learnedEntry.tokens
  }
  return probed ?? listed
}

export function resetContextWindowDiscoveryForTests(): void {
  probeCache.clear()
  probeInflight.clear()
}
