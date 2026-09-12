/**
 * Model metadata (context window and pricing) from the public models.dev catalog, used by the
 * chat context/cost meter. GET https://models.dev/api.json, cached in memory for 24 hours. Shape:
 * { [providerId]: { models: { [modelId]: { id, limit: {context, output}, cost: {input, output} } } } }
 * (prices in USD per 1M tokens). Degrades gracefully: chat still works without metadata offline.
 */
import { net } from 'electron'
import type { ChatModelMeta } from '../../shared/chat'
import { grokReasoningMeta } from './grok-subscription/models'

const CATALOG_URL = 'https://models.dev/api.json'
const TTL = 24 * 60 * 60 * 1000
const CATALOG_TIMEOUT_MS = 10_000

let cache: { at: number; map: Map<string, ChatModelMeta> } | null = null
let inflight: Promise<Map<string, ChatModelMeta>> | null = null
let catalogStatus: 'available' | 'unavailable' = 'unavailable'

const providerModelKey = (providerId: string, modelId: string): string => `\0${providerId}\0${modelId}`

/** Strict mapping of BYOK hosts to models.dev providers. Unknown hosts have no mapped canonical provider. */
export function catalogProviderForBaseURL(baseURL: string): string | null {
  let host: string
  try {
    host = new URL(baseURL).hostname.toLowerCase()
  } catch {
    return null
  }
  const byHost: Record<string, string> = {
    'api.anthropic.com': 'anthropic',
    'api.deepseek.com': 'deepseek',
    'api.groq.com': 'groq',
    'api.mistral.ai': 'mistral',
    'api.openai.com': 'openai',
    'api.together.xyz': 'togetherai',
    'api.x.ai': 'xai',
    'generativelanguage.googleapis.com': 'google',
    'openrouter.ai': 'openrouter',
    'token-plan-sgp.xiaomimimo.com': 'xiaomi',
  }
  return byHost[host] ?? null
}

// Home provider by model ID family. The same ID often appears across providers
// (official, resellers, gateways, clouds); the official entry is authoritative for window, effort and price.
// Without a tiebreaker, flattening was last-write-wins and a later provider could overwrite better data
// (e.g. claude-opus-4-8 fell from 1M to 200k and lost xhigh because Azure appeared last in the JSON).
const HOME_PROVIDER: Array<[RegExp, string]> = [
  [/^claude-/, 'anthropic'],
  [/^(gpt-|o1|o3|o4|chatgpt|codex)/, 'openai'],
  [/^gemini-/, 'google'],
  [/^grok-/, 'xai'],
  [/^deepseek-/, 'deepseek'],
  [/^(mistral|magistral|codestral|ministral|pixtral|devstral)/, 'mistral'],
]

/** Resolve collisions by canonical provider first, then larger window, more effort levels and available pricing. */
function scoreEntry(providerId: string, modelKey: string, meta: ChatModelMeta): number {
  const home = HOME_PROVIDER.find(([re]) => re.test(modelKey))?.[1]
  const canonical = home && providerId === home ? 1 : 0
  return (
    canonical * 1e13 +
    (meta.contextWindow ?? 0) * 1e3 +
    (meta.reasoningEfforts?.length ?? 0) * 10 +
    (meta.inputPer1M != null ? 1 : 0)
  )
}

