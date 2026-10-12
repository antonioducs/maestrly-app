import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../../src/main/store'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

// Keep the full local table inventory explicit so hosted cleanup cannot silently remove local data.
const LOCAL_TABLES = [
  'app_settings',
  'bot_command_outbox',
  'bot_command_receipts',
  'bot_conversation_allocations',
  'bot_local_commands',
  'bot_local_connections',
  'bot_local_conversations',
  'bot_local_events',
  'bot_local_grants',
  'bot_local_idempotency',
  'bot_local_inventory',
  'bot_local_messages',
  'bot_local_questions',
  'bot_question_bindings',
  'chat_antigravity_sessions',
  'chat_background_compaction',
  'chat_claude_message_map',
  'chat_claude_session_cleanup',
  'chat_claude_sessions',
  'chat_codex_thread_cleanup',
  'chat_codex_threads',
  'chat_cursor_agent_cleanup',
  'chat_cursor_agents',
  'chat_github_copilot_session_cleanup',
  'chat_github_copilot_sessions',
  'chat_inference_state',
  'chat_maestro_run_messages',
  'chat_maestro_runs',
  'chat_messages',
  'chat_subagent_sessions',
  'chat_subagent_transcript',
  'chat_tool_executions',
  'chat_usage_ledger',
  'conversation_dispatches',
  'conversation_memory_state',
  'conversation_migrations',
  'conversation_peer_messages',
  'conversation_repos',
  'conversations',
  'host_transfer_ranges',
  'host_transfers',
  'local_memories',
  'local_memory_migrations',
  'memory_consolidation_state',
  'memory_extraction_state',
  'permission_saved',
  'schema_migrations',
  'workspace_creations',
  'workspace_groups',
  'workspaces',
].sort()

