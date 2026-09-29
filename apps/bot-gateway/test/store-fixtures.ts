import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The schema a version 5 gateway left in `gateway.sqlite`, statement by statement as its `sqlite_master` records it,
 * so migration tests start from a real older database instead of downgrading a current one.
 */
export const SCHEMA_5 = [
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT)',
  'CREATE TABLE pairing_codes (code_sha256 TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT, attempts INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL, tint TEXT NOT NULL, ceiling TEXT NOT NULL, selection_json TEXT, talks_to_json TEXT NOT NULL, paused INTEGER NOT NULL, lifecycle TEXT NOT NULL, setup_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, compaction_json TEXT)',
  'CREATE TABLE bot_secrets (bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, control_token TEXT NOT NULL, gateway_token TEXT NOT NULL, gateway_token_sha256 TEXT NOT NULL UNIQUE, keyring_password TEXT NOT NULL)',
  "CREATE TABLE routines (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), title TEXT NOT NULL, prompt TEXT NOT NULL, schedule_json TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at TEXT, last_run_at TEXT, last_outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT 'owner', last_input_id TEXT)",
  'CREATE TABLE activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, bot_id TEXT REFERENCES bots(id), kind TEXT NOT NULL, summary TEXT, data_json TEXT NOT NULL)',
  'CREATE TABLE peer_messages (id TEXT PRIMARY KEY, at TEXT NOT NULL, from_bot TEXT NOT NULL, to_bot TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL)',
  'CREATE TABLE pending_deliveries (message_id TEXT PRIMARY KEY REFERENCES peer_messages(id), to_bot TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE TABLE owner_messages (bot_id TEXT PRIMARY KEY, at TEXT NOT NULL)',
  'CREATE TABLE pair_blocks (pair_key TEXT PRIMARY KEY, blocked_until TEXT NOT NULL)',
  'CREATE TABLE idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, status INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,key))',
  'CREATE INDEX idx_activity_seq ON activity(seq)',
  'CREATE INDEX idx_idempotency_created ON idempotency(created_at)',
  'CREATE TABLE owner_memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL, author_kind TEXT NOT NULL, author_bot_id TEXT, author_name TEXT, origin TEXT, replaces_id TEXT, replaced_by_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE INDEX idx_owner_memories_status ON owner_memories(status, created_at)',
  'CREATE TABLE routine_runs (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, bot_id TEXT NOT NULL, input_id TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, delivered_at TEXT NOT NULL, finished_at TEXT, report_json TEXT, final_text TEXT)',
  'CREATE INDEX idx_routine_runs_routine ON routine_runs(routine_id, delivered_at DESC)',
  'CREATE INDEX idx_routine_runs_input ON routine_runs(bot_id, input_id)',
]

/** Creates `gateway.sqlite` in `dir` with empty tables, exactly as a version 5 gateway left it, and returns it open. */
export function createSchema5Database(dir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(dir, 'gateway.sqlite'))
  db.exec('PRAGMA journal_mode=WAL')
  for (const statement of SCHEMA_5) db.exec(statement)
  db.exec("INSERT INTO meta(key,value) VALUES('schema_version','5'),('owner_memory_revision','0')")
  return db
}

