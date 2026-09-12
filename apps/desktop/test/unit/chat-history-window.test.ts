import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatStreamEvent } from '../../src/shared/chat'
import { applyChatEvent } from '../../src/shared/chat'
import {
  boundChatHistoryWindow,
  CHAT_HISTORY_MAX_BYTES,
  CHAT_HISTORY_MAX_MESSAGES,
  estimateHistoryWindowBytes,
} from '../../src/renderer/lib/chat-history-window'

/**
 * History message and byte budgets are invariants
 * for replacement, prepend and live streaming growth,
 * not merely the original pagination path.
 */

function textMessage(id: string, text = 'x'): ChatMessage {
  return {
    id,
    conversationId: 'c1',
    role: 'user',
    parts: [{ type: 'text', id: `${id}:p`, text }],
    createdAt: 1,
  }
}

function heavyMessage(id: string, textSize: number): ChatMessage {
  return textMessage(id, 'x'.repeat(textSize))
}

function messageStart(messageId: string): ChatStreamEvent {
  return { kind: 'message-start', messageId, createdAt: 2, responseStartedAt: 2 }
}

describe('history prepend regression contract', () => {
  it('trims newest history to preserve older prepended messages', () => {
    const current = Array.from({ length: CHAT_HISTORY_MAX_MESSAGES }, (_, i) => textMessage(`m${i}`))
    const incoming = Array.from({ length: 50 }, (_, i) => textMessage(`old${i}`))

    const next = boundChatHistoryWindow({ messages: current, incoming, side: 'prepend', keepIds: new Set() })

    expect(next.messages).toHaveLength(CHAT_HISTORY_MAX_MESSAGES)
    expect(next.trimmedBack).toBe(true)
    expect(next.messages[0]?.id).toBe('old0') // Older messages remain.
    expect(next.messages.at(-1)?.id).toBe(`m${CHAT_HISTORY_MAX_MESSAGES - 50 - 1}`) // Trims newer messages from the end.
  })
})

describe('oversized history replacement pages', () => {
  it('trims oversized legacy images from the front while retaining the tail', () => {
    // 3 messages of approximately 2 MiB each = approximately 6 MiB, above the 4 MiB cap.
    const page = [heavyMessage('a', 2_000_000), heavyMessage('b', 2_000_000), heavyMessage('c', 2_000_000)]

    const next = boundChatHistoryWindow({ messages: [], incoming: page, side: 'replace', keepIds: new Set() })

    expect(next.trimmedFront).toBe(true)
    expect(estimateHistoryWindowBytes(next.messages)).toBeLessThanOrEqual(CHAT_HISTORY_MAX_BYTES)
    expect(next.messages.map((m) => m.id)).toEqual(['b', 'c']) // Preserves latest-window semantics.
  })

  it('protects edited messages through keepIds despite budget overflow', () => {
    const page = [heavyMessage('edit', 2_500_000), heavyMessage('big', 2_500_000), heavyMessage('big2', 2_500_000)]

    const next = boundChatHistoryWindow({ messages: [], incoming: page, side: 'replace', keepIds: new Set(['edit']) })

    // Front trimming skips protected edit messages and removes later candidates.
    expect(next.messages.map((m) => m.id)).toEqual(['edit'])
    expect(estimateHistoryWindowBytes(next.messages)).toBeLessThanOrEqual(CHAT_HISTORY_MAX_BYTES)
  })

  it('preserves oversized live messages alone', () => {
    // ChatView passes the turn message as an anchor (keepIds); otherwise trimming the front would empty
    // the window when ONE message alone exceeds the cap.
    const page = [textMessage('small'), heavyMessage('live', 5_000_000)]

    const next = boundChatHistoryWindow({ messages: [], incoming: page, side: 'replace', keepIds: new Set(['live']) })

    expect(next.messages.map((m) => m.id)).toEqual(['live'])
    expect(next.trimmedFront).toBe(true)
    // Without anchors the result is empty; every caller must protect the live message.
    const unprotected = boundChatHistoryWindow({ messages: [], incoming: page, side: 'replace', keepIds: new Set() })
    expect(unprotected.messages).toHaveLength(0)
  })
})

describe('live streaming history bounds', () => {
  // The SAME ChatView contract: fold and normalize every event; replace trims the front.
  const fold = (window: ChatMessage[], ev: ChatStreamEvent): ChatMessage[] =>
    boundChatHistoryWindow({
      messages: [],
      incoming: applyChatEvent(window, ev),
      side: 'replace',
      keepIds: new Set(),
    }).messages

  it('trims old messages while preserving live message-start events', () => {
    let window = Array.from({ length: CHAT_HISTORY_MAX_MESSAGES }, (_, i) => textMessage(`m${i}`))

    window = fold(window, messageStart('live'))

    expect(window).toHaveLength(CHAT_HISTORY_MAX_MESSAGES)
    expect(window.at(-1)?.id).toBe('live')
    expect(window[0]?.id).toBe('m1') // The oldest message was trimmed.
  })

  it('bounds long deltas by trimming older history', () => {
    // A roughly 4.5 MiB base window plus a growing 2.8 MiB turn.
    let window = Array.from({ length: CHAT_HISTORY_MAX_MESSAGES }, (_, i) => heavyMessage(`m${i}`, 15_000))
    window = fold(window, messageStart('live'))

    const delta: ChatStreamEvent = {
      kind: 'text-delta',
      messageId: 'live',
      partId: 'live:p',
      delta: 'y'.repeat(400_000),
    }
    for (let i = 0; i < 7; i++) window = fold(window, delta)

    // The ENTIRE window (including the live message) fits the cap, and the turn message survives.
    expect(estimateHistoryWindowBytes(window)).toBeLessThanOrEqual(CHAT_HISTORY_MAX_BYTES)
    expect(window.some((m) => m.id === 'live')).toBe(true)
    // Old messages are trimmed from the front to fit the budget.
    expect(window[0]?.id).not.toBe('m0')
  })

  it('successive turns never exceed the message cap', () => {
    let window = Array.from({ length: CHAT_HISTORY_MAX_MESSAGES - 2 }, (_, i) => textMessage(`m${i}`))
    for (let turn = 0; turn < 5; turn++) {
      window = fold(window, messageStart(`live${turn}`))
      window = fold(window, {
        kind: 'finish',
        messageId: `live${turn}`,
        finishReason: 'end_turn',
        responseDurationMs: 100,
      })
      expect(window.length).toBeLessThanOrEqual(CHAT_HISTORY_MAX_MESSAGES)
    }
    expect(window.some((m) => m.id === 'live4')).toBe(true)
  })
})
