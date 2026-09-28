import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getDb, transaction } from '../../src/main/store'
import {
  deleteChatMessage,
  forgetChatStoreCaches,
  getChatMessage,
  hasConversationContextMessages,
  latestPortableCompactionMessage,
  listActiveConversationContextMessages,
  listConversationContextMessages,
  runnerContextHistory,
  updateChatMessageParts,
  upsertChatMessage,
  type StoredChatMessage,
} from '../../src/main/chat/chat-store'
import {
  activeChatContext,
  isPortableCompactionMarker,
  parseParts,
  renderNativeSeedTranscript,
  toModelMessages,
} from '../../src/main/chat/message'
import { buildOpenAIModelMessages } from '../../src/main/chat/openai/history'
import { estimateNativeSeedContextTokens, estimatePortableContextTokens } from '../../src/main/chat/portable-context'
import { codexTransferCharacters } from '../../src/main/chat/native-transfer'
import type { MessagePart } from '../../src/shared/chat'

beforeEach(freshDb)
afterEach(closeDb)

function prng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const newConversation = () => makeConversation(makeWorkspace().id).id
const portable = (text: string): MessagePart => ({ type: 'compaction', id: randomUUID(), text, origin: 'prepared' })
const reviewLoop = {
  kind: 'review-loop' as const,
  executionId: 'exec-1',
  loopId: 'loop',
  iteration: 1,
  maxIterations: 3,
}

/**
 * A long conversation with every kind of compaction marker: portable ones (whole messages and mid-message), native
 * ones (a checkpoint text part, provider strategies) after and before them, markers of isolated rounds, internal
 * messages and unreadable metadata. It ends with a user message, as a turn starts.
 */
/** Writes the conversation in one transaction: a commit per message syncs the disk each time, slowly on Windows. */
function generate(conversationId: string, seed: number, count: number): void {
  transaction(() => writeConversation(conversationId, seed, count))
}

function writeConversation(conversationId: string, seed: number, count: number) {
  const random = prng(seed)
  let createdAt = 1_000
  for (let index = 0; index < count; index++) {
    createdAt += 1 + Math.floor(random() * 1_000)
    const user = index % 2 === 0
    const parts: MessagePart[] = []
    const steps = 1 + Math.floor(random() * 4)
    for (let step = 0; step < steps; step++) {
      const kind = random()
      if (user || kind < 0.45) parts.push({ type: 'text', id: randomUUID(), text: `Message ${index}.${step}` })
      else if (kind < 0.7)
        parts.push({
          type: 'tool',
          id: 'call_' + index + '_' + step,
          toolCallId: 'call_' + index + '_' + step,
          toolName: 'bash',
          input: { command: 'ls' },
          state: { status: 'completed', output: { text: 'ok ' + index } },
        })
      else if (kind < 0.78) parts.push({ type: 'reasoning', id: randomUUID(), text: 'Thinking' })
      else if (kind < 0.86) parts.push(portable('Summary before ' + index))
      else if (kind < 0.9)
        parts.push({
          type: 'compaction',
          id: randomUUID(),
          text: '',
          strategy: random() < 0.5 ? 'codex-native' : 'claude-native',
        })
      else if (kind < 0.94) parts.push({ type: 'text', id: randomUUID(), text: '', checkpoint: 'openai-native' })
      else parts.push({ type: 'text', id: randomUUID(), text: 'After ' + index })
    }
    const isolated = !user && random() < 0.08
    upsertChatMessage({
      id: `m${index}`,
      conversationId,
      role: user ? 'user' : 'assistant',
      createdAt,
      parts,
      ...(user ? {} : { model: { providerId: 'openai', modelId: 'synthetic' }, finishReason: 'stop' }),
      ...(isolated ? { executionScope: reviewLoop } : {}),
      ...(!user && random() < 0.05 ? { internal: true } : {}),
    })
    if (random() < 0.02)
      getDb().prepare("UPDATE chat_messages SET meta_json = '{not json' WHERE id = ?").run(`m${index}`)
  }
  upsertChatMessage({
    id: 'turn',
    conversationId,
    role: 'user',
    createdAt: createdAt + 1,
    parts: [{ type: 'text', id: 'turn-text', text: 'Next turn' }],
  })
}

/** What every runner and estimate reads is the same from the window as from the whole main context. */
function expectSameContext(conversationId: string) {
  const full = listConversationContextMessages(conversationId)
  const window = listActiveConversationContextMessages(conversationId)
  expect(full.slice(full.length - window.length)).toEqual(window)
  expect(activeChatContext(window)).toEqual(activeChatContext(full))
  expect(toModelMessages(window)).toEqual(toModelMessages(full))
  expect(buildOpenAIModelMessages(window, () => null)).toEqual(buildOpenAIModelMessages(full, () => null))
  expect(estimatePortableContextTokens(window)).toBe(estimatePortableContextTokens(full))
  expect(estimateNativeSeedContextTokens(window)).toBe(estimateNativeSeedContextTokens(full))
  expect(codexTransferCharacters(window, [])).toBe(codexTransferCharacters(full, []))
  expect(window.at(-1)).toEqual(full.at(-1))
  // Runners set the turn's own message apart: what comes before it is the same too.
  if (full.length > 1) {
    expect(window.at(-2)).toEqual(full.at(-2))
    expect(activeChatContext(window.slice(0, -1))).toEqual(activeChatContext(full.slice(0, -1)))
    expect(renderNativeSeedTranscript(window.slice(0, -1))).toBe(renderNativeSeedTranscript(full.slice(0, -1)))
  }
  return { full, window }
}

