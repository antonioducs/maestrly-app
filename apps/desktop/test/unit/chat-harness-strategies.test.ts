import { describe, expect, it } from 'vitest'
import { createPostToolReadGuidance } from '../../src/main/chat/harness/strategies/post-tool-read-guidance'
import { withEnvironmentOnLastUserMessage } from '../../src/main/chat/harness/strategies/environment'
import { createHarnessPostToolUseHooks } from '../../src/main/chat/harness/adapters/claude'
import { resolveChatHarness } from '../../src/main/chat/harness/execution'

const GUIDANCE = 'BATCH READS'

describe('post-tool-read guidance strategy', () => {
  it('delivers once per eligible tool-use id', () => {
    const strategy = createPostToolReadGuidance({ text: GUIDANCE })
    expect(strategy.guidanceFor('read', 'a')).toBe(GUIDANCE)
    expect(strategy.guidanceFor('read', 'a')).toBeNull()
    expect(strategy.guidanceFor('grep', 'b')).toBe(GUIDANCE)
  })

  it('normalizes qualified tool names and ignores non-read tools', () => {
    const strategy = createPostToolReadGuidance({ text: GUIDANCE })
    expect(strategy.guidanceFor('mcp__maestrly__Glob', 'a')).toBe(GUIDANCE)
    expect(strategy.guidanceFor('bash', 'b')).toBeNull()
    expect(strategy.guidanceFor('edit', 'c')).toBeNull()
  })

  it('requires a tool-use id and honors the reminder cap', () => {
    const strategy = createPostToolReadGuidance({ text: GUIDANCE, maxReminders: 2 })
    expect(strategy.guidanceFor('read', null)).toBeNull()
    expect(strategy.guidanceFor('read', 'a')).toBe(GUIDANCE)
    expect(strategy.guidanceFor('read', 'b')).toBe(GUIDANCE)
    expect(strategy.guidanceFor('read', 'c')).toBeNull()
  })

  it('defaults to 24 reminders', () => {
    const strategy = createPostToolReadGuidance({ text: GUIDANCE })
    const delivered = Array.from({ length: 30 }, (_, index) => strategy.guidanceFor('read', `id-${index}`))
    expect(delivered.filter(Boolean)).toHaveLength(24)
  })

  it('isolates state between two executions', () => {
    const first = createPostToolReadGuidance({ text: GUIDANCE, maxReminders: 1 })
    const second = createPostToolReadGuidance({ text: GUIDANCE, maxReminders: 1 })
    expect(first.guidanceFor('read', 'a')).toBe(GUIDANCE)
    expect(first.guidanceFor('read', 'b')).toBeNull()
    expect(second.guidanceFor('read', 'a')).toBe(GUIDANCE)
  })
})

describe('claude adapter hook translation', () => {
  const post = (toolName: string, id: string) => ({
    hook_event_name: 'PostToolUse' as const,
    tool_name: toolName,
    tool_use_id: id,
  })

  it('builds a hook only for a profile that declares one', async () => {
    const fable = resolveChatHarness('claude-subscription', 'claude-fable-5-1').harness
    const plain = resolveChatHarness('claude-subscription', 'claude-sonnet-4').harness
    expect(createHarnessPostToolUseHooks(plain)).toBeNull()
    const matcher = createHarnessPostToolUseHooks(fable)
    expect(matcher).not.toBeNull()
    const run = matcher!.hooks[0]!
    const first = (await run(post('read', 'a') as never, undefined, {
      signal: new AbortController().signal,
    })) as { hookSpecificOutput?: { additionalContext?: string } }
    expect(first.hookSpecificOutput?.additionalContext).toBe(fable.hooks[0]!.text)
    const repeat = await run(post('read', 'a') as never, undefined, { signal: new AbortController().signal })
    expect(repeat).toEqual({})
    const ignored = await run(post('bash', 'z') as never, undefined, { signal: new AbortController().signal })
    expect(ignored).toEqual({})
  })

  it('gives each execution its own hook instance', async () => {
    const fable = resolveChatHarness('claude-subscription', 'claude-fable-5-1').harness
    const runA = createHarnessPostToolUseHooks(fable)!.hooks[0]!
    const runB = createHarnessPostToolUseHooks(fable)!.hooks[0]!
    const ctx = { signal: new AbortController().signal }
    await runA(post('read', 'a') as never, undefined, ctx)
    const second = (await runB(post('read', 'a') as never, undefined, ctx)) as {
      hookSpecificOutput?: { additionalContext?: string }
    }
    expect(second.hookSpecificOutput?.additionalContext).toBe(fable.hooks[0]!.text)
  })
})

describe('environment placement strategy', () => {
  it('prepends to the last user message and preserves the rest', () => {
    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'second' }] },
    ]
    const result = withEnvironmentOnLastUserMessage(messages, 'OS: macOS.')
    expect(result[0]).toEqual(messages[0])
    expect(result[1]).toEqual(messages[1])
    expect(result[2]!.content).toEqual([
      { type: 'text', text: '# Current environment\nOS: macOS.' },
      { type: 'text', text: 'second' },
    ])
  })

  it('creates a user message when none exists', () => {
    expect(withEnvironmentOnLastUserMessage([], 'OS: Linux.')).toEqual([
      { role: 'user', content: [{ type: 'text', text: '# Current environment\nOS: Linux.' }] },
    ])
  })
})
