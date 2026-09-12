import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { deleteConversation } from '../../src/main/store'
import {
  clampUsageRange,
  getUnifiedUsage,
  invalidateUnifiedUsageCache,
  resetUsageCacheForTests,
} from '../../src/main/usage/usage-service'
import { USAGE_MAX_WINDOW_DAYS } from '../../src/shared/usage'

const DAY = 86_400_000

/** Chat Usage and Costs service backed by the application's durable ledger. */

beforeEach(() => {
  freshDb()
  resetUsageCacheForTests()
})
afterEach(closeDb)

function seedChatTurn(conversationId: string, id: string, createdAt: number): void {
  upsertChatMessage({
    id,
    conversationId,
    role: 'assistant',
    parts: [{ type: 'text', id: `${id}-t`, text: 'hello' }],
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
    usage: { usageVersion: 2, input: 100, output: 50, cachedInput: 10, cacheCreate: 5 },
    createdAt,
  })
}

describe('clampUsageRange (90-day ceiling)', () => {
  const now = new Date(2026, 6, 11).getTime()
  const floor = now - USAGE_MAX_WINDOW_DAYS * DAY

  it('without options, uses the maximum window [now-90d, now]', () => {
    expect(clampUsageRange({}, now)).toEqual({ since: floor, until: now })
  })

  it('clamps since to the 90-day floor and future until to now', () => {
    expect(clampUsageRange({ since: now - 400 * DAY, until: now + DAY }, now)).toEqual({ since: floor, until: now })
  })

  it('preserves a valid range within the window', () => {
    const since = now - 7 * DAY
    const until = now - DAY
    expect(clampUsageRange({ since, until }, now)).toEqual({ since, until })
  })

  it('since > until collapses since to until, producing an empty range', () => {
    const until = now - 10 * DAY
    expect(clampUsageRange({ since: now - DAY, until }, now)).toEqual({ since: until, until })
  })
})

describe('getUnifiedUsage', () => {
  it('returns only Maestrly Chat usage with providerId, turns, and cost', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, {})
    seedChatTurn(conv.id, 'a1', Date.now() - DAY)
    seedChatTurn(conv.id, 'a2', Date.now())

    const stats = await getUnifiedUsage()
    expect(stats.rows).toHaveLength(1)
    expect(stats.rows[0]).toMatchObject({
      source: 'chat',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      input: 200,
      output: 100,
      cacheRead: 20,
      cacheCreate: 10,
      turns: 2,
      costUsd: null, // o renderer precifica o chat (models.dev)
    })
    expect(stats.chatTurns).toBe(2)
    expect(stats.firstAt).not.toBeNull()
    expect(stats.lastAt).toBeGreaterThanOrEqual(stats.firstAt!)
  })

  it('period filtering excludes chat messages outside the range', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, {})
    seedChatTurn(conv.id, 'old', Date.now() - 30 * DAY)
    seedChatTurn(conv.id, 'new', Date.now())

    const stats = await getUnifiedUsage({ since: Date.now() - 7 * DAY })
    expect(stats.rows[0].turns).toBe(1)
    expect(stats.chatTurns).toBe(1)
  })

  it('preserves zero native cost and separates legacy catalog-priced usage', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, {})
    upsertChatMessage({
      id: 'native-zero',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
      usage: {
        usageVersion: 2,
        input: 100,
        output: 10,
        runtimeEstimatedCostUsd: 0,
      },
      createdAt: Date.now() - 1,
    })
    seedChatTurn(conv.id, 'legacy-catalog', Date.now())

    const stats = await getUnifiedUsage({ force: true })
    expect(stats.rows[0]).toMatchObject({
      costUsd: 0,
      catalogInput: 100,
      catalogOutput: 50,
      catalogCacheRead: 10,
      catalogCacheCreate: 5,
    })
  })

  it('60-second cache returns the same snapshot for the same key; force refreshes it', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, {})
    seedChatTurn(conv.id, 'a1', Date.now())

    const s1 = await getUnifiedUsage()
    const s2 = await getUnifiedUsage()
    expect(s2).toBe(s1) // Cache hit preserves reference identity.

    seedChatTurn(conv.id, 'a2', Date.now())
    const s3 = await getUnifiedUsage({ force: true })
    expect(s3).not.toBe(s1)
    expect(s3.rows[0].turns).toBe(2)
  })

  it('changing the period to another day produces a new key and refreshes without force', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, {})
    seedChatTurn(conv.id, 'a1', Date.now())

    const s1 = await getUnifiedUsage()
    const s2 = await getUnifiedUsage({ since: Date.now() - 7 * DAY })
    expect(s2).not.toBe(s1)
  })

  it('preserves unified usage after deleting the conversation that produced the turn', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, {})
    seedChatTurn(conv.id, 'durable', Date.now())

    const before = await getUnifiedUsage({ force: true })
    deleteConversation(conv.id)
    const after = await getUnifiedUsage({ force: true })

    expect(after.chatTurns).toBe(before.chatTurns)
    expect(after.rows).toEqual(before.rows)
  })

  it('includes tokens, cost, and turns from isolated review loops in unified usage', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, {})
    seedChatTurn(conv.id, 'main', Date.now() - 1)
    upsertChatMessage({
      id: 'round-1',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 't', text: 'fix' }],
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
      source: 'chatgpt-web-review-loop',
      executionScope: {
        kind: 'review-loop',
        executionId: 'exec-1',
        loopId: 'rl_1',
        iteration: 1,
        maxIterations: 5,
      },
      usage: {
        usageVersion: 2,
        input: 40,
        output: 8,
        runtimeEstimatedCostUsd: 0.002,
      },
      createdAt: Date.now(),
    })

    const stats = await getUnifiedUsage({ force: true })
    expect(stats.chatTurns).toBe(2)
    expect(stats.rows[0]).toMatchObject({
      source: 'chat',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      input: 140,
      output: 58,
      turns: 2,
      costUsd: 0.002,
    })
  })

  it('invalidateUnifiedUsageCache rereads the ledger without caller force', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, {})
    seedChatTurn(conv.id, 'a1', Date.now())

    const s1 = await getUnifiedUsage()
    expect(s1.chatTurns).toBe(1)

    seedChatTurn(conv.id, 'a2', Date.now())
    const cached = await getUnifiedUsage()
    expect(cached).toBe(s1) // Still a cache hit.
    expect(cached.chatTurns).toBe(1)

    invalidateUnifiedUsageCache()
    const s2 = await getUnifiedUsage()
    expect(s2).not.toBe(s1)
    expect(s2.chatTurns).toBe(2)
  })

  it('zero native cost for an isolated turn remains valid in unified usage', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, {})
    upsertChatMessage({
      id: 'round-zero',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
      source: 'chatgpt-web-review-loop',
      executionScope: {
        kind: 'review-loop',
        executionId: 'exec-z',
        loopId: 'rl_z',
        iteration: 1,
        maxIterations: 3,
      },
      usage: {
        usageVersion: 2,
        input: 25,
        output: 4,
        runtimeEstimatedCostUsd: 0,
      },
      createdAt: Date.now(),
    })

    const stats = await getUnifiedUsage({ force: true })
    expect(stats.rows[0]).toMatchObject({
      costUsd: 0,
      turns: 1,
      catalogInput: 0,
      catalogOutput: 0,
    })
  })
})
