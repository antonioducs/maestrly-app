import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshDb, closeDb, restartDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import {
  aggregateChatUsage,
  chatHistoryStats,
  deleteChatMessagesFrom,
  getExecutionAssistantMessage,
  getMessageSeq,
  lastConversationContextMessage,
  listChatMessages,
  listChatMessagesPage,
  listConversationContextMessages,
  listExecutionContextMessages,
  reconcileInterruptedExecutionMessages,
  runnerContextHistory,
  upsertChatMessage,
  type StoredChatMessage,
  type StoredChatUsage,
} from '../../src/main/chat/chat-store'
import { estimateNativeSeedContextTokens, estimatePortableContextTokens } from '../../src/main/chat/portable-context'
import { getDb } from '../../src/main/store'
import type { ChatMessage, ChatUsage } from '../../src/shared/chat'

beforeEach(freshDb)
afterEach(closeDb)

function chatConv() {
  const ws = makeWorkspace()
  return makeConversation(ws.id, { mode: 'local' })
}

/** Insert alternating messages with predictable numbered text. */
function seed(conversationId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    upsertChatMessage({
      id: `m${i}`,
      conversationId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', id: `t${i}`, text: `m${i}` }],
      createdAt: 1000 + i,
    })
  }
}

describe('UI message pagination contract', () => {
  it('returns latest messages in ascending order with page metadata', () => {
    const conv = chatConv()
    seed(conv.id, 250)
    const page = listChatMessagesPage(conv.id, { limit: 100 })
    expect(page.messages).toHaveLength(100)
    // Latest one hundred messages remain in ascending order.
    expect(page.messages[0].id).toBe('m150')
    expect(page.messages[99].id).toBe('m249')
    expect(page.hasMore).toBe(true)
    // The earliest sequence anchors the next page.
    expect(page.earliestSeq).toBe(getMessageSeq('m150'))
  })

  it('paginates older messages without repeats until exhausted', () => {
    const conv = chatConv()
    seed(conv.id, 250)
    const p1 = listChatMessagesPage(conv.id, { limit: 100 }) // m150..m249
    const p2 = listChatMessagesPage(conv.id, { beforeSeq: p1.earliestSeq!, limit: 100 }) // m50..m149
    expect(p2.messages[0].id).toBe('m50')
    expect(p2.messages[99].id).toBe('m149')
    expect(p2.hasMore).toBe(true)
    const p3 = listChatMessagesPage(conv.id, { beforeSeq: p2.earliestSeq!, limit: 100 }) // m0..m49
    expect(p3.messages).toHaveLength(50)
    expect(p3.messages[0].id).toBe('m0')
    expect(p3.messages[49].id).toBe('m49')
    expect(p3.hasMore).toBe(false) // Nothing precedes m0.
    // Concatenated pages equal complete history without gaps or overlaps.
    const all = [...p3.messages, ...p2.messages, ...p1.messages].map((m) => m.id)
    expect(all).toEqual(listChatMessages(conv.id).map((m) => m.id))
  })

  it('empty conversation has no messages, hasMore=false, and earliestSeq=null', () => {
    const conv = chatConv()
    const page = listChatMessagesPage(conv.id, { limit: 100 })
    expect(page.messages).toEqual([])
    expect(page.hasMore).toBe(false)
    expect(page.earliestSeq).toBeNull()
    expect(page.latestSeq).toBeNull()
    expect(page.hasMoreAfter).toBe(false)
  })

  it('aroundSeq anchors a centered window with half before and after the target, hasMore, and hasMoreAfter', () => {
    const conv = chatConv()
    seed(conv.id, 250) // m0..m249
    const target = getMessageSeq('m120')!
    const page = listChatMessagesPage(conv.id, { aroundSeq: target, limit: 100 })
    expect(page.messages).toHaveLength(100)
    // Half (50) before m120 is m70 through m119; from m120 onward is m120 through m169.
    expect(page.messages[0].id).toBe('m70')
    expect(page.messages[99].id).toBe('m169')
    // The target message remains inside the window.
    expect(page.messages.some((m) => m.id === 'm120')).toBe(true)
    expect(page.hasMore).toBe(true) // Rows exist before m70.
    expect(page.hasMoreAfter).toBe(true) // Rows exist after m169.
    expect(page.earliestSeq).toBe(getMessageSeq('m70'))
    expect(page.latestSeq).toBe(getMessageSeq('m169'))
  })

  it('returns bounded tail windows without later pages', () => {
    const conv = chatConv()
    seed(conv.id, 250) // m0..m249
    const target = getMessageSeq('m240')!
    const page = listChatMessagesPage(conv.id, { aroundSeq: target, limit: 100 })
    // Fifty earlier and ten remaining messages produce a sixty-message tail window.
    expect(page.messages[0].id).toBe('m190')
    expect(page.messages[page.messages.length - 1].id).toBe('m249')
    expect(page.messages.some((m) => m.id === 'm240')).toBe(true)
    expect(page.hasMoreAfter).toBe(false) // m249 is the last row.
    expect(page.hasMore).toBe(true) // Rows exist before m190.
  })

  it('returns complete undersized pages without more flags', () => {
    const conv = chatConv()
    seed(conv.id, 3)
    const page = listChatMessagesPage(conv.id, { limit: 100 })
    expect(page.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2'])
    expect(page.hasMore).toBe(false)
  })

  it('handles sequence gaps after edit and resend', () => {
    const conv = chatConv()
    seed(conv.id, 10) // m0..m9 (seq 0..9)
    const seq5 = getMessageSeq('m5')!
    deleteChatMessagesFrom(conv.id, seq5) // deletes m5..m9, leaving m0..m4 (seq 0..4)
    const page = listChatMessagesPage(conv.id, { limit: 3 }) // Last three: m2, m3, m4.
    expect(page.messages.map((m) => m.id)).toEqual(['m2', 'm3', 'm4'])
    expect(page.hasMore).toBe(true)
    const prev = listChatMessagesPage(conv.id, { beforeSeq: page.earliestSeq!, limit: 3 })
    expect(prev.messages.map((m) => m.id)).toEqual(['m0', 'm1'])
    expect(prev.hasMore).toBe(false)
  })

  it('preserves complete internal ascending history', () => {
    const conv = chatConv()
    seed(conv.id, 120)
    expect(listChatMessages(conv.id)).toHaveLength(120)
    expect(listChatMessages(conv.id)[0].id).toBe('m0')
    expect(listChatMessages(conv.id)[119].id).toBe('m119')
  })

  it('round-trips hidden internal message flags', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'plain',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 't', text: 'hi' }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'handoff',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 't', text: 'Implement the approved plan…' }],
      internal: true,
      createdAt: 2,
    })
    const msgs = listChatMessages(conv.id)
    // Both messages remain in model history; only flags mark internal content.
    expect(msgs.map((m) => m.id)).toEqual(['plain', 'handoff'])
    expect(msgs.find((m) => m.id === 'plain')?.internal).toBeUndefined()
    expect(msgs.find((m) => m.id === 'handoff')?.internal).toBe(true)
  })

  it('clamps page limits between one and one thousand', () => {
    const conv = chatConv()
    seed(conv.id, 5)
    expect(listChatMessagesPage(conv.id, { limit: 0 }).messages).toHaveLength(1) // Minimum 1.
    expect(listChatMessagesPage(conv.id, { limit: 999999 }).messages).toHaveLength(5) // Does not exceed the cap.
    expect(listChatMessagesPage(conv.id, { limit: Number.NaN }).messages).toHaveLength(5) // Invalid value uses a safe default.
    expect(listChatMessagesPage(conv.id, { beforeSeq: Number.NaN, limit: 2 }).messages.map((m) => m.id)).toEqual([
      'm3',
      'm4',
    ])
  })
})

