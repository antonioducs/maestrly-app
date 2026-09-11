import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { withOpusEnvironment } from '../../src/main/chat/opus/environment'

describe('Opus transient API environment', () => {
  it('updates only the latest user request without changing history or tool pairs', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Earlier task' },
      { role: 'assistant', content: 'Done' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Continue' },
          { type: 'image', image: new URL('https://example.com/ui.png') },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read', input: { path: 'app.ts' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'read-1', toolName: 'read', output: { type: 'text', value: 'source' } },
        ],
      },
    ]
    const original = JSON.stringify(messages)
    const first = withOpusEnvironment(messages, 'Monday, branch main, clean')
    const second = withOpusEnvironment(messages, 'Tuesday, branch fix, dirty')
    expect(JSON.stringify(messages)).toBe(original)
    expect(first.slice(0, 2)).toEqual(messages.slice(0, 2))
    expect(first.slice(3)).toEqual(messages.slice(3))
    expect(first[2]?.content).toEqual([
      { type: 'text', text: '# Current environment\nMonday, branch main, clean' },
      ...(messages[2]!.content as object[]),
    ])
    expect(JSON.stringify(second)).not.toContain('Monday')
    expect(JSON.stringify(second)).toContain('Tuesday')
  })

  it('preserves string requests and provides context for an empty transcript', () => {
    expect(withOpusEnvironment([{ role: 'user', content: 'Fix it' }], 'env')[0]?.content).toEqual([
      { type: 'text', text: '# Current environment\nenv' },
      { type: 'text', text: 'Fix it' },
    ])
    expect(withOpusEnvironment([], 'env')).toEqual([
      { role: 'user', content: [{ type: 'text', text: '# Current environment\nenv' }] },
    ])
  })
})
