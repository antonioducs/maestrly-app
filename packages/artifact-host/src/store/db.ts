import { randomBytes } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS host_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('local', 'device', 'bot')),
  owner_id TEXT NOT NULL,
  workspace_id TEXT,
  conversation_id TEXT,
  conversation_title TEXT,
  current_version INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'people', 'link')),
  link_expires_at INTEGER,
  access_code_hash TEXT,
  comments_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_workspace ON artifacts (workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS artifacts_conversation ON artifacts (conversation_id, updated_at);
CREATE TABLE IF NOT EXISTS versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  entry TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'owner')),
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, number)
);
CREATE TABLE IF NOT EXISTS version_files (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version, path),
  FOREIGN KEY (artifact_id, version) REFERENCES versions(artifact_id, number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS version_files_blob ON version_files (sha256);
CREATE TABLE IF NOT EXISTS thumbnails (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, version),
  FOREIGN KEY (artifact_id, version) REFERENCES versions(artifact_id, number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS thumbnails_blob ON thumbnails (sha256);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  principal_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  device_label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_artifact ON sessions (artifact_id);
CREATE INDEX IF NOT EXISTS sessions_principal ON sessions (principal_id);
CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invited', 'approved', 'guest')),
  name TEXT NOT NULL DEFAULT '',
  invite_token_hash TEXT UNIQUE,
  invite_expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS principals_artifact ON principals (artifact_id);
CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  browser_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  principal_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS access_requests_artifact ON access_requests (artifact_id, status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('device_added', 'access_requested', 'invite_declined', 'comment_added')),
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS events_unseen ON events (artifact_id, seen_at);
CREATE TABLE IF NOT EXISTS owner_tickets (
  token_hash TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);`

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Opens (or creates) a host database with WAL, foreign keys and the idempotent schema. */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  try {
    if (process.platform !== 'win32') chmodSync(file, 0o600)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    transaction(db, () => {
      db.exec(SCHEMA)
      const insert = db.prepare('INSERT OR IGNORE INTO host_meta (key, value) VALUES (?, ?)')
      insert.run('schema_version', '1')
      insert.run('capability_key', randomBytes(32).toString('base64'))
    })
  } catch (error) {
    db.close()
    throw error
  }
  return db
}