describe('complete-history meter statistics', () => {
  function withUsage(
    id: string,
    conversationId: string,
    modelId: string,
    usage: ChatUsage,
    providerId = 'p',
    createdAt = 1
  ): ChatMessage {
    return {
      id,
      conversationId,
      role: 'assistant',
      parts: [{ type: 'text', id: `t-${id}`, text: 'ok' }],
      model: { providerId, modelId },
      usage,
      createdAt,
    }
  }

  it('aggregates provider usage and returns latest context usage', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'u0',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 't', text: 'hi' }],
      createdAt: 1,
    })
    upsertChatMessage(withUsage('a1', conv.id, 'gpt-x', { input: 100, output: 20, contextInput: 90 }))
    upsertChatMessage(
      withUsage('a2', conv.id, 'gpt-x', {
        input: 200,
        output: 30,
        contextInput: 180,
        cachedInput: 50,
        cacheCreate: 25,
      })
    )
    upsertChatMessage(
      withUsage('a3', conv.id, 'claude-y', {
        input: 10,
        output: 5,
        contextInput: 8,
        subInput: 1000,
        subOutput: 200,
        subCachedInput: 600,
        subCacheCreate: 300,
      })
    )
    // Compaction contributes cost without replacing real context measurements.
    upsertChatMessage(
      withUsage('compact', conv.id, 'claude-y', { usageVersion: 2, input: 70, output: 8, billingOnly: true })
    )
    // Identical model IDs under different providers have separate prices and aggregates.
    upsertChatMessage(
      withUsage('a4', conv.id, 'gpt-x', { input: 7, output: 2, contextInput: 6, modelContextWindow: 258_400 }, 'p2')
    )
    const s = chatHistoryStats(conv.id)
    expect(s.lastUsage).toEqual({ input: 7, output: 2, contextInput: 6, modelContextWindow: 258_400 })
    expect(s.lastModel).toEqual({ providerId: 'p2', modelId: 'gpt-x' })
    expect(s.modelIds.sort()).toEqual(['claude-y', 'gpt-x'])
    expect(s.perModel).toHaveLength(3)
    const gpt = s.perModel.find((p) => p.providerId === 'p' && p.modelId === 'gpt-x')!
    expect(gpt).toMatchObject({ input: 225, output: 50, cachedInput: 50, cacheCreate: 25 })
    const claude = s.perModel.find((p) => p.modelId === 'claude-y')!
    expect(claude).toMatchObject({
      input: 80,
      output: 13,
      subInput: 100,
      subOutput: 200,
      subCachedInput: 600,
      subCacheCreate: 300,
    })
    expect(s.perModel.find((p) => p.providerId === 'p2' && p.modelId === 'gpt-x')).toMatchObject({
      input: 7,
      output: 2,
    })
  })

  it('conversation without turns containing usage has null lastUsage and empty perModel and modelIds', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'u0',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 't', text: 'hi' }],
      createdAt: 1,
    })
    expect(chatHistoryStats(conv.id)).toEqual({ lastUsage: null, perModel: [], modelIds: [], bytesSaved: 0 })
  })

  it('preserves unknown parent and valid subagent usage buckets', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'a1',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      usage: {
        usageVersion: 2,
        input: 7,
        output: 3,
        subInput: 10,
        subOutput: 1,
        subagentUsage: [{ providerId: 'p', modelId: 'worker', input: 10, output: 1 }],
      },
      createdAt: 1,
    })
    const s = chatHistoryStats(conv.id)
    expect(s.modelIds).toEqual(['worker'])
    expect(s.perModel).toHaveLength(2)
    expect(s.perModel.find((p) => p.modelId === null)).toMatchObject({ providerId: null, input: 7, output: 3 })
    expect(s.perModel.find((p) => p.modelId === 'worker')).toMatchObject({
      providerId: 'p',
      subInput: 10,
      subOutput: 1,
    })
  })
})