describe('model context window', () => {
  it('gives every runner the same context from the last portable marker on, reading only from there', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const conversationId = newConversation()
      generate(conversationId, seed, 400)
      const { full, window } = expectSameContext(conversationId)
      const withMarker = full.filter((message) => message.parts.some(isPortableCompactionMarker))
      if (withMarker.length) {
        expect(window[0].id).toBe(withMarker.at(-1)!.id)
        expect(window.length).toBeLessThan(full.length)
      } else expect(window).toEqual(full)
      expect(runnerContextHistory(conversationId)).toEqual(window)
      // Asked again, from the cached start.
      expect(listActiveConversationContextMessages(conversationId)).toEqual(window)
    }
  })

  it('follows markers as they come, move into older messages, and go', () => {
    const conversationId = newConversation()
    const say = (id: string, role: 'user' | 'assistant', parts: MessagePart[], at: number) =>
      upsertChatMessage({ id, conversationId, role, createdAt: at, parts })
    for (let index = 0; index < 20; index++)
      say(`m${index}`, index % 2 ? 'assistant' : 'user', [{ type: 'text', id: 't', text: 'Hello ' + index }], index)
    expect(expectSameContext(conversationId).window).toHaveLength(20)
    say('c1', 'assistant', [portable('First summary')], 20)
    say('m21', 'user', [{ type: 'text', id: 't', text: 'After the first' }], 21)
    expect(expectSameContext(conversationId).window[0].id).toBe('c1')
    for (let index = 22; index < 30; index++)
      say(`m${index}`, index % 2 ? 'assistant' : 'user', [{ type: 'text', id: 't', text: 'More ' + index }], index)
    expectSameContext(conversationId)
    // A prepared compaction goes into an older message, after the last marker.
    const older = getChatMessage(conversationId, 'm25')!
    upsertChatMessage({ ...older, parts: [...older.parts, portable('Prepared')] })
    expect(expectSameContext(conversationId).window[0].id).toBe('m25')
    // Its marker removed again: back to the first one.
    expect(updateChatMessageParts(conversationId, 'm25', older.parts)).toBe(true)
    expect(expectSameContext(conversationId).window[0].id).toBe('c1')
    // The marker message deleted: the whole context again.
    deleteChatMessage('c1')
    expect(expectSameContext(conversationId).window).toEqual(listConversationContextMessages(conversationId))
  })

  it('never cuts the context short when rows change behind its back', () => {
    const conversationId = newConversation()
    generate(conversationId, 11, 120)
    expectSameContext(conversationId)
    const raw = (id: string, parts: MessagePart[]) =>
      getDb().prepare('UPDATE chat_messages SET parts_json = ? WHERE id = ?').run(JSON.stringify(parts), id)
    const full = listConversationContextMessages(conversationId)
    const markers = full.filter((message) => message.parts.some(isPortableCompactionMarker))
    // The start it keeps loses its marker without any hook: checked before use.
    raw(markers.at(-1)!.id, [{ type: 'text', id: 't', text: 'No marker any more' }])
    expectSameContext(conversationId)
    // A marker put into an older message without any hook: a longer window, never a shorter one.
    raw(full[full.length - 5].id, [portable('Hidden')])
    expectSameContext(conversationId)
    // A new message with a marker, inserted directly: the newest, it does not start the context until one follows.
    const insert = getDb().prepare(
      "INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at) VALUES (?, ?, ?, ?, '{}', ?, ?)"
    )
    insert.run('direct', conversationId, 'assistant', JSON.stringify([portable('Direct')]), 10_000, 10_000_000)
    expect(expectSameContext(conversationId).window.at(-1)?.id).toBe('direct')
    insert.run('after', conversationId, 'user', '[]', 10_001, 10_000_001)
    expect(expectSameContext(conversationId).window[0].id).toBe('direct')
  })

  it('keeps the markers of isolated rounds out of the main context, and review rounds on their own messages', () => {
    const conversationId = newConversation()
    upsertChatMessage({
      id: 'main',
      conversationId,
      role: 'user',
      createdAt: 1,
      parts: [{ type: 'text', id: 't', text: 'Main' }],
    })
    upsertChatMessage({
      id: 'round',
      conversationId,
      role: 'assistant',
      createdAt: 2,
      parts: [portable('Round summary')],
      executionScope: reviewLoop,
    })
    expect(expectSameContext(conversationId).window.map((message) => message.id)).toEqual(['main'])
    expect(
      runnerContextHistory(conversationId, { ephemeralSession: true, executionScope: reviewLoop }).map(
        (message) => message.id
      )
    ).toEqual(['round'])
  })

  it('tells whether a conversation has a main context without reading it', () => {
    const conversationId = newConversation()
    expect(hasConversationContextMessages(conversationId)).toBe(false)
    expect(listActiveConversationContextMessages(conversationId)).toEqual([])
    upsertChatMessage({
      id: 'round',
      conversationId,
      role: 'assistant',
      createdAt: 1,
      parts: [{ type: 'text', id: 't', text: 'Isolated' }],
      executionScope: reviewLoop,
    })
    expect(hasConversationContextMessages(conversationId)).toBe(false)
    upsertChatMessage({
      id: 'main',
      conversationId,
      role: 'user',
      createdAt: 2,
      parts: [{ type: 'text', id: 't', text: 'Main' }],
    } satisfies StoredChatMessage)
    expect(hasConversationContextMessages(conversationId)).toBe(true)
  })
})

