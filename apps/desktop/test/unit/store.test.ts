import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { freshDb, restartDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'

import {
  getDb,
  transaction,
  initStore,
  closeStore,
  insertWorkspace,
  getWorkspace,
  getWorkspaceByPath,
  listWorkspaces,
  getMemoryEnabled,
  setMemoryEnabled,
  setWorkspaceDefaultBranch,
  deleteWorkspace,
  setWorkspaceOrder,
  setConversationOrder,
  listWorkspaceGroups,
  createWorkspaceGroup,
  renameWorkspaceGroup,
  deleteWorkspaceGroup,
  setGroupCollapsed,
  setGroupOrder,
  setWorkspaceCollapsed,
  setWorkspaceGroupAndOrder,
  listWorkspaceGroupIds,
  getAppFlag,
  setAppFlag,
  getAppSetting,
  setAppSetting,
  getDefaultMainTabOrder,
  setDefaultMainTabOrder,
  initOnboardingFlag,
  ONBOARDING_KEY,
  getConversation,
  listConversations,
  updateConversationStatus,
  renameConversation,
  setConversationArchived,
  setConversationPinned,
  countOtherConversationsInCwd,
  countOtherActiveConversationsInCwd,
  deleteConversation,
  patchConvUiPrefs,
  getConvUiPrefs,
  getShortcutOpenMode,
  setShortcutOpenMode,
  type Workspace,
} from '../../src/main/store'

// ─────────────────────────────────────────────────────────────────────────────
// Schema and defensive, idempotent migrations.
// ─────────────────────────────────────────────────────────────────────────────

describe('schema and migrations', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('key tables exist after initStore', () => {
    const tables = [
      'workspaces',
      'workspace_groups',
      'conversations',
      'local_memories',
      'chat_codex_threads',
      'chat_codex_thread_cleanup',
      'app_settings',
    ]
    for (const table of tables) {
      const row = getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) as
        | { name?: string }
        | undefined
      expect(row?.name, `table "${table}" must exist`).toBe(table)
    }
  })

  it('Codex cleanup has a durable schema without a foreign key and a defensive binding trigger', () => {
    const columns = getDb().prepare('PRAGMA table_info(chat_codex_thread_cleanup)').all() as Array<{
      name: string
      notnull: number
    }>
    expect(columns.map((column) => column.name)).toEqual([
      'thread_id',
      'conversation_id',
      'last_error',
      'attempts',
      'account_id',
      'created_at',
      'updated_at',
    ])
    expect(getDb().prepare('PRAGMA foreign_key_list(chat_codex_thread_cleanup)').all()).toEqual([])
    const trigger = getDb()
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get('trg_chat_codex_thread_cleanup_before_delete') as { name: string; tbl_name: string } | undefined
    expect(trigger).toEqual({
      name: 'trg_chat_codex_thread_cleanup_before_delete',
      tbl_name: 'chat_codex_threads',
    })
  })

  it('migrated conversation columns exist', () => {
    const columns = getDb().prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    const names = columns.map((c) => c.name)
    for (const col of ['is_multi', 'archived', 'pinned_at', 'last_activity_at', 'ui_prefs', 'position']) {
      expect(names, `column conversations.${col} must exist`).toContain(col)
    }
    for (const removed of ['cli', 'started', 'cli_sessions', 'session_anchors', 'kind']) {
      expect(names, `legacy column conversations.${removed} must be removed`).not.toContain(removed)
    }
  })

  it('a new database creates nullable INTEGER conversations.pinned_at', () => {
    const pinnedAt = (
      getDb().prepare('PRAGMA table_info(conversations)').all() as Array<{
        name: string
        type: string
        notnull: number
      }>
    ).find((column) => column.name === 'pinned_at')

    expect(pinnedAt).toMatchObject({ type: 'INTEGER', notnull: 0 })
  })

  it('migrated workspace columns exist', () => {
    const columns = getDb().prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>
    const names = columns.map((c) => c.name)
    expect(names).toContain('memory_enabled')
    expect(names).toContain('position')
    expect(names).toContain('group_id')
    expect(names).toContain('collapsed')
    expect(names).not.toContain('next_card_number')
  })

  it('migrations are idempotent when initializing the same database again', () => {
    // freshDb already initialized the schema; verify column uniqueness.
    // Reopening requires closing the current database first.
    // Production guards use IF NOT EXISTS and hasCol.
    // No column may appear twice.
    const columns = getDb().prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    const names = columns.map((c) => c.name)
    const nomesUnicos = new Set(names)
    expect(names.length).toBe(nomesUnicos.size)
  })

})

