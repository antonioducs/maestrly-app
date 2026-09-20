import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessagePart } from '../../src/shared/chat'
import { effectiveBackgroundCompactionInterval } from '../../src/main/chat/background-compaction/config'
import {
  backgroundCompactionSourceHash,
  selectBackgroundCompactionTarget,
} from '../../src/main/chat/background-compaction/policy'

function message(id: string, role: 'user' | 'assistant', parts: MessagePart[], finishReason?: string): ChatMessage {
  return { id, conversationId: 'conversation', role, parts, createdAt: 1, ...(finishReason ? { finishReason } : {}) }
}

function text(id: string, length: number): MessagePart {
  return { type: 'text', id, text: 'x'.repeat(length) }
}

describe('background compaction policy', () => {
  it('caps the configured interval only at half of the active conversation window', () => {
    expect(effectiveBackgroundCompactionInterval(200_000, 1_000_000)).toBe(200_000)
    expect(effectiveBackgroundCompactionInterval(100_000, 1_000_000)).toBe(100_000)
    expect(effectiveBackgroundCompactionInterval(100_000, 128_000)).toBe(64_000)
  })

  it('selects the first exact part boundary at the interval, including a same-message prefix', () => {
    const messages = [
      message('assistant', 'assistant', [text('part-1', 150_000), text('part-2', 60_000), text('part-3', 30_000)]),
    ]
    const target = selectBackgroundCompactionTarget(messages, 64_000, {
      messageId: 'assistant',
      partId: 'part-2',
    })

    expect(target?.boundary).toEqual({ messageId: 'assistant', partId: 'part-2', partIndex: 1 })
    expect(target?.newTokens).toBeGreaterThanOrEqual(64_000)
    const hash = target!.sourceHash
    messages[0].parts[2] = text('part-3', 60_000)
    expect(backgroundCompactionSourceHash(messages, target!.boundary)).toBe(hash)
    messages[0].parts[0] = text('part-1', 150_001)
    expect(backgroundCompactionSourceHash(messages, target!.boundary)).not.toBe(hash)
  })

  it('never crosses pending, awaiting-permission, or running tools', () => {
    for (const state of [
      { status: 'pending' as const },
      { status: 'awaiting-permission' as const },
      { status: 'running' as const },
    ]) {
      const messages = [
        message('assistant', 'assistant', [
          text('before', 30),
          { type: 'tool', id: 'tool', toolCallId: 'call', toolName: 'shell', input: {}, state },
          text('after', 30_000),
        ]),
      ]
      expect(selectBackgroundCompactionTarget(messages, 100, { messageId: 'assistant', partId: 'after' })).toBeNull()
    }
  })

  it('uses only proven completed assistant messages without a runner boundary', () => {
    const incomplete = message('incomplete', 'assistant', [text('incomplete-part', 3_000)])
    const completed = message('completed', 'assistant', [text('completed-part', 3_000)], 'stop')

    expect(selectBackgroundCompactionTarget([incomplete], 100)).toBeNull()
    expect(selectBackgroundCompactionTarget([incomplete, completed], 100)).toBeNull()
    expect(selectBackgroundCompactionTarget([completed], 100)?.boundary.partId).toBe('completed-part')
  })

  it('advances one interval per target instead of selecting an entire old transcript', () => {
    const messages = Array.from({ length: 4 }, (_, index) =>
      message(`assistant-${index}`, 'assistant', [text(`part-${index}`, 90_000)], 'stop')
    )
    const first = selectBackgroundCompactionTarget(messages, 25_000)
    expect(first?.boundary.partId).toBe('part-0')
  })

  it('does not count the active compaction summary toward a new interval', () => {
    const messages = [
      message('marker', 'assistant', [
        { type: 'compaction', id: 'summary', text: 'old summary '.repeat(100_000), strategy: 'summary' },
        text('small-suffix', 30),
      ]),
    ]

    expect(selectBackgroundCompactionTarget(messages, 100, { messageId: 'marker', partId: 'small-suffix' })).toBeNull()
  })
  it('prepares old completed multi-step messages by intervals rather than selecting their entire body', () => {
    const messages = [
      message('old', 'assistant', [text('first', 300000), text('second', 300000), text('third', 300000)], 'stop'),
    ]
    expect(selectBackgroundCompactionTarget(messages, 100000)?.boundary.partId).toBe('first')
  })
})
