import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getChatMessage, toPublicChatMessage, upsertChatMessage } from '../../src/main/chat/chat-store'

beforeEach(freshDb)
afterEach(closeDb)
it('persists bot authorship per message without relabeling human follow-ups', () => {
  const conversation = makeConversation(makeWorkspace().id)
  const base = { conversationId: conversation.id, role: 'user' as const, parts: [], createdAt: Date.now() }
  upsertChatMessage({ ...base, id: 'bot-message', botName: 'Grok Bot' })
  upsertChatMessage({ ...base, id: 'human-message' })
  restartDb()
  expect(toPublicChatMessage(getChatMessage(conversation.id, 'bot-message')!).botName).toBe('Grok Bot')
  expect(toPublicChatMessage(getChatMessage(conversation.id, 'human-message')!).botName).toBeUndefined()
})
