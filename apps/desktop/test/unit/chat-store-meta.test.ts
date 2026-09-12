import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import {
  chatHistoryStats,
  getExecutionAssistantMessage,
  lastConversationContextMessage,
  listChatMessages,
  listChatMessagesPage,
  listConversationContextMessages,
  listExecutionContextMessages,
  listInterruptedExecutionAssistantMessages,
  listPublicChatMessagesPage,
  runnerContextHistory,
  toPublicChatHistoryStats,
  toPublicChatMessage,
  toPublicChatMessages,
  toPublicChatUsage,
  upsertChatMessage,
  type StoredChatMessage,
} from '../../src/main/chat/chat-store'
import { getDb } from '../../src/main/store'
import { toModelMessages } from '../../src/main/chat/message'
import type { ChatMessage } from '../../src/shared/chat'

beforeEach(freshDb)
afterEach(closeDb)

function chatConv() {
  const ws = makeWorkspace()
  return makeConversation(ws.id, { mode: 'local' })
}

/** Insert arbitrary raw metadata to simulate legacy or corrupt records. */
function insertRaw(conversationId: string, id: string, metaJson: string): void {
  getDb()
    .prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
       VALUES (?, ?, 'assistant', '[]', ?, 0, 1000)`
    )
    .run(id, conversationId, metaJson)
}

const FP = 'a'.repeat(64)

function storedWithFingerprint(overrides: Partial<StoredChatMessage> = {}): StoredChatMessage {
  return {
    id: 'a1',
    conversationId: 'c1',
    role: 'assistant',
    createdAt: 1000,
    model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
    providerFingerprint: FP,
    usage: {
      usageVersion: 2,
      input: 10,
      output: 20,
      contextInput: 10,
      contextOutput: 20,
      contextIdentity: FP,
    },
    parts: [
      { type: 'reasoning', id: 'r1', text: 'R' },
      {
        type: 'tool',
        id: 'k1',
        toolCallId: 'k1',
        toolName: 'read',
        input: {},
        state: { status: 'completed', output: 'x' },
      },
    ],
    ...overrides,
  }
}

describe('chat-store opaque providerFingerprint provenance', () => {
  it('round-trips assistant fingerprints unchanged', () => {
    const conv = chatConv()
    upsertChatMessage(storedWithFingerprint({ conversationId: conv.id }))
    const [loaded] = listChatMessages(conv.id)
    expect(loaded.providerFingerprint).toBe(FP)
    expect(loaded.model).toEqual({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' })
    expect(loaded.parts).toHaveLength(2)
  })

  it('loads legacy messages without fingerprints', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'a1',
      conversationId: conv.id,
      role: 'assistant',
      createdAt: 1000,
      model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
      parts: [{ type: 'text', id: 't1', text: 'answer' }],
    })
    const [loaded] = listChatMessages(conv.id)
    expect(loaded.providerFingerprint).toBeUndefined()
    expect(loaded.parts).toEqual([{ type: 'text', id: 't1', text: 'answer' }])
  })

  it('ignores corrupt non-string fingerprints in meta_json', () => {
    const conv = chatConv()
    insertRaw(
      conv.id,
      'a1',
      JSON.stringify({ model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' }, providerFingerprint: 12345 })
    )
    insertRaw(conv.id, 'a2', JSON.stringify({ providerFingerprint: '' }))
    const [n1, n2] = listChatMessages(conv.id)
    expect(n1.providerFingerprint).toBeUndefined()
    expect(n1.model).toEqual({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' })
    expect(n2.providerFingerprint).toBeUndefined()
  })

  it('a placeholder without fingerprint plus a runner upsert with fingerprint persists the final identity', () => {
    const conv = chatConv()
    // Initial empty service checkpoint; the runner owns identity.
    upsertChatMessage({
      id: 'a1',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      createdAt: 1000,
    })
    // Runner upsert with full identity (same id replaces meta_json).
    upsertChatMessage(storedWithFingerprint({ conversationId: conv.id }))
    const [loaded] = listChatMessages(conv.id)
    expect(loaded.providerFingerprint).toBe(FP)
    expect(loaded.parts).toHaveLength(2)
    // Upserts fully replace metadata. Later writes without fingerprints,
    // including external integrations, remove the identity.
    upsertChatMessage({
      id: 'a1',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 't2', text: 'new' }],
      createdAt: 1000,
    })
    const [after] = listChatMessages(conv.id)
    expect(after.providerFingerprint).toBeUndefined()
  })
})

describe('chat-store public message projection', () => {
  it('removes internal identity while preserving public message fields', () => {
    const stored = storedWithFingerprint()
    const pub = toPublicChatMessage(stored)
    expect(pub).not.toHaveProperty('providerFingerprint')
    expect(pub.usage).not.toHaveProperty('contextIdentity')
    expect(pub.usage).toEqual({
      usageVersion: 2,
      input: 10,
      output: 20,
      contextInput: 10,
      contextOutput: 20,
    })
    expect(pub.model).toEqual({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' })
    expect(pub.parts).toEqual(stored.parts)
    expect(pub.createdAt).toBe(1000)
    expect(pub.id).toBe('a1')
    expect(pub.role).toBe('assistant')
    // The internal input is not mutated.
    expect(stored.providerFingerprint).toBe(FP)
    expect(stored.usage?.contextIdentity).toBe(FP)
  })

  it('removes only contextIdentity from public usage', () => {
    const usage = {
      usageVersion: 2 as const,
      input: 1,
      output: 2,
      contextIdentity: FP,
      cachedInput: 3,
    }
    const pub = toPublicChatUsage(usage)
    expect(pub).toEqual({ usageVersion: 2, input: 1, output: 2, cachedInput: 3 })
    expect(usage.contextIdentity).toBe(FP) // Does not mutate.
    expect(toPublicChatUsage(undefined)).toBeUndefined()
  })

  it('preserves the complete public message envelope', () => {
    const stored = storedWithFingerprint({
      id: 'a9',
      finishReason: 'stop',
      usage: { usageVersion: 2, input: 10, output: 20, contextIdentity: FP },
      error: 'boom',
      responseDurationMs: 123,
      internal: true,
      source: 'chatgpt-web',
      responseStartedAt: 99,
    })
    const pub = toPublicChatMessage(stored)
    expect(pub).toEqual({
      id: 'a9',
      conversationId: 'c1',
      role: 'assistant',
      parts: stored.parts,
      model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
      source: 'chatgpt-web',
      createdAt: 1000,
      finishReason: 'stop',
      usage: { usageVersion: 2, input: 10, output: 20 },
      error: 'boom',
      errorCode: undefined,
      responseStartedAt: 99,
      responseDurationMs: 123,
      internal: true,
    })
  })

  it('projects complete lists without sharing private fields', () => {
    const list: StoredChatMessage[] = [storedWithFingerprint({ id: 'a1' }), storedWithFingerprint({ id: 'a2' })]
    const pub = toPublicChatMessages(list)
    expect(pub).toHaveLength(2)
    for (const message of pub) {
      expect(message).not.toHaveProperty('providerFingerprint')
      expect(message.usage).not.toHaveProperty('contextIdentity')
    }
    // No internal entry lost its identity.
    expect(list.map((m) => m.providerFingerprint)).toEqual([FP, FP])
    expect(list.map((m) => m.usage?.contextIdentity)).toEqual([FP, FP])
  })

  it('projects messages without internal identity without inventing fields', () => {
    const stored = storedWithFingerprint({
      providerFingerprint: undefined,
      usage: { usageVersion: 2, input: 1, output: 2 },
    })
    const pub = toPublicChatMessage(stored)
    expect(pub).not.toHaveProperty('providerFingerprint')
    expect(pub.usage).not.toHaveProperty('contextIdentity')
  })
})

describe('chat-store history IPC boundary', () => {
  it('never returns private identity in public history pages', () => {
    const conv = chatConv()
    upsertChatMessage(storedWithFingerprint({ id: 'a1', conversationId: conv.id }))
    upsertChatMessage(storedWithFingerprint({ id: 'a2', conversationId: conv.id }))
    const page = listPublicChatMessagesPage(conv.id, { limit: 10 })
    expect(page.messages).toHaveLength(2)
    for (const message of page.messages) {
      expect(message).not.toHaveProperty('providerFingerprint')
      expect(message.usage).not.toHaveProperty('contextIdentity')
      expect(JSON.stringify(message)).not.toContain('contextIdentity')
      expect(JSON.stringify(message)).not.toContain(FP)
    }
    expect(page.messages.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(page.hasMore).toBe(false)
    expect(page.earliestSeq).toBe(0)
    expect(page.latestSeq).toBe(1)
  })

  it('preserves private identity in internal history pages', () => {
    const conv = chatConv()
    upsertChatMessage(storedWithFingerprint({ id: 'a1', conversationId: conv.id }))
    const page = listChatMessagesPage(conv.id, { limit: 10 })
    expect(page.messages[0].providerFingerprint).toBe(FP)
    expect(page.messages[0].usage?.contextIdentity).toBe(FP)
  })

  it('preserves internal usage.contextIdentity across round trips', () => {
    const conv = chatConv()
    upsertChatMessage(storedWithFingerprint({ conversationId: conv.id }))
    const [loaded] = listChatMessages(conv.id)
    expect(loaded.usage?.contextIdentity).toBe(FP)
    expect(loaded.usage?.input).toBe(10)
  })

  it('preserves public pagination anchors and hasMore', () => {
    const conv = chatConv()
    for (let i = 0; i < 5; i++) {
      upsertChatMessage(storedWithFingerprint({ id: `a${i}`, conversationId: conv.id }))
    }
    const page = listPublicChatMessagesPage(conv.id, { beforeSeq: 4, limit: 2 })
    expect(page.messages.map((m) => m.id)).toEqual(['a2', 'a3'])
    expect(page.hasMore).toBe(true)
    expect(page.earliestSeq).toBe(2)
    expect(page.latestSeq).toBe(3)
    for (const message of page.messages) {
      expect(message).not.toHaveProperty('providerFingerprint')
      expect(message.usage).not.toHaveProperty('contextIdentity')
    }
  })
})

describe('chat-store internal and public stats', () => {
  it('keeps identity in internal stats only', () => {
    const conv = chatConv()
    upsertChatMessage(storedWithFingerprint({ conversationId: conv.id }))
    const internal = chatHistoryStats(conv.id)
    expect(internal.lastUsage?.contextIdentity).toBe(FP)
    expect(internal.lastUsage?.input).toBe(10)
    const pub = toPublicChatHistoryStats(internal)
    expect(pub.lastUsage).not.toHaveProperty('contextIdentity')
    expect(pub.lastUsage).toMatchObject({ usageVersion: 2, input: 10, output: 20 })
    // Internal entry remains intact.
    expect(internal.lastUsage?.contextIdentity).toBe(FP)
  })
})

describe('chat-store: restart (store, internal load, replay)', () => {
  it('rehydrates same-identity reasoning from SQLite', () => {
    const conv = chatConv()
    upsertChatMessage(storedWithFingerprint({ conversationId: conv.id }))
    // Restart: the internal load (listChatMessages) restores the full identity.
    const history = listChatMessages(conv.id)
    const policy = {
      field: 'reasoning_content',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      providerFingerprint: FP,
    }
    const messages = toModelMessages(history, { reasoningReplay: policy })
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant).toMatchObject({
      content: [
        { type: 'reasoning', text: 'R' },
        { type: 'tool-call', toolCallId: 'k1', toolName: 'read' },
      ],
      providerOptions: { openaiCompatible: { reasoning_content: 'R' } },
    })
  })

  it('a changed endpoint with a mismatched SQLite fingerprint degrades to empty reasoning', () => {
    const conv = chatConv()
    upsertChatMessage(storedWithFingerprint({ conversationId: conv.id, providerFingerprint: 'b'.repeat(64) }))
    const history = listChatMessages(conv.id)
    const messages = toModelMessages(history, {
      reasoningReplay: {
        field: 'reasoning_content',
        providerId: 'deepseek',
        modelId: 'deepseek-v4-pro',
        providerFingerprint: FP,
      },
    })
    const assistant = messages.find((m) => m.role === 'assistant')
    // Old reasoning is omitted while the structural field remains explicitly empty.
    expect(assistant?.providerOptions).toEqual({ openaiCompatible: { reasoning_content: '' } })
  })
})

describe('chat-store public and internal compile-time contracts', () => {
  it('excludes identity from public types and retains it in Stored types', () => {
    const stored = storedWithFingerprint()
    const publicMessage: ChatMessage = toPublicChatMessage(stored)
    // Public types do not declare identity keys; access must fail compilation.
    expect('providerFingerprint' in publicMessage).toBe(false)
    expect(publicMessage.usage && 'contextIdentity' in publicMessage.usage).toBe(false)
    expect('providerFingerprint' in stored).toBe(true)
    expect(stored.usage && 'contextIdentity' in stored.usage).toBe(true)
  })
})

describe('chat-store: source + executionScope/reviewLoop (review-loop)', () => {
  const executionScope = {
    kind: 'review-loop' as const,
    executionId: 'exec-1',
    loopId: 'rl_1',
    iteration: 2,
    maxIterations: 5,
  }

  it('source chatgpt-web-review-loop + executionScope sobrevivem round-trip SQLite', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'r1',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 't', text: 'fix' }],
      model: { providerId: 'p', modelId: 'm' },
      source: 'chatgpt-web-review-loop',
      executionScope,
      createdAt: 1000,
    })
    const [loaded] = listChatMessages(conv.id)
    expect(loaded.source).toBe('chatgpt-web-review-loop')
    expect(loaded.executionScope).toEqual(executionScope)
    expect(loaded.reviewLoop).toEqual({
      loopId: 'rl_1',
      executionId: 'exec-1',
      iteration: 2,
      maxIterations: 5,
    })
  })

  it('derives execution scope from legacy review metadata', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'r2',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 't', text: 'fix' }],
      source: 'chatgpt-web-review-loop',
      reviewLoop: {
        loopId: 'rl_9',
        executionId: 'exec-9',
        iteration: 1,
        maxIterations: 3,
      },
      createdAt: 1000,
    })
    const [loaded] = listChatMessages(conv.id)
    expect(loaded.executionScope).toEqual({
      kind: 'review-loop',
      executionId: 'exec-9',
      loopId: 'rl_9',
      iteration: 1,
      maxIterations: 3,
    })
    expect(loaded.reviewLoop).toEqual({
      loopId: 'rl_9',
      executionId: 'exec-9',
      iteration: 1,
      maxIterations: 3,
    })
  })

  it('preserves public review provenance without fingerprints', () => {
    const stored = storedWithFingerprint({
      source: 'chatgpt-web-review-loop',
      executionScope,
      reviewLoop: {
        loopId: 'rl_1',
        executionId: 'exec-1',
        iteration: 2,
        maxIterations: 5,
      },
    })
    const pub = toPublicChatMessage(stored)
    expect(pub).not.toHaveProperty('providerFingerprint')
    expect(pub.source).toBe('chatgpt-web-review-loop')
    expect(pub.executionScope).toEqual(executionScope)
    expect(pub.reviewLoop).toEqual({
      loopId: 'rl_1',
      executionId: 'exec-1',
      iteration: 2,
      maxIterations: 5,
    })
  })

  it('discards invalid executionScope metadata', () => {
    const conv = chatConv()
    insertRaw(
      conv.id,
      'bad-scope',
      JSON.stringify({
        source: 'chatgpt-web-review-loop',
        executionScope: { kind: 'review-loop', executionId: '', loopId: 'rl', iteration: 0, maxIterations: 5 },
      })
    )
    const [loaded] = listChatMessages(conv.id)
    expect(loaded.source).toBe('chatgpt-web-review-loop')
    expect(loaded.executionScope).toBeUndefined()
    expect(loaded.reviewLoop).toBeUndefined()
  })
})

describe('chat-store executionScope predicates with invalid JSON', () => {
  it('a row with malformed meta_json degrades to main-context in SQL filters without malformed JSON errors', () => {
    const conv = chatConv()
    // Raw invalid JSON must be tolerated by both row parsing and SQL predicates.
    insertRaw(conv.id, 'corrupt-1', '{corrompido')
    insertRaw(conv.id, 'corrupt-2', 'not json at all')
    upsertChatMessage({
      id: 'main-user',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 't', text: 'ok' }],
      createdAt: 1,
    })
    // Main runner history includes corrupt metadata as legacy content.
    expect(listConversationContextMessages(conv.id).map((m) => m.id)).toEqual(['corrupt-1', 'corrupt-2', 'main-user'])
    expect(runnerContextHistory(conv.id, {}).map((m) => m.id)).toEqual(['corrupt-1', 'corrupt-2', 'main-user'])
    expect(lastConversationContextMessage(conv.id)?.id).toBe('main-user')
    // Corruption is never classified as a review loop.
    expect(listExecutionContextMessages(conv.id, 'corrupt-1')).toEqual([])
    expect(getExecutionAssistantMessage(conv.id, 'corrupt-1')).toBeUndefined()
    expect(listInterruptedExecutionAssistantMessages(conv.id)).toEqual([])
  })

  it('handles invalid metadata while keeping lastUsage in main context', () => {
    const conv = chatConv()
    insertRaw(conv.id, 'corrupt-1', '{corrompido')
    upsertChatMessage({
      id: 'main-a',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 't', text: 'ok' }],
      model: { providerId: 'p', modelId: 'm' },
      usage: { input: 40_000, output: 10, contextInput: 40_000 },
      createdAt: 1,
    })
    const s = chatHistoryStats(conv.id)
    expect(s.lastUsage).toMatchObject({ input: 40_000, contextInput: 40_000 })
    expect(s.lastModel).toEqual({ providerId: 'p', modelId: 'm' })
    expect(s.perModel.find((p) => p.modelId === 'm')).toMatchObject({ input: 40_000, output: 10 })
  })

  it('isolates round context despite invalid rows', () => {
    const conv = chatConv()
    insertRaw(conv.id, 'corrupt-mid', 'lixo')
    upsertChatMessage({
      id: 'round-user',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 't', text: 'findings' }],
      internal: true,
      source: 'chatgpt-web-review-loop',
      executionScope: { kind: 'review-loop', executionId: 'exec-a', loopId: 'rl', iteration: 1, maxIterations: 5 },
      createdAt: 1,
    })
    expect(listConversationContextMessages(conv.id).map((m) => m.id)).toEqual(['corrupt-mid'])
    expect(listExecutionContextMessages(conv.id, 'exec-a').map((m) => m.id)).toEqual(['round-user'])
    expect(listChatMessages(conv.id).map((m) => m.id)).toEqual(['corrupt-mid', 'round-user'])
  })
})

describe('chat-store: final review-loop summary stays outside the main context', () => {
  it('keeps audit summaries outside main context and round history', () => {
    const conv = chatConv()
    upsertChatMessage({
      id: 'main-a',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 't', text: 'turn manual' }],
      model: { providerId: 'p', modelId: 'm' },
      usage: { input: 40_000, output: 10, contextInput: 40_000 },
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'review-loop-summary:rl_1',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'review-loop-summary:rl_1:text', text: '## Review encerrado' }],
      model: { providerId: 'q', modelId: 'sum' },
      usage: { input: 1_234, output: 56, contextInput: 100 },
      source: 'chatgpt-web-review-loop',
      executionScope: { kind: 'review-summary', loopId: 'rl_1' },
      createdAt: 2,
    })
    // The audit summary retains scope in complete history.
    const loaded = listChatMessages(conv.id)
    expect(loaded.map((m) => m.id)).toEqual(['main-a', 'review-loop-summary:rl_1'])
    expect(loaded[1]?.executionScope).toEqual({ kind: 'review-summary', loopId: 'rl_1' })
    // No round metadata: the renderer continues displaying a summary.
    expect(loaded[1]?.reviewLoop).toBeUndefined()
    // The summary never enters inference context.
    expect(listConversationContextMessages(conv.id).map((m) => m.id)).toEqual(['main-a'])
    expect(runnerContextHistory(conv.id, {}).map((m) => m.id)).toEqual(['main-a'])
    // The main resume boundary remains the manual turn.
    expect(lastConversationContextMessage(conv.id)?.id).toBe('main-a')
    // Never classify this as an isolated or interrupted execution.
    expect(listExecutionContextMessages(conv.id, 'rl_1')).toEqual([])
    expect(listInterruptedExecutionAssistantMessages(conv.id)).toEqual([])
    // Summary usage must not become main-context lastUsage or lastModel;
    // but is_main_ctx=0): lastUsage remains the manual turn. Billing aggregates everything.
    const stats = chatHistoryStats(conv.id)
    expect(stats.lastModel).toEqual({ providerId: 'p', modelId: 'm' })
    expect(stats.lastUsage).toMatchObject({ input: 40_000, contextInput: 40_000 })
    expect(stats.perModel.find((p) => p.modelId === 'sum')).toMatchObject({ input: 1_234 })
    // Public projection preserves source and scope without internal identity.
    const pub = toPublicChatMessage(loaded[1]!)
    expect(pub.source).toBe('chatgpt-web-review-loop')
    expect(pub.executionScope).toEqual({ kind: 'review-summary', loopId: 'rl_1' })
    expect(pub.reviewLoop).toBeUndefined()
    expect('providerFingerprint' in pub).toBe(false)
  })

  it('malformed review-summary kind still excludes it from main context without degrading into it', () => {
    const conv = chatConv()
    insertRaw(conv.id, 'summary-bad', JSON.stringify({ executionScope: { kind: 'review-summary', loopId: 42 } }))
    // Invalid loop IDs become empty while preserving scope to protect main history.
    const [loaded] = listChatMessages(conv.id)
    expect(loaded.executionScope).toEqual({ kind: 'review-summary', loopId: '' })
    expect(loaded.reviewLoop).toBeUndefined()
    expect(listConversationContextMessages(conv.id)).toEqual([])
    expect(lastConversationContextMessage(conv.id)).toBeUndefined()
    expect(runnerContextHistory(conv.id, {}).map((m) => m.id)).toEqual([])
  })
})

describe('chat-store compact Memory Center provenance', () => {
  it('persists only source metadata without retrieved content', () => {
    const conv = chatConv()
    const maliciousSources = Array.from({ length: 12 }, (_, index) => ({
      kind: index % 2 === 0 ? ('local' as const) : ('shared' as const),
      id: `memory-${index}${'x'.repeat(600)}`,
      title: `Memory ${index}${'y'.repeat(600)}`,
      repo: index % 2 ? 'backend' : undefined,
      path: index % 2 ? `.agents/knowledge/decision/${index}.md` : undefined,
      startLine: index + 1,
      endLine: index + 2,
      // Untyped callers cannot inject retrieved content into metadata.
      content: `retrieved secret ${index}`,
    }))
    upsertChatMessage({
      id: 'assistant-with-memory',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'answer', text: 'Public answer only.' }],
      memoryContext: {
        revision: `revision-${'r'.repeat(300)}`,
        sources: maliciousSources,
        degradedReason: `text-only-${'d'.repeat(600)}`,
      } as never,
      createdAt: 1,
    })

    const row = getDb()
      .prepare('SELECT parts_json, meta_json FROM chat_messages WHERE id = ?')
      .get('assistant-with-memory') as { parts_json: string; meta_json: string }
    expect(row.parts_json).toContain('Public answer only.')
    expect(row.parts_json).not.toContain('retrieved secret')
    expect(row.meta_json).not.toContain('retrieved secret')
    expect(row.meta_json).not.toContain('"content"')

    const [loaded] = listChatMessages(conv.id)
    expect(loaded.memoryContext?.sources).toHaveLength(10)
    expect(loaded.memoryContext?.revision).toHaveLength(200)
    expect(loaded.memoryContext?.degradedReason).toHaveLength(500)
    expect(loaded.memoryContext?.sources[0]?.id).toHaveLength(500)
    expect(loaded.memoryContext?.sources[0]?.title).toHaveLength(500)
    expect(JSON.stringify(loaded.memoryContext)).not.toContain('retrieved secret')
    expect(toPublicChatMessage(loaded).memoryContext).toEqual(loaded.memoryContext)
  })

  it('ignores malformed envelopes and malformed individual sources', () => {
    const conv = chatConv()
    insertRaw(conv.id, 'bad-envelope', JSON.stringify({ memoryContext: { revision: 42, sources: [] } }))
    insertRaw(
      conv.id,
      'partially-valid',
      JSON.stringify({
        memoryContext: {
          revision: 'rev',
          sources: [
            null,
            { kind: 'remote', id: 'x', title: 'invalid kind' },
            { kind: 'local', id: 3, title: 'invalid id' },
            { kind: 'shared', id: 'valid', title: 'Valid source', path: '.agents/knowledge/reference/x.md' },
          ],
        },
      })
    )

    const [bad, partial] = listChatMessages(conv.id)
    expect(bad.memoryContext).toBeUndefined()
    expect(partial.memoryContext).toEqual({
      revision: 'rev',
      sources: [{ kind: 'shared', id: 'valid', title: 'Valid source', path: '.agents/knowledge/reference/x.md' }],
    })
  })
})
