import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { closeStore, getConversation, getDb, initStore } from '../../src/main/store'

const LEGACY_MANAGEMENT_TABLES = [
  'delivery_memory_chunks',
  'delivery_memories',
  'card_body_history',
  'column_prompt_history',
  'card_dispatch_guards',
  'card_events',
  'card_comments',
  'card_conversations',
  'column_agent_configs',
  'board_cards',
  'board_columns',
  'boards',
] as const

let tempRoots: string[] = []

function createLegacyDatabase(options: { brokenChatMessages?: boolean; usageConversationId?: boolean } = {}): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-management-schema-'))
  tempRoots.push(root)
  const databasePath = path.join(root, 'legacy.db')
  const raw = new DatabaseSync(databasePath)
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      memory_enabled INTEGER NOT NULL DEFAULT 1,
      next_card_number INTEGER NOT NULL DEFAULT 1,
      group_id TEXT,
      collapsed INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      branch TEXT NOT NULL,
      mode TEXT NOT NULL,
      experience TEXT NOT NULL DEFAULT 'standard',
      kind TEXT NOT NULL DEFAULT 'regular',
      cwd TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      pinned_at INTEGER,
      last_activity_at INTEGER NOT NULL DEFAULT 0,
      is_multi INTEGER NOT NULL DEFAULT 0,
      ui_prefs TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE boards (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE TABLE board_columns (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE TABLE board_cards (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      column_id TEXT NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES board_cards(id) ON DELETE CASCADE
    );
    CREATE TABLE column_agent_configs (
      column_id TEXT PRIMARY KEY REFERENCES board_columns(id) ON DELETE CASCADE
    );
    CREATE TABLE card_conversations (
      card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, conversation_id)
    );
    CREATE TABLE card_events (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE
    );
    CREATE TABLE card_comments (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE
    );
    CREATE TABLE card_dispatch_guards (
      card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
      column_id TEXT NOT NULL,
      PRIMARY KEY (card_id, column_id)
    );
    CREATE TABLE delivery_memories (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL UNIQUE REFERENCES board_cards(id) ON DELETE CASCADE
    );
    CREATE TABLE delivery_memory_chunks (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES delivery_memories(id) ON DELETE CASCADE
    );
    CREATE TABLE card_body_history (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE
    );
    CREATE TABLE column_prompt_history (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE
    );
    ${
      options.brokenChatMessages
        ? 'CREATE TABLE chat_messages (id TEXT PRIMARY KEY);'
        : `CREATE TABLE chat_messages (
             id TEXT PRIMARY KEY,
             conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
             role TEXT NOT NULL,
             parts_json TEXT NOT NULL DEFAULT '[]',
             meta_json TEXT,
             seq INTEGER NOT NULL,
             created_at INTEGER NOT NULL
           );
           CREATE TABLE chat_usage_ledger (
             message_id TEXT PRIMARY KEY,
             ${options.usageConversationId ? 'conversation_id TEXT,' : ''}
             provider_id TEXT NOT NULL DEFAULT '',
             model_id TEXT NOT NULL DEFAULT '',
             usage_json TEXT NOT NULL,
             created_at INTEGER NOT NULL
           );`
    }
  `)
  raw
    .prepare('INSERT INTO workspaces (id, path, name, default_branch, added_at) VALUES (?, ?, ?, ?, ?)')
    .run('workspace-1', '/tmp/legacy-workspace', 'Legacy', 'main', 1)
  raw
    .prepare(`INSERT INTO conversations
      (id, workspace_id, name, branch, mode, experience, kind, cwd, status, created_at, archived,
       pinned_at, last_activity_at, is_multi, ui_prefs, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'conversation-regular',
      'workspace-1',
      'Keep me',
      'main',
      'local',
      'standard',
      'regular',
      '/tmp/legacy-workspace',
      'idle',
      1,
      0,
      null,
      1,
      0,
      JSON.stringify({
        assistantEngine: 'chatgpt-web',
        assistantProjectId: 'legacy-project',
        browserActive: 2,
        mainTabOrder: ['browser', 'card', 'terminal', 'card'],
        floating: {
          card: { x: 1, y: 2, width: 300, height: 400 },
          terminal: { x: 5, y: 6, width: 700, height: 500 },
        },
        chatGptWebCapabilities: {
          git: 'read',
          gh: 'read',
          conversation: 'read',
          memory: 'read',
          board: 'write',
          browser: 'inspect',
          mcp: {},
        },
      }),
      0
    )
  raw
    .prepare(`INSERT INTO conversations
      (id, workspace_id, name, branch, mode, experience, kind, cwd, status, created_at, archived,
       pinned_at, last_activity_at, is_multi, ui_prefs, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'conversation-assistant',
      'workspace-1',
      'Project assistant',
      'main',
      'local',
      'standard',
      'assistant',
      '/tmp/legacy-workspace',
      'idle',
      2,
      0,
      null,
      2,
      0,
      JSON.stringify({ assistantEngine: 'maestrly', assistantProjectId: 'legacy-project' }),
      1
    )
  raw.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('dispatch.maxPerCardPerColumn', '5')
  raw.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('keep.setting', 'yes')
  raw
    .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
    .run('defaultMainTabOrder', JSON.stringify(['card', 'notes', 'browser']))
  raw.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(
    'shortcuts.config',
    JSON.stringify({
      card: { key: 'c', mods: ['meta', 'control'] },
      terminal: { key: 'j', mods: ['meta', 'control'] },
    })
  )
  raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('board-auto-advance-pending-v1', 1)
  raw.exec(`
    INSERT INTO boards VALUES ('board-1', 'workspace-1');
    INSERT INTO board_columns VALUES ('column-1', 'workspace-1');
    INSERT INTO board_cards VALUES ('card-1', 'workspace-1', 'column-1', NULL);
    INSERT INTO column_agent_configs VALUES ('column-1');
    INSERT INTO card_conversations VALUES ('card-1', 'conversation-regular');
    INSERT INTO card_events VALUES ('event-1', 'card-1');
    INSERT INTO card_comments VALUES ('comment-1', 'card-1');
    INSERT INTO card_dispatch_guards VALUES ('card-1', 'column-1');
    INSERT INTO delivery_memories VALUES ('memory-1', 'card-1');
    INSERT INTO delivery_memory_chunks VALUES ('chunk-1', 'memory-1');
    INSERT INTO card_body_history VALUES ('body-history-1', 'card-1');
    INSERT INTO column_prompt_history VALUES ('prompt-history-1', 'column-1');
  `)
  if (!options.brokenChatMessages) {
    raw.exec(
      options.usageConversationId
        ? `
      INSERT INTO chat_messages VALUES
        ('message-regular', 'conversation-regular', 'user', '[{"type":"text","text":"keep me"}]', NULL, 1, 1),
        ('message-assistant', 'conversation-assistant', 'user', '[{"type":"text","text":"remove me"}]', NULL, 1, 2);
      INSERT INTO chat_usage_ledger VALUES
        ('message-regular', 'conversation-regular', 'provider', 'model', '{"input":1,"output":1}', 1),
        ('message-assistant', NULL, 'provider', 'model', '{"input":2,"output":2}', 2);
    `
        : `
      INSERT INTO chat_messages VALUES
        ('message-regular', 'conversation-regular', 'user', '[{"type":"text","text":"keep me"}]', NULL, 1, 1),
        ('message-assistant', 'conversation-assistant', 'user', '[{"type":"text","text":"remove me"}]', NULL, 1, 2);
      INSERT INTO chat_usage_ledger VALUES
        ('message-regular', 'provider', 'model', '{"input":1,"output":1}', 1),
        ('message-assistant', 'provider', 'model', '{"input":2,"output":2}', 2);
    `
    )
  }
  raw.close()
  return databasePath
}

describe('legacy project-management schema migration', () => {
  afterEach(() => {
    closeStore()
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
    tempRoots = []
  })

  it('removes management tables, assistant conversations, fields, and settings while preserving chat data', () => {
    const databasePath = createLegacyDatabase()

    initStore(databasePath)

    const tables = new Set(
      (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        ({ name }) => name
      )
    )
    for (const table of LEGACY_MANAGEMENT_TABLES) expect(tables).not.toContain(table)

    const conversationColumns = (
      getDb().prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    ).map(({ name }) => name)
    const workspaceColumns = (getDb().prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>).map(
      ({ name }) => name
    )
    expect(conversationColumns).not.toContain('kind')
    expect(workspaceColumns).not.toContain('next_card_number')
    expect(getConversation('conversation-assistant')).toBeUndefined()
    const regularConversation = getConversation('conversation-regular')
    expect(regularConversation).toMatchObject({
      id: 'conversation-regular',
      name: 'Keep me',
    })
    expect(regularConversation?.uiPrefs).toEqual({
      browserActive: 2,
      mainTabOrder: ['browser', 'terminal'],
      floating: { terminal: { x: 5, y: 6, width: 700, height: 500 } },
      chatGptWebCapabilities: {
        git: 'read',
        gh: 'read',
        conversation: 'read',
        memory: 'read',
        browser: 'inspect',
        mcp: {},
      },
    })
    expect(getDb().prepare('SELECT id FROM chat_messages ORDER BY id').all()).toEqual([{ id: 'message-regular' }])
    expect(getDb().prepare('SELECT message_id FROM chat_usage_ledger ORDER BY message_id').all()).toEqual([
      { message_id: 'message-regular' },
    ])
    expect(
      getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get('dispatch.maxPerCardPerColumn')
    ).toBeUndefined()
    expect(getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get('keep.setting')).toEqual({
      value: 'yes',
    })
    expect(
      JSON.parse(
        (
          getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get('defaultMainTabOrder') as {
            value: string
          }
        ).value
      )
    ).toEqual(['notes', 'browser'])
    expect(
      JSON.parse(
        (getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get('shortcuts.config') as { value: string })
          .value
      )
    ).toEqual({ terminal: { key: 'j', mods: ['meta', 'control'] } })
    expect(
      getDb().prepare('SELECT applied_at FROM schema_migrations WHERE id = ?').get('board-auto-advance-pending-v1')
    ).toBeUndefined()
    expect(getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(getDb().prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })

    closeStore()
    initStore(databasePath)
    expect(getConversation('conversation-regular')?.uiPrefs).toMatchObject({
      browserActive: 2,
      mainTabOrder: ['browser', 'terminal'],
    })
  })

  it('rolls the purge back when a later schema step fails', () => {
    const databasePath = createLegacyDatabase({ brokenChatMessages: true })

    expect(() => initStore(databasePath)).toThrow()

    const raw = new DatabaseSync(databasePath)
    const tables = new Set(
      (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        ({ name }) => name
      )
    )
    expect(tables).toContain('boards')
    expect(
      (raw.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(({ name }) => name)
    ).toContain('kind')
    expect(
      (raw.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>).map(({ name }) => name)
    ).toContain('next_card_number')
    expect(raw.prepare('SELECT id FROM conversations WHERE id = ?').get('conversation-assistant')).toEqual({
      id: 'conversation-assistant',
    })
    const prefs = JSON.parse(
      (
        raw.prepare('SELECT ui_prefs FROM conversations WHERE id = ?').get('conversation-regular') as {
          ui_prefs: string
        }
      ).ui_prefs
    ) as Record<string, unknown>
    expect(prefs.mainTabOrder).toEqual(['browser', 'card', 'terminal', 'card'])
    expect(prefs).toHaveProperty('assistantEngine')
    expect(prefs).toHaveProperty('chatGptWebCapabilities.board', 'write')
    expect(
      JSON.parse(
        (raw.prepare('SELECT value FROM app_settings WHERE key = ?').get('defaultMainTabOrder') as { value: string })
          .value
      )
    ).toEqual(['card', 'notes', 'browser'])
    raw.close()
  })

  it('removes assistant usage from a partially backfilled owner-aware ledger', () => {
    const databasePath = createLegacyDatabase({ usageConversationId: true })

    initStore(databasePath)

    expect(getDb().prepare('SELECT message_id FROM chat_usage_ledger ORDER BY message_id').all()).toEqual([
      { message_id: 'message-regular' },
    ])
  })
})
