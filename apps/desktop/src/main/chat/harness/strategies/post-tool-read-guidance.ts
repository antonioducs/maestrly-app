const READ_TOOLS = new Set(['read', 'grep', 'glob', 'webfetch', 'memory_search', 'memory_list', 'memory_read'])

function canonicalToolName(value: string): string {
  const unqualified = value.startsWith('mcp__maestrly__') ? value.slice('mcp__maestrly__'.length) : value
  return unqualified.toLowerCase()
}

export interface PostToolReadGuidanceOptions {
  text: string
  maxReminders?: number
}

export interface PostToolReadGuidanceStrategy {
  /** Returns the guidance to attach once for an eligible, not-yet-reminded read, or null. */
  guidanceFor(toolName: string, toolUseId: string | null | undefined): string | null
}

/**
 * Bounded, deduplicated batching guidance. It never rewrites results or changes permissions, and the
 * state is per execution: a shared profile object must not accumulate counters across turns.
 */
export function createPostToolReadGuidance(options: PostToolReadGuidanceOptions): PostToolReadGuidanceStrategy {
  const delivered = new Set<string>()
  const maxReminders = Math.max(1, Math.floor(options.maxReminders ?? 24))
  return {
    guidanceFor(toolName, toolUseId) {
      if (!READ_TOOLS.has(canonicalToolName(toolName))) return null
      if (!toolUseId || delivered.has(toolUseId) || delivered.size >= maxReminders) return null
      delivered.add(toolUseId)
      return options.text
    },
  }
}