describe('aggregateChatUsage (painel global)', () => {
  function usageMessage(args: {
    id: string
    conversationId: string
    providerId: string
    modelId: string
    createdAt: number
    usage: ChatUsage
  }): ChatMessage {
    return {
      id: args.id,
      conversationId: args.conversationId,
      role: 'assistant',
      parts: [],
      model: { providerId: args.providerId, modelId: args.modelId },
      usage: args.usage,
      createdAt: args.createdAt,
    }
  }

  it('attributes disjoint buckets to effective models', () => {
    const conv = chatConv()
    upsertChatMessage(
      usageMessage({
        id: 'u1',
        conversationId: conv.id,
        providerId: 'anthropic-a',
        modelId: 'same-model',
        createdAt: 1_000,
        usage: {
          usageVersion: 2,
          input: 100,
          output: 100,
          cachedInput: 600,
          cacheCreate: 300,
          runtimeEstimatedCostUsd: 0.02,
          subInput: 500,
          subOutput: 50,
          subCachedInput: 300,
          subCacheCreate: 100,
          subagentUsage: [
            {
              providerId: 'anthropic-a',
              modelId: 'worker-model',
              input: 100,
              output: 50,
              cachedInput: 300,
              cacheCreate: 100,
              runtimeEstimatedCostUsd: 0.01,
              catalogInput: 20,
              catalogOutput: 2,
            },
          ],
        },
      })
    )
    upsertChatMessage(
      usageMessage({
        id: 'u2',
        conversationId: conv.id,
        providerId: 'openai-b',
        modelId: 'same-model',
        createdAt: 2_000,
        usage: { usageVersion: 2, input: 200, output: 20, cachedInput: 150 },
      })
    )
    upsertChatMessage(
      usageMessage({
        id: 'compact',
        conversationId: conv.id,
        providerId: 'anthropic-a',
        modelId: 'same-model',
        createdAt: 3_000,
        usage: { usageVersion: 2, input: 100, output: 10, billingOnly: true },
      })
    )

    const stats = aggregateChatUsage()
    expect(stats.totalTurns).toBe(2) // Compaction has cost and context but is not a user turn.
    expect(stats.firstAt).toBe(1_000)
    expect(stats.lastAt).toBe(3_000)
    expect(stats.perModel).toHaveLength(3)
    expect(stats.perModel.find((m) => m.providerId === 'anthropic-a' && m.modelId === 'same-model')).toMatchObject({
      turns: 1,
      input: 600, // main 100 + compaction 100 + residual subInput 400 without breakdown
      output: 110,
      cacheRead: 600,
      cacheCreate: 300,
      runtimeEstimatedCostUsd: 0.02,
      catalogInput: 500,
      catalogOutput: 10,
      catalogCacheRead: 0,
      catalogCacheCreate: 0,
    })
    expect(stats.perModel.find((m) => m.modelId === 'worker-model')).toMatchObject({
      turns: 0,
      input: 100,
      output: 50,
      cacheRead: 300,
      cacheCreate: 100,
      runtimeEstimatedCostUsd: 0.01,
      catalogInput: 20,
      catalogOutput: 2,
      catalogCacheRead: 0,
      catalogCacheCreate: 0,
    })
    expect(stats.perModel.find((m) => m.providerId === 'openai-b')).toMatchObject({
      turns: 1,
      input: 200,
      output: 20,
      cacheRead: 150,
      cacheCreate: 0,
    })
    // Sort across disjoint buckets without duplicating cache usage.
    expect(stats.perModel[0]).toMatchObject({ providerId: 'anthropic-a', modelId: 'same-model' })
    const physicalTotal = stats.perModel.reduce((sum, m) => sum + m.input + m.output + m.cacheRead + m.cacheCreate, 0)
    expect(physicalTotal).toBe(2_530)

    const history = chatHistoryStats(conv.id)
    expect(history.perModel.find((m) => m.providerId === 'anthropic-a' && m.modelId === 'same-model')).toMatchObject({
      runtimeEstimatedCostUsd: 0.02,
      catalogInput: 500,
      catalogOutput: 10,
    })
    expect(history.perModel.find((m) => m.modelId === 'worker-model')).toMatchObject({
      runtimeEstimatedCostUsd: 0.01,
      catalogInput: 20,
      catalogOutput: 2,
    })
  })

  it('preserves native zero estimates without repricing covered tokens', () => {
    const conv = chatConv()
    upsertChatMessage(
      usageMessage({
        id: 'zero-runtime-cost',
        conversationId: conv.id,
        providerId: 'p',
        modelId: 'free-model',
        createdAt: 1_000,
        usage: {
          usageVersion: 2,
          input: 100,
          output: 10,
          runtimeEstimatedCostUsd: 0,
        },
      })
    )

    expect(aggregateChatUsage().perModel[0]).toMatchObject({
      runtimeEstimatedCostUsd: 0,
      catalogInput: 0,
      catalogOutput: 0,
      catalogCacheRead: 0,
      catalogCacheCreate: 0,
    })
  })

  it('avoids duplicating detailed subagent breakdowns', () => {
    const conv = chatConv()
    upsertChatMessage(
      usageMessage({
        id: 'detailed-sub',
        conversationId: conv.id,
        providerId: 'p',
        modelId: 'parent',
        createdAt: 1_000,
        usage: {
          usageVersion: 2,
          input: 10,
          output: 1,
          subInput: 50,
          subOutput: 5,
          subagentUsage: [{ providerId: 'p', modelId: 'worker', input: 100, output: 10 }],
        },
      })
    )
    const stats = aggregateChatUsage()
    expect(stats.perModel.find((m) => m.modelId === 'parent')).toMatchObject({ input: 10, output: 1 })
    expect(stats.perModel.find((m) => m.modelId === 'worker')).toMatchObject({ input: 100, output: 10 })
    expect(stats.perModel.reduce((sum, m) => sum + m.input + m.output, 0)).toBe(121)
  })

  it('normalizes legacy subagent buckets without duplicate cache', () => {
    const conv = chatConv()
    upsertChatMessage(
      usageMessage({
        id: 'legacy-sub',
        conversationId: conv.id,
        providerId: 'p',
        modelId: 'parent',
        createdAt: 1_000,
        usage: {
          input: 100,
          output: 10,
          subInput: 50,
          subOutput: 5,
          subCachedInput: 40,
          subCacheCreate: 5,
        },
      })
    )
    expect(aggregateChatUsage().perModel).toEqual([
      expect.objectContaining({
        providerId: 'p',
        modelId: 'parent',
        input: 105,
        output: 15,
        cacheRead: 40,
        cacheCreate: 5,
      }),
    ])
  })

  it('preserves entirely cached subagent usage', () => {
    const conv = chatConv()
    upsertChatMessage(
      usageMessage({
        id: 'cached-sub',
        conversationId: conv.id,
        providerId: 'p',
        modelId: 'parent',
        createdAt: 1_000,
        usage: {
          usageVersion: 2,
          input: 10,
          output: 1,
          subInput: 0,
          subOutput: 0,
          subCachedInput: 800,
          subCacheCreate: 200,
        },
      })
    )
    expect(aggregateChatUsage().perModel[0]).toMatchObject({
      input: 10,
      output: 1,
      cacheRead: 800,
      cacheCreate: 200,
    })
  })

  it('applies inclusive time filters', () => {
    const conv = chatConv()
    for (const [id, createdAt] of [
      ['old', 1_000],
      ['mid', 2_000],
      ['new', 3_000],
    ] as const) {
      upsertChatMessage(
        usageMessage({
          id,
          conversationId: conv.id,
          providerId: 'p',
          modelId: 'm',
          createdAt,
          usage: { input: createdAt, output: 1 },
        })
      )
    }
    const stats = aggregateChatUsage({ since: 2_000, until: 3_000 })
    expect(stats.totalTurns).toBe(2)
    expect(stats.perModel[0]).toMatchObject({ input: 5_000, output: 2 })
  })

  it('keeps idempotent usage snapshots across checkpoints without usage', () => {
    const conv = chatConv()
    const checkpoint = (usage?: StoredChatUsage): StoredChatMessage => ({
      id: 'streaming-assistant',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      model: { providerId: 'p', modelId: 'm' },
      ...(usage ? { usage } : {}),
      createdAt: 2_000,
    })

    upsertChatMessage(checkpoint())
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM chat_usage_ledger').get()).toMatchObject({ n: 0 })
    upsertChatMessage(checkpoint({ usageVersion: 2, input: 10, output: 2 }))
    upsertChatMessage(
      checkpoint({ usageVersion: 2, input: 30, output: 4, cachedInput: 5, contextIdentity: 'private-context-hash' })
    )
    // Checkpoints without usage cannot refund recorded billable snapshots.
    upsertChatMessage(checkpoint())

    expect(getDb().prepare('SELECT COUNT(*) AS n FROM chat_usage_ledger').get()).toMatchObject({ n: 1 })
    const ledger = getDb().prepare('SELECT usage_json FROM chat_usage_ledger').get() as { usage_json: string }
    expect(JSON.parse(ledger.usage_json)).not.toHaveProperty('contextIdentity')
    expect(aggregateChatUsage()).toMatchObject({ totalTurns: 1 })
    expect(aggregateChatUsage().perModel[0]).toMatchObject({ input: 30, output: 4, cacheRead: 5 })
  })

  it('backfills transcripts idempotently and tolerates invalid metadata', () => {
    const conv = chatConv()
    const db = getDb()
    // Simulate old databases whose messages predate ledgers and triggers.
    db.exec(
      'DROP TRIGGER trg_chat_usage_ledger_after_insert; DROP TRIGGER trg_chat_usage_ledger_after_usage_update; DROP TABLE chat_usage_ledger;'
    )
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
       VALUES (?, ?, 'assistant', '[]', ?, 0, ?)`
    ).run(
      'pre-ledger',
      conv.id,
      JSON.stringify({
        model: { providerId: 'p', modelId: 'm' },
        usage: { usageVersion: 2, input: 9, output: 3, contextIdentity: 'backfill-private-hash' },
      }),
      4_000
    )
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
       VALUES (?, ?, 'assistant', '[]', ?, 1, ?)`
    ).run('corrupt-meta', conv.id, '{not-json', 4_001)

    restartDb()
    expect(aggregateChatUsage()).toMatchObject({ totalTurns: 1 })
    expect(aggregateChatUsage().perModel[0]).toMatchObject({ providerId: 'p', modelId: 'm', input: 9, output: 3 })
    const backfilled = getDb()
      .prepare('SELECT usage_json FROM chat_usage_ledger WHERE message_id = ?')
      .get('pre-ledger') as {
      usage_json: string
    }
    expect(JSON.parse(backfilled.usage_json)).not.toHaveProperty('contextIdentity')

    upsertChatMessage({
      id: 'post-upgrade',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      model: { providerId: 'p', modelId: 'm' },
      usage: { input: 2, output: 1, contextIdentity: 'post-upgrade-private-hash' },
      createdAt: 4_002,
    })
    const postUpgrade = getDb()
      .prepare('SELECT usage_json FROM chat_usage_ledger WHERE message_id = ?')
      .get('post-upgrade') as { usage_json: string }
    expect(JSON.parse(postUpgrade.usage_json)).not.toHaveProperty('contextIdentity')

    getDb()
      .prepare(
        `INSERT INTO chat_usage_ledger (message_id, provider_id, model_id, usage_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        'orphan-private',
        'p',
        'm',
        JSON.stringify({ input: 4, output: 1, contextIdentity: 'orphan-private-hash' }),
        4_003
      )
    restartDb()
    const orphan = getDb()
      .prepare('SELECT usage_json FROM chat_usage_ledger WHERE message_id = ?')
      .get('orphan-private') as {
      usage_json: string
    }
    expect(JSON.parse(orphan.usage_json)).not.toHaveProperty('contextIdentity')
  })
})

// Latest compaction milestones immediately estimate context from
// summary tokens instead of leaving the meter full until another turn.
describe('immediate compaction milestone history stats', () => {
  const milestone = (id: string, conversationId: string, text: string, output?: number): ChatMessage => ({
    id,
    conversationId,
    role: 'assistant',
    parts: [{ type: 'compaction', id: `c-${id}`, text }],
    model: { providerId: 'p', modelId: 'm' },
    ...(output != null ? { usage: { usageVersion: 2, input: 500, output, billingOnly: true } as ChatUsage } : {}),
    createdAt: 2,
  })
  const turn = (id: string, conversationId: string, contextInput: number): ChatMessage => ({
    id,
    conversationId,
    role: 'assistant',
    parts: [{ type: 'text', id: `t-${id}`, text: 'ok' }],
    model: { providerId: 'p', modelId: 'm' },
    usage: { input: contextInput, output: 10, contextInput },
    createdAt: 1,
  })

  it('uses compaction output estimates for newer milestones', () => {
    const conv = chatConv()
    upsertChatMessage(turn('a1', conv.id, 371_000)) // Full turn (100% of the window).
    upsertChatMessage(milestone('mk', conv.id, 'summary…', 1234))
    const s = chatHistoryStats(conv.id)
    expect(s.lastUsage).toEqual({ usageVersion: 2, input: 0, output: 0, contextInput: 1234, contextOutput: 0 })
  })

  it('milestone WITHOUT usage estimates from text at approximately four characters per token', () => {
    const conv = chatConv()
    upsertChatMessage(turn('a1', conv.id, 300_000))
    upsertChatMessage(milestone('mk', conv.id, 'x'.repeat(4000)))
    expect(chatHistoryStats(conv.id).lastUsage?.contextInput).toBe(1000)
  })

  it('prefers real turns after compaction milestones', () => {
    const conv = chatConv()
    upsertChatMessage(milestone('mk', conv.id, 'summary…', 1234))
    upsertChatMessage({ ...turn('a2', conv.id, 5_000), createdAt: 3 })
    expect(chatHistoryStats(conv.id).lastUsage?.contextInput).toBe(5_000)
  })

  it('preserves intra-turn estimates after immediate abort', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'active',
      conversationId: conv.id,
      role: 'assistant',
      parts: [
        { type: 'text', id: 'before', text: 'prefix cheio' },
        { type: 'compaction', id: 'cmp', text: 'summary short' },
      ],
      model: { providerId: 'p', modelId: 'm' },
      finishReason: 'aborted',
      usage: { usageVersion: 2, input: 90_000, output: 500, contextInput: 321, contextOutput: 0 },
      createdAt: 1,
    })
    expect(chatHistoryStats(conv.id).lastUsage?.contextInput).toBe(321)
  })

  it('does not treat quoted user compaction JSON as milestones', () => {
    const conv = chatConv()
    upsertChatMessage(turn('a1', conv.id, 42_000))
    upsertChatMessage({
      id: 'u9',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 't9', text: 'look at this JSON: {"type":"compaction"}' }],
      createdAt: 4,
    })
    expect(chatHistoryStats(conv.id).lastUsage?.contextInput).toBe(42_000) // No spurious estimate.
  })
})

describe('review-loop context isolation and billing in the store', () => {
  const scope = (executionId: string, iteration: number, loopId = 'rl_1') => ({
    kind: 'review-loop' as const,
    executionId,
    loopId,
    iteration,
    maxIterations: 5,
  })

  function seedMainAndRounds(conversationId: string): void {
    upsertChatMessage({
      id: 'legacy-user',
      conversationId,
      role: 'user',
      parts: [{ type: 'text', id: 't-lu', text: 'question legada' }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'legacy-asst',
      conversationId,
      role: 'assistant',
      parts: [{ type: 'text', id: 't-la', text: 'answer legada' }],
      model: { providerId: 'p', modelId: 'main-model' },
      usage: { usageVersion: 2, input: 100, output: 20, contextInput: 90 },
      createdAt: 2,
    })
    upsertChatMessage({
      id: 'main-user',
      conversationId,
      role: 'user',
      parts: [{ type: 'text', id: 't-mu', text: 'turn main' }],
      executionScope: { kind: 'conversation' },
      createdAt: 3,
    })
    upsertChatMessage({
      id: 'r1-user',
      conversationId,
      role: 'user',
      parts: [{ type: 'text', id: 't-r1u', text: 'findings r1' }],
      internal: true,
      source: 'chatgpt-web-review-loop',
      executionScope: scope('exec-a', 1),
      createdAt: 4,
    })
    upsertChatMessage({
      id: 'r1-asst',
      conversationId,
      role: 'assistant',
      parts: [{ type: 'text', id: 't-r1a', text: 'fix r1' }],
      model: { providerId: 'p', modelId: 'round-model' },
      source: 'chatgpt-web-review-loop',
      executionScope: scope('exec-a', 1),
      usage: {
        usageVersion: 2,
        input: 50,
        output: 10,
        contextInput: 40,
        runtimeEstimatedCostUsd: 0.01,
      },
      createdAt: 5,
    })
    upsertChatMessage({
      id: 'r2-user',
      conversationId,
      role: 'user',
      parts: [{ type: 'text', id: 't-r2u', text: 'findings r2' }],
      internal: true,
      source: 'chatgpt-web-review-loop',
      executionScope: scope('exec-b', 2),
      createdAt: 6,
    })
    upsertChatMessage({
      id: 'r2-asst',
      conversationId,
      role: 'assistant',
      parts: [{ type: 'text', id: 't-r2a', text: 'fix r2' }],
      model: { providerId: 'p', modelId: 'round-model' },
      source: 'chatgpt-web-review-loop',
      executionScope: scope('exec-b', 2),
      usage: { usageVersion: 2, input: 30, output: 5, contextInput: 25, runtimeEstimatedCostUsd: 0 },
      createdAt: 7,
    })
  }

  it('includes legacy conversation scope while excluding review loops', () => {
    const conv = chatConv()
    seedMainAndRounds(conv.id)
    expect(listChatMessages(conv.id).map((m) => m.id)).toEqual([
      'legacy-user',
      'legacy-asst',
      'main-user',
      'r1-user',
      'r1-asst',
      'r2-user',
      'r2-asst',
    ])
    expect(listConversationContextMessages(conv.id).map((m) => m.id)).toEqual([
      'legacy-user',
      'legacy-asst',
      'main-user',
    ])
    expect(lastConversationContextMessage(conv.id)?.id).toBe('main-user')
  })

  it('keeps review cards in full history but out of inference context', () => {
    const conv = chatConv()
    seedMainAndRounds(conv.id)
    const full = listChatMessages(conv.id)
    expect(full.filter((m) => m.source === 'chatgpt-web-review-loop')).toHaveLength(4)
    expect(full.filter((m) => m.executionScope?.kind === 'review-loop')).toHaveLength(4)
    const main = listConversationContextMessages(conv.id)
    expect(main.every((m) => m.source !== 'chatgpt-web-review-loop')).toBe(true)
    expect(main.every((m) => m.executionScope?.kind !== 'review-loop')).toBe(true)
  })

  it('isolates execution histories by iteration', () => {
    const conv = chatConv()
    seedMainAndRounds(conv.id)
    expect(listExecutionContextMessages(conv.id, 'exec-a').map((m) => m.id)).toEqual(['r1-user', 'r1-asst'])
    expect(listExecutionContextMessages(conv.id, 'exec-b').map((m) => m.id)).toEqual(['r2-user', 'r2-asst'])
    expect(listExecutionContextMessages(conv.id, 'exec-missing')).toEqual([])
    expect(listExecutionContextMessages(conv.id, '')).toEqual([])
    expect(getExecutionAssistantMessage(conv.id, 'exec-a')?.id).toBe('r1-asst')
    expect(getExecutionAssistantMessage(conv.id, 'exec-b')?.id).toBe('r2-asst')
    expect(getExecutionAssistantMessage(conv.id, 'exec-missing')).toBeUndefined()
  })

  it('includes review usage in aggregates while retaining main lastUsage', () => {
    const conv = chatConv()
    seedMainAndRounds(conv.id)
    const s = chatHistoryStats(conv.id)
    expect(s.lastUsage).toMatchObject({ input: 100, output: 20, contextInput: 90 })
    expect(s.lastModel).toEqual({ providerId: 'p', modelId: 'main-model' })
    expect(s.perModel.find((p) => p.modelId === 'main-model')).toMatchObject({ input: 100, output: 20 })
    expect(s.perModel.find((p) => p.modelId === 'round-model')).toMatchObject({
      input: 80,
      output: 15,
      runtimeEstimatedCostUsd: 0.01,
    })
  })

  it('preserves runtime costs and auxiliary catalog buckets', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'main-a',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 't', text: 'ok' }],
      model: { providerId: 'p', modelId: 'm' },
      // Claude main uses native cost while unestimated compaction uses catalog buckets.
      usage: {
        usageVersion: 2,
        input: 100,
        output: 20,
        contextInput: 100,
        runtimeEstimatedCostUsd: 0.5,
        catalogInput: 30,
        catalogOutput: 10,
        catalogCacheRead: 5,
        catalogCacheCreate: 2,
      },
      createdAt: 1,
    })
    const pm = chatHistoryStats(conv.id).perModel.find((p) => p.modelId === 'm')
    expect(pm).toMatchObject({
      input: 100,
      output: 20,
      runtimeEstimatedCostUsd: 0.5,
      catalogInput: 30,
      catalogOutput: 10,
      catalogCacheRead: 5,
      catalogCacheCreate: 2,
    })
    // Meters sum native main and catalog compaction costs.
    const aggregated = aggregateChatUsage().perModel.find((p) => p.modelId === 'm')
    expect(aggregated).toMatchObject({
      runtimeEstimatedCostUsd: 0.5,
      catalogInput: 30,
      catalogOutput: 10,
      catalogCacheRead: 5,
      catalogCacheCreate: 2,
    })
  })

  it('ignores isolated compaction milestones for main lastUsage', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'main-a',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 't', text: 'ok' }],
      model: { providerId: 'p', modelId: 'm' },
      usage: { input: 40_000, output: 10, contextInput: 40_000 },
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'round-compact',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'compaction', id: 'c', text: 'summary isolated…' }],
      model: { providerId: 'p', modelId: 'm' },
      source: 'chatgpt-web-review-loop',
      executionScope: scope('exec-x', 1),
      usage: { usageVersion: 2, input: 500, output: 80, billingOnly: true },
      createdAt: 2,
    })
    expect(chatHistoryStats(conv.id).lastUsage?.contextInput).toBe(40_000)
  })

  it('aggregates review costs and preserves native zero', () => {
    const conv = chatConv()
    seedMainAndRounds(conv.id)
    const stats = aggregateChatUsage()
    expect(stats.totalTurns).toBe(3)
    expect(stats.perModel.find((m) => m.modelId === 'main-model')).toMatchObject({
      turns: 1,
      input: 100,
      output: 20,
    })
    expect(stats.perModel.find((m) => m.modelId === 'round-model')).toMatchObject({
      turns: 2,
      input: 80,
      output: 15,
      runtimeEstimatedCostUsd: 0.01,
      catalogInput: 0,
      catalogOutput: 0,
    })
  })

  it('marks unfinished rounds interrupted with public codes', () => {
    const conv = chatConv()
    // Preserve healthy main messages.
    upsertChatMessage({
      id: 'main-user',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 't-mu', text: 'turn main' }],
      createdAt: 1,
    })
    // Interrupted isolated assistants lack terminals but retain durable usage.
    const scopeExec = (iteration: number) => ({
      kind: 'review-loop' as const,
      executionId: 'exec-crash',
      loopId: 'rl_1',
      iteration,
      maxIterations: 5,
    })
    upsertChatMessage({
      id: 'crash-user',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 't-cu', text: 'findings crash' }],
      internal: true,
      source: 'chatgpt-web-review-loop',
      executionScope: scopeExec(1),
      createdAt: 2,
    })
    upsertChatMessage({
      id: 'crash-asst',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 't-ca', text: 'work in progress' }],
      model: { providerId: 'p', modelId: 'round-model' },
      source: 'chatgpt-web-review-loop',
      executionScope: scopeExec(1),
      usage: { usageVersion: 2, input: 50, output: 10, contextInput: 40, runtimeEstimatedCostUsd: 0.01 },
      createdAt: 3,
    })
    // Recovery targets only isolated executions, not unfinished main turns.
    upsertChatMessage({
      id: 'main-asst-no-terminal',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 't-mt', text: 'without terminal' }],
      createdAt: 4,
    })

    expect(reconcileInterruptedExecutionMessages(conv.id)).toBe(1)
    const [recovered] = listExecutionContextMessages(conv.id, 'exec-crash').filter((m) => m.role === 'assistant')
    expect(recovered.finishReason).toBe('interrupted')
    // Renderer messages use public codes rather than raw audit errors.
    expect(recovered.errorCode).toBe('review-loop-process-interrupted')
    expect(recovered.error).toBe('process-interrupted')
    // Durable billing and audit usage survives crashes unchanged.
    expect(recovered.usage).toMatchObject({
      usageVersion: 2,
      input: 50,
      output: 10,
      contextInput: 40,
      runtimeEstimatedCostUsd: 0.01,
    })
    // Main remains intact: neither the user nor the assistant without a terminal state was touched.
    expect(listChatMessages(conv.id).find((m) => m.id === 'main-asst-no-terminal')?.finishReason).toBeUndefined()
    // Repeated reconciliation neither remarks nor recounts messages.
    expect(reconcileInterruptedExecutionMessages(conv.id)).toBe(0)
  })

  it('reconciles paired reviewer roles without resuming loops', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'paired-reviewer-open',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'paired-text', text: 'review in progress' }],
      source: 'maestrly-review-loop',
      executionScope: {
        kind: 'review-loop',
        executionId: 'paired-execution',
        loopId: 'paired-loop',
        iteration: 1,
        maxIterations: 5,
        role: 'reviewer',
        executorConversationId: 'executor',
        reviewerConversationId: conv.id,
      },
      createdAt: 1,
    })

    expect(reconcileInterruptedExecutionMessages(conv.id)).toBe(1)
    const recovered = getExecutionAssistantMessage(conv.id, 'paired-execution')
    expect(recovered).toMatchObject({
      source: 'maestrly-review-loop',
      finishReason: 'interrupted',
      errorCode: 'review-loop-process-interrupted',
      executionScope: { role: 'reviewer', executorConversationId: 'executor', reviewerConversationId: conv.id },
    })
    expect(reconcileInterruptedExecutionMessages(conv.id)).toBe(0)
  })

  it('provides only main context to normal turns after review rounds', () => {
    const conv = chatConv()
    seedMainAndRounds(conv.id)
    // Normal turns share runner seed and inference history sources.
    const normal = runnerContextHistory(conv.id, {})
    expect(normal.map((m) => m.id)).toEqual(['legacy-user', 'legacy-asst', 'main-user'])
    expect(normal.every((m) => m.source !== 'chatgpt-web-review-loop')).toBe(true)
    // Isolated rounds receive only their own execution history.
    expect(
      runnerContextHistory(conv.id, { ephemeralSession: true, executionScope: scope('exec-a', 1) }).map((m) => m.id)
    ).toEqual(['r1-user', 'r1-asst'])
    expect(
      runnerContextHistory(conv.id, { ephemeralSession: true, executionScope: scope('exec-b', 2) }).map((m) => m.id)
    ).toEqual(['r2-user', 'r2-asst'])
  })

  it('excludes isolated rounds from portable and native projections', () => {
    const conv = chatConv()
    seedMainAndRounds(conv.id)
    const main = listConversationContextMessages(conv.id)
    const full = listChatMessages(conv.id)
    // Rounds add text to the full transcript…
    expect(full).toHaveLength(7)
    expect(main).toHaveLength(3)
    // Current history estimates include only main context.
    expect(estimatePortableContextTokens(main)).toBeLessThan(estimatePortableContextTokens(full))
    expect(estimateNativeSeedContextTokens(main)).toBeLessThan(estimateNativeSeedContextTokens(full))
  })
})
