import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { toModelMessages, withAnthropicCacheControl } from '../../src/main/chat/message'
import type { ChatMessage } from '../../src/shared/chat'

const messages: ModelMessage[] = [
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'second' },
  { role: 'user', content: 'third' },
  { role: 'assistant', content: 'fourth' },
  { role: 'user', content: 'fifth' },
]
const cache = (list: ModelMessage[]) =>
  list.map((message) => (message.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl)

describe('Anthropic prompt-cache lifetime', () => {
  it('keeps the older breakpoints for an hour and the newest for five minutes, in the order Anthropic requires', () => {
    expect(cache(withAnthropicCacheControl(messages, { longTtl: true }))).toEqual([
      { type: 'ephemeral', ttl: '1h' },
      undefined,
      undefined,
      { type: 'ephemeral', ttl: '1h' },
      { type: 'ephemeral' },
    ])
  })

  it('stays on five minutes by default and with a single message', () => {
    expect(cache(withAnthropicCacheControl(messages))).toEqual([
      { type: 'ephemeral' },
      undefined,
      undefined,
      { type: 'ephemeral' },
      { type: 'ephemeral' },
    ])
    expect(cache(withAnthropicCacheControl(messages.slice(0, 1), { longTtl: true }))).toEqual([{ type: 'ephemeral' }])
  })

  it('recomputes breakpoints instead of accumulating them on a growing request', () => {
    const once = withAnthropicCacheControl(messages.slice(0, 3), { longTtl: true })
    const again = withAnthropicCacheControl([...once, ...messages.slice(3)], { longTtl: true })
    expect(cache(again).filter(Boolean)).toHaveLength(3)
    expect(cache(again)[2]).toBeUndefined()
  })

  it('applies the lifetime through toModelMessages', () => {
    const history: ChatMessage[] = messages.map((message, index) => ({
      id: `m${index}`,
      conversationId: 'c',
      role: message.role as 'user' | 'assistant',
      createdAt: index,
      parts: [{ type: 'text', id: `t${index}`, text: String(message.content) }],
    }))
    const sent = toModelMessages(history, { cacheControl: true, longCacheTtl: true })
    expect(cache(sent)[0]).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(cache(sent).at(-1)).toEqual({ type: 'ephemeral' })
    expect(JSON.stringify(toModelMessages(history))).not.toContain('cacheControl')
  })
})
