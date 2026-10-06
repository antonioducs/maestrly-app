import { beforeEach, afterEach, expect, it } from 'vitest'
import { freshDb, closeDb, restartDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import { getConversation, getDb } from '../../src/main/store'
import { setBotManagementState, setBotManualChatEnabled } from '../../src/main/bot/store'
import { botBlocksManualSend } from '../../src/main/bot/control'

beforeEach(freshDb)
afterEach(closeDb)

it('keeps origin immutable while allowing the owner to pause control', () => {
  const conversation = makeConversation(makeWorkspace().id)
  const origin = { kind: 'bot', connectionId: 'grok', botName: 'Grok Bot' }
  getDb()
    .prepare("UPDATE conversations SET bot_origin=?,bot_management_state='active' WHERE id=?")
    .run(JSON.stringify(origin), conversation.id)
  setBotManagementState(conversation.id, 'paused')
  restartDb()
  expect(getConversation(conversation.id)).toMatchObject({ botOrigin: origin, botManagementState: 'paused' })
  expect(() => getDb().prepare('UPDATE conversations SET bot_origin=NULL WHERE id=?').run(conversation.id)).toThrow(
    /immutable/
  )
  setBotManagementState(conversation.id, 'revoked')
  expect(() => setBotManagementState(conversation.id, 'active')).toThrow(/Revoked/)
})

it('does not assign bot ownership to existing human conversations', () => {
  const conversation = makeConversation(makeWorkspace().id)
  restartDb()
  expect(getConversation(conversation.id)?.botOrigin).toBeUndefined()
  expect(() => setBotManagementState(conversation.id, 'active')).toThrow(/not bot-owned/)
  expect(() => setBotManualChatEnabled(conversation.id, true)).toThrow(/not bot-owned/)
  // A chat the person started is theirs: nothing about bots may block what they write in it.
  expect(botBlocksManualSend(conversation.id)).toBe(false)
})

it('releases one bot chat for the person without moving the bot out of it', () => {
  const workspace = makeWorkspace().id
  const released = makeConversation(workspace)
  const other = makeConversation(workspace)
  const origin = { kind: 'bot', connectionId: 'grok', botName: 'Grok Bot' }
  for (const id of [released.id, other.id])
    getDb()
      .prepare("UPDATE conversations SET bot_origin=?,bot_management_state='active' WHERE id=?")
      .run(JSON.stringify(origin), id)

  // A bot chat starts closed to manual messages, and a conversation that predates the choice keeps that.
  expect(getConversation(released.id)?.botManualChatEnabled).toBe(false)
  expect(botBlocksManualSend(released.id)).toBe(true)

  setBotManualChatEnabled(released.id, true)
  restartDb()
  const conversation = getConversation(released.id)
  expect(conversation?.botManualChatEnabled).toBe(true)
  // Releasing is not a pause: the bot still owns the chat and may send at any time.
  expect(conversation?.botManagementState).toBe('active')
  expect(botBlocksManualSend(released.id)).toBe(false)
  // The choice is per conversation; the other bot chat is untouched.
  expect(getConversation(other.id)?.botManualChatEnabled).toBe(false)
  expect(botBlocksManualSend(other.id)).toBe(true)

  // Pausing and resuming the bot preserves what the person decided about their own messages.
  setBotManagementState(released.id, 'paused')
  expect(getConversation(released.id)?.botManualChatEnabled).toBe(true)
  setBotManagementState(released.id, 'active')
  expect(botBlocksManualSend(released.id)).toBe(false)

  setBotManualChatEnabled(released.id, false)
  expect(getConversation(released.id)?.botManualChatEnabled).toBe(false)
  expect(botBlocksManualSend(released.id)).toBe(true)
})

it('keeps the block in force when releasing the chat cannot be written', () => {
  const conversation = makeConversation(makeWorkspace().id)
  getDb()
    .prepare("UPDATE conversations SET bot_origin=?,bot_management_state='active' WHERE id=?")
    .run(JSON.stringify({ kind: 'bot', connectionId: 'grok', botName: 'Grok Bot' }), conversation.id)
  getDb().exec('PRAGMA query_only = ON;')
  try {
    expect(() => setBotManualChatEnabled(conversation.id, true)).toThrow()
  } finally {
    getDb().exec('PRAGMA query_only = OFF;')
  }
  expect(getConversation(conversation.id)?.botManualChatEnabled).toBe(false)
  expect(botBlocksManualSend(conversation.id)).toBe(true)
})
