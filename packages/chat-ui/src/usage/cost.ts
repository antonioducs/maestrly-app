/**
 * Cost and context arithmetic shared by both applications. Pure: no React, no window, so the
 * desktop main process and the Bot's main process can use it as well as the renderers.
 */
export interface UsagePricing {
  inputPer1M?: number
  outputPer1M?: number
  cacheReadPer1M?: number
  cacheWritePer1M?: number
}

export interface ChatModelMeta extends UsagePricing {
  contextWindow?: number
  maxOutput?: number
  reasoning?: boolean
  reasoningEfforts?: string[]
  interleavedReasoning?: { field: string; format: 'text' }
  vision?: boolean
  chatCapable?: boolean
  /** The model advertises Fast/Priority support (Codex service tiers, Claude supportsFastMode, xAI Priority Processing). */
  fastModeCapability?: boolean
  nativeUltraMode?: boolean
  contextLimitEditable?: boolean
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead?: number
  cacheCreate?: number
}

/** The fields the context meter reads; both applications' usage records satisfy it. */
export interface ContextUsage {
  usageVersion?: 2
  input: number
  output: number
  contextInput?: number
  contextOutput?: number
  cachedInput?: number
  cacheCreate?: number
}

export function totalTokensOf(u: TokenUsage): number {
  return Math.max(0, u.input) + Math.max(0, u.output) + Math.max(0, u.cacheRead ?? 0) + Math.max(0, u.cacheCreate ?? 0)
}

export function hasUsagePricing(meta: UsagePricing | null | undefined): boolean {
  return !!meta && [meta.inputPer1M, meta.outputPer1M, meta.cacheReadPer1M, meta.cacheWritePer1M].some(Number.isFinite)
}

export function costOfUsage(t: TokenUsage, meta: UsagePricing | null | undefined): number {
  const inRate = meta?.inputPer1M ?? 0
  const outRate = meta?.outputPer1M ?? 0
  const cacheReadRate = meta?.cacheReadPer1M ?? inRate
  const cacheWriteRate = meta?.cacheWritePer1M ?? inRate * 1.25
  const input = Math.max(0, t.input)
  const output = Math.max(0, t.output)
  const cacheRead = Math.max(0, t.cacheRead ?? 0)
  const cacheCreate = Math.max(0, t.cacheCreate ?? 0)
  return (input * inRate + cacheRead * cacheReadRate + cacheCreate * cacheWriteRate + output * outRate) / 1e6
}

function hasUsagePricingFor(usage: TokenUsage, meta: UsagePricing | null | undefined): boolean {
  const hasInput = Number.isFinite(meta?.inputPer1M)
  const hasOutput = Number.isFinite(meta?.outputPer1M)
  const hasCacheRead = Number.isFinite(meta?.cacheReadPer1M) || hasInput
  const hasCacheWrite = Number.isFinite(meta?.cacheWritePer1M) || hasInput
  return (
    (Math.max(0, usage.input) === 0 || hasInput) &&
    (Math.max(0, usage.output) === 0 || hasOutput) &&
    (Math.max(0, usage.cacheRead ?? 0) === 0 || hasCacheRead) &&
    (Math.max(0, usage.cacheCreate ?? 0) === 0 || hasCacheWrite)
  )
}

/**
 * Estimated cost in USD, or null when the catalogue cannot price what was used. A runtime
 * estimate (reported by the provider itself) wins over the catalogue for the tokens it covers.
 */
export function estimatedCostOfUsage(
  usage: TokenUsage,
  meta: UsagePricing | null | undefined,
  runtimeEstimatedCostUsd?: number | null,
  catalogUsage: TokenUsage = { input: 0, output: 0 }
): number | null {
  const runtimeCost =
    typeof runtimeEstimatedCostUsd === 'number' && Number.isFinite(runtimeEstimatedCostUsd) && runtimeEstimatedCostUsd >= 0
      ? runtimeEstimatedCostUsd
      : null
  if (runtimeCost == null) return hasUsagePricingFor(usage, meta) ? costOfUsage(usage, meta) : null
  if (totalTokensOf(catalogUsage) === 0) return runtimeCost
  return hasUsagePricingFor(catalogUsage, meta) ? runtimeCost + costOfUsage(catalogUsage, meta) : null
}

export function usageMetaForModel(
  metaByModel: Record<string, ChatModelMeta | null> | undefined,
  target: { providerId: string | null; modelId: string | null },
  current: { providerId?: string | null; modelId?: string | null; meta: ChatModelMeta | null }
): ChatModelMeta | null {
  const providerId = target.providerId ?? ''
  const modelId = target.modelId ?? ''
  const key = `${providerId}\0${modelId}`
  if (metaByModel && Object.hasOwn(metaByModel, key)) return metaByModel[key]
  if (modelId && metaByModel && Object.hasOwn(metaByModel, modelId)) return metaByModel[modelId]
  if (providerId === (current.providerId ?? '') && modelId === (current.modelId ?? '')) return current.meta
  return null
}

/** Tokens currently occupying the model's window, as best the usage record can tell. */
export function contextOccupancy(u: ContextUsage): number {
  if (u.contextInput != null) return u.contextInput + (u.contextOutput ?? 0)
  return u.usageVersion === 2 ? u.input + (u.cachedInput ?? 0) + (u.cacheCreate ?? 0) + u.output : u.input + u.output
}

export const formatTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n)

export const formatCost = (c: number): string => (c >= 1 ? `$${c.toFixed(2)}` : c >= 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(4)}`)
