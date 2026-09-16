import type { DatabaseSync } from 'node:sqlite'

/**
 * Schema 5 → 6 adds the teams domain beside bots, sessions, accounts and desktop control.
 * The migration is one transaction and rewrites nothing that already exists: bots, their
 * conversations, turns, memory, files, sessions and VMs are untouched, so a Host that never
 * creates a team behaves exactly as before. A binary that only knows schema 5 keeps
 * refusing to open a schema 6 database (checked by HostStore), which is why the store
 * takes a consistent backup before calling this.
 *
 * Uniqueness is where the safety lives: one membership per bot per team, one message per
 * client key, one attempt row per physical turn, one task per (run, round, localKey) and
 * one idempotency record per method key. Nothing here starts a subprocess or does
 * asynchronous I/O inside the transaction.
 */
export function migrateToV6(db: DatabaseSync) {
  const version = db.prepare('PRAGMA user_version').get()!.user_version as number
  if (version >= 6) return
  if (version !== 5) throw new Error('Team migration requires host schema version 5')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE teams(id TEXT PRIMARY KEY, host_id TEXT NOT NULL, status TEXT NOT NULL, coordinator_bot_id TEXT NOT NULL REFERENCES bots(id), conversation_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE team_members(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), bot_id TEXT NOT NULL REFERENCES bots(id), body TEXT NOT NULL, UNIQUE(team_id, bot_id));
      CREATE INDEX team_members_bot ON team_members(bot_id);
      CREATE TABLE team_conversations(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), body TEXT NOT NULL);
      CREATE TABLE team_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES team_conversations(id), client_message_id TEXT NOT NULL, sequence INTEGER NOT NULL, run_id TEXT, body TEXT NOT NULL, UNIQUE(conversation_id, client_message_id), UNIQUE(conversation_id, sequence));
      CREATE TABLE team_runs(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), conversation_id TEXT NOT NULL REFERENCES team_conversations(id), message_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX team_runs_active ON team_runs(conversation_id) WHERE status IN ('queued','planning','working','reviewing','waiting_user','paused','needs_attention','cancelling');
      CREATE TABLE team_tasks(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES team_runs(id), team_id TEXT NOT NULL REFERENCES teams(id), round INTEGER NOT NULL, local_task_key TEXT NOT NULL, assignee_bot_id TEXT NOT NULL REFERENCES bots(id), status TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(run_id, round, local_task_key));
      CREATE INDEX team_tasks_status ON team_tasks(status);
      CREATE TABLE team_task_dependencies(task_id TEXT NOT NULL REFERENCES team_tasks(id), depends_on_task_id TEXT NOT NULL REFERENCES team_tasks(id), PRIMARY KEY(task_id, depends_on_task_id));
      CREATE TABLE team_task_turns(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES team_tasks(id), run_id TEXT NOT NULL REFERENCES team_runs(id), turn_id TEXT NOT NULL UNIQUE REFERENCES bot_turns(id), bot_id TEXT NOT NULL REFERENCES bots(id), settled INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL);
      CREATE INDEX team_task_turns_task ON team_task_turns(task_id);
      CREATE TABLE team_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL, run_id TEXT, body TEXT NOT NULL);
      CREATE INDEX team_events_team ON team_events(team_id, seq);
      CREATE TABLE team_requests(id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, request_id TEXT NOT NULL, method TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(turn_id, request_id));
      CREATE TABLE team_memory(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE team_artifacts(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), state TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX team_artifacts_team ON team_artifacts(team_id, state);
      CREATE TABLE team_artifact_grants(id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES team_artifacts(id), team_id TEXT NOT NULL REFERENCES teams(id), bot_id TEXT NOT NULL REFERENCES bots(id), run_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(artifact_id, bot_id, run_id));
      CREATE TABLE team_transfers(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), body TEXT NOT NULL);
      CREATE TABLE team_operations(id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, team_id TEXT, run_id TEXT, request TEXT NOT NULL, body TEXT NOT NULL);
      PRAGMA user_version=6;
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
