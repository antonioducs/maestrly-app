/**
 * What a bot reads back from a chat the person released. It must find what they wrote, page through a
 * chat larger than the relay ever held, and still carry nothing private out of this computer.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { bindBotConversation, reserveBotConversation } from '../../src/main/bot/store'
import { readBotChatHistory } from '../../src/main/bot/transcript'
import { getDb } from '../../src/main/store'
import type { BotIdentity } from '../../src/shared/bot'
import type { MessagePart } from '../../src/shared/chat'

const identity: BotIdentity = {
  instanceId: 'local',
  ownerUserId: 'owner',
  desktopId: 'desktop',
  connectionId: 'grok',
  botName: 'Grok Bot',
}

let workspaceId: string
let localId: string
/** The chat id the bot knows, which is the allocation request it created the chat under. */
let publicId: string

beforeEach(() => {
  freshDb()
  workspaceId = makeWorkspace().id
  localId = makeConversation(workspaceId).id
  publicId = randomUUID()
  bind(publicId, localId)
  getDb()
    .prepare("UPDATE conversations SET bot_origin=?,bot_management_state='active',bot_manual_chat_enabled=1 WHERE id=?")
    .run(JSON.stringify({ kind: 'bot', connectionId: 'grok', botName: 'Grok Bot' }), localId)
})
afterEach(closeDb)

function bind(requestId: string, conversationId: string, connectionId = 'grok'): void {
  const allocationId = randomUUID()
  reserveBotConversation({
    instanceId: 'local',
    ownerUserId: 'owner',
    desktopId: 'desktop',
    connectionId,
    requestId,
    allocationId,
    conversationId: null,
    workspaceId,
    branch: `bot/${allocationId.slice(0, 8)}`,
    cwd: `/tmp/bot-${allocationId.slice(0, 8)}`,
    baseBranch: 'main',
    name: 'Bot chat',
    fingerprint: allocationId,
    phase: 'reserved',
    error: null,
  })
  bindBotConversation(allocationId, conversationId)
}

function say(
  text: string,
  options: { role?: 'user' | 'assistant'; botName?: string; createdAt?: number; parts?: MessagePart[] } = {}
): string {
  const id = randomUUID()
  upsertChatMessage({
    id,
    conversationId: localId,
    role: options.role ?? 'user',
    createdAt: options.createdAt ?? 1_000,
    parts: options.parts ?? [{ type: 'text', id: randomUUID(), text }],
    ...(options.botName ? { botName: options.botName } : {}),
  })
  return id
}

const page = (input: { cursor?: string | null; limit?: number } = {}) =>
  readBotChatHistory({ identity, conversationId: publicId, ...input })

it('reads back what the person wrote and what it answered, in order', () => {
  say('Report the evidence.', { botName: 'Grok Bot', createdAt: 1 })
  say('Evidence reported.', { role: 'assistant', createdAt: 2 })
  say('My own correction, written here.', { createdAt: 3 })
  say('Understood; applying the correction.', { role: 'assistant', createdAt: 4 })
  restartDb()

  const first = page()
  expect(first.messages.map((message) => message.text)).toEqual([
    'Report the evidence.',
    'Evidence reported.',
    'My own correction, written here.',
    'Understood; applying the correction.',
  ])
  // Authorship stays honest: the bot's own message is labelled, the person's is not.
  expect(first.messages[0]).toMatchObject({ role: 'user', botName: 'Grok Bot' })
  expect(first.messages[2].botName).toBeUndefined()
  expect(first.messages[0].createdAt).toBe(new Date(1).toISOString())
  expect(first.hasMore).toBe(false)
  expect(first.nextCursor).toBeNull()
  // Ids are the chat's own and do not move between reads or restarts.
  restartDb()
  expect(page().messages.map((message) => message.id)).toEqual(first.messages.map((message) => message.id))
})

it('pages past the 500 the relay holds, on a ceiling later messages cannot move', () => {
  for (let index = 1; index <= 620; index++) say(`Message ${index}`, { createdAt: 1_000 })
  restartDb()

  const collected: string[] = []
  let cursor: string | null | undefined
  let pages = 0
  do {
    const current = page({ cursor, limit: 200 })
    collected.push(...current.messages.map((message) => message.text))
    cursor = current.nextCursor
    pages++
    // A message that arrives mid-read belongs to the next read, never to this page sequence.
    if (pages === 1) say('Written while the bot was still reading.', { createdAt: 2_000 })
  } while (cursor)

  expect(pages).toBe(4)
  expect(collected).toHaveLength(620)
  expect(collected[0]).toBe('Message 1')
  expect(collected.at(-1)).toBe('Message 620')
  expect(collected).not.toContain('Written while the bot was still reading.')
  // Equal timestamps keep a stable order, so nothing is skipped or read twice.
  expect(new Set(collected).size).toBe(620)

  // Reading again from the start reaches what arrived in between.
  const fresh: string[] = []
  let next: string | null | undefined
  do {
    const current = page({ cursor: next, limit: 500 })
    fresh.push(...current.messages.map((message) => message.text))
    next = current.nextCursor
  } while (next)
  expect(fresh.at(-1)).toBe('Written while the bot was still reading.')
})