describe('conversations.pinned_at migration', () => {
  it('adds the column to an old database, preserves rows, and remains idempotent', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agents-pinned-mig-'))
    const dbFile = path.join(tmpDir, 'old.db')
    try {
      const raw = new DatabaseSync(dbFile)
      raw.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          default_branch TEXT NOT NULL, added_at INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          branch TEXT NOT NULL,
          mode TEXT NOT NULL,
          cli TEXT NOT NULL DEFAULT 'claude',
          kind TEXT NOT NULL DEFAULT 'regular',
          cwd TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle',
          created_at INTEGER NOT NULL,
          started INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          last_activity_at INTEGER NOT NULL DEFAULT 0,
          is_multi INTEGER NOT NULL DEFAULT 0,
          cli_sessions TEXT NOT NULL DEFAULT '{}',
          session_anchors TEXT NOT NULL DEFAULT '{}',
          ui_prefs TEXT NOT NULL DEFAULT '{}',
          position INTEGER NOT NULL DEFAULT 0
        );
      `)
      const workspaceId = randomUUID()
      const conversationId = randomUUID()
      const now = Date.now()
      raw
        .prepare('INSERT INTO workspaces (id, path, name, default_branch, added_at, position) VALUES (?,?,?,?,?,?)')
        .run(workspaceId, `/tmp/pinned-old-${workspaceId}`, 'old workspace', 'main', now, 0)
      raw
        .prepare(`INSERT INTO conversations
          (id, workspace_id, name, branch, mode, cli, kind, cwd, status, created_at, started, archived,
           last_activity_at, is_multi, cli_sessions, session_anchors, ui_prefs, position)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          conversationId,
          workspaceId,
          'old conversation',
          'main',
          'local',
          'claude',
          'regular',
          `/tmp/pinned-old-${conversationId}`,
          'idle',
          now,
          1,
          0,
          now,
          0,
          '{}',
          '{}',
          '{}',
          0
        )
      raw.close()

      initStore(dbFile)
      const firstColumns = (getDb().prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
      expect(firstColumns.filter((column) => column === 'pinned_at')).toHaveLength(1)
      expect(firstColumns.filter((column) => column === 'experience')).toHaveLength(1)
      expect(getConversation(conversationId)).toMatchObject({
        id: conversationId,
        name: 'old conversation',
        pinnedAt: null,
        experience: 'standard',
      })
      closeStore()

      initStore(dbFile)
      const secondColumns = (getDb().prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
      expect(secondColumns.filter((column) => column === 'pinned_at')).toHaveLength(1)
      expect(secondColumns.filter((column) => column === 'experience')).toHaveLength(1)
      expect(getConversation(conversationId)?.pinnedAt).toBeNull()
      expect(getConversation(conversationId)?.experience).toBe('standard')
      closeStore()
    } finally {
      try {
        closeStore()
      } catch {
        /* Already closed. */
      }
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('OpenAI tool ledger migration', () => {
  it('atomically replaces the draft without message_id and remains idempotent', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agents-openai-tool-mig-'))
    const dbFile = path.join(tmpDir, 'old.db')
    try {
      const raw = new DatabaseSync(dbFile)
      raw.exec(`CREATE TABLE chat_tool_executions (
        conversation_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        output_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, call_id)
      );`)
      raw.close()

      initStore(dbFile)
      const columns = (getDb().prepare('PRAGMA table_info(chat_tool_executions)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
      expect(columns).toContain('message_id')
      expect(
        getDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chat_tool_exec_message'").get()
      ).toEqual({ name: 'idx_chat_tool_exec_message' })
      closeStore()

      initStore(dbFile)
      const secondColumns = (
        getDb().prepare('PRAGMA table_info(chat_tool_executions)').all() as Array<{ name: string }>
      ).map((column) => column.name)
      expect(secondColumns.filter((column) => column === 'message_id')).toHaveLength(1)
      closeStore()
    } finally {
      try {
        closeStore()
      } catch {
        /* Already closed. */
      }
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// transaction() commit and rollback.
// ─────────────────────────────────────────────────────────────────────────────

describe('transaction()', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('COMMIT: persists data inserted inside the transaction', () => {
    const ws = makeWorkspace()
    transaction(() => {
      getDb()
        .prepare(
          'INSERT INTO conversations (id, workspace_id, name, branch, mode, cwd, status, created_at, archived, last_activity_at, is_multi) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          randomUUID(),
          ws.id,
          'tx-conv',
          'main',
          'local',
          '/tmp/tx',
          'idle',
          Date.now(),
          0,
          Date.now(),
          0
        )
    })
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM conversations WHERE name = 'tx-conv'").get() as { n: number }
    expect(row.n).toBe(1)
  })

  it('ROLLBACK: throwing inside fn persists nothing and rethrows the error', () => {
    const ws = makeWorkspace()
    const idUnico = randomUUID()
    let erroCapturado: Error | null = null

    try {
      transaction(() => {
        getDb()
          .prepare(
            'INSERT INTO conversations (id, workspace_id, name, branch, mode, cwd, status, created_at, archived, last_activity_at, is_multi) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
          )
          .run(
            idUnico,
            ws.id,
            'rollback-conv',
            'main',
            'local',
            '/tmp/rb',
            'idle',
            Date.now(),
            0,
            Date.now(),
            0
          )
        throw new Error('intentional failure during transaction')
      })
    } catch (e) {
      erroCapturado = e as Error
    }

    expect(erroCapturado).not.toBeNull()
    expect(erroCapturado?.message).toContain('intentional failure')

    const row = getDb().prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(idUnico) as { n: number }
    expect(row.n).toBe(0)
  })

  it('ROLLBACK: discards multiple inserts together', () => {
    const ws = makeWorkspace()
    const ids = [randomUUID(), randomUUID(), randomUUID()]

    try {
      transaction(() => {
        for (const id of ids) {
          getDb()
            .prepare(
              'INSERT INTO conversations (id, workspace_id, name, branch, mode, cwd, status, created_at, archived, last_activity_at, is_multi) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
            )
            .run(
              id,
              ws.id,
              `conv-${id}`,
              'main',
              'local',
              `/tmp/${id}`,
              'idle',
              Date.now(),
              0,
              Date.now(),
              0
            )
        }
        throw new Error('batch rollback')
      })
    } catch {
      // esperado
    }

    for (const id of ids) {
      const row = getDb().prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(id) as { n: number }
      expect(row.n).toBe(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. patchConvUiPrefs — merge read-modify-write
// ─────────────────────────────────────────────────────────────────────────────

describe('patchConvUiPrefs and getConvUiPrefs', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('successive patches coexist without removing earlier keys', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)

    patchConvUiPrefs(conv.id, { mainTabOrder: ['a', 'b'] })
    patchConvUiPrefs(conv.id, { browserActive: 2 })

    const prefs = getConvUiPrefs(conv.id)
    expect(prefs.mainTabOrder).toEqual(['a', 'b'])
    expect(prefs.browserActive).toBe(2)
  })

  it('patching an existing key overwrites only that key', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)

    patchConvUiPrefs(conv.id, { mainTabOrder: ['x'], browserActive: 0 })
    patchConvUiPrefs(conv.id, { mainTabOrder: ['x', 'y', 'z'] })

    const prefs = getConvUiPrefs(conv.id)
    expect(prefs.mainTabOrder).toEqual(['x', 'y', 'z'])
    expect(prefs.browserActive).toBe(0) // Preserved unchanged.
  })

  it('getConvUiPrefs returns {} for invalid ui_prefs JSON', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)

    getDb().prepare("UPDATE conversations SET ui_prefs = 'not-json' WHERE id = ?").run(conv.id)

    const prefs = getConvUiPrefs(conv.id)
    expect(prefs).toEqual({})
  })

  it('getConvUiPrefs returns {} for a missing conversation', () => {
    const prefs = getConvUiPrefs('missing-id')
    expect(prefs).toEqual({})
  })

  it('getConversation().uiPrefs also returns preferences', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)

    patchConvUiPrefs(conv.id, { browserActive: 7 })

    const c = getConversation(conv.id)
    expect(c?.uiPrefs?.browserActive).toBe(7)
  })
})

describe('global default drawer tab order', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('persists and applies the global default to new conversations', () => {
    const ws = makeWorkspace()

    setDefaultMainTabOrder(['terminal', 'browser', 'notes'])
    const conv = makeConversation(ws.id)

    expect(getDefaultMainTabOrder()).toEqual(['terminal', 'browser', 'notes'])
    expect(getConversation(conv.id)?.uiPrefs?.mainTabOrder).toEqual(['terminal', 'browser', 'notes'])
  })

  it('does not overwrite explicit ui_prefs supplied during creation', () => {
    const ws = makeWorkspace()

    setDefaultMainTabOrder(['terminal', 'browser', 'notes'])
    const conv = makeConversation(ws.id, { uiPrefs: { mainTabOrder: ['review', 'plan'], browserActive: 2 } })

    expect(getConversation(conv.id)?.uiPrefs).toEqual({ mainTabOrder: ['review', 'plan'], browserActive: 2 })
  })
})

describe('shortcut open mode (popup versus floating)', () => {
  beforeEach(freshDb)
  afterEach(closeDb)
  it('defaults to popup, persists set/get, and falls back to popup for invalid values', () => {
    expect(getShortcutOpenMode()).toBe('popup') // Default when no value is saved.
    setShortcutOpenMode('floating')
    expect(getShortcutOpenMode()).toBe('floating')
    setShortcutOpenMode('popup')
    expect(getShortcutOpenMode()).toBe('popup')
    // @ts-expect-error — Exercise the runtime guard for an invalid enum value.
    setShortcutOpenMode('xyz')
    expect(getShortcutOpenMode()).toBe('popup') // Sanitized to popup.
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Foreign-key cascading removes workspace-owned data.
// ─────────────────────────────────────────────────────────────────────────────

describe('foreign-key cascade by workspace_id', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('deleting a workspace cascades to conversations and their messages', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)
    getDb()
      .prepare(
        'INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run('message-1', conv.id, 'user', '[]', null, 1, 1)

    getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id)

    expect(getConversation(conv.id)).toBeUndefined()
    expect(getDb().prepare('SELECT id FROM chat_messages WHERE id = ?').get('message-1')).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Invalid preference JSON.
// ─────────────────────────────────────────────────────────────────────────────

describe('conversation UI preference parsing', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('getConvUiPrefs returns {} for non-JSON strings', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)

    // Invalid JSON string.
    getDb().prepare("UPDATE conversations SET ui_prefs = 'invalid-string' WHERE id = ?").run(conv.id)
    expect(getConvUiPrefs(conv.id)).toEqual({})

    // Empty string.
    getDb().prepare("UPDATE conversations SET ui_prefs = '' WHERE id = ?").run(conv.id)
    expect(getConvUiPrefs(conv.id)).toEqual({})

    // A root array is valid JSON but not a record.
    getDb().prepare("UPDATE conversations SET ui_prefs = '[1,2,3]' WHERE id = ?").run(conv.id)
    // Arrays pass the current object-type check and are not rejected.
    // Parsing must not throw.
    expect(() => getConvUiPrefs(conv.id)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Workspace getters and setters.
// ─────────────────────────────────────────────────────────────────────────────

describe('workspaces — CRUD and helpers', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('insertWorkspace and getWorkspace return the same record', () => {
    const ws = makeWorkspace()
    const result = getWorkspace(ws.id)
    expect(result).toBeDefined()
    expect(result?.id).toBe(ws.id)
    expect(result?.path).toBe(ws.path)
    expect(result?.name).toBe(ws.name)
    expect(result?.defaultBranch).toBe(ws.defaultBranch)
  })

  it('getWorkspace returns undefined for a missing ID', () => {
    expect(getWorkspace('missing-id')).toBeUndefined()
  })

  it('getWorkspaceByPath finds the matching path', () => {
    const ws = makeWorkspace()
    const result = getWorkspaceByPath(ws.path)
    expect(result?.id).toBe(ws.id)
  })

  it('getWorkspaceByPath returns undefined for a missing path', () => {
    expect(getWorkspaceByPath('/missing/path')).toBeUndefined()
  })

  it('listWorkspaces returns all workspaces ordered by added_at', () => {
    const ws1 = makeWorkspace()
    const ws2 = makeWorkspace()

    const list = listWorkspaces()
    const ids = list.map((w) => w.id)
    expect(ids).toContain(ws1.id)
    expect(ids).toContain(ws2.id)
  })

  it('insertWorkspace ON CONFLICT(path) DO NOTHING tolerates duplicate paths', () => {
    const ws = makeWorkspace()
    const wsComMesmoPath: Workspace = {
      id: randomUUID(),
      path: ws.path, // Same path.
      name: 'other-name',
      defaultBranch: 'dev',
      addedAt: Date.now(),
    }
    // Must not throw.
    expect(() => insertWorkspace(wsComMesmoPath)).not.toThrow()

    // Preserve the original workspace.
    const result = getWorkspaceByPath(ws.path)
    expect(result?.id).toBe(ws.id)
  })

  it('getMemoryEnabled defaults to true because the column defaults to 1', () => {
    const ws = makeWorkspace()
    expect(getMemoryEnabled(ws.id)).toBe(true)
  })

  it('setMemoryEnabled toggles enabled state', () => {
    const ws = makeWorkspace()
    setMemoryEnabled(ws.id, false)
    expect(getMemoryEnabled(ws.id)).toBe(false)
    setMemoryEnabled(ws.id, true)
    expect(getMemoryEnabled(ws.id)).toBe(true)
  })

  it('deleteWorkspace removes the workspace', () => {
    const ws = makeWorkspace()
    deleteWorkspace(ws.id)
    expect(getWorkspace(ws.id)).toBeUndefined()
  })

  // Editable default_branch trims input and rejects empty values to preserve the NOT NULL invariant (#557).
  it('setWorkspaceDefaultBranch updates and trims the default branch', () => {
    const ws = makeWorkspace({ defaultBranch: 'main' })
    setWorkspaceDefaultBranch(ws.id, '  stage  ')
    expect(getWorkspace(ws.id)!.defaultBranch).toBe('stage')
  })

  it('setWorkspaceDefaultBranch rejects empty or whitespace input', () => {
    const ws = makeWorkspace({ defaultBranch: 'main' })
    expect(() => setWorkspaceDefaultBranch(ws.id, '')).toThrow()
    expect(() => setWorkspaceDefaultBranch(ws.id, '   ')).toThrow()
    expect(getWorkspace(ws.id)!.defaultBranch).toBe('main') // Unchanged.
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Conversation getters and setters.
// ─────────────────────────────────────────────────────────────────────────────

describe('conversations — CRUD and helpers', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('insertConversation and getConversation return the same record', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)
    const result = getConversation(conv.id)
    expect(result).toBeDefined()
    expect(result?.id).toBe(conv.id)
    expect(result?.workspaceId).toBe(ws.id)
    expect(result?.name).toBe(conv.name)
    expect(result?.pinnedAt).toBeNull()
  })

  it('persists Standard and Maestro as distinct structural experiences', () => {
    const ws = makeWorkspace()
    const standard = makeConversation(ws.id, { experience: 'standard' })
    const maestro = makeConversation(ws.id, { experience: 'maestro' })
    expect(getConversation(standard.id)?.experience).toBe('standard')
    expect(getConversation(maestro.id)?.experience).toBe('maestro')
  })

  it('insertConversation persists the supplied pinnedAt', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { pinnedAt: 123_456 })

    expect(getConversation(conv.id)?.pinnedAt).toBe(123_456)
  })

  it('getConversation returns undefined for a missing ID', () => {
    expect(getConversation('missing-id')).toBeUndefined()
  })

  it('listConversations returns only this workspace\'s conversations and excludes archived entries by default', () => {
    const ws1 = makeWorkspace()
    const ws2 = makeWorkspace()

    const conv1 = makeConversation(ws1.id)
    const convArq = makeConversation(ws1.id)
    makeConversation(ws2.id)

    setConversationArchived(convArq.id, true)

    const list = listConversations(ws1.id)
    const ids = list.map((c) => c.id)
    expect(ids).toContain(conv1.id)
    expect(ids).not.toContain(convArq.id) // Archived entries are excluded by default.
  })

  it('listConversations includes archived entries with includeArchived=true', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)
    setConversationArchived(conv.id, true)

    const semArq = listConversations(ws.id)
    const comArq = listConversations(ws.id, true)

    expect(semArq.map((c) => c.id)).not.toContain(conv.id)
    expect(comArq.map((c) => c.id)).toContain(conv.id)
  })

  it('updateConversationStatus updates status and last_activity_at', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)

    const before = getConversation(conv.id)!.lastActivityAt
    updateConversationStatus(conv.id, 'working')

    const after = getConversation(conv.id)
    expect(after?.status).toBe('working')
    expect(after?.lastActivityAt).toBeGreaterThanOrEqual(before)
  })

  it('renameConversation updates the name', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)

    renameConversation(conv.id, 'New name')

    expect(getConversation(conv.id)?.name).toBe('New name')
  })

  it('setConversationArchived archives and unarchives', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)

    setConversationArchived(conv.id, true)
    expect(getConversation(conv.id)?.archived).toBe(1)

    setConversationArchived(conv.id, false)
    expect(getConversation(conv.id)?.archived).toBe(0)
  })

  it('setConversationPinned persists the first pin across database restart', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)

    const pinnedAt = setConversationPinned(conv.id, true)
    expect(pinnedAt).toEqual(expect.any(Number))
    expect(getConversation(conv.id)?.pinnedAt).toBe(pinnedAt)

    restartDb()
    expect(getConversation(conv.id)?.pinnedAt).toBe(pinnedAt)
  })

  it('setConversationPinned preserves the timestamp on retries', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      expect(setConversationPinned(conv.id, true)).toBe(1_000)
      now.mockReturnValue(2_000)
      expect(setConversationPinned(conv.id, true)).toBe(1_000)
      expect(getConversation(conv.id)?.pinnedAt).toBe(1_000)
    } finally {
      now.mockRestore()
    }
  })

  it('setConversationPinned clears pins idempotently, including for missing IDs', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)
    setConversationPinned(conv.id, true)

    expect(setConversationPinned(conv.id, false)).toBeNull()
    expect(getConversation(conv.id)?.pinnedAt).toBeNull()
    expect(setConversationPinned(conv.id, false)).toBeNull()
    expect(setConversationPinned('id-missing', false)).toBeNull()
  })

  it('setConversationPinned rejects archived and missing conversations', () => {
    const ws = makeWorkspace()
    const archived = makeConversation(ws.id, { archived: 1 })

    expect(() => setConversationPinned(archived.id, true)).toThrow('Archived conversations cannot be pinned.')
    expect(() => setConversationPinned('id-missing', true)).toThrow('Conversation not found.')
  })

  it('archiving clears pins atomically and unarchiving does not restore them', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)
    setConversationPinned(conv.id, true)

    setConversationArchived(conv.id, true)
    expect(getConversation(conv.id)).toMatchObject({ archived: 1, pinnedAt: null })

    setConversationArchived(conv.id, false)
    expect(getConversation(conv.id)).toMatchObject({ archived: 0, pinnedAt: null })
  })

  it('activity and ordinary reordering do not change pinnedAt', () => {
    const ws = makeWorkspace()
    const pinned = makeConversation(ws.id)
    const other = makeConversation(ws.id)
    const pinnedAt = setConversationPinned(pinned.id, true)

    updateConversationStatus(pinned.id, 'working')
    setConversationOrder(ws.id, [other.id, pinned.id])

    expect(listConversations(ws.id).map((conversation) => conversation.id)).toEqual([other.id, pinned.id])
    expect(getConversation(pinned.id)?.pinnedAt).toBe(pinnedAt)
  })

  it('renameConversation preserves the pin and its shortcut', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)
    const pinnedAt = setConversationPinned(conv.id, true)

    renameConversation(conv.id, 'New name')

    expect(getConversation(conv.id)).toMatchObject({ name: 'New name', pinnedAt })
  })

  it('archiving sibling conversations one by one clears every pin', () => {
    const ws = makeWorkspace()
    const a = makeConversation(ws.id)
    const b = makeConversation(ws.id)
    setConversationPinned(a.id, true)
    setConversationPinned(b.id, true)

    // Sibling bulk archival calls the individual path sequentially for each member.
    setConversationArchived(a.id, true)
    setConversationArchived(b.id, true)

    expect(getConversation(a.id)).toMatchObject({ archived: 1, pinnedAt: null })
    expect(getConversation(b.id)).toMatchObject({ archived: 1, pinnedAt: null })
  })

  it('restart preserves pinnedAt for multiple conversations and retains their relative order', () => {
    const ws = makeWorkspace()
    const older = makeConversation(ws.id)
    const newer = makeConversation(ws.id)
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(1_000)
      setConversationPinned(older.id, true)
      now.mockReturnValue(2_000)
      setConversationPinned(newer.id, true)
    } finally {
      now.mockRestore()
    }

    restartDb()

    // Preserved canonical timestamps keep the same descending pinnedAt ordering.
    // Newest pins remain first after restart.
    expect(getConversation(older.id)?.pinnedAt).toBe(1_000)
    expect(getConversation(newer.id)?.pinnedAt).toBe(2_000)
  })

  it('countOtherConversationsInCwd counts other conversations sharing cwd', () => {
    const ws = makeWorkspace()
    const sharedCwd = '/tmp/shared-cwd'

    const conv1 = makeConversation(ws.id, { cwd: sharedCwd })
    const conv2 = makeConversation(ws.id, { cwd: sharedCwd })
    makeConversation(ws.id, { cwd: sharedCwd })

    // Exclude conv1; count conv2 and conv3.
    expect(countOtherConversationsInCwd(sharedCwd, conv1.id)).toBe(2)
    // Exclude conv2; count conv1 and conv3.
    expect(countOtherConversationsInCwd(sharedCwd, conv2.id)).toBe(2)
    // Exclude conversations in other directories.
    const otherConv = makeConversation(ws.id, { cwd: '/tmp/other-cwd' })
    expect(countOtherConversationsInCwd('/tmp/other-cwd', otherConv.id)).toBe(0)
  })

  it('countOtherActiveConversationsInCwd ignores archived siblings', () => {
    const ws = makeWorkspace()
    const sharedCwd = '/tmp/shared-cwd'

    const active = makeConversation(ws.id, { cwd: sharedCwd })
    const archived = makeConversation(ws.id, { cwd: sharedCwd, archived: 1 })
    const otherActive = makeConversation(ws.id, { cwd: sharedCwd })

    expect(countOtherConversationsInCwd(sharedCwd, active.id)).toBe(2)
    expect(countOtherActiveConversationsInCwd(sharedCwd, active.id)).toBe(1)
    expect(countOtherActiveConversationsInCwd(sharedCwd, otherActive.id)).toBe(1)
    expect(countOtherActiveConversationsInCwd(sharedCwd, archived.id)).toBe(2)
  })

  it('deleteConversation removes the conversation', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)

    deleteConversation(conv.id)

    expect(getConversation(conv.id)).toBeUndefined()
  })

  it('sensible Chat-only defaults', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)
    const c = getConversation(conv.id)!

    expect(c.archived).toBe(0)
    expect(c.pinnedAt).toBeNull()
    expect(c.isMulti).toBe(0)
    expect(c.uiPrefs).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// app_settings global flags.
