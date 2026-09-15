import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import { activeChatContext, isProviderNativeCompactionMarker, parseParts } from '../../src/main/chat/message'
import { chatHistoryStats, listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import type { ChatMessage, MessagePart } from '../../src/shared/chat'

beforeEach(freshDb)
afterEach(closeDb)

describe('Codex native compaction markers', () => {
  const marker: MessagePart = {
    type: 'compaction',
    id: 'native',
    strategy: 'codex-native',
    text: 'Runtime compacted context.',
  }

  it('preserves all message parts on reload and does not turn a native marker into a portable summary', () => {
    const parts: MessagePart[] = [{ type: 'text', id: 'before', text: 'Keep this work.' }, marker]
    expect(parseParts(JSON.stringify(parts))).toEqual(parts)
    expect(isProviderNativeCompactionMarker(marker)).toBe(true)
    const message: ChatMessage = { id: 'assistant', conversationId: 'conv', role: 'assistant', parts, createdAt: 1 }
    const active = activeChatContext([message])
    expect(active.summary).toBeFalsy()
    expect(active.messages.flatMap((m) => m.parts)).toContainEqual(parts[0])
  })

  it('uses native checkpoint occupancy only for a validated runtime binding', () => {
    const conv = makeConversation(makeWorkspace().id, { mode: 'local' })
    upsertChatMessage({
      id: 'before',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      createdAt: 1,
      usage: { input: 800_000, output: 1, contextInput: 800_000, contextOutput: 1 },
    })
    upsertChatMessage({
      id: 'checkpoint',
      conversationId: conv.id,
      role: 'assistant',
      parts: [marker],
      createdAt: 2,
      usage: { input: 0, output: 0, contextInput: 50_000, contextOutput: 0, billingOnly: true },
    })
    expect(listChatMessages(conv.id)[1].parts).toEqual([marker])
    expect(chatHistoryStats(conv.id).lastUsage?.contextInput).toBe(800_000)
    expect(chatHistoryStats(conv.id, { isNativeCompactionActive: () => true }).lastUsage?.contextInput).toBe(50_000)
  })
})