it('answers an empty page rather than hiding the rest of the chat behind it', () => {
  say('', {
    role: 'assistant',
    parts: [
      {
        type: 'tool',
        id: 't1',
        toolCallId: 't1',
        toolName: 'bash',
        input: {},
        state: { status: 'completed', output: { text: 'private tool output' } },
      },
    ],
  })
  say('', {
    role: 'assistant',
    parts: [{ type: 'reasoning', id: 'r1', text: 'Private reasoning about the repository.' }],
  })
  say('The part that is mine to read.')

  const first = page({ limit: 2 })
  expect(first.messages).toEqual([])
  expect(first.hasMore).toBe(true)
  const second = page({ cursor: first.nextCursor, limit: 2 })
  expect(second.messages.map((message) => message.text)).toEqual(['The part that is mine to read.'])
  expect(second.hasMore).toBe(false)
})

it('carries public message text alone, and redacts what looks like a secret', () => {
  say('Use sk-live-9876543210 to reach it.')
  say('', {
    role: 'assistant',
    parts: [
      { type: 'reasoning', id: 'r', text: 'Do not reveal this reasoning.' },
      { type: 'text', id: 'a', text: 'Done.' },
      { type: 'file', id: 'f', name: 'secret.png', mediaType: 'image/png', kind: 'image', data: 'AAAA' },
    ],
  })
  // An isolated review-loop round is not part of the chat the person is having.
  upsertChatMessage({
    id: randomUUID(),
    conversationId: localId,
    role: 'assistant',
    createdAt: 5,
    parts: [{ type: 'text', id: 'x', text: 'Reviewer round detail.' }],
    executionScope: { kind: 'review-loop', loopId: 'l', executionId: 'e', iteration: 1, maxIterations: 2 },
  })
  upsertChatMessage({
    id: randomUUID(),
    conversationId: localId,
    role: 'assistant',
    createdAt: 6,
    parts: [{ type: 'text', id: 'y', text: 'Internal orchestration note.' }],
    internal: true,
  })

  const texts = page().messages.map((message) => message.text)
  expect(texts).toEqual(['Use [redacted] to reach it.', 'Done.'])
  expect(JSON.stringify(page())).not.toContain('sk-live')
  expect(JSON.stringify(page())).not.toMatch(/reasoning|secret\.png|Reviewer round|orchestration/i)
})

it('says the answer is still being written while the chat is working', () => {
  say('Report it.', { botName: 'Grok Bot', createdAt: 1 })
  say('Working on', { role: 'assistant', createdAt: 2 })
  getDb().prepare("UPDATE conversations SET status='working' WHERE id=?").run(localId)

  const messages = page().messages
  expect(messages[0].partial).toBeUndefined()
  expect(messages[1].partial).toBe(true)

  getDb().prepare("UPDATE conversations SET status='ready' WHERE id=?").run(localId)
  expect(page().messages[1].partial).toBeUndefined()
})

it('refuses a cursor it did not issue, and one issued for another chat', () => {
  say('First.')
  const other = randomUUID()
  bind(other, makeConversation(workspaceId).id)
  const cursorOfOther = readBotChatHistory({ identity, conversationId: other, limit: 1 }).nextCursor

  expect(() => page({ cursor: 'not-a-cursor' })).toThrow(/cursor/i)
  expect(() => page({ cursor: Buffer.from('{"v":2}', 'utf8').toString('base64url') })).toThrow(/cursor/i)
  if (cursorOfOther) expect(() => page({ cursor: cursorOfOther })).toThrow(/another chat/i)
})

it('never reaches a chat of another connection, or one with no conversation here', () => {
  say('Private to this connection.')
  const foreign = randomUUID()
  bind(foreign, makeConversation(workspaceId).id, 'another-bot')

  expect(() => readBotChatHistory({ identity, conversationId: foreign })).toThrow()
  expect(() => readBotChatHistory({ identity, conversationId: randomUUID() })).toThrow(/nothing to read back/)
  expect(() =>
    readBotChatHistory({ identity: { ...identity, connectionId: 'another-bot' }, conversationId: publicId })
  ).toThrow()
})
