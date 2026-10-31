import type { DatabaseSync } from 'node:sqlite'

/**
 * One row per snapshotted turn. The row belongs to the turn's user message, so editing, clearing or deleting the
 * conversation removes it with the messages; its trees live in the shadow stores until collection drops them.
 */
export function initializeTurnSnapshotSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_turn_snapshots (
      id                   TEXT PRIMARY KEY,
      conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_message_id      TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      assistant_message_id TEXT,
      status               TEXT NOT NULL,
      unavailable_reason   TEXT,
      roots_json           TEXT NOT NULL,
      summary_json         TEXT,
      overlap_json         TEXT,
      revert_json          TEXT,
      started_at           INTEGER NOT NULL,
      ended_at             INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chat_turn_snapshots_conversation
      ON chat_turn_snapshots(conversation_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_chat_turn_snapshots_started ON chat_turn_snapshots(started_at);
    CREATE INDEX IF NOT EXISTS idx_chat_turn_snapshots_user_message ON chat_turn_snapshots(user_message_id);
  `)
}
