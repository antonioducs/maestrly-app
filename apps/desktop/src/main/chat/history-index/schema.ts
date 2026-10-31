import type { DatabaseSync } from 'node:sqlite'

/**
 * Change capture for the conversation-history search index. Triggers record which messages changed, through every
 * write path (upserts, part updates, moves, imports, truncation and cascades); the index itself lives in a separate,
 * rebuildable file. Plain SQL with no FTS in the main database, so older app versions keep writing safely: the queue
 * only grows until a version with the indexer drains it.
 */
export function initializeHistoryIndexQueue(db: DatabaseSync): void {
  const enqueue = (row: 'NEW' | 'OLD') => `
      INSERT INTO chat_history_index_queue (message_id, conversation_id, queued_at)
      VALUES (${row}.id, ${row}.conversation_id, CAST(unixepoch('subsec') * 1000 AS INTEGER))
      ON CONFLICT(message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        queued_at = excluded.queued_at;`
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_history_index_queue (
      message_id      TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      queued_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_history_index_queue_conv
      ON chat_history_index_queue(conversation_id, queued_at);
    CREATE INDEX IF NOT EXISTS idx_chat_history_index_queue_time
      ON chat_history_index_queue(queued_at);

    CREATE TRIGGER IF NOT EXISTS trg_chat_history_index_after_insert
    AFTER INSERT ON chat_messages
    FOR EACH ROW
    BEGIN${enqueue('NEW')}
    END;

    -- Streaming checkpoints rewrite the same parts; an unchanged upsert queues nothing.
    CREATE TRIGGER IF NOT EXISTS trg_chat_history_index_after_update
    AFTER UPDATE OF parts_json, meta_json, conversation_id ON chat_messages
    FOR EACH ROW
    WHEN OLD.parts_json IS NOT NEW.parts_json
      OR OLD.meta_json IS NOT NEW.meta_json
      OR OLD.conversation_id IS NOT NEW.conversation_id
    BEGIN${enqueue('NEW')}
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_history_index_after_delete
    AFTER DELETE ON chat_messages
    FOR EACH ROW
    BEGIN${enqueue('OLD')}
    END;
  `)
}
