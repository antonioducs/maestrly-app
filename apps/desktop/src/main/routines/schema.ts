import type { DatabaseSync } from 'node:sqlite'

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (item) => item.name === column
  )
}

export function initializeRoutineSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_routines (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      instruction TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      paused_at INTEGER,
      perm_mode TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      notify TEXT NOT NULL,
      missed TEXT NOT NULL,
      retention_days INTEGER,
      origin_conversation_id TEXT,
      origin_title TEXT,
      origin_via TEXT,
      folder TEXT NOT NULL,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_routine_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES local_routines(id) ON DELETE CASCADE,
      scheduled_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      report_json TEXT,
      error TEXT,
      conversation_id TEXT,
      conversation_deleted INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      unread INTEGER NOT NULL DEFAULT 0,
      waiting_kind TEXT,
      waiting_prompt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_local_routine_runs_routine_sched
      ON local_routine_runs(routine_id, scheduled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_local_routine_runs_conversation
      ON local_routine_runs(conversation_id);

    CREATE TABLE IF NOT EXISTS local_routine_proposals (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      draft_json TEXT NOT NULL,
      state TEXT NOT NULL,
      routine_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_routine_proposals_conv
      ON local_routine_proposals(conversation_id, created_at);
  `)

  if (!tableHasColumn(db, 'local_routine_runs', 'waiting_kind')) {
    db.exec('ALTER TABLE local_routine_runs ADD COLUMN waiting_kind TEXT;')
  }
  if (!tableHasColumn(db, 'local_routine_runs', 'waiting_prompt')) {
    db.exec('ALTER TABLE local_routine_runs ADD COLUMN waiting_prompt TEXT;')
  }
  if (!tableHasColumn(db, 'conversations', 'routine_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN routine_id TEXT;')
  }
  if (!tableHasColumn(db, 'conversations', 'routine_run_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN routine_run_id TEXT;')
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_conversations_routine ON conversations(routine_id) WHERE routine_id IS NOT NULL;'
  )
}
