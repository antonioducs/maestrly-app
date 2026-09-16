import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export const HOST_DB_VERSION = 6
/**
 * Schema 1 → 2 adds the Bot domain next to the phase-one VM catalogue. The migration is
 * one transaction; hostId, VMs, operations and events are untouched. A binary rolled
 * back to schema 1 refuses to open a schema 2 database (checked by HostStore).
 */
export function migrateToV2(db: DatabaseSync) {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version >= 2) return
  if (version !== 1) throw new Error('Bot migration requires host schema version 1')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE bots(id TEXT PRIMARY KEY, vm_id TEXT, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX bots_active_vm ON bots(vm_id) WHERE vm_id IS NOT NULL AND status != 'archived';
      CREATE TABLE bot_bindings(bot_id TEXT PRIMARY KEY REFERENCES bots(id), vm_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE bot_conversations(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), body TEXT NOT NULL);
      CREATE TABLE bot_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES bot_conversations(id), client_message_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(conversation_id, client_message_id), UNIQUE(conversation_id, sequence));
      CREATE TABLE bot_turns(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), conversation_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX bot_turns_active ON bot_turns(bot_id) WHERE status IN ('queued','starting','running','waiting_approval','waiting_input','cancelling','needs_attention');
      CREATE TABLE bot_interactions(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), turn_id TEXT NOT NULL, action_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(turn_id, action_id));
      CREATE TABLE bot_memory(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), body TEXT NOT NULL);
      CREATE TABLE bot_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, runtime_event_id TEXT, body TEXT NOT NULL);
      CREATE UNIQUE INDEX bot_events_runtime ON bot_events(bot_id, runtime_event_id) WHERE runtime_event_id IS NOT NULL;
      CREATE TABLE bot_outbox(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE bot_transfers(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE bot_operations(id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE bot_network(bot_id TEXT PRIMARY KEY REFERENCES bots(id), body TEXT NOT NULL);
      CREATE TABLE bot_previews(id TEXT PRIMARY KEY, expires_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE bot_reservations(key TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id));
      PRAGMA user_version=2;
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Existing rows are never rewritten. Ambiguous legacy ownership blocks adoption. */
export function migrateToV3(db: DatabaseSync) {
  const version = db.prepare('PRAGMA user_version').get()!.user_version as number
  if (version >= 3) return
  if (version !== 2) throw new Error('Session migration requires host schema version 2')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE bot_sessions(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL UNIQUE REFERENCES bots(id), vm_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX bot_sessions_vm ON bot_sessions(vm_id);
      CREATE TABLE bot_vm_sessions(vm_id TEXT PRIMARY KEY, body TEXT NOT NULL);`)
    const rows = db.prepare('SELECT id,vm_id,status FROM bots WHERE vm_id IS NOT NULL').all()
    const owners = new Map<string, number>()
    for (const row of rows) owners.set(String(row.vm_id), (owners.get(String(row.vm_id)) ?? 0) + 1)
    // Count bindings whose historical owner no longer names that VM as well.
    for (const row of db.prepare('SELECT bot_id,vm_id FROM bot_bindings').all()) {
      if (!rows.some(b => b.id === row.bot_id && b.vm_id === row.vm_id))
        owners.set(String(row.vm_id), (owners.get(String(row.vm_id)) ?? 0) + 1)
    }
    const time = new Date().toISOString()
    for (const row of rows) {
      const conflict = owners.get(String(row.vm_id))! > 1
      const session = { id: randomUUID(), botId: row.id, vmId: row.vm_id,
        state: conflict ? 'needs_attention' : row.status === 'archived' ? 'archived' : 'stopped',
        transport: 'legacy', generation: 0, revision: 0, createdAt: time, updatedAt: time,
        ...(conflict ? { issue: 'LEGACY_BINDING_CONFLICT' } : {}),
      }
      db.prepare('INSERT INTO bot_sessions(id,bot_id,vm_id,body) VALUES(?,?,?,?)').run(session.id, String(row.id), String(row.vm_id), JSON.stringify(session))
    }
    db.exec('DROP INDEX bots_active_vm; CREATE INDEX bots_vm ON bots(vm_id); PRAGMA user_version=3; COMMIT;')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/** Account records contain only public metadata. Private credentials are outside SQLite. */
export function migrateToV4(db: DatabaseSync) {
  const version = db.prepare('PRAGMA user_version').get()!.user_version as number
  if (version >= 4) return
  if (version !== 3) throw new Error('Account migration requires host schema version 3')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE shared_accounts(id TEXT PRIMARY KEY, body TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE account_operations(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES shared_accounts(id), source_bot_id TEXT, phase TEXT NOT NULL, body TEXT NOT NULL DEFAULT '{}');
      CREATE UNIQUE INDEX account_migration_source ON account_operations(source_bot_id) WHERE source_bot_id IS NOT NULL;
      CREATE TABLE account_grants(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES shared_accounts(id), peer_host_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE account_links(account_id TEXT PRIMARY KEY REFERENCES shared_accounts(id), body TEXT NOT NULL);
      CREATE TABLE account_leases(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES shared_accounts(id), peer_host_id TEXT NOT NULL, expires_at INTEGER NOT NULL, body TEXT NOT NULL);
      ALTER TABLE bot_vm_sessions ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE environment_operations(id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE environment_vms(vm_id TEXT PRIMARY KEY, state TEXT NOT NULL, operation_id TEXT NOT NULL);
      PRAGMA user_version=4;`)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/**
 * Schema 4 → 5 adds live-desktop control: one durable control record per session and
 * idempotent handoff operations. Nothing existing is rewritten. Tokens, pixels and
 * input never enter the database; continuation turns are unique per return operation
 * and per interrupted turn.
 */
export function migrateToV5(db: DatabaseSync) {
  const version = db.prepare('PRAGMA user_version').get()!.user_version as number
  if (version >= 5) return
  if (version !== 4) throw new Error('Desktop migration requires host schema version 4')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE bot_desktop_control(session_id TEXT PRIMARY KEY REFERENCES bot_sessions(id), bot_id TEXT NOT NULL UNIQUE REFERENCES bots(id), mode TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE bot_desktop_operations(id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES bot_sessions(id), kind TEXT NOT NULL, resume_of_turn_id TEXT, continuation_turn_id TEXT UNIQUE, body TEXT NOT NULL);
      CREATE UNIQUE INDEX bot_desktop_one_continuation ON bot_desktop_operations(resume_of_turn_id) WHERE continuation_turn_id IS NOT NULL;
      PRAGMA user_version=5;`)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
