import type { DatabaseSync } from 'node:sqlite'

/**
 * Local memories belong to a memory space: a workspace id, or a host-defined space such as a bot's own memory. The
 * table therefore has no foreign key to `workspaces`; a trigger keeps the cascade for workspace spaces.
 */
export function localMemoriesTableSql(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
      id                     TEXT PRIMARY KEY,
      workspace_id           TEXT NOT NULL,
      title                  TEXT NOT NULL,
      content                TEXT NOT NULL,
      type                   TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'active',
      scope                  TEXT NOT NULL DEFAULT '',
      tags_json              TEXT NOT NULL DEFAULT '[]',
      importance             INTEGER NOT NULL DEFAULT 0,
      pinned                 INTEGER NOT NULL DEFAULT 0,
      source                 TEXT NOT NULL,
      origin_conversation_id TEXT,
      origin_message_id      TEXT,
      supersedes_id          TEXT REFERENCES local_memories(id) ON DELETE SET NULL,
      promoted_path          TEXT,
      content_hash           TEXT NOT NULL,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      last_used_at           INTEGER,
      use_count              INTEGER NOT NULL DEFAULT 0
    )`
}

export const LOCAL_MEMORY_WORKSPACE_CLEANUP_TRIGGER = `CREATE TRIGGER IF NOT EXISTS local_memories_workspace_cleanup
  AFTER DELETE ON workspaces BEGIN DELETE FROM local_memories WHERE workspace_id = OLD.id; END`

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`
const foreignKeysOn = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys

/** Run after the schema transaction commits and outside any transaction: foreign keys must be switchable. */
export function migrateLocalMemorySpaces(db: DatabaseSync): void {
  try {
    migrate(db)
  } finally {
    restoreForeignKeys(db)
  }
}

function restoreForeignKeys(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON')
  if (foreignKeysOn(db) !== 1)
    throw new Error('Local memory space migration could not restore foreign key enforcement; close the connection.')
}

function migrate(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_memories'").get()) return
  const keys = db.prepare('PRAGMA foreign_key_list(local_memories)').all() as Array<{ table: string; from: string }>
  if (!keys.some((key) => key.table === 'workspaces' && key.from === 'workspace_id')) {
    db.exec(LOCAL_MEMORY_WORKSPACE_CLEANUP_TRIGGER)
    return
  }
  const columns = (db.prepare('PRAGMA table_info(local_memories)').all() as Array<{ name: string }>).map(
    (column) => column.name
  )
  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='local_memories' AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>
  const dependents = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger','view') AND sql LIKE '%local_memories%'"
    )
    .all() as Array<{ type: string; name: string; sql: string }>
  db.exec('PRAGMA foreign_keys = OFF')
  if (foreignKeysOn(db) !== 0) throw new Error('Local memory space migration requires no active transaction.')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const object of dependents) db.exec(`DROP ${object.type} ${quote(object.name)}`)
    db.exec(localMemoriesTableSql('local_memories_space_new'))
    const names = columns.map(quote).join(',')
    db.exec(`INSERT INTO local_memories_space_new (${names}) SELECT ${names} FROM local_memories`)
    db.exec('DROP TABLE local_memories')
    db.exec('ALTER TABLE local_memories_space_new RENAME TO local_memories')
    for (const index of indexes) db.exec(index.sql)
    for (const object of dependents) db.exec(object.sql)
    db.exec(LOCAL_MEMORY_WORKSPACE_CLEANUP_TRIGGER)
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Local memory space migration foreign key check failed.')
    const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
      throw new Error('Local memory space migration integrity check failed.')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
