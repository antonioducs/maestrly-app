import { describe, it, expect } from 'vitest'
import { createDeltaCoalescer } from '../../src/main/chat/delta-coalescer'
import type { ChatStreamEvent } from '../../src/shared/chat'

/**
 * Coalescer with a manual timer: the injected schedule retains a callback instead of using setTimeout.
 * Each test controls timed flushes deterministically without fake timers.
 */
function harness() {
  const out: ChatStreamEvent[] = []
  let pending: (() => void) | null = null
  const c = createDeltaCoalescer((ev) => out.push(ev), {
    schedule: (fn) => {
      pending = fn
      return () => {
        pending = null
      }
    },
  })
  return {
    out,
    push: (ev: ChatStreamEvent) => c.push(ev),
    flush: () => c.flush(),
    dispose: () => c.dispose(),
    /** Simulate the timer firing after roughly 40 ms. */
    fireTimer: () => {
      const fn = pending
      pending = null
      fn?.()
    },
    hasTimer: () => pending != null,
  }
}

const td = (partId: string, delta: string, messageId = 'a1'): ChatStreamEvent => ({
  kind: 'text-delta',
  messageId,
  partId,
  delta,
})
const rd = (partId: string, delta: string, messageId = 'a1'): ChatStreamEvent => ({
  kind: 'reasoning-delta',
  messageId,
  partId,
  delta,
})

describe('createDeltaCoalescer (#559)', () => {
  it('concatenates text-delta events for the same partId and emits on the timed flush', () => {
    const h = harness()
    h.push(td('p1', 'Hello'))
    h.push(td('p1', ', '))
    h.push(td('p1', 'world'))
    expect(h.out).toHaveLength(0) // nothing emitted yet (buffered)
    h.fireTimer()
    expect(h.out).toEqual([{ kind: 'text-delta', messageId: 'a1', partId: 'p1', delta: 'Hello, world' }])
  })

  it('coalesced text produces the same state as folding token by token', async () => {
    const { applyChatEvent } = await import('../../src/shared/chat')
    type Msg = Parameters<typeof applyChatEvent>[0]
    const base: Msg = [{ id: 'a1', conversationId: 'c', role: 'assistant', parts: [], createdAt: 1 }]
    // token by token without coalescing
    let tokenByToken = base
    for (const d of ['Hello', ', ', 'world']) tokenByToken = applyChatEvent(tokenByToken, td('p1', d))
    // coalesced
    const h = harness()
    for (const d of ['Hello', ', ', 'world']) h.push(td('p1', d))
    h.fireTimer()
    let coalesced = base
    for (const ev of h.out) coalesced = applyChatEvent(coalesced, ev)
    expect(coalesced[0].parts).toEqual(tokenByToken[0].parts)
  })

  it('drains before a non-delta event to preserve text→tool order', () => {
    const h = harness()
    h.push(td('p1', 'will read'))
    h.push({ kind: 'tool-call', messageId: 'a1', toolCallId: 'k', toolName: 'read', input: {} })
    // emit the concatenated text-delta before the tool-call without reordering
    expect(h.out).toEqual([
      { kind: 'text-delta', messageId: 'a1', partId: 'p1', delta: 'will read' },
      { kind: 'tool-call', messageId: 'a1', toolCallId: 'k', toolName: 'read', input: {} },
    ])
    expect(h.hasTimer()).toBe(false) // draining canceled the pending timer
  })

  it('emits different parts (reasoning vs text) in their original order', () => {
    const h = harness()
    h.push(rd('r1', 'thinking'))
    h.push(rd('r1', '...'))
    h.push(td('t1', 'answer')) // new partId → drain reasoning first
    h.flush()
    expect(h.out).toEqual([
      { kind: 'reasoning-delta', messageId: 'a1', partId: 'r1', delta: 'thinking...' },
      { kind: 'text-delta', messageId: 'a1', partId: 't1', delta: 'answer' },
    ])
  })

  it('flush() empties the pending buffer at the end of the turn', () => {
    const h = harness()
    h.push(td('p1', 'final'))
    expect(h.out).toHaveLength(0)
    h.flush()
    expect(h.out).toEqual([{ kind: 'text-delta', messageId: 'a1', partId: 'p1', delta: 'final' }])
  })

  it('dispose() cancels the timer and drops the buffer without leaks or emissions from a background turn', () => {
    const h = harness()
    h.push(td('p1', 'x'))
    expect(h.hasTimer()).toBe(true)
    h.dispose()
    expect(h.hasTimer()).toBe(false)
    h.fireTimer() // emit nothing even if the timer fires later
    expect(h.out).toHaveLength(0)
  })

  it('passes non-delta events through in order when the buffer is empty', () => {
    const h = harness()
    h.push({ kind: 'message-start', messageId: 'a1', createdAt: 1, responseStartedAt: 0 })
    h.push({ kind: 'finish', messageId: 'a1', finishReason: 'stop', responseDurationMs: 1 })
    expect(h.out).toEqual([
      { kind: 'message-start', messageId: 'a1', createdAt: 1, responseStartedAt: 0 },
      { kind: 'finish', messageId: 'a1', finishReason: 'stop', responseDurationMs: 1 },
    ])
  })
})
