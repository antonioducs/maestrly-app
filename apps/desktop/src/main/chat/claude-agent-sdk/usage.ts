export interface NormalizedClaudeUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  totalInput: number
}

function tokens(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

/**
 * Anthropic reports uncached input, cache reads, and cache writes as disjoint
 * buckets. Keep them disjoint for ChatUsage v2 and sum them only for totalInput.
 */
export function normalizeClaudeUsage(usage: {
  input_tokens?: unknown
  output_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
}): NormalizedClaudeUsage {
  const input = tokens(usage.input_tokens)
  const cacheRead = tokens(usage.cache_read_input_tokens)
  const cacheCreate = tokens(usage.cache_creation_input_tokens)
  return {
    input,
    output: tokens(usage.output_tokens),
    cacheRead,
    cacheCreate,
    totalInput: input + cacheRead + cacheCreate,
  }
}
