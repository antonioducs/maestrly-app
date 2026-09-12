import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { deleteConversation, getConversation, getDb } from '../../src/main/store'
import {
  advanceMigration,
  assertConversationMigrationMutationAllowed,
  commitConversationLocation,
  getMigration,
  findIncompleteMigrationForScope,
  incompleteMigrationForConversation,
  insertMigration,
  rollbackMigrationIdentity,
} from '../../src/main/conversation-migration/store'
import type { ConversationMigrationRecord } from '../../src/shared/conversation-migration'

let source: ReturnType<typeof makeConversation>

function record(): ConversationMigrationRecord {
  return {
    id: 'migration',
    conversationId: source.id,
    sourceWorkspaceId: source.workspaceId,
    sourceBranch: 'main',
    destinationBranch: 'feature/migrate',
    sourceCwd: '/repo',
    destinationCwd: '/worktree',
    sourceHeadOid: 'a'.repeat(40),
    changes: { staged: [], unstaged: [], untracked: [] },
    ignored: [],
    selectedIgnoredPaths: [],
    confirmedSensitivePaths: [],
    gitPlan: {},
    sidecars: [],
    phase: 'prepared',
    status: 'prepared',
    baselineAssistants: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

beforeEach(() => {
  freshDb()
  const workspace = makeWorkspace({ id: 'ws' })
  source = makeConversation(workspace.id, { id: 'source', cwd: '/repo', mode: 'local' })
})
afterEach(closeDb)

describe('conversation migration store Chat-only', () => {
  it('uses only conversation_id without creating successor, CLI or session schema', () => {
    const tables = (
      getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(tables).toContain('conversation_migrations')
    expect(tables).not.toContain('conversation_successions')
    const migrationColumns = (
      getDb().prepare('PRAGMA table_info(conversation_migrations)').all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(migrationColumns).toContain('conversation_id')
    expect(migrationColumns).not.toEqual(
      expect.arrayContaining([
        'source_conversation_id',
        'successor_conversation_id',
        'cli',
        'engine_version',
        'continuation_json',
      ])
    )
    const conversationColumns = (
      getDb().prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(conversationColumns).not.toEqual(expect.arrayContaining(['cli', 'cli_sessions', 'session_anchors']))
  })

  it('migrates the legacy forward-only journal and requires safe rollback', () => {
    getDb().exec(`
      DROP TRIGGER IF EXISTS trg_conversation_migration_source_delete_guard;
      DROP TABLE conversation_migrations;
      CREATE TABLE conversation_migrations (
        id TEXT PRIMARY KEY, source_conversation_id TEXT NOT NULL, successor_conversation_id TEXT,
        source_workspace_id TEXT NOT NULL, source_branch TEXT NOT NULL, destination_branch TEXT NOT NULL,
        source_cwd TEXT NOT NULL, destination_cwd TEXT NOT NULL, source_head_oid TEXT NOT NULL,
        cli TEXT NOT NULL, engine_version TEXT, continuation_json TEXT NOT NULL, changes_json TEXT NOT NULL,
        ignored_json TEXT NOT NULL, selected_ignored_json TEXT NOT NULL, confirmed_sensitive_json TEXT NOT NULL,
        git_plan_json TEXT NOT NULL, sidecars_json TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL,
        stash_oid TEXT, stash_marker TEXT, baseline_assistants INTEGER NOT NULL, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE conversation_successions (
        original_id TEXT NOT NULL, successor_id TEXT NOT NULL, migration_id TEXT NOT NULL,
        validated_at INTEGER, PRIMARY KEY (original_id, successor_id)
      );
    `)
    getDb()
      .prepare(`INSERT INTO conversation_migrations VALUES
      (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        'legacy',
        source.id,
        null,
        source.workspaceId,
        'main',
        'feature/old',
        '/repo',
        '/old-worktree',
        'a'.repeat(40),
        'codex',
        '1.0',
        '{}',
        '{}',
        '[]',
        '[]',
        '[]',
        '{}',
        '[]',
        'awaiting-validation',
        'awaiting-validation',
        'b'.repeat(40),
        'marker',
        0,
        null,
        Date.now(),
        Date.now()
      )
    restartDb()
    expect(getMigration('legacy')).toMatchObject({
      conversationId: source.id,
      phase: 'rolling-back',
      status: 'recovery-required',
      error: 'Legacy CLI migration: only safe rollback is available.',
    })
    const columns = (
      getDb().prepare('PRAGMA table_info(conversation_migrations)').all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(columns).not.toEqual(expect.arrayContaining(['cli', 'engine_version', 'continuation_json']))
    expect(
      getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_successions'").get()
    ).toBeUndefined()
  })

  it('preserves and removes a legacy successor with history across restart and rollback', () => {
    const successor = makeConversation(source.workspaceId, {
      id: 'successor',
      cwd: '/old-worktree',
      branch: 'feature/old',
      mode: 'worktree',
    })
    getDb()
      .prepare(
        'INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run('successor-message', successor.id, 'assistant', '[]', null, 1, Date.now())

    getDb().exec(`
      DROP TRIGGER IF EXISTS trg_conversation_migration_source_delete_guard;
      DROP TABLE conversation_migrations;
      CREATE TABLE conversation_migrations (
        id TEXT PRIMARY KEY, source_conversation_id TEXT NOT NULL, successor_conversation_id TEXT,
        source_workspace_id TEXT NOT NULL, source_branch TEXT NOT NULL, destination_branch TEXT NOT NULL,
        source_cwd TEXT NOT NULL, destination_cwd TEXT NOT NULL, source_head_oid TEXT NOT NULL,
        cli TEXT NOT NULL, engine_version TEXT, continuation_json TEXT NOT NULL, changes_json TEXT NOT NULL,
        ignored_json TEXT NOT NULL, selected_ignored_json TEXT NOT NULL, confirmed_sensitive_json TEXT NOT NULL,
        git_plan_json TEXT NOT NULL, sidecars_json TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL,
        stash_oid TEXT, stash_marker TEXT, baseline_assistants INTEGER NOT NULL, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE conversation_successions (
        original_id TEXT NOT NULL, successor_id TEXT NOT NULL, migration_id TEXT NOT NULL,
        validated_at INTEGER, PRIMARY KEY (original_id, successor_id)
      );
    `)
    getDb()
      .prepare(`INSERT INTO conversation_migrations VALUES
      (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        'legacy-successor',
        source.id,
        successor.id,
        source.workspaceId,
        'main',
        'feature/old',
        '/repo',
        '/old-worktree',
        'a'.repeat(40),
        'codex',
        '1.0',
        JSON.stringify({ mode: 'successor' }),
        '{}',
        '[]',
        '[]',
        '[]',
        '{}',
        '[]',
        'awaiting-validation',
        'awaiting-validation',
        'b'.repeat(40),
        'marker',
        0,
        null,
        Date.now(),
        Date.now()
      )

    restartDb()
    expect(getMigration('legacy-successor')).toMatchObject({
      conversationId: source.id,
      legacySuccessorConversationId: successor.id,
      phase: 'rolling-back',
      status: 'recovery-required',
    })
    expect(getConversation(successor.id)).toBeDefined()
    expect(getDb().prepare('SELECT id FROM chat_messages WHERE conversation_id = ?').get(successor.id)).toBeDefined()
    expect(incompleteMigrationForConversation(successor.id)?.id).toBe('legacy-successor')
    expect(findIncompleteMigrationForScope(successor.id, '/unrelated-cwd')?.id).toBe('legacy-successor')
    expect(() => assertConversationMigrationMutationAllowed(successor.id, 'Archive conversation')).toThrow(
      'Archive conversation is blocked by incomplete migration legacy-successor.'
    )
    expect(() => deleteConversation(successor.id)).toThrow('conversation has an incomplete migration')

    expect(advanceMigration('legacy-successor', 'rolling-back', { phase: 'rolling-back', status: 'running' })).toBe(
      true
    )
    expect(rollbackMigrationIdentity('legacy-successor')).toBe(true)
    expect(getConversation(source.id)).toMatchObject({ cwd: '/repo', branch: 'main', mode: 'local' })
    expect(getConversation(successor.id)).toBeUndefined()
    expect(getDb().prepare('SELECT id FROM chat_messages WHERE conversation_id = ?').get(successor.id)).toBeUndefined()
    expect(getMigration('legacy-successor')).toMatchObject({ phase: 'rolled-back', status: 'rolled-back' })

    // Cleanup must remain idempotent after restarting from a terminal checkpoint.
    restartDb()
    expect(getConversation(successor.id)).toBeUndefined()
    expect(getMigration('legacy-successor')).toMatchObject({ phase: 'rolled-back', status: 'rolled-back' })
  })

  it('releases legacy successor guards when the journal becomes terminal', () => {
    const successor = makeConversation(source.workspaceId, { id: 'terminal-successor', cwd: '/old-worktree' })
    const migration = record()
    migration.id = 'terminal-legacy'
    migration.legacySuccessorConversationId = successor.id
    migration.phase = 'rolled-back'
    migration.status = 'rolled-back'
    insertMigration(migration)

    expect(incompleteMigrationForConversation(successor.id)).toBeUndefined()
    expect(findIncompleteMigrationForScope(successor.id, '/unrelated-cwd')).toBeUndefined()
    expect(() => assertConversationMigrationMutationAllowed(successor.id, 'Archive conversation')).not.toThrow()
    expect(() => deleteConversation(successor.id)).not.toThrow()
    expect(getConversation(successor.id)).toBeUndefined()
  })

  it('commits the same conversation location when entering finalization', () => {
    insertMigration(record())
    expect(
      commitConversationLocation('migration', 'prepared', {
        conversationId: source.id,
        branch: 'feature/migrate',
        cwd: '/worktree',
      })
    ).toBe(true)
    expect(getConversation(source.id)).toMatchObject({
      id: source.id,
      branch: 'feature/migrate',
      cwd: '/worktree',
      mode: 'worktree',
    })
    expect(getMigration('migration')).toMatchObject({
      conversationId: source.id,
      phase: 'finalizing',
      status: 'running',
    })
  })

  it('blocks deletion during the saga and restores the same identity on rollback', () => {
    const migration = record()
    migration.phase = 'finalizing'
    migration.status = 'running'
    insertMigration(migration)
    getDb()
      .prepare("UPDATE conversations SET branch = ?, mode = 'worktree', cwd = ? WHERE id = ?")
      .run(migration.destinationBranch, migration.destinationCwd, source.id)
    expect(incompleteMigrationForConversation(source.id)?.id).toBe(migration.id)
    expect(() => deleteConversation(source.id)).toThrow('conversation has an incomplete migration')
    expect(advanceMigration(migration.id, 'finalizing', { phase: 'rolling-back', status: 'running' })).toBe(true)
    expect(rollbackMigrationIdentity(migration.id)).toBe(true)
    expect(getConversation(source.id)).toMatchObject({ id: source.id, branch: 'main', mode: 'local', cwd: '/repo' })
    expect(getMigration(migration.id)).toMatchObject({ phase: 'rolled-back', status: 'rolled-back' })
  })
})
