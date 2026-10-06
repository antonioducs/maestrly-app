import type { DatabaseSync } from 'node:sqlite'

/** Local receipts live independently of transcripts so a deleted conversation cannot be replayed. */
export function initializeBotCommandSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_command_receipts (
      instance_id TEXT NOT NULL, command_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('admitted','completed')), result TEXT,
      native_started INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(instance_id,command_id)
    );
    CREATE TABLE IF NOT EXISTS bot_command_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL, command_id TEXT NOT NULL, event_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(instance_id,command_id,event_id),
      FOREIGN KEY(instance_id,command_id) REFERENCES bot_command_receipts(instance_id,command_id)
    );
    CREATE INDEX IF NOT EXISTS bot_command_outbox_pending ON bot_command_outbox(instance_id,command_id,seq);
    CREATE TABLE IF NOT EXISTS bot_question_bindings (
      instance_id TEXT NOT NULL, question_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, request_id TEXT NOT NULL,
      PRIMARY KEY(instance_id,question_id)
    );
  `)
  initializeLocalBotSchema(db)
}

/**
 * The embedded bot relay of this computer.
 *
 * A personal bot is answered entirely from here: its connection, the grants the person gave it, the
 * inventory this desktop published for it, its chats, commands, durable events and idempotency
 * receipts. No account, organization or remote instance takes part in any of these rows.
 */
function initializeLocalBotSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_local_connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, client_id TEXT NOT NULL,
      desktop_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      provider_ids TEXT NOT NULL DEFAULT '[]', selections TEXT,
      permission_ceiling TEXT NOT NULL DEFAULT 'ask',
      revoked_at INTEGER, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS bot_local_connections_client ON bot_local_connections(client_id);
    CREATE TABLE IF NOT EXISTS bot_local_grants (
      connection_id TEXT NOT NULL REFERENCES bot_local_connections(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL, actions TEXT NOT NULL,
      PRIMARY KEY(connection_id,workspace_id)
    );
    CREATE TABLE IF NOT EXISTS bot_local_inventory (
      connection_id TEXT PRIMARY KEY REFERENCES bot_local_connections(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_local_conversations (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES bot_local_connections(id) ON DELETE CASCADE,
      desktop_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      name TEXT NOT NULL, base_branch TEXT NOT NULL, selection TEXT NOT NULL,
      management_state TEXT NOT NULL DEFAULT 'active'
        CHECK(management_state IN ('active','paused','revoked')),
      owner_attention TEXT,
      version INTEGER NOT NULL DEFAULT 1, command_sequence INTEGER NOT NULL DEFAULT 0,
      command_fence INTEGER NOT NULL DEFAULT 0, event_sequence INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bot_local_conversations_connection
      ON bot_local_conversations(connection_id,updated_at);
    CREATE TABLE IF NOT EXISTS bot_local_commands (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES bot_local_conversations(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL, desktop_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('create','send','configure','cancel','answer')),
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','leased','succeeded','failed','cancelled')),
      lease_token TEXT, lease_expires_at INTEGER, fence INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0, error TEXT, sequence INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS bot_local_commands_order
      ON bot_local_commands(conversation_id,sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS bot_local_commands_serial
      ON bot_local_commands(conversation_id) WHERE status='leased' AND kind NOT IN ('answer','cancel');
    CREATE UNIQUE INDEX IF NOT EXISTS bot_local_commands_control_serial
      ON bot_local_commands(conversation_id) WHERE status='leased' AND kind IN ('answer','cancel');
    CREATE INDEX IF NOT EXISTS bot_local_commands_queue ON bot_local_commands(status,sequence);
    CREATE TABLE IF NOT EXISTS bot_local_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES bot_local_conversations(id) ON DELETE CASCADE,
      command_id TEXT, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      parts TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bot_local_messages_conversation
      ON bot_local_messages(conversation_id,created_at,id);
    CREATE TABLE IF NOT EXISTS bot_local_questions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES bot_local_conversations(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL, questions TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','answered','expired')),
      answers TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bot_local_questions_conversation
      ON bot_local_questions(conversation_id,created_at);
    CREATE TABLE IF NOT EXISTS bot_local_events (
      conversation_id TEXT NOT NULL REFERENCES bot_local_conversations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, event_id TEXT NOT NULL, command_id TEXT,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_id,sequence)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS bot_local_events_identity
      ON bot_local_events(conversation_id,event_id);
    CREATE TABLE IF NOT EXISTS bot_local_idempotency (
      connection_id TEXT NOT NULL REFERENCES bot_local_connections(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(connection_id,idempotency_key)
    );
  `)
  // A connection saved before the owner could choose how far a bot goes keeps the strictest ceiling:
  // an existing bot never widens on its own because the application learned a new column.
  const connectionColumns = db.prepare('PRAGMA table_info(bot_local_connections)').all() as Array<{ name: string }>
  if (!connectionColumns.some((column) => column.name === 'permission_ceiling'))
    db.exec("ALTER TABLE bot_local_connections ADD COLUMN permission_ceiling TEXT NOT NULL DEFAULT 'ask';")
}
