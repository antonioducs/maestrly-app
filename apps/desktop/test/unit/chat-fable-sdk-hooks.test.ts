import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { createFablePostToolUseHook } from '../../src/main/chat/fable/sdk-hooks'

const postTool = (toolName: string, toolUseId: string): HookInput =>
  ({
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    transcript_path: '/tmp/transcript',
    cwd: '/repo',
    permission_mode: 'dontAsk',
    tool_name: toolName,
    tool_input: {},
    tool_response: { ok: true },
    tool_use_id: toolUseId,
  }) as HookInput

describe('Fable Agent SDK hooks', () => {
  it('adds bounded context once per relevant tool result without rewriting it', async () => {
    const matcher = createFablePostToolUseHook({ maxReminders: 1 })
    const hook = matcher.hooks[0]!
    const first = await hook(postTool('mcp__maestrly__read', 'read-1'), 'read-1', {
      signal: new AbortController().signal,
    })
    expect(first).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: expect.stringContaining('group them in parallel'),
      },
    })
    expect(first).not.toHaveProperty('decision')
    expect(first).not.toHaveProperty('systemMessage')
    expect(first).not.toHaveProperty('updatedMCPToolOutput')
    expect(
      await hook(postTool('mcp__maestrly__read', 'read-1'), 'read-1', { signal: new AbortController().signal })
    ).toEqual({})
    expect(
      await hook(postTool('mcp__maestrly__grep', 'grep-2'), 'grep-2', { signal: new AbortController().signal })
    ).toEqual({})
  })

  it('ignores mutating and terminal tools', async () => {
    const hook = createFablePostToolUseHook().hooks[0]!
    for (const tool of ['edit', 'bash', 'review_plan', 'submit_review']) {
      expect(
        await hook(postTool(`mcp__maestrly__${tool}`, `${tool}-1`), `${tool}-1`, {
          signal: new AbortController().signal,
        })
      ).toEqual({})
    }
  })
})