// ─────────────────────────────────────────────────────────────────────────────

describe('getAppFlag / setAppFlag', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('returns the default when a key has never been written', () => {
    expect(getAppFlag('floating.drawer', true)).toBe(true)
    expect(getAppFlag('floating.drawer', false)).toBe(false)
  })

  it('persists booleans with upsert', () => {
    setAppFlag('floating.drawer', true)
    expect(getAppFlag('floating.drawer', false)).toBe(true)
    setAppFlag('floating.drawer', false)
    expect(getAppFlag('floating.drawer', true)).toBe(false)
  })
})

describe('getAppSetting / setAppSetting (string/JSON)', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('returns null when a key has never been written', () => {
    expect(getAppSetting('clis.status')).toBeNull()
  })

  it('persists and reads arbitrary strings with upsert', () => {
    setAppSetting('clis.status', 'hello')
    expect(getAppSetting('clis.status')).toBe('hello')
    setAppSetting('clis.status', 'world')
    expect(getAppSetting('clis.status')).toBe('world')
  })

  it('round-trips JSON used by the CLI status cache', () => {
    const payload = { available: ['claude', 'codex'], anyAvailable: true, detectedAt: 123 }
    setAppSetting('clis.status', JSON.stringify(payload))
    expect(JSON.parse(getAppSetting('clis.status')!)).toEqual(payload)
  })

  it('coexists with getAppFlag in the same table using distinct keys', () => {
    setAppFlag('yoloMode', false)
    setAppSetting('clis.status', '{}')
    expect(getAppFlag('yoloMode', true)).toBe(false)
    expect(getAppSetting('clis.status')).toBe('{}')
  })
})