/** Flatten the catalog to modelId→meta, indexing by model key and the provider/model `id`. */
export function parseCatalog(json: unknown): Map<string, ChatModelMeta> {
  const map = new Map<string, ChatModelMeta>()
  const score = new Map<string, number>() // Best score stored per key, resolving provider collisions.
  if (!json || typeof json !== 'object') return map
  // Overwrite only with a higher score; ties retain the first entry for stability.
  const put = (k: string, meta: ChatModelMeta, s: number): void => {
    const prev = score.get(k)
    if (prev != null && prev >= s) return
    map.set(k, meta)
    score.set(k, s)
  }
  for (const [providerId, provider] of Object.entries(json as Record<string, unknown>)) {
    const models = (provider as { models?: unknown })?.models
    if (!models || typeof models !== 'object') continue
    for (const [key, raw] of Object.entries(models as Record<string, unknown>)) {
      const m = raw as {
        id?: unknown
        reasoning?: unknown
        reasoning_options?: unknown
        interleaved?: unknown
        modalities?: { input?: unknown; output?: unknown }
        limit?: { context?: unknown; output?: unknown }
        cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown }
      }
      const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const inputs = m?.modalities?.input
      const outputs = m?.modalities?.output
      const vision = Array.isArray(inputs) ? inputs.includes('image') : undefined
      // Text/code chat requires text input and output. Filter out TTS (audio output),
      // ASR (audio-only input), and image/video generation only when both modalities are known.
      const chatCapable =
        Array.isArray(inputs) && Array.isArray(outputs)
          ? inputs.includes('text') && outputs.includes('text')
          : undefined
      // Model effort levels: read values from the type='effort' entry in the reasoning_options array.
      let reasoningEfforts: string[] | undefined
      if (Array.isArray(m?.reasoning_options)) {
        const effort = (m.reasoning_options as Array<{ type?: unknown; values?: unknown }>).find(
          (o) => o?.type === 'effort'
        )
        if (effort && Array.isArray(effort.values)) {
          const vals = effort.values.filter((v): v is string => typeof v === 'string')
          if (vals.length) reasoningEfforts = vals
        }
      }
      // Interleaved reasoning (models.dev `interleaved`) enables `reasoning_content` replay during
      // tool-call round trips. Only the textual `{ field: string }` shape with `reasoning_content` enables this
      // capability; bare `interleaved: true` and structured shapes remain disabled because their contract is unknown.
      let interleavedReasoning: ChatModelMeta['interleavedReasoning']
      if (
        m?.interleaved &&
        typeof m.interleaved === 'object' &&
        !Array.isArray(m.interleaved) &&
        (m.interleaved as { field?: unknown }).field === 'reasoning_content'
      ) {
        interleavedReasoning = { field: 'reasoning_content', format: 'text' }
      }
      const meta: ChatModelMeta = {
        contextWindow: num(m?.limit?.context),
        maxOutput: num(m?.limit?.output),
        inputPer1M: num(m?.cost?.input),
        outputPer1M: num(m?.cost?.output),
        cacheReadPer1M: num(m?.cost?.cache_read),
        cacheWritePer1M: num(m?.cost?.cache_write),
        reasoning: typeof m?.reasoning === 'boolean' ? m.reasoning : undefined,
        reasoningEfforts,
        interleavedReasoning,
        vision,
        chatCapable,
      }
      if (meta.contextWindow == null && meta.inputPer1M == null) continue // Entry contains no useful metadata.
      const s = scoreEntry(providerId, key, meta)
      // Exact provider entry with its actual catalog price, plus the canonical flattened capabilities index.
      map.set(providerModelKey(providerId, key), meta)
      put(key, meta, s)
      if (typeof m?.id === 'string') {
        map.set(providerModelKey(providerId, m.id), meta)
        put(m.id, meta, s) // For example, "openai/gpt-4o-mini" is used by OpenRouter.
      }
    }
  }
  return map
}

