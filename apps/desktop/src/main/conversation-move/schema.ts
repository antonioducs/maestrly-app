import type { DatabaseSync } from 'node:sqlite'

/**
 * Journals of conversation moves. `conversation_moves` is the coordinator's (this computer's) record of each move;
 * `conversation_move_endpoints` is what one host did as its source or target. Neither references `conversations`:
 * the coordinator's conversation may live on another host, and an endpoint's journal outlives the conversation it
 * released.
 */
export function initializeConversationMoveSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_moves (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, conversation_name TEXT NOT NULL,
      source_host_id TEXT NOT NULL, target_host_id TEXT NOT NULL,
      phase TEXT NOT NULL, status TEXT NOT NULL,
      preview_json TEXT NOT NULL, selection_json TEXT NOT NULL DEFAULT '{}', state_json TEXT NOT NULL DEFAULT '{}',
      error TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversation_moves_conversation ON conversation_moves(conversation_id, status);
    CREATE TABLE IF NOT EXISTS conversation_move_endpoints (
      operation_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('source','target')),
      conversation_id TEXT NOT NULL, state TEXT NOT NULL, cwd TEXT,
      data_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (operation_id, role)
    );
    CREATE INDEX IF NOT EXISTS conversation_move_endpoints_conversation
      ON conversation_move_endpoints(conversation_id, state);
  `)
}