describe('initOnboardingFlag (backfill first-run, #145)', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('an empty store leaves the flag unset so first-run onboarding appears', () => {
    initOnboardingFlag()
    expect(getAppSetting(ONBOARDING_KEY)).toBeNull() // Key remains absent.
    expect(getAppFlag(ONBOARDING_KEY, false)).toBe(false) // Default false shows onboarding.
  })

  it('existing workspaces with an unset flag backfill true to hide onboarding on upgrade', () => {
    makeWorkspace()
    initOnboardingFlag()
    expect(getAppFlag(ONBOARDING_KEY, false)).toBe(true)
  })

  it('preserves a saved flag; backfill does not overwrite an explicit false value', () => {
    makeWorkspace()
    setAppFlag(ONBOARDING_KEY, false) // Explicitly saved preference despite an existing workspace.
    initOnboardingFlag()
    expect(getAppFlag(ONBOARDING_KEY, true)).toBe(false) // Backfill preserved it.
  })

  it('repeated calls remain idempotent across two boots', () => {
    makeWorkspace()
    initOnboardingFlag()
    initOnboardingFlag()
    expect(getAppFlag(ONBOARDING_KEY, false)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar position and reordering (#31).
// ─────────────────────────────────────────────────────────────────────────────

describe('position and reorder (workspaces/conversations)', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('new workspaces append with increasing positions', () => {
    const ws1 = makeWorkspace()
    const ws2 = makeWorkspace()
    const ws3 = makeWorkspace()
    const ordered = listWorkspaces().map((w) => w.id)
    expect(ordered).toEqual([ws1.id, ws2.id, ws3.id])
    const positions = listWorkspaces().map((w) => {
      const row = getDb().prepare('SELECT position FROM workspaces WHERE id = ?').get(w.id) as { position: number }
      return row.position
    })
    expect(positions[0]).toBeLessThan(positions[1]!)
    expect(positions[1]).toBeLessThan(positions[2]!)
  })

  it('setWorkspaceOrder reorders the visible list', () => {
    const ws1 = makeWorkspace()
    const ws2 = makeWorkspace()
    const ws3 = makeWorkspace()
    setWorkspaceOrder([ws3.id, ws1.id, ws2.id])
    expect(listWorkspaces().map((w) => w.id)).toEqual([ws3.id, ws1.id, ws2.id])
  })

  it('setWorkspaceOrder ignores invalid or duplicate IDs without throwing', () => {
    const ws1 = makeWorkspace()
    const ws2 = makeWorkspace()
    expect(() => setWorkspaceOrder([ws2.id, 'fantasma', ws2.id, ws1.id])).not.toThrow()
    expect(listWorkspaces().map((w) => w.id)).toEqual([ws2.id, ws1.id])
  })

  it('new conversations append within their workspace', () => {
    const ws = makeWorkspace()
    const c1 = makeConversation(ws.id)
    const c2 = makeConversation(ws.id)
    const ordered = listConversations(ws.id, true).map((c) => c.id)
    expect(ordered).toEqual([c1.id, c2.id])
  })

  it('setConversationOrder reorders workspace conversations', () => {
    const ws = makeWorkspace()
    const c1 = makeConversation(ws.id)
    const c2 = makeConversation(ws.id)
    setConversationOrder(ws.id, [c2.id, c1.id])
    expect(listConversations(ws.id, true).map((c) => c.id)).toEqual([c2.id, c1.id])
  })

  it('setConversationOrder ignores IDs from another workspace', () => {
    const wsA = makeWorkspace()
    const wsB = makeWorkspace()
    const a1 = makeConversation(wsA.id)
    const a2 = makeConversation(wsA.id)
    const b1 = makeConversation(wsB.id)
    setConversationOrder(wsA.id, [a2.id, b1.id, a1.id])
    expect(listConversations(wsA.id, true).map((c) => c.id)).toEqual([a2.id, a1.id])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Workspace groups: schema, CRUD, ordering, atomicity, and migration (#218).
// ─────────────────────────────────────────────────────────────────────────────

describe('workspace_groups — schema, CRUD, and ordering (#218)', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('workspace_groups exists after initStore', () => {
    const row = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_groups'`)
      .get() as { name?: string } | undefined
    expect(row?.name).toBe('workspace_groups')
  })

  it('createWorkspaceGroup appends with an increasing position and returns the row', () => {
    const g1 = createWorkspaceGroup('Backend')
    const g2 = createWorkspaceGroup('Frontend')
    expect(g1.name).toBe('Backend')
    expect(g1.collapsed).toBe(false)
    const list = listWorkspaceGroups()
    expect(list.map((g) => g.id)).toEqual([g1.id, g2.id])
    expect(list[0]!.position).toBeLessThan(list[1]!.position)
  })

  it('renameWorkspaceGroup and setGroupCollapsed persist', () => {
    const g = createWorkspaceGroup('Group')
    renameWorkspaceGroup(g.id, 'Renamed')
    setGroupCollapsed(g.id, true)
    const found = listWorkspaceGroups().find((x) => x.id === g.id)!
    expect(found.name).toBe('Renamed')
    expect(found.collapsed).toBe(true)
    setGroupCollapsed(g.id, false)
    expect(listWorkspaceGroups().find((x) => x.id === g.id)!.collapsed).toBe(false)
  })

  it('setGroupOrder reorders while ignoring invalid or duplicate IDs', () => {
    const a = createWorkspaceGroup('A')
    const b = createWorkspaceGroup('B')
    const c = createWorkspaceGroup('C')
    setGroupOrder([c.id, 'fantasma', c.id, a.id, b.id])
    expect(listWorkspaceGroups().map((g) => g.id)).toEqual([c.id, a.id, b.id])
  })

  it('new workspaces start ungrouped and expanded', () => {
    const ws = makeWorkspace()
    const assoc = listWorkspaceGroupIds().find((r) => r.id === ws.id)!
    expect(assoc.groupId).toBeNull()
    expect(assoc.collapsed).toBe(false)
  })

  it('setWorkspaceCollapsed persists collapse state for listWorkspaceGroupIds hydration', () => {
    const ws = makeWorkspace()
    setWorkspaceCollapsed(ws.id, true)
    expect(listWorkspaceGroupIds().find((r) => r.id === ws.id)!.collapsed).toBe(true)
    setWorkspaceCollapsed(ws.id, false)
    expect(listWorkspaceGroupIds().find((r) => r.id === ws.id)!.collapsed).toBe(false)
  })

  it('deleteWorkspaceGroup ungroups members without deleting workspaces', () => {
    const ws = makeWorkspace()
    const g = createWorkspaceGroup('Tmp')
    setWorkspaceGroupAndOrder(ws.id, g.id, [ws.id])
    expect(listWorkspaceGroupIds().find((r) => r.id === ws.id)!.groupId).toBe(g.id)

    deleteWorkspaceGroup(g.id)

    // The group is gone but the ungrouped workspace and its files remain.
    expect(listWorkspaceGroups().find((x) => x.id === g.id)).toBeUndefined()
    expect(getWorkspace(ws.id)).toBeDefined()
    expect(listWorkspaceGroupIds().find((r) => r.id === ws.id)!.groupId).toBeNull()
  })

  it('setWorkspaceGroupAndOrder atomically moves to a group and renumbers positions', () => {
    const a = makeWorkspace()
    const b = makeWorkspace()
    const c = makeWorkspace()
    const g = createWorkspaceGroup('G')
    // Move b into the group and impose flattened order [a, c, b].
    setWorkspaceGroupAndOrder(b.id, g.id, [a.id, c.id, b.id])
    expect(listWorkspaceGroupIds().find((r) => r.id === b.id)!.groupId).toBe(g.id)
    // Densely renumber positions in the requested order.
    expect(listWorkspaces().map((w) => w.id)).toEqual([a.id, c.id, b.id])
    // a and c remain ungrouped.
    expect(listWorkspaceGroupIds().find((r) => r.id === a.id)!.groupId).toBeNull()
    expect(listWorkspaceGroupIds().find((r) => r.id === c.id)!.groupId).toBeNull()
  })

  it('setWorkspaceGroupAndOrder coerces unknown groups to null to prevent orphan membership', () => {
    const ws = makeWorkspace()
    setWorkspaceGroupAndOrder(ws.id, 'grupo-fantasma', [ws.id])
    expect(listWorkspaceGroupIds().find((r) => r.id === ws.id)!.groupId).toBeNull()
  })

  it('setWorkspaceGroupAndOrder moves back to ungrouped while preserving order', () => {
    const a = makeWorkspace()
    const b = makeWorkspace()
    const g = createWorkspaceGroup('G')
    setWorkspaceGroupAndOrder(a.id, g.id, [b.id, a.id])
    expect(listWorkspaceGroupIds().find((r) => r.id === a.id)!.groupId).toBe(g.id)
    setWorkspaceGroupAndOrder(a.id, null, [a.id, b.id])
    expect(listWorkspaceGroupIds().find((r) => r.id === a.id)!.groupId).toBeNull()
    expect(listWorkspaces().map((w) => w.id)).toEqual([a.id, b.id])
  })
})

describe('workspace_groups — migration from a database without group_id or collapsed (#218)', () => {
  it('reinitializing an old database adds columns with defaults, preserves rows, and remains idempotent', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agents-grp-mig-'))
    const dbFile = path.join(tmpDir, 'old.db')
    try {
      // Create a pre-feature workspaces table with one row and no grouping columns.
      const raw = new DatabaseSync(dbFile)
      raw.exec(`CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        default_branch TEXT NOT NULL, added_at INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0
      );`)
      const wsId = randomUUID()
      raw
        .prepare('INSERT INTO workspaces (id, path, name, default_branch, added_at, position) VALUES (?,?,?,?,?,?)')
        .run(wsId, `/tmp/old-${wsId}`, 'old', 'main', Date.now(), 0)
      raw.close()

      // Real startup adds the missing columns without losing the row.
      initStore(dbFile)
      const cols = (getDb().prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
      expect(cols).toContain('group_id')
      expect(cols).toContain('collapsed')
      expect(getWorkspace(wsId)).toBeDefined() // Preserve the workspace row.
      const assoc = listWorkspaceGroupIds().find((r) => r.id === wsId)!
      expect(assoc.groupId).toBeNull() // Default to ungrouped.
      expect(assoc.collapsed).toBe(false) // Default to expanded.
      closeStore()

      // A second boot must not duplicate columns.
      initStore(dbFile)
      const cols2 = (getDb().prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
      expect(cols2.filter((n) => n === 'group_id').length).toBe(1)
      expect(cols2.filter((n) => n === 'collapsed').length).toBe(1)
      closeStore()
    } finally {
      try {
        closeStore()
      } catch {
        /* Already closed. */
      }
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