function readSchema(): Array<{ type: string; name: string; tbl_name: string; sql: string }> {
  return store
    .getDb()
    .prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `)
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>
}

describe('local-only SQLite schema', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('creates all local tables without hosted tables, indexes, or triggers', () => {
    const schema = readSchema()
    expect(schema.filter((entry) => entry.type === 'table').map((entry) => entry.name)).toEqual(LOCAL_TABLES)
    expect(schema.filter((entry) => /cloud_|telemetry/i.test(`${entry.name} ${entry.tbl_name} ${entry.sql}`))).toEqual(
      []
    )
    expect(store.getDb().prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(store.getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(store.getDb().prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  })

  it('reopens a local database without recreating hosted schema or changing local migration history', () => {
    const schema = readSchema()
    const migrations = store.getDb().prepare('SELECT * FROM schema_migrations ORDER BY id').all()
    store.setAppSetting('local-schema-test', 'preserved')

    restartDb()

    expect(readSchema()).toEqual(schema)
    expect(store.getDb().prepare('SELECT * FROM schema_migrations ORDER BY id').all()).toEqual(migrations)
    expect(store.getAppSetting('local-schema-test')).toBe('preserved')
  })

  it('adds extraction tables to the previous schema without losing existing data', () => {
    store.setAppSetting('before-extraction', 'preserved')
    store.getDb().exec('DROP TABLE memory_extraction_state; DROP TABLE memory_consolidation_state;')
    restartDb()
    expect(
      readSchema()
        .filter((entry) => entry.type === 'table')
        .map((entry) => entry.name)
    ).toEqual(LOCAL_TABLES)
    expect(store.getAppSetting('before-extraction')).toBe('preserved')
    expect(store.getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(store.getDb().prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    restartDb()
    expect(store.getAppSetting('before-extraction')).toBe('preserved')
  })

  it('drops the OAuth registrations and delegation journals of the retired external agent connection', () => {
    const conversation = makeConversation(makeWorkspace().id, { name: 'Started by a bot' })
    store
      .getDb()
      .prepare("UPDATE conversations SET bot_origin=?, bot_management_state='active' WHERE id=?")
      .run(JSON.stringify({ kind: 'bot', connectionId: 'connection', botName: 'Bot' }), conversation.id)
    // What an earlier release left behind, next to the tables the bots of a bot server keep using.
    store.getDb().exec(`
      CREATE TABLE bot_oauth_tokens (token_hash TEXT PRIMARY KEY);
      CREATE TABLE bot_oauth_clients (client_id TEXT PRIMARY KEY);
      CREATE TABLE platform_delegation_workspaces (instance_id TEXT, task_id TEXT, conversation_id TEXT);
      CREATE TABLE platform_delegation_attempts (attempt_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL);
      INSERT INTO bot_oauth_tokens VALUES ('token');
      INSERT INTO platform_delegation_attempts VALUES ('attempt', 'turn');
    `)

    restartDb()

    const schema = readSchema()
    expect(schema.filter((entry) => entry.type === 'table').map((entry) => entry.name)).toEqual(LOCAL_TABLES)
    expect(schema.filter((entry) => /oauth|delegation/.test(entry.name))).toEqual([])
    expect(store.getConversation(conversation.id)?.botOrigin).toMatchObject({ connectionId: 'connection' })
    expect(store.getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(store.getDb().prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  })

  it('drops the web chat projections, connections, credentials and settings of the retired Kanban platform', () => {
    const conversation = makeConversation(makeWorkspace().id, { name: 'Projected from the web' })
    store.getDb().exec(`
      CREATE TABLE platform_chat_sessions (
        instance_id TEXT NOT NULL, session_id TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY(instance_id, session_id)
      );
      CREATE TABLE platform_chat_turns (
        turn_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, lease_id TEXT NOT NULL, state TEXT NOT NULL, completion TEXT
      );
      CREATE TABLE platform_chat_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
      );
      CREATE INDEX platform_chat_outbox_turn ON platform_chat_outbox(turn_id,seq);
    `)
    store
      .getDb()
      .prepare("INSERT INTO platform_chat_sessions VALUES ('instance', 'session', ?)")
      .run(conversation.id)
    for (const key of [
      'platform.connections.v1',
      'platform.credential.connection',
      'platform.project-bindings.v1',
      'platform.desktop-executor.v1',
      'platform.execution-history.v1',
    ])
      store.setAppSetting(key, 'retired')
    store.setAppSetting('platformless.setting', 'preserved')

    restartDb()

    const schema = readSchema()
    expect(schema.filter((entry) => entry.type === 'table').map((entry) => entry.name)).toEqual(LOCAL_TABLES)
    expect(schema.filter((entry) => entry.name.startsWith('platform_chat'))).toEqual([])
    expect(
      store.getDb().prepare("SELECT key FROM app_settings WHERE key LIKE 'platform.%'").all()
    ).toEqual([])
    expect(store.getAppSetting('platformless.setting')).toBe('preserved')
    expect(store.getConversation(conversation.id)?.name).toBe('Projected from the web')
    expect(store.getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(store.getDb().prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  })

  it.each([
    [true, 1],
    [false, 0],
  ])('removes the login item of a retired executor that started at login (autoStart %s)', (autoStart, calls) => {
    const target = app as unknown as { isPackaged: boolean; setLoginItemSettings?: (settings: unknown) => void }
    const setLoginItemSettings = vi.fn()
    target.isPackaged = true
    target.setLoginItemSettings = setLoginItemSettings
    try {
      store.setAppSetting('platform.desktop-executor.v1', JSON.stringify({ autoStart, background: true }))
      restartDb()
      expect(setLoginItemSettings).toHaveBeenCalledTimes(calls)
      if (calls) expect(setLoginItemSettings.mock.calls[0][0]).toMatchObject({ openAtLogin: false })
      expect(store.getAppSetting('platform.desktop-executor.v1')).toBeNull()
      restartDb()
      expect(setLoginItemSettings).toHaveBeenCalledTimes(calls)
    } finally {
      target.isPackaged = false
      delete target.setLoginItemSettings
    }
  })

  it('isolates nested transaction rollback while preserving the outer transaction', () => {
    store.transaction(() => {
      store.setAppSetting('outer', 'preserved')
      expect(() =>
        store.transaction(() => {
          store.setAppSetting('inner', 'rolled back')
          throw new Error('inner failed')
        })
      ).toThrow('inner failed')
      expect(store.getAppSetting('inner')).toBeNull()
    })
    expect(store.getAppSetting('outer')).toBe('preserved')
    expect(() =>
      store.transaction(() => {
        store.transaction(() => store.setAppSetting('nested', 'rolled back'))
        throw new Error('outer failed')
      })
    ).toThrow('outer failed')
    expect(store.getAppSetting('nested')).toBeNull()
    expect(store.getDb().prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
  })

  it('rolls back all schema changes when an existing database cannot be upgraded', () => {
    closeDb()
    const directory = mkdtempSync(path.join(os.tmpdir(), 'schema-rollback-'))
    const file = path.join(directory, 'database.sqlite')
    const original = new DatabaseSync(file)
    original.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES ('preserved');")
    original.close()
    try {
      expect(() => store.initStore(file)).toThrow()
      const restored = new DatabaseSync(file)
      try {
        expect(restored.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([
          { name: 'workspaces' },
        ])
        expect(restored.prepare('SELECT id FROM workspaces').all()).toEqual([{ id: 'preserved' }])
        expect(restored.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      } finally {
        restored.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not export retired diagnostics or telemetry helpers', () => {
    expect(Object.keys(store).filter((name) => /telemetry|diagnostics/i.test(name))).toEqual([])
  })
})
