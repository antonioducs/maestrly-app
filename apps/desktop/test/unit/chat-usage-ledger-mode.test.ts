import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { closeStore, getDb, initStore, patchConvUiPrefs } from '../../src/main/store'
import {
  aggregateChatUsage,
  getChatMessage,
  recordChatUsageAttempt,
  recordStandaloneChatUsage,
  upsertChatMessage,
  type StoredChatMessage,
} from '../../src/main/chat/chat-store'
import { withSubagentMessageOwnership } from '../../src/main/chat/subagent-ownership'
import { buildExportBundle } from '../../src/main/local-data/data-export'
import type { ChatBehavior } from '../../src/shared/conversation-experience'

describe('chat_usage_ledger mode recording, migration, aggregation, and export', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('migrates an existing database without the mode column idempotently and upgrades triggers', () => {
    closeDb()
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-ledger-mode-mig-'))
    const dbPath = path.join(tempDir, 'legacy.db')
    try {
      // Seed a real database, then downgrade chat_usage_ledger and its triggers to the pre-mode schema.
      initStore(dbPath)
      const ws = makeWorkspace()
      const conv = makeConversation(ws.id, { mode: 'local' })
      patchConvUiPrefs(conv.id, { chat: { mode: 'design' } })
      closeStore()

      const legacy = new DatabaseSync(dbPath)
      legacy.exec(`
        DROP TRIGGER IF EXISTS trg_chat_usage_ledger_after_insert;
        DROP TRIGGER IF EXISTS trg_chat_usage_ledger_after_usage_update;
        DROP TABLE chat_usage_ledger;
        CREATE TABLE chat_usage_ledger (
          message_id TEXT PRIMARY KEY,
          conversation_id TEXT,
          provider_id TEXT NOT NULL DEFAULT '',
          model_id TEXT NOT NULL DEFAULT '',
          usage_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TRIGGER trg_chat_usage_ledger_after_insert
        AFTER INSERT ON chat_messages
        FOR EACH ROW
        WHEN NEW.role = 'assistant'
          AND json_type(NEW.meta_json, '$.usage.input') IN ('integer', 'real')
          AND json_type(NEW.meta_json, '$.usage.output') IN ('integer', 'real')
        BEGIN
          INSERT INTO chat_usage_ledger (message_id, conversation_id, provider_id, model_id, usage_json, created_at)
          VALUES (NEW.id, NEW.conversation_id, 'p', 'm', json_extract(NEW.meta_json, '$.usage'), NEW.created_at);
        END;
        CREATE TRIGGER trg_chat_usage_ledger_after_usage_update
        AFTER UPDATE OF meta_json ON chat_messages
        FOR EACH ROW
        WHEN NEW.role = 'assistant'
          AND json_type(NEW.meta_json, '$.usage.input') IN ('integer', 'real')
          AND json_type(NEW.meta_json, '$.usage.output') IN ('integer', 'real')
        BEGIN
          INSERT INTO chat_usage_ledger (message_id, conversation_id, provider_id, model_id, usage_json, created_at)
          VALUES (NEW.id, NEW.conversation_id, 'p', 'm', json_extract(NEW.meta_json, '$.usage'), NEW.created_at)
          ON CONFLICT(message_id) DO UPDATE SET usage_json = excluded.usage_json;
        END;
      `)
      legacy
        .prepare(
          `INSERT INTO chat_usage_ledger (message_id, conversation_id, provider_id, model_id, usage_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('legacy-orphan', conv.id, 'p', 'm', JSON.stringify({ usageVersion: 2, input: 100, output: 20 }), 1000)
      legacy
        .prepare(
          `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
           VALUES (?, ?, 'assistant', '[]', ?, 0, ?)`
        )
        .run(
          'legacy-msg',
          conv.id,
          JSON.stringify({
            model: { providerId: 'p', modelId: 'm' },
            usage: { usageVersion: 2, input: 50, output: 10 },
          }),
          2000
        )
      legacy.close()

      // First migration boot.
      initStore(dbPath)
      const cols = getDb().prepare('PRAGMA table_info(chat_usage_ledger)').all() as Array<{ name: string }>
      expect(cols.some((c) => c.name === 'mode')).toBe(true)

      // Pre-existing ledger entries remain NULL rather than inheriting the conversation's mutable preference.
      expect(getDb().prepare('SELECT message_id, mode FROM chat_usage_ledger ORDER BY message_id').all()).toEqual([
        { message_id: 'legacy-msg', mode: null },
        { message_id: 'legacy-orphan', mode: null },
      ])

      // Upgraded triggers copy mode on insert and streaming checkpoint updates.
      upsertChatMessage({
        id: 'post-mig-design',
        conversationId: conv.id,
        role: 'assistant',
        parts: [],
        model: { providerId: 'p', modelId: 'm' },
        mode: 'design',
        createdAt: 3000,
      })
      upsertChatMessage({
        id: 'post-mig-design',
        conversationId: conv.id,
        role: 'assistant',
        parts: [],
        model: { providerId: 'p', modelId: 'm' },
        mode: 'design',
        usage: { usageVersion: 2, input: 70, output: 15 },
        createdAt: 3000,
      })
      expect(getDb().prepare('SELECT mode FROM chat_usage_ledger WHERE message_id = ?').get('post-mig-design')).toEqual(
        { mode: 'design' }
      )

      // Re-opening the migrated database is idempotent and preserves every row's mode.
      closeStore()
      initStore(dbPath)
      expect(getDb().prepare('SELECT message_id, mode FROM chat_usage_ledger ORDER BY message_id').all()).toEqual([
        { message_id: 'legacy-msg', mode: null },
        { message_id: 'legacy-orphan', mode: null },
        { message_id: 'post-mig-design', mode: 'design' },
      ])
    } finally {
      closeStore()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('backfills mode from chat_messages and never wipes an existing ledger mode on updates without mode', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { mode: 'local' })
    const db = getDb()
    db.exec(
      'DROP TRIGGER trg_chat_usage_ledger_after_insert; DROP TRIGGER trg_chat_usage_ledger_after_usage_update; DROP TABLE chat_usage_ledger;'
    )
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
       VALUES (?, ?, 'assistant', '[]', ?, 0, ?)`
    ).run(
      'msg-with-mode',
      conv.id,
      JSON.stringify({
        model: { providerId: 'p', modelId: 'm' },
        mode: 'plan',
        usage: { usageVersion: 2, input: 10, output: 5 },
      }),
      1000
    )
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
       VALUES (?, ?, 'assistant', '[]', ?, 1, ?)`
    ).run(
      'msg-without-mode',
      conv.id,
      JSON.stringify({
        model: { providerId: 'p', modelId: 'm' },
        usage: { usageVersion: 2, input: 12, output: 4 },
      }),
      2000
    )
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
       VALUES (?, ?, 'assistant', '[]', ?, 2, ?)`
    ).run(
      'msg-invalid-mode',
      conv.id,
      JSON.stringify({
        model: { providerId: 'p', modelId: 'm' },
        mode: 'not-a-mode',
        usage: { usageVersion: 2, input: 8, output: 2 },
      }),
      3000
    )

    restartDb()

    expect(getDb().prepare('SELECT message_id, mode FROM chat_usage_ledger ORDER BY created_at').all()).toEqual([
      { message_id: 'msg-with-mode', mode: 'plan' },
      { message_id: 'msg-without-mode', mode: null },
      { message_id: 'msg-invalid-mode', mode: null },
    ])

    // Updating a message without repeating mode must preserve the mode already stored in the ledger.
    upsertChatMessage({
      id: 'msg-with-mode',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      model: { providerId: 'p', modelId: 'm' },
      usage: { usageVersion: 2, input: 20, output: 9 },
      createdAt: 1000,
    })
    expect(getDb().prepare('SELECT mode FROM chat_usage_ledger WHERE message_id = ?').get('msg-with-mode')).toEqual({
      mode: 'plan',
    })
  })

  it('records mode across triggers, direct ledger paths, host-managed subagents, and survives mode switches', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { mode: 'local' })
    patchConvUiPrefs(conv.id, { chat: { mode: 'design' } })

    // 1. Trigger path for every valid mode (including subagent breakdown merged into parent turn).
    const modes: ChatBehavior[] = ['agent', 'design', 'plan', 'ask', 'maestro']
    for (const [index, mode] of modes.entries()) {
      const msg: StoredChatMessage = {
        id: `turn-${mode}`,
        conversationId: conv.id,
        role: 'assistant',
        parts: [],
        model: { providerId: 'p', modelId: 'main-model' },
        mode,
        usage: {
          usageVersion: 2,
          input: 100,
          output: 20,
          ...(mode === 'design'
            ? {
                subInput: 40,
                subOutput: 10,
                subagentUsage: [{ providerId: 'p', modelId: 'sub-model', input: 40, output: 10 }],
              }
            : {}),
        },
        createdAt: 1_000 + index,
      }
      upsertChatMessage(msg)
      expect(getChatMessage(conv.id, msg.id)?.mode).toBe(mode)
    }

    // Changing the conversation's mode afterwards does not mutate historical ledger rows.
    patchConvUiPrefs(conv.id, { chat: { mode: 'ask' } })
    expect(getDb().prepare('SELECT mode FROM chat_usage_ledger WHERE message_id = ?').get('turn-design')).toEqual({
      mode: 'design',
    })

    // 2. Direct standalone usage (Maestro Configurator -> 'maestro', unspecified -> NULL).
    recordStandaloneChatUsage({
      id: 'standalone-maestro',
      model: { providerId: 'p', modelId: 'maestro-cfg' },
      mode: 'maestro',
      usage: { input: 30, output: 10, cacheRead: 0, cacheCreate: 0 },
      createdAt: 2_000,
    })
    recordStandaloneChatUsage({
      id: 'standalone-unknown',
      model: { providerId: 'p', modelId: 'other' },
      usage: { input: 15, output: 5, cacheRead: 0, cacheCreate: 0 },
      createdAt: 2_001,
    })

    // 3. Direct billing-only attempts (compaction with mode, memory extraction without mode).
    recordChatUsageAttempt({
      id: 'bg-compact-design',
      conversationId: conv.id,
      model: { providerId: 'p', modelId: 'summarizer' },
      mode: 'design',
      usage: { input: 200, output: 30, cacheRead: 0, cacheCreate: 0 },
      createdAt: 3_000,
    })
    recordChatUsageAttempt({
      id: 'memory-extraction:1',
      conversationId: conv.id,
      model: { providerId: 'p', modelId: 'extractor' },
      usage: { input: 50, output: 10, cacheRead: 0, cacheCreate: 0 },
      createdAt: 3_001,
    })

    // 4. Host-managed subagent ownership (code reviewer running in 'ask' mode; message deleted after run).
    await withSubagentMessageOwnership({
      conversationId: conv.id,
      messageId: 'host-review-ok',
      model: { providerId: 'p', modelId: 'reviewer' },
      mode: 'ask',
      ownership: { kind: 'host-managed', cleanup: 'delete' },
      execute: async () => ({
        text: 'looks good',
        usage: { input: 80, output: 12, cacheRead: 0, cacheCreate: 0, totalInput: 80 },
      }),
    })
    await expect(
      withSubagentMessageOwnership({
        conversationId: conv.id,
        messageId: 'host-review-err',
        model: { providerId: 'p', modelId: 'reviewer' },
        mode: 'ask',
        ownership: { kind: 'host-managed', cleanup: 'delete' },
        execute: async () => {
          throw Object.assign(new Error('failed'), {
            subagentUsage: { input: 25, output: 4, cacheRead: 0, cacheCreate: 0, totalInput: 25 },
          })
        },
      })
    ).rejects.toThrow('failed')

    const rows = getDb().prepare('SELECT message_id, mode FROM chat_usage_ledger ORDER BY message_id').all() as Array<{
      message_id: string
      mode: string | null
    }>
    const byId = Object.fromEntries(rows.map((r) => [r.message_id, r.mode]))
    expect(byId).toEqual({
      'bg-compact-design': 'design',
      'host-review-err': 'ask',
      'host-review-ok': 'ask',
      'memory-extraction:1': null,
      'standalone-maestro': 'maestro',
      'standalone-unknown': null,
      'turn-agent': 'agent',
      'turn-ask': 'ask',
      'turn-design': 'design',
      'turn-maestro': 'maestro',
      'turn-plan': 'plan',
    })
  })

  it('filters and groups usage by mode, treating legacy NULL rows as unknown', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { mode: 'local' })

    // Design turn with subagent breakdown + background compaction in design mode.
    upsertChatMessage({
      id: 'd1',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      model: { providerId: 'anthropic', modelId: 'claude-opus' },
      mode: 'design',
      usage: {
        usageVersion: 2,
        input: 500,
        output: 100,
        cachedInput: 200,
        runtimeEstimatedCostUsd: 0.05,
        subInput: 100,
        subOutput: 50,
        subagentUsage: [
          {
            providerId: 'anthropic',
            modelId: 'claude-haiku',
            input: 100,
            output: 50,
            runtimeEstimatedCostUsd: 0.01,
          },
        ],
      },
      createdAt: 1_000,
    })
    recordChatUsageAttempt({
      id: 'd-compact',
      conversationId: conv.id,
      model: { providerId: 'anthropic', modelId: 'claude-haiku' },
      mode: 'design',
      usage: { input: 300, output: 40, cacheRead: 0, cacheCreate: 0 },
      runtimeEstimatedCostUsd: 0.005,
      createdAt: 2_000,
    })

    // Agent turn.
    upsertChatMessage({
      id: 'a1',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      model: { providerId: 'openai', modelId: 'gpt-5' },
      mode: 'agent',
      usage: { usageVersion: 2, input: 400, output: 80, runtimeEstimatedCostUsd: 0.02 },
      createdAt: 3_000,
    })

    // Legacy row with mode = NULL.
    getDb()
      .prepare(
        `INSERT INTO chat_usage_ledger (message_id, conversation_id, provider_id, model_id, mode, usage_json, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`
      )
      .run('legacy-1', conv.id, 'openai', 'gpt-4', JSON.stringify({ usageVersion: 2, input: 150, output: 25 }), 4_000)

    // Filter by a single mode.
    const designOnly = aggregateChatUsage({ mode: 'design' })
    expect(designOnly.totalTurns).toBe(1) // compaction is billingOnly, subagent is not a separate turn
    expect(designOnly.firstAt).toBe(1_000)
    expect(designOnly.lastAt).toBe(2_000)
    expect(designOnly.perModel).toHaveLength(2)
    expect(designOnly.perModel.find((m) => m.modelId === 'claude-opus')).toMatchObject({
      turns: 1,
      input: 500,
      output: 100,
      cacheRead: 200,
      runtimeEstimatedCostUsd: 0.05,
    })
    expect(designOnly.perModel.find((m) => m.modelId === 'claude-haiku')).toMatchObject({
      turns: 0,
      input: 400, // 100 subagent + 300 compaction
      output: 90, // 50 subagent + 40 compaction
    })
    expect(designOnly.perModel.find((m) => m.modelId === 'claude-haiku')?.runtimeEstimatedCostUsd).toBeCloseTo(0.015, 6)

    // Filter by unknown (both 'unknown' and null).
    expect(aggregateChatUsage({ mode: 'unknown' })).toMatchObject({
      totalTurns: 1,
      perModel: [expect.objectContaining({ modelId: 'gpt-4', input: 150, output: 25 })],
    })
    expect(aggregateChatUsage({ mode: null })).toMatchObject({
      totalTurns: 1,
      perModel: [expect.objectContaining({ modelId: 'gpt-4', input: 150, output: 25 })],
    })

    // Filter by multiple modes + time range.
    const designAndUnknown = aggregateChatUsage({ mode: ['design', 'unknown'], since: 2_000 })
    expect(designAndUnknown.totalTurns).toBe(1) // d-compact (billingOnly) + legacy-1 (turn)
    expect(designAndUnknown.perModel.map((m) => m.modelId)).toEqual(['claude-haiku', 'gpt-4'])

    // Empty mode list returns empty stats.
    expect(aggregateChatUsage({ mode: [], groupByMode: true })).toEqual({
      perModel: [],
      perMode: [],
      totalTurns: 0,
      firstAt: null,
      lastAt: null,
    })

    // Group by mode.
    const grouped = aggregateChatUsage({ groupByMode: true })
    expect(grouped.totalTurns).toBe(3)
    expect(grouped.perMode.map((m) => m.mode)).toEqual(['design', 'agent', 'unknown'])
    expect(grouped.perMode[0]).toMatchObject({
      mode: 'design',
      turns: 1,
      input: 900,
      output: 190,
      cacheRead: 200,
      cacheCreate: 0,
      firstAt: 1_000,
      lastAt: 2_000,
    })
    expect(grouped.perMode[0]?.runtimeEstimatedCostUsd).toBeCloseTo(0.065, 6)
    expect(grouped.perMode[0]?.perModel.map((m) => m.modelId)).toEqual(['claude-opus', 'claude-haiku'])
    expect(grouped.perMode[1]).toMatchObject({
      mode: 'agent',
      turns: 1,
      input: 400,
      output: 80,
      runtimeEstimatedCostUsd: 0.02,
      firstAt: 3_000,
      lastAt: 3_000,
    })
    expect(grouped.perMode[2]).toMatchObject({
      mode: 'unknown',
      turns: 1,
      input: 150,
      output: 25,
      firstAt: 4_000,
      lastAt: 4_000,
    })
    expect(grouped.perMode[2]).not.toHaveProperty('runtimeEstimatedCostUsd')

    // Export carries recorded modes and null for legacy rows.
    const bundle = await buildExportBundle()
    expect(bundle.usageHistory.map((row) => ({ id: row.messageId, mode: row.mode }))).toEqual([
      { id: 'd1', mode: 'design' },
      { id: 'd-compact', mode: 'design' },
      { id: 'a1', mode: 'agent' },
      { id: 'legacy-1', mode: null },
    ])
  })
})
