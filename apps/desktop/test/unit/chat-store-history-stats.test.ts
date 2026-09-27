import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getDb, transaction } from '../../src/main/store'
import {
  chatHistoryStats,
  deleteChatMessage,
  deleteChatMessagesFrom,
  forgetChatStoreCaches,
  getChatMessage,
  getMessageSeq,
  latestMeasuredContextSnapshot,
  listChatMessages,
  recordChatUsageAttempt,
  updateChatMessageParts,
  upsertChatMessage,
} from '../../src/main/chat/chat-store'
import type { ChatContextSnapshot, ChatUsage, MessagePart } from '../../src/shared/chat'

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
const reviewLoop = { kind: 'review-loop' as const, executionId: 'exec', loopId: 'loop', iteration: 1, maxIterations: 3 }
const models = [
  { providerId: 'openai', modelId: 'gpt-synthetic' },
  { providerId: 'anthropic', modelId: 'claude-synthetic' },
  { providerId: 'openai', modelId: 'mini-synthetic' },
]

/** Billing and context usage as runners record it, with sub-agent envelopes, details and helper calls. */
function usage(random: () => number): ChatUsage {
  const int = (max: number) => Math.floor(random() * max)
  return {
    usageVersion: 2,
    input: int(40_000),
    output: int(2_000),
    ...(random() < 0.7 ? { cachedInput: int(30_000), cacheCreate: int(500) } : {}),
    ...(random() < 0.8 ? { contextInput: int(120_000), contextOutput: int(3_000), modelContextWindow: 272_000 } : {}),
    ...(random() < 0.15 ? { billingOnly: true } : {}),
    ...(random() < 0.3 ? { runtimeEstimatedCostUsd: int(10_000) / 7_919 } : {}),
    ...(random() < 0.2 ? { subInput: int(9_000), subOutput: int(900), subCachedInput: int(100) } : {}),
    ...(random() < 0.1
      ? { subagentUsage: [{ ...models[int(3)], input: int(5_000), output: int(400), cachedInput: int(50) }] }
      : {}),
  }
}

/** One row as runners write them: turns, compaction milestones of every kind, isolated rounds, helper rows. */
function write(conversationId: string, random: () => number, id: string, createdAt: number) {
  const assistant = random() < 0.6
  const parts: MessagePart[] = [{ type: 'text', id: 'text', text: 'Row ' + id }]
  const kind = random()
  if (kind < 0.08) parts.push({ type: 'compaction', id: 'c', text: 'Summary '.repeat(20), origin: 'prepared' })
  else if (kind < 0.12) parts.push({ type: 'compaction', id: 'c', text: '', strategy: 'codex-native' })
  else if (kind < 0.14) parts.push({ type: 'text', id: 'c', text: '', checkpoint: 'openai-native' })
  upsertChatMessage({
    id,
    conversationId,
    role: assistant ? 'assistant' : 'user',
    createdAt,
    parts,
    ...(assistant ? { model: models[Math.floor(random() * 3)] } : {}),
    ...(assistant && random() < 0.85 ? { usage: usage(random) } : {}),
    ...(assistant && random() < 0.1 ? { executionScope: reviewLoop } : {}),
  })
}

/** The kept totals give what a computation from scratch gives. */
function expectCurrent(conversationId: string, opts: Parameters<typeof chatHistoryStats>[1] = {}) {
  const kept = chatHistoryStats(conversationId, opts)
  forgetChatStoreCaches()
  const scratch = chatHistoryStats(conversationId, opts)
  expect(kept).toEqual(scratch)
  return scratch
}

