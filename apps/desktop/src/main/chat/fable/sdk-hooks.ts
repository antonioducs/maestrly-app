import type { HookCallbackMatcher, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'

const READ_TOOLS = new Set(['read', 'grep', 'glob', 'webfetch', 'memory_search', 'memory_list', 'memory_read'])
const BATCHING_REMINDER =
  'If more independent reads or searches are needed, group them in parallel before continuing; keep dependent operations sequential.'

function canonicalToolName(value: string): string {
  const unqualified = value.startsWith('mcp__maestrly__') ? value.slice('mcp__maestrly__'.length) : value
  return unqualified.toLowerCase()
}

export interface FablePostToolUseHookOptions {
  maxReminders?: number
}

/** Adds bounded, deduplicated batching guidance without rewriting results or changing permissions. */
export function createFablePostToolUseHook(options: FablePostToolUseHookOptions = {}): HookCallbackMatcher {
  const delivered = new Set<string>()
  const maxReminders = Math.max(1, Math.floor(options.maxReminders ?? 24))
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PostToolUse') return {}
        const post = input as PostToolUseHookInput
        if (!READ_TOOLS.has(canonicalToolName(post.tool_name))) return {}
        if (!post.tool_use_id || delivered.has(post.tool_use_id) || delivered.size >= maxReminders) return {}
        delivered.add(post.tool_use_id)
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: BATCHING_REMINDER,
          },
        }
      },
    ],
  }
}
