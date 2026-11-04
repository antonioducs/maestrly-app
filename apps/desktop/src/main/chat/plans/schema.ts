import type { DatabaseSync } from 'node:sqlite'

/**
 * Plans proposed with `review_plan` and the person's decision on each. Compaction refers to them instead of carrying
 * their text in every summary, and `plan_read` returns one in full. The transcript remains the source a conversation
 * rebuilds them from (older conversations, moved conversations); rows follow the conversation's deletion.
 */
export function initializePlanSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_plans (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      version         INTEGER NOT NULL,
      title           TEXT,
      content         TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      status          TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      decided_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chat_plans_conversation ON chat_plans(conversation_id, created_at);
  `)
}