describe('conversation history stats', () => {
  it('keeps totals equal to a full computation through growth, rewrites, deletions and billed attempts', () => {
    for (const seed of [1, 2, 3]) {
      const random = prng(seed)
      const conversationId = newConversation()
      let clock = 1_000
      let next = 0
      // Message ids are unique across conversations.
      const id = (index: number) => `s${seed}m${index}`
      const grow = (count: number) => {
        for (let index = 0; index < count; index++) write(conversationId, random, id(next++), (clock += 1_000))
      }
      grow(300)
      expectCurrent(conversationId)
      grow(5)
      expectCurrent(conversationId)
      grow(150)
      expectCurrent(conversationId)
      // An old row gets its usage rewritten (a delegated run billed on its parent).
      const old = getChatMessage(conversationId, id(40))!
      upsertChatMessage({ ...old, role: 'assistant', model: models[1], usage: usage(random) })
      expectCurrent(conversationId)
      // An old row gets a compaction marker (a prepared activation), then loses it.
      const boundary = getChatMessage(conversationId, id(200))!
      updateChatMessageParts(conversationId, id(200), [
        ...boundary.parts,
        { type: 'compaction', id: 'p', text: 'Prepared' },
      ])
      expectCurrent(conversationId)
      updateChatMessageParts(conversationId, id(200), boundary.parts)
      expectCurrent(conversationId)
      // Deleted billed rows keep billing through the ledger.
      deleteChatMessage(id(10))
      deleteChatMessage(id(next - 3))
      expectCurrent(conversationId)
      recordChatUsageAttempt({
        id: 'attempt-' + seed,
        conversationId,
        model: models[2],
        usage: { input: 10, output: 20, cacheRead: 0, cacheCreate: 0 },
      })
      expectCurrent(conversationId)
      // A message back under a deleted, billed id.
      write(conversationId, random, id(10), (clock += 1_000))
      expectCurrent(conversationId)
      // Edit and resend: everything from an older row on goes.
      deleteChatMessagesFrom(conversationId, getMessageSeq(id(350))!)
      expectCurrent(conversationId)
      grow(80)
      const stats = expectCurrent(conversationId)
      expect(stats.perModel.length).toBeGreaterThan(1)
    }
  })

  it('counts a native milestone only while its caller confirms it, on kept totals too', () => {
    const conversationId = newConversation()
    const random = prng(7)
    for (let index = 0; index < 200; index++) write(conversationId, random, `m${index}`, index * 1_000)
    upsertChatMessage({
      id: 'native',
      conversationId,
      role: 'assistant',
      createdAt: 300_000,
      parts: [{ type: 'compaction', id: 'n', text: '', strategy: 'claude-native' }],
      model: models[1],
      usage: {
        usageVersion: 2,
        input: 5,
        output: 7,
        contextInput: 900,
        modelContextWindow: 200_000,
        billingOnly: true,
      },
    })
    for (let index = 0; index < 70; index++)
      upsertChatMessage({
        id: `tail${index}`,
        conversationId,
        role: 'user',
        createdAt: 400_000 + index,
        parts: [{ type: 'text', id: 't', text: 'Waiting' }],
      })
    const without = expectCurrent(conversationId)
    const confirmed = expectCurrent(conversationId, { isNativeCompactionActive: (id) => id === 'native' })
    expect(confirmed.lastUsage).toMatchObject({ contextInput: 900, modelContextWindow: 200_000, input: 0 })
    expect(confirmed.lastModel).toBeUndefined()
    expect(without.lastUsage).not.toEqual(confirmed.lastUsage)
  })

  it('never keeps totals from a transaction that may roll back, and follows another connection', () => {
    const conversationId = newConversation()
    const random = prng(9)
    for (let index = 0; index < 150; index++) write(conversationId, random, `m${index}`, index * 1_000)
    expectCurrent(conversationId)
    const before = chatHistoryStats(conversationId)
    expect(() =>
      transaction(() => {
        upsertChatMessage({
          ...getChatMessage(conversationId, 'm5')!,
          role: 'assistant',
          model: models[0],
          usage: usage(random),
        })
        chatHistoryStats(conversationId)
        throw new Error('rolled back')
      })
    ).toThrow('rolled back')
    expect(chatHistoryStats(conversationId)).toEqual(before)
    // Another connection rewrites an old row: this one's data version tells.
    const file = (getDb().prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>).find(
      (row) => row.name === 'main'
    )!.file
    const other = new DatabaseSync(file)
    other.exec('PRAGMA busy_timeout=5000')
    other
      .prepare('UPDATE chat_messages SET meta_json = ? WHERE id = ?')
      .run(JSON.stringify({ model: models[2], usage: { usageVersion: 2, input: 123_456, output: 1 } }), 'm3')
    other.close()
    const after = expectCurrent(conversationId)
    expect(after).not.toEqual(before)
  })

  it('follows rows whose ids other conversations reuse', () => {
    const first = newConversation()
    const second = newConversation()
    const random = prng(13)
    for (let index = 0; index < 200; index++) write(first, random, `a${index}`, index * 1_000)
    const billed = (id: string, conversationId: string, input: number) =>
      upsertChatMessage({
        id,
        conversationId,
        role: 'assistant',
        createdAt: 900_000,
        parts: [{ type: 'text', id: 't', text: 'Billed' }],
        model: models[0],
        usage: { usageVersion: 2, input, output: 3 },
      })
    billed('shared', first, 70)
    deleteChatMessage('shared')
    expectCurrent(first)
    chatHistoryStats(first)
    // Its id comes back in another conversation: the first one's ledger row is no longer without a message.
    upsertChatMessage({
      id: 'shared',
      conversationId: second,
      role: 'user',
      createdAt: 900_001,
      parts: [{ type: 'text', id: 't', text: 'Hello' }],
    })
    expectCurrent(first)
    chatHistoryStats(first)
    // An update under an old row's id from another conversation changes the row where it is.
    billed('a10', second, 55_555)
    expect(getChatMessage(first, 'a10')?.usage?.input).toBe(55_555)
    expectCurrent(first)
  })

  it('never keeps totals of a row that was deleted and whose seq came back', () => {
    const conversationId = newConversation()
    const random = prng(17)
    for (let index = 0; index < 200; index++) write(conversationId, random, `m${index}`, index * 1_000)
    chatHistoryStats(conversationId)
    // The newest rows go one by one, down to the newest kept one: the next row takes its seq, and the kept count again.
    for (let index = 199; index >= 135; index--) deleteChatMessage(`m${index}`)
    upsertChatMessage({
      id: 'again',
      conversationId,
      role: 'assistant',
      createdAt: 999_999,
      parts: [{ type: 'text', id: 't', text: 'Again' }],
      model: models[1],
      usage: { usageVersion: 2, input: 31_337, output: 1, contextInput: 4_242 },
    })
    expect(getMessageSeq('again')).toBe(135)
    expect(chatHistoryStats(conversationId).lastUsage?.contextInput).toBe(4_242)
    expectCurrent(conversationId)
  })

  it('never keeps totals of rows an edit and resend replaced', () => {
    const conversationId = newConversation()
    const random = prng(19)
    for (let index = 0; index < 200; index++) write(conversationId, random, `m${index}`, index * 1_000)
    chatHistoryStats(conversationId)
    // From an older, kept row on, replaced by as many new ones: the kept rows count the same again.
    deleteChatMessagesFrom(conversationId, getMessageSeq('m100')!)
    for (let index = 0; index < 100; index++)
      upsertChatMessage({
        id: `resent${index}`,
        conversationId,
        role: 'assistant',
        createdAt: 500_000 + index,
        parts: [{ type: 'text', id: 't', text: 'Resent' }],
        model: models[2],
        usage: { usageVersion: 2, input: 1_000 + index, output: 1 },
      })
    expectCurrent(conversationId)
  })

  it('counts a compaction written into a kept row after the last measured turn', () => {
    const conversationId = newConversation()
    for (let index = 0; index < 200; index++)
      upsertChatMessage({
        id: `m${index}`,
        conversationId,
        role: index < 100 ? 'assistant' : 'user',
        createdAt: index,
        parts: [{ type: 'text', id: 't', text: 'Row' }],
        ...(index < 100
          ? { model: models[0], usage: { usageVersion: 2 as const, input: 10, output: 1, contextInput: 50_000 } }
          : {}),
      })
    expect(chatHistoryStats(conversationId).lastUsage?.contextInput).toBe(50_000)
    // A prepared compaction activates on a kept user row after the last measured turn.
    updateChatMessageParts(conversationId, 'm120', [{ type: 'compaction', id: 'c', text: 'x'.repeat(400) }])
    expect(expectCurrent(conversationId).lastUsage).toMatchObject({ contextInput: 100, input: 0 })
  })

  it('catches rows inserted or deleted among the kept ones behind its back', () => {
    const conversationId = newConversation()
    const random = prng(23)
    for (let index = 0; index < 200; index++) write(conversationId, random, `m${index}`, index * 1_000)
    chatHistoryStats(conversationId)
    // Inserted before the conversation, as an import does.
    getDb()
      .prepare(
        "INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at) VALUES (?, ?, 'assistant', '[]', ?, -1, 0)"
      )
      .run(
        'imported',
        conversationId,
        JSON.stringify({ model: models[1], usage: { usageVersion: 2, input: 77, output: 7 } })
      )
    expectCurrent(conversationId)
    chatHistoryStats(conversationId)
    getDb().prepare('DELETE FROM chat_messages WHERE id = ?').run('m3')
    expectCurrent(conversationId)
  })

  it('returns objects of its own, which callers may change', () => {
    const conversationId = newConversation()
    // The last measured turn is among the kept rows: newer ones measure nothing.
    for (let index = 0; index < 170; index++)
      upsertChatMessage({
        id: `m${index}`,
        conversationId,
        role: index < 100 ? 'assistant' : 'user',
        createdAt: index,
        parts: [{ type: 'text', id: 't', text: 'Row' }],
        ...(index < 100
          ? {
              model: models[index % 3],
              usage: { usageVersion: 2 as const, input: 10, output: 1, contextInput: 1_000 + index },
            }
          : {}),
      })
    const first = chatHistoryStats(conversationId)
    const snapshot = structuredClone(first)
    expect(first.lastUsage?.contextInput).toBe(1_099)
    first.lastUsage!.contextInput = -1
    first.lastModel!.modelId = 'changed'
    for (const usage of first.perModel) usage.input = -1
    expect(chatHistoryStats(conversationId)).toEqual(snapshot)
  })

  it('notes deletions through the store at once, whatever writes next', () => {
    const conversationId = newConversation()
    for (let index = 0; index < 200; index++)
      upsertChatMessage({
        id: `m${index}`,
        conversationId,
        role: 'assistant',
        createdAt: index,
        parts: [{ type: 'text', id: 't', text: 'Row' }],
        model: models[index % 3],
        usage: { usageVersion: 2, input: 100 + index, output: 1, contextInput: 5_000 + index },
      })
    const raw = getDb().prepare(
      "INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at) VALUES (?, ?, 'user', '[]', '{}', ?, ?)"
    )
    // Kept rows deleted, and their seqs taken again by a writer the store does not see: the kept rows count the same.
    chatHistoryStats(conversationId)
    const seq = getMessageSeq('m20')!
    deleteChatMessage('m20')
    raw.run('outside', conversationId, seq, 1)
    expectCurrent(conversationId)
    // The same after an edit and resend, from a kept row on.
    chatHistoryStats(conversationId)
    const from = getMessageSeq('m50')!
    const kept =
      (
        getDb().prepare('SELECT MAX(seq) AS n FROM chat_messages WHERE conversation_id = ?').get(conversationId) as {
          n: number
        }
      ).n - 64
    deleteChatMessagesFrom(conversationId, from)
    for (let next = from; next <= kept; next++) raw.run(`outside${next}`, conversationId, next, 2)
    expectCurrent(conversationId)
  })

  it('keeps shortcuts for a bounded number of conversations', () => {
    const conversations = Array.from({ length: 260 }, () => newConversation())
    const insert = getDb().prepare(
      "INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at) VALUES (?, ?, 'assistant', '[]', ?, ?, ?)"
    )
    const meta = JSON.stringify({ model: models[0], usage: { usageVersion: 2, input: 1, output: 1 } })
    transaction(() => {
      for (const [index, conversationId] of conversations.entries())
        for (let row = 0; row < 65; row++) insert.run(`c${index}r${row}`, conversationId, meta, row, row)
    })
    for (const conversationId of conversations) chatHistoryStats(conversationId)
    const behindItsBack = (id: string) =>
      getDb()
        .prepare('UPDATE chat_messages SET meta_json = ? WHERE id = ?')
        .run(JSON.stringify({ model: models[2], usage: { usageVersion: 2, input: 424_242, output: 1 } }), id)
    const seen = (conversationId: string) =>
      chatHistoryStats(conversationId).perModel.some((usage) => usage.input >= 424_242)
    // The newest conversations keep their totals; the oldest were let go.
    behindItsBack('c259r0')
    expect(seen(conversations[259])).toBe(false)
    behindItsBack('c0r0')
    expect(seen(conversations[0])).toBe(true)
  })

  it('reads only the newest rows once older totals are kept', () => {
    const conversationId = newConversation()
    const random = prng(11)
    for (let index = 0; index < 400; index++) write(conversationId, random, `m${index}`, index * 1_000)
    chatHistoryStats(conversationId)
    // Rewritten behind the store's back on the same connection: the kept totals show they were used.
    getDb()
      .prepare('UPDATE chat_messages SET meta_json = ? WHERE id = ?')
      .run(JSON.stringify({ model: models[2], usage: { usageVersion: 2, input: 999_999, output: 1 } }), 'm2')
    const kept = chatHistoryStats(conversationId)
    forgetChatStoreCaches()
    expect(kept).not.toEqual(chatHistoryStats(conversationId))
  })
})

