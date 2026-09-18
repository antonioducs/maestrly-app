import type { DatabaseSync } from 'node:sqlite'

/**
 * Schema 6 → 7 adds the routines and voice domains beside bots, sessions, accounts, desktop
 * control and teams. The migration is one transaction and rewrites nothing that already
 * exists: no bot, conversation, turn, memory, file, session, VM, team, run or task row is
 * touched, so a Host that never creates a routine and never records audio behaves exactly as
 * before. A binary that only knows schema 6 keeps refusing to open a schema 7 database
 * (checked by HostStore), which is why the store takes a consistent backup before this runs.
 *
 * Uniqueness is where the safety lives:
 *  - one occurrence per (routine, nominal instant), so a restart between materialising and
 *    dispatching cannot produce a second firing for the same moment;
 *  - at most one occurrence holding a routine's slot at a time, so a routine never overlaps
 *    itself while the previous run is still pending or active;
 *  - one execution row per physical turn or run, with a CHECK that exactly one of them is
 *    present — a routine execution is either a bot turn or a team run, never both;
 *  - one audio link per clip and per message, so removing a recording can never orphan or
 *    duplicate the text a person actually sent.
 *
 * Audio bytes never live in SQLite: clips are files under the Host state directory, named by
 * generated identity and referenced here by size and digest only.
 */
export function migrateToV7(db: DatabaseSync) {
  const version = db.prepare('PRAGMA user_version').get()!.user_version as number
  if (version >= 7) return
  if (version !== 6) throw new Error('Routine and voice migration requires host schema version 6')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE routines(
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('bot','team')),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','paused','archived')),
        fingerprint TEXT NOT NULL,
        next_due_utc TEXT,
        watermark_utc TEXT NOT NULL,
        body TEXT NOT NULL);
      CREATE INDEX routines_due ON routines(status, next_due_utc);
      CREATE INDEX routines_target ON routines(target_kind, target_id);

      CREATE TABLE routine_occurrences(
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL REFERENCES routines(id),
        origin TEXT NOT NULL CHECK(origin IN ('schedule','manual')),
        scheduled_for_utc TEXT NOT NULL,
        status TEXT NOT NULL,
        manual_key TEXT,
        body TEXT NOT NULL);
      -- One nominal instant fires once, whatever happens to the routine's revisions.
      CREATE UNIQUE INDEX routine_occurrences_slot ON routine_occurrences(routine_id, scheduled_for_utc) WHERE origin='schedule';
      -- "Run now" has its own stable key so a repeated click returns the same receipt.
      CREATE UNIQUE INDEX routine_occurrences_manual ON routine_occurrences(manual_key) WHERE manual_key IS NOT NULL;
      CREATE UNIQUE INDEX routine_occurrences_active ON routine_occurrences(routine_id)
        WHERE status IN ('pending','waiting_resource','running','waiting_user','needs_attention');
      CREATE INDEX routine_occurrences_history ON routine_occurrences(routine_id, scheduled_for_utc);

      CREATE TABLE routine_executions(
        id TEXT PRIMARY KEY,
        occurrence_id TEXT NOT NULL REFERENCES routine_occurrences(id),
        routine_id TEXT NOT NULL REFERENCES routines(id),
        turn_id TEXT UNIQUE REFERENCES bot_turns(id),
        team_run_id TEXT UNIQUE REFERENCES team_runs(id),
        continuation_of TEXT,
        settled INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL,
        CHECK((turn_id IS NULL) <> (team_run_id IS NULL)));
      CREATE INDEX routine_executions_occurrence ON routine_executions(occurrence_id);

      CREATE TABLE routine_proposals(
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('bot','team')),
        target_id TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES bots(id),
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','activated','dismissed','expired')),
        expires_at TEXT NOT NULL,
        body TEXT NOT NULL);
      CREATE INDEX routine_proposals_target ON routine_proposals(target_kind, target_id, status);
      CREATE INDEX routine_proposals_turn ON routine_proposals(turn_id);

      CREATE TABLE routine_operations(
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        routine_id TEXT,
        occurrence_id TEXT,
        request TEXT NOT NULL,
        body TEXT NOT NULL);

      -- Moving 24 h window, kept as one row per routine instead of one row per second.
      CREATE TABLE routine_usage(
        routine_id TEXT PRIMARY KEY REFERENCES routines(id),
        window_start TEXT NOT NULL,
        admissions INTEGER NOT NULL DEFAULT 0,
        active_ms INTEGER NOT NULL DEFAULT 0,
        actions INTEGER NOT NULL DEFAULT 0);

      CREATE TABLE routine_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        routine_id TEXT,
        occurrence_id TEXT,
        body TEXT NOT NULL);
      CREATE INDEX routine_events_routine ON routine_events(routine_id, seq);

      CREATE TABLE voice_clips(
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('bot','team')),
        target_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('uploading','stored','expired','removed')),
        bytes INTEGER NOT NULL,
        digest TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        body TEXT NOT NULL);
      CREATE INDEX voice_clips_target ON voice_clips(target_kind, target_id, state);
      CREATE INDEX voice_clips_expiry ON voice_clips(state, expires_at);

      CREATE TABLE voice_uploads(
        id TEXT PRIMARY KEY,
        clip_id TEXT NOT NULL REFERENCES voice_clips(id),
        client_clip_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        body TEXT NOT NULL,
        UNIQUE(target_kind, target_id, client_clip_id));

      CREATE TABLE voice_jobs(
        id TEXT PRIMARY KEY,
        clip_id TEXT NOT NULL REFERENCES voice_clips(id),
        state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
        generation INTEGER NOT NULL,
        body TEXT NOT NULL);
      CREATE INDEX voice_jobs_clip ON voice_jobs(clip_id);
      CREATE INDEX voice_jobs_state ON voice_jobs(state);

      -- Sidecar only: the message itself stays in its own domain and survives audio removal.
      CREATE TABLE voice_message_links(
        message_id TEXT PRIMARY KEY,
        clip_id TEXT NOT NULL UNIQUE REFERENCES voice_clips(id),
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        body TEXT NOT NULL);
      CREATE INDEX voice_message_links_target ON voice_message_links(target_kind, target_id);

      CREATE TABLE voice_operations(
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        clip_id TEXT,
        message_id TEXT,
        request TEXT NOT NULL,
        body TEXT NOT NULL);
      PRAGMA user_version=7;
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
