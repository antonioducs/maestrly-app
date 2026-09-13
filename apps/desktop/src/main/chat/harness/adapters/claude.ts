import type { HookCallbackMatcher, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import { createPostToolReadGuidance } from '../strategies/post-tool-read-guidance'
import type { ResolvedHarness } from '../types'

/**
 * Translates generic harness strategies into the Claude Agent SDK contract. Every hook instance is
 * created per execution, so counters and dedup sets never leak between turns or conversations.
 */
export function createHarnessPostToolUseHooks(harness: ResolvedHarness): HookCallbackMatcher | null {
  const declared = harness.hooks.filter((hook) => hook.id === 'post-tool-read-guidance')
  if (declared.length === 0) return null
  const strategies = declared.map((hook) =>
    createPostToolReadGuidance({ text: hook.text, maxReminders: hook.maxReminders })
  )
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PostToolUse') return {}
        const post = input as PostToolUseHookInput
        for (const strategy of strategies) {
          const guidance = strategy.guidanceFor(post.tool_name, post.tool_use_id)
          if (guidance) {
            return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: guidance } }
          }
        }
        return {}
      },
    ],
  }
}

/** Anthropic transports execute the behavioral axis only; Responses-specific capabilities stay off. */
export function claudeAdapterCapabilities(): Record<string, boolean> {
  return {}
}