describe('chat store write boundary', () => {
  it('leaves every write to messages and the usage ledger to the chat store, as its kept totals assume', () => {
    const root = path.resolve(__dirname, '../../src/main')
    const writer =
      /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+chat_(?:messages|usage_ledger)\b/i
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith('.ts'))
    const writers = files.filter((file) => writer.test(readFileSync(path.join(root, file), 'utf8'))).sort()
    // The store's schema and startup maintenance, and the startup import of legacy conversations.
    expect(writers.map((file) => file.split(path.sep).join('/'))).toEqual([
      'chat/chat-store.ts',
      'store/db.ts',
      'store/legacy-conversation-import.ts',
    ])
  })
})

describe('latest measured context snapshot', () => {
  /** What the bot runtime computed from the whole conversation before. */
  const reference = (conversationId: string) =>
    [...listChatMessages(conversationId)]
      .reverse()
      .filter((message) => message.role === 'assistant' && !message.internal)
      .map((message) => message.contextSnapshot)
      .find(
        (value) =>
          !!value &&
          Number.isFinite(value.usedTokens) &&
          value.usedTokens >= 0 &&
          Number.isFinite(value.modelContextWindow) &&
          (value.modelContextWindow ?? 0) > 0
      ) ?? null
  const expectLatest = (conversationId: string) => {
    const kept = latestMeasuredContextSnapshot(conversationId)
    expect(kept).toEqual(reference(conversationId))
    forgetChatStoreCaches()
    expect(latestMeasuredContextSnapshot(conversationId)).toEqual(kept)
    return kept
  }
  const measured = (sequence: number, usedTokens = 1_000 + sequence): ChatContextSnapshot => ({
    usedTokens,
    modelContextWindow: 272_000,
    model: models[sequence % 3],
    quality: 'measured',
    observedAt: 10_000 + sequence,
    sequence,
  })
  /** Snapshots as runners leave them, and as they may be found: estimated, without a window, invalid. */
  const snapshot = (random: () => number, sequence: number): unknown => {
    const kind = random()
    const valid = measured(sequence, Math.floor(random() * 200_000))
    if (kind < 0.25) return valid
    if (kind < 0.35) return { ...valid, quality: 'estimated' }
    if (kind < 0.55) return { ...valid, modelContextWindow: undefined }
    if (kind < 0.6) return { ...valid, usedTokens: -5 }
    if (kind < 0.65) return { ...valid, modelContextWindow: 0 }
    if (kind < 0.7) return { ...valid, sequence: 'first' }
    return undefined
  }
  const say = (conversationId: string, random: () => number, id: string, index: number) =>
    upsertChatMessage({
      id,
      conversationId,
      role: random() < 0.7 ? 'assistant' : 'user',
      createdAt: index * 1_000,
      parts: [{ type: 'text', id: 't', text: 'Row ' + id }],
      model: models[index % 3],
      contextSnapshot: snapshot(random, index) as ChatContextSnapshot,
      ...(random() < 0.1 ? { internal: true } : {}),
      ...(random() < 0.1 ? { executionScope: reviewLoop } : {}),
    })

  it('finds what a read of the whole conversation finds, through growth, rewrites and deletions', () => {
    for (const seed of [41, 43, 47]) {
      const random = prng(seed)
      const conversationId = newConversation()
      const id = (index: number) => `s${seed}r${index}`
      let next = 0
      const grow = (count: number) => {
        for (let index = 0; index < count; index++) say(conversationId, random, id(next), next++)
      }
      grow(300)
      expectLatest(conversationId)
      grow(3)
      expectLatest(conversationId)
      // Its message loses its snapshot, then is deleted: an older one takes over.
      const current = reference(conversationId)
      const owner = [...listChatMessages(conversationId)]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' &&
            !message.internal &&
            JSON.stringify(message.contextSnapshot) === JSON.stringify(current)
        )!
      upsertChatMessage({ ...owner, contextSnapshot: undefined })
      expectLatest(conversationId)
      deleteChatMessage(owner.id)
      expectLatest(conversationId)
      grow(100)
      expectLatest(conversationId)
    }
  })

  it('sees a kept message that gains or loses the newest measured snapshot', () => {
    const conversationId = newConversation()
    for (let index = 0; index < 200; index++)
      upsertChatMessage({
        id: `m${index}`,
        conversationId,
        role: 'assistant',
        createdAt: index,
        parts: [{ type: 'text', id: 't', text: 'Row' }],
        model: models[0],
        contextSnapshot:
          index < 50 ? measured(index) : ({ ...measured(index), modelContextWindow: undefined } as ChatContextSnapshot),
      })
    expect(expectLatest(conversationId)?.sequence).toBe(49)
    const kept = getChatMessage(conversationId, 'm120')!
    upsertChatMessage({ ...kept, contextSnapshot: measured(120) })
    expect(expectLatest(conversationId)?.sequence).toBe(120)
    upsertChatMessage({ ...kept, contextSnapshot: measured(120), internal: true })
    expect(expectLatest(conversationId)?.sequence).toBe(49)
    deleteChatMessage('m49')
    expect(expectLatest(conversationId)?.sequence).toBe(48)
    // What callers get is theirs to change.
    const mine = latestMeasuredContextSnapshot(conversationId)!
    mine.usedTokens = -1
    expect(latestMeasuredContextSnapshot(conversationId)?.usedTokens).toBe(measured(48).usedTokens)
  })

  it('finds none without a measured snapshot, however long the conversation', () => {
    const conversationId = newConversation()
    for (let index = 0; index < 150; index++)
      upsertChatMessage({
        id: `m${index}`,
        conversationId,
        role: index % 2 ? 'assistant' : 'user',
        createdAt: index,
        parts: [{ type: 'text', id: 't', text: 'Row' }],
        contextSnapshot: { ...measured(index), modelContextWindow: undefined } as ChatContextSnapshot,
      })
    expect(expectLatest(conversationId)).toBeNull()
    // Measured, but on a user message or an internal one: neither is the context meter's.
    upsertChatMessage({
      id: 'user',
      conversationId,
      role: 'user',
      createdAt: 200,
      parts: [{ type: 'text', id: 't', text: 'Hello' }],
      contextSnapshot: measured(200),
    })
    upsertChatMessage({
      id: 'internal',
      conversationId,
      role: 'assistant',
      createdAt: 201,
      parts: [{ type: 'text', id: 't', text: 'Hidden' }],
      contextSnapshot: measured(201),
      internal: true,
    })
    expect(expectLatest(conversationId)).toBeNull()
  })
})