async function loadCatalog(): Promise<Map<string, ChatModelMeta>> {
  if (cache && Date.now() - cache.at < TTL) return cache.map
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await net.fetch(CATALOG_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
      if (!res.ok) throw new Error('models.dev HTTP ' + res.status)
      const map = parseCatalog(await res.json())
      catalogStatus = 'available'
      cache = { at: Date.now(), map }
      return map
    } catch {
      // Offline/error: preserve existing data and retry in about one minute to avoid hammering the network.
      catalogStatus = 'unavailable'
      const map = cache?.map ?? new Map<string, ChatModelMeta>()
      cache = { at: Date.now() - TTL + 60_000, map }
      return map
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * Model IDs for one provider in the public catalog. Supplements provider runtime discovery;
 * callers apply their own allowlist before exposing executable IDs. Requires no Maestrly account or service.
 */
export async function listCatalogProviderModelIds(providerId: string): Promise<string[]> {
  const map = await loadCatalog()
  const prefix = providerModelKey(providerId, '')
  return [...new Set([...map.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}

/** Pure lookup: with a catalog provider, never silently use the canonical price from another provider. */
export function catalogModelMeta(
  map: Map<string, ChatModelMeta>,
  modelId: string,
  catalogProviderId?: string
): ChatModelMeta | null {
  if (typeof modelId !== 'string' || !modelId) return null
  const basename = modelId.split('/').pop() ?? ''
  if (catalogProviderId) {
    return (
      map.get(providerModelKey(catalogProviderId, modelId)) ??
      map.get(providerModelKey(catalogProviderId, basename)) ??
      null
    )
  }
  return map.get(modelId) ?? map.get(basename) ?? null
}

/** Model metadata; the optional provider selects the exact models.dev entry. */
export async function getModelMeta(modelId: string, catalogProviderId?: string): Promise<ChatModelMeta | null> {
  return catalogModelMeta(await loadCatalog(), modelId, catalogProviderId)
}

const ANTHROPIC_KEY_PREFIX = providerModelKey('anthropic', '')
// Harness window-variant suffix (`opus[1m]`, `claude-sonnet-4-5-20250929[1m]`): models.dev indexes
// the model rather than its window; strip the suffix before lookup.
const CLAUDE_WINDOW_VARIANT = /\[\d+m\]$/i
// Model family from either a bare alias (`opus`) or a concrete ID (`claude-opus-4-8`).
const CLAUDE_FAMILY = /(?:^|[-/])(opus|sonnet|haiku|fable)(?:[-.]|$)/i

/** Version as numeric segments (`claude-opus-4-8` → [4,8]); nonnumeric IDs return null. */
function claudeVersionSegments(modelKey: string, family: string): number[] | null {
  const rest = modelKey.slice(`claude-${family}-`.length)
  if (!rest) return null
  const parts = rest.split('-')
  const segments: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    segments.push(Number(part))
  }
  return segments
}

/** Prefer the highest version; equal prefixes prefer fewer segments (stable ID rather than dated snapshot). */
function compareClaudeVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return b.length - a.length
}

/**
 * Resolve Claude Code harness aliases (`opus[1m]`, `sonnet`, `fable`) to keys in the
 * models.dev Anthropic catalog, which only recognizes concrete IDs (`claude-opus-4-6`, `claude-fable-5`, etc.).
 * Strip the window variant, try an exact catalog key, then choose the latest `claude-<family>-<version>`
 * entry in that family. This uses family pricing as an estimate, not a guarantee for a specific alias; the
 * usage panel labels it as an estimate. `default` has no family and returns null rather than inventing a price.
 */
export function claudeHarnessCatalogModelId(map: Map<string, ChatModelMeta>, modelId: string): string | null {
  if (typeof modelId !== 'string' || !modelId) return null
  const base = modelId.trim().replace(CLAUDE_WINDOW_VARIANT, '')
  if (!base) return null
  if (map.has(providerModelKey('anthropic', base))) return base
  const family = base.match(CLAUDE_FAMILY)?.[1]?.toLowerCase()
  if (!family) return null
  let best: { key: string; version: number[] } | null = null
  for (const key of map.keys()) {
    if (!key.startsWith(ANTHROPIC_KEY_PREFIX)) continue
    const modelKey = key.slice(ANTHROPIC_KEY_PREFIX.length)
    if (!modelKey.startsWith(`claude-${family}-`)) continue
    const version = claudeVersionSegments(modelKey, family)
    if (!version) continue
    if (!best || compareClaudeVersions(version, best.version) > 0) best = { key: modelKey, version }
  }
  return best?.key ?? null
}

/** Anthropic metadata for a harness alias (see `claudeHarnessCatalogModelId`). Return null without a match. */
export async function getClaudeHarnessModelMeta(modelId: string): Promise<ChatModelMeta | null> {
  const map = await loadCatalog()
  const key = claudeHarnessCatalogModelId(map, modelId)
  return key ? catalogModelMeta(map, key, 'anthropic') : null
}

export function catalogModelMetaWithStatus(
  map: Map<string, ChatModelMeta>,
  status: 'available' | 'unavailable',
  modelId: string,
  catalogProviderId?: string
): { status: 'available' | 'unavailable'; meta: ChatModelMeta | null } {
  const meta = catalogModelMeta(map, modelId, catalogProviderId)
  // A catalog revalidation failure does not invalidate metadata already in the 24-hour cache.
  return { status: meta ? 'available' : status, meta }
}

export async function getModelMetaWithStatus(
  modelId: string,
  catalogProviderId?: string
): Promise<{ status: 'available' | 'unavailable'; meta: ChatModelMeta | null }> {
  return catalogModelMetaWithStatus(await loadCatalog(), catalogStatus, modelId, catalogProviderId)
}

export interface ProviderModelMetaResult {
  status: 'available' | 'unavailable'
  meta: ChatModelMeta | null
}

/** Prefer the exact provider entry, then canonical model ID metadata, consistently across the UI. */
export function selectProviderModelMeta(
  exact: ProviderModelMetaResult | null,
  canonical: ProviderModelMetaResult
): ProviderModelMetaResult {
  const meta = exact?.meta ?? canonical.meta
  return { status: meta ? 'available' : 'unavailable', meta }
}

/** Capabilities and pricing shared by chat, subagent profiles and execution. */
export async function getProviderModelMetaWithStatus(
  modelId: string,
  catalogProviderId?: string | null
): Promise<ProviderModelMetaResult> {
  const exact = catalogProviderId ? await getModelMetaWithStatus(modelId, catalogProviderId) : null
  const selected = exact?.meta
    ? { status: 'available' as const, meta: exact.meta }
    : selectProviderModelMeta(exact, await getModelMetaWithStatus(modelId))
  if (catalogProviderId !== 'xai') return selected

  // The xAI /models API does not publish its effort matrix. Preserve authoritative canonical capabilities
  // and fill in only known models when the catalog does not yet cover a newly released family.
  const reasoning = grokReasoningMeta(modelId, selected.meta)
  const meta = selected.meta
    ? { ...selected.meta, ...reasoning }
    : Object.keys(reasoning).length
      ? ({ ...reasoning } as ChatModelMeta)
      : null
  return { status: meta ? 'available' : selected.status, meta }
}

export async function getProviderModelMeta(
  modelId: string,
  catalogProviderId?: string | null
): Promise<ChatModelMeta | null> {
  return (await getProviderModelMetaWithStatus(modelId, catalogProviderId)).meta
}

/**
 * Compose base metadata from the exact provider entry when the host maps to a models.dev provider
 * and the canonical entry flattened by model ID family. Capabilities (window/output/reasoning/vision) use
 * `exact ?? canonical`. Pricing uses the same source: a mapped host uses the exact provider price;
 * unmapped proxy/custom hosts use the canonical official model price. The usage panel labels pricing
 * as an ESTIMATE, so a public price is more useful than no price. This is a pure function
 * (no I/O) for testing. Effective window resolution (limit/provider) belongs to `effectiveModelMeta`.
 */
export function composeEffectiveMeta(
  exact: ChatModelMeta | null,
  canonical: ChatModelMeta | null
): ChatModelMeta | null {
  const source = exact ?? canonical
  if (!source) return null
  return {
    contextWindow: source.contextWindow,
    maxOutput: source.maxOutput,
    inputPer1M: source.inputPer1M,
    outputPer1M: source.outputPer1M,
    cacheReadPer1M: source.cacheReadPer1M,
    cacheWritePer1M: source.cacheWritePer1M,
    reasoning: source.reasoning,
    reasoningEfforts: source.reasoningEfforts,
    interleavedReasoning: source.interleavedReasoning,
    vision: source.vision,
    chatCapable: source.chatCapable,
  }
}

// Clearly non-chat names (synthesis/transcription/embeddings/etc.): a safety net only for IDs the
// catalog does not know. Existing models.dev metadata is authoritative.
const NON_CHAT_NAME =
  /(^|[-_/])(tts|asr|stt|ocr|image|video|embed(ding)?s?|rerank(er)?|whisper|voice(clone|design)?)([-_./]|$)/i

function filterChatModelIds(ids: string[], map?: Map<string, ChatModelMeta>): string[] {
  const metaOf = (id: string): ChatModelMeta | undefined => map?.get(id) ?? map?.get(id.split('/').pop() ?? '')
  return ids.filter((id) => {
    const cap = metaOf(id)?.chatCapable
    if (cap === false) return false
    if (cap === true) return true
    return !NON_CHAT_NAME.test(id)
  })
}

/**
 * Synchronous filter for discovery paths that cannot wait for the network. Use a warmed catalog when
 * available; on cold start, retain unknown models unless their IDs are clearly incompatible with chat.
 */
export function filterChatModelsSnapshot(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) return []
  return filterChatModelIds(ids, cache?.map)
}

/**
 * Filter model IDs to those usable for text/code chat (models.dev chatCapable). Models known to be
 * non-chat (chatCapable === false: TTS, ASR, image/video) are excluded; unknown models without metadata
 * or while offline remain because the catalog may not cover the user provider, unless their names reveal
 * a non-chat purpose (tts/asr/embed/etc.). Preserve input order.
 */
export async function filterChatModels(ids: string[]): Promise<string[]> {
  if (!Array.isArray(ids) || ids.length === 0) return []
  return filterChatModelIds(ids, await loadCatalog())
}
