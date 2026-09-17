/**
 * Pure parser for the public models.dev catalogue (https://models.dev/api.json). Shape:
 * { [providerId]: { models: { [modelId]: { id, limit: {context, output}, cost: {input, output} } } } }
 * (prices in USD per 1M tokens). Both applications fetch the file themselves and hand the JSON here.
 */
import type { ChatModelMeta } from './cost'

export const providerModelKey = (providerId: string, modelId: string): string => `\0${providerId}\0${modelId}`

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

/**
 * The catalogue flattened to `providerId/modelId` → meta, for callers that only need a plain
 * record (the Bot's context meter and usage panel).
 */
export function parseModelsDev(json: unknown): Record<string, ChatModelMeta> {
  const out: Record<string, ChatModelMeta> = {}
  for (const [key, meta] of parseCatalog(json)) {
    if (!key.startsWith('\0')) continue
    const [, providerId, modelId] = key.split('\0')
    out[`${providerId}/${modelId}`] = meta
  }
  return out
}