/** The schema a version 6 gateway left in `gateway.sqlite`, statement by statement as its `sqlite_master` records it. */
export const SCHEMA_6 = [
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT)',
  'CREATE TABLE pairing_codes (code_sha256 TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT, attempts INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE bot_secrets (bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, gateway_token TEXT NOT NULL, gateway_token_sha256 TEXT NOT NULL UNIQUE)',
  "CREATE TABLE routines (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), title TEXT NOT NULL, prompt TEXT NOT NULL, schedule_json TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at TEXT, last_run_at TEXT, last_outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT 'owner', last_input_id TEXT)",
  'CREATE TABLE activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, bot_id TEXT REFERENCES bots(id), kind TEXT NOT NULL, summary TEXT, data_json TEXT NOT NULL, environment_id TEXT)',
  'CREATE TABLE peer_messages (id TEXT PRIMARY KEY, at TEXT NOT NULL, from_bot TEXT NOT NULL, to_bot TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL)',
  'CREATE TABLE pending_deliveries (message_id TEXT PRIMARY KEY REFERENCES peer_messages(id), to_bot TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE TABLE owner_messages (bot_id TEXT PRIMARY KEY, at TEXT NOT NULL)',
  'CREATE TABLE pair_blocks (pair_key TEXT PRIMARY KEY, blocked_until TEXT NOT NULL)',
  'CREATE TABLE idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, status INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,key))',
  'CREATE INDEX idx_activity_seq ON activity(seq)',
  'CREATE INDEX idx_idempotency_created ON idempotency(created_at)',
  'CREATE TABLE owner_memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL, author_kind TEXT NOT NULL, author_bot_id TEXT, author_name TEXT, origin TEXT, replaces_id TEXT, replaced_by_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE)',
  'CREATE INDEX idx_owner_memories_status ON owner_memories(status, created_at)',
  'CREATE TABLE routine_runs (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, bot_id TEXT NOT NULL, input_id TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, delivered_at TEXT NOT NULL, finished_at TEXT, report_json TEXT, final_text TEXT)',
  'CREATE INDEX idx_routine_runs_routine ON routine_runs(routine_id, delivered_at DESC)',
  'CREATE INDEX idx_routine_runs_input ON routine_runs(bot_id, input_id)',
  "CREATE TABLE environments (id TEXT PRIMARY KEY, name TEXT NOT NULL, lifecycle TEXT NOT NULL, setup_json TEXT NOT NULL, container_name TEXT NOT NULL UNIQUE, volume_name TEXT NOT NULL UNIQUE, memory_limit_bytes INTEGER CHECK (memory_limit_bytes IS NULL OR (typeof(memory_limit_bytes) = 'integer' AND memory_limit_bytes > 0)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, CHECK ((lifecycle = 'archived') = (archived_at IS NOT NULL)))",
  'CREATE TABLE environment_secrets (environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE, control_token TEXT NOT NULL, keyring_password TEXT NOT NULL)',
  'CREATE TABLE "bots" (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL, tint TEXT NOT NULL, ceiling TEXT NOT NULL, selection_json TEXT, talks_to_json TEXT NOT NULL, paused INTEGER NOT NULL, lifecycle TEXT NOT NULL, setup_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, compaction_json TEXT, environment_id TEXT NOT NULL REFERENCES environments(id), slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 8), archived_with_environment INTEGER NOT NULL DEFAULT 0 CHECK (archived_with_environment IN (0, 1)), CHECK ((lifecycle = \'archived\') = (archived_at IS NOT NULL)), CHECK (archived_with_environment = 0 OR archived_at IS NOT NULL))',
  'CREATE INDEX idx_bots_environment ON bots(environment_id)',
  'CREATE UNIQUE INDEX idx_bots_environment_slot ON bots(environment_id, slot) WHERE archived_at IS NULL',
  'CREATE INDEX idx_owner_memories_environment ON owner_memories(environment_id)',
  'CREATE INDEX idx_activity_environment ON activity(environment_id)',
]

/** Creates `gateway.sqlite` in `dir` with empty tables, exactly as a version 6 gateway left it, and returns it open. */
export function createSchema6Database(dir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(dir, 'gateway.sqlite'))
  db.exec('PRAGMA journal_mode=WAL')
  for (const statement of SCHEMA_6) db.exec(statement)
  db.exec("INSERT INTO meta(key,value) VALUES('schema_version','6'),('owner_memory_revision','0')")
  return db
}

/**
 * Creates `gateway.sqlite` in `dir` exactly as a version 7 gateway left it: schema 6 plus the column its migration added
 * to environments, and returns it open.
 */
export function createSchema7Database(dir: string): DatabaseSync {
  const db = createSchema6Database(dir)
  db.exec('ALTER TABLE environments ADD COLUMN compaction_json TEXT')
  db.exec("UPDATE meta SET value='7' WHERE key='schema_version'")
  return db
}

/** Every row of every table, for checking that a failed or repeated migration left a database as it was. */
export function dumpTables(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  return Object.fromEntries(
    tables.map(({ name }) => [String(name), db.prepare(`SELECT * FROM "${String(name)}" ORDER BY rowid`).all()])
  )
}
