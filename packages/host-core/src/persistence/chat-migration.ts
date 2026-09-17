import type { DatabaseSync } from 'node:sqlite'

/**
 * Schema 7 → 8 adds what the chat experience needs beside bots, teams, routines and voice:
 * stored prompt templates, per-bot extensions (MCP servers and skills), a usage ledger with
 * one row per finished turn, and a `turn_id` column on events so a turn's transcript can be
 * read without scanning a bot's whole history.
 *
 * One transaction, nothing existing rewritten: bots, conversations, messages, turns, sessions,
 * teams, routines and clips keep their rows byte for byte. The only writes into existing tables
 * are backfills of derived data (the event's own turnId, already in its body) and the ledger,
 * which is derived from the usage each finished turn already recorded. Secrets have no table
 * here on purpose: extension secrets live in private files, never in SQLite.
 */
export function migrateToV8(db: DatabaseSync) {
  const version = db.prepare('PRAGMA user_version').get()!.user_version as number
  if (version >= 8) return
  if (version !== 7) throw new Error('Chat experience migration requires host schema version 7')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE bot_prompts(
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('host','bot')),
        bot_id TEXT REFERENCES bots(id),
        name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        body TEXT NOT NULL,
        CHECK((scope='host' AND bot_id IS NULL) OR (scope='bot' AND bot_id IS NOT NULL)));
      CREATE UNIQUE INDEX bot_prompts_name ON bot_prompts(scope, COALESCE(bot_id,''), name);

      CREATE TABLE bot_extensions(
        bot_id TEXT PRIMARY KEY REFERENCES bots(id),
        revision INTEGER NOT NULL,
        body TEXT NOT NULL);

      CREATE TABLE bot_skills(
        bot_id TEXT NOT NULL REFERENCES bots(id),
        name TEXT NOT NULL,
        digest TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY(bot_id, name));

      CREATE TABLE bot_turn_usage(
        turn_id TEXT PRIMARY KEY REFERENCES bot_turns(id),
        bot_id TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input INTEGER NOT NULL DEFAULT 0,
        cached_input INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0,
        reasoning_output INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX bot_turn_usage_period ON bot_turn_usage(bot_id, finished_at);

      ALTER TABLE bot_events ADD COLUMN turn_id TEXT;
      CREATE INDEX bot_events_turn ON bot_events(turn_id, seq);
      UPDATE bot_events SET turn_id = json_extract(body, '$.turnId');

      INSERT INTO bot_turn_usage(turn_id, bot_id, finished_at, provider, model, input, cached_input, output, reasoning_output, tool_calls)
        SELECT id, bot_id,
          COALESCE(json_extract(body, '$.finishedAt'), json_extract(body, '$.updatedAt')),
          'codex',
          COALESCE(json_extract(body, '$.model.model'), 'unknown'),
          COALESCE(json_extract(body, '$.usage.inputTokens'), 0),
          COALESCE(json_extract(body, '$.usage.cachedInputTokens'), 0),
          COALESCE(json_extract(body, '$.usage.outputTokens'), 0),
          COALESCE(json_extract(body, '$.usage.reasoningOutputTokens'), 0),
          COALESCE(json_extract(body, '$.usage.toolCalls'), 0)
        FROM bot_turns
        WHERE status IN ('succeeded','failed','cancelled','interrupted')
          AND json_extract(body, '$.usage') IS NOT NULL;

      PRAGMA user_version=8;`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