describe('model context window around the newest message', () => {
  it('never starts at the newest message, so that what comes before it stays the same', () => {
    const conversationId = newConversation()
    generate(conversationId, 17, 200)
    const say = (id: string, role: 'user' | 'assistant', parts: MessagePart[], at: number) =>
      upsertChatMessage({ id, conversationId, role, createdAt: at, parts })
    // A compaction lands in the newest message: it holds the newest marker.
    say('compacted', 'assistant', [portable('Newest summary')], 10_000_000)
    const { window } = expectSameContext(conversationId)
    expect(window.at(-1)?.id).toBe('compacted')
    expect(window.length).toBeGreaterThan(1)
    // The next message makes it the start.
    say('next', 'user', [{ type: 'text', id: 't', text: 'Go on' }], 10_000_001)
    expect(expectSameContext(conversationId).window[0].id).toBe('compacted')
    // The newest message deleted again: back to the one before.
    deleteChatMessage('next')
    expect(expectSameContext(conversationId).window.at(-1)?.id).toBe('compacted')
  })
})

describe('newest portable marker of a conversation', () => {
  /** Every row, newest first: the first holding a portable marker. */
  const reference = (conversationId: string) => {
    const rows = getDb()
      .prepare(
        'SELECT id, seq, length(parts_json) AS size, parts_json FROM chat_messages WHERE conversation_id = ? ORDER BY seq DESC'
      )
      .all(conversationId) as Array<{ id: string; seq: number; size: number; parts_json: string | null }>
    const row = rows.find((candidate) => parseParts(candidate.parts_json ?? '[]').some(isPortableCompactionMarker))
    return row ? { id: row.id, seq: Number(row.seq), size: Number(row.size) } : null
  }
  const expectNewest = (conversationId: string) => {
    const kept = latestPortableCompactionMessage(conversationId)
    expect(kept).toEqual(reference(conversationId))
    forgetChatStoreCaches()
    expect(latestPortableCompactionMessage(conversationId)).toEqual(kept)
    return kept
  }

  it('finds what a read of every row finds, through markers that come, move, change and go', () => {
    for (const seed of [5, 6, 7]) {
      const conversationId = newConversation()
      generate(conversationId, seed, 150)
      expectNewest(conversationId)
      const say = (id: string, parts: MessagePart[], at: number) =>
        upsertChatMessage({ id: id + seed, conversationId, role: 'assistant', createdAt: at, parts })
      for (let index = 0; index < 5; index++) say('plain' + index, [{ type: 'text', id: 't', text: 'x' }], 9e6 + index)
      expectNewest(conversationId)
      // Into an older message, then longer, then removed, then its message deleted.
      // Into an older message after every marker so far.
      const older = getChatMessage(conversationId, 'plain2' + seed)!
      upsertChatMessage({ ...older, parts: [...older.parts, portable('Prepared')] })
      expect(expectNewest(conversationId)?.id).toBe(older.id)
      upsertChatMessage({ ...older, parts: [...older.parts, portable('Prepared, and more of it')] })
      expectNewest(conversationId)
      expect(updateChatMessageParts(conversationId, older.id, older.parts)).toBe(true)
      expectNewest(conversationId)
      say('marker', [portable('Newest')], 9.1e6)
      expect(expectNewest(conversationId)?.id).toBe('marker' + seed)
      deleteChatMessage('marker' + seed)
      expectNewest(conversationId)
      // Isolated rounds count here: every row does.
      upsertChatMessage({
        id: 'round' + seed,
        conversationId,
        role: 'assistant',
        createdAt: 9.2e6,
        parts: [portable('Round')],
        executionScope: reviewLoop,
      })
      expect(expectNewest(conversationId)?.id).toBe('round' + seed)
    }
  })

  it('finds none, reading only new rows, when no marker is portable', () => {
    const conversationId = newConversation()
    for (let index = 0; index < 50; index++)
      upsertChatMessage({
        id: 'n' + index,
        conversationId,
        role: 'assistant',
        createdAt: index,
        parts: [{ type: 'compaction', id: 'c', text: '', strategy: 'codex-native' }],
      })
    expect(expectNewest(conversationId)).toBeNull()
    upsertChatMessage({ id: 'later', conversationId, role: 'user', createdAt: 100, parts: [] })
    expect(expectNewest(conversationId)).toBeNull()
  })
})
