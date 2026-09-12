import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { prepareProductionDatabasePath } from './database-path-migration'

// Use built-in node:sqlite available in the Electron runtime, avoiding an additional native module or ABI
// rebuild.

let db: DatabaseSync

const LEGACY_MANAGEMENT_TABLES = [
  'delivery_memory_chunks',
  'delivery_memories',
  'card_body_history',
  'column_prompt_history',
  'card_dispatch_guards',
  'card_events',
  'card_comments',
  'card_conversations',
  'column_agent_configs',
  'board_cards',
  'board_columns',
  'boards',
] as const

function tableExists(name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function tableHasColumn(table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (item) => item.name === column
  )
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function purgeLegacyConversationPreferences(): void {
  if (!tableExists('conversations') || !tableHasColumn('conversations', 'ui_prefs')) return
  const rows = db.prepare('SELECT id, ui_prefs FROM conversations').all() as Array<{ id: string; ui_prefs: string }>
  const update = db.prepare('UPDATE conversations SET ui_prefs = ? WHERE id = ?')
  for (const row of rows) {
    let prefs: unknown
    try {
      prefs = JSON.parse(row.ui_prefs)
    } catch {
      continue
    }
    if (!isJsonObject(prefs)) continue

    let changed = false
    for (const key of ['assistantEngine', 'assistantProjectId']) {
      if (!Object.hasOwn(prefs, key)) continue
      delete prefs[key]
      changed = true
    }
    if (Array.isArray(prefs.mainTabOrder)) {
      const mainTabOrder = prefs.mainTabOrder.filter((tab) => tab !== 'card')
      if (mainTabOrder.length !== prefs.mainTabOrder.length) {
        prefs.mainTabOrder = mainTabOrder
        changed = true
      }
    }
    if (isJsonObject(prefs.floating) && Object.hasOwn(prefs.floating, 'card')) {
      delete prefs.floating.card
      changed = true
    }
    if (isJsonObject(prefs.chatGptWebCapabilities) && Object.hasOwn(prefs.chatGptWebCapabilities, 'board')) {
      delete prefs.chatGptWebCapabilities.board
      changed = true
    }
    if (changed) update.run(JSON.stringify(prefs), row.id)
  }
}

function purgeLegacyAppPreferences(): void {
  if (!tableExists('app_settings')) return
  const rows = db
    .prepare("SELECT key, value FROM app_settings WHERE key IN ('defaultMainTabOrder', 'shortcuts.config')")
    .all() as Array<{ key: string; value: string }>
  const update = db.prepare('UPDATE app_settings SET value = ? WHERE key = ?')
  for (const row of rows) {
    let value: unknown
    try {
      value = JSON.parse(row.value)
    } catch {
      continue
    }
    if (row.key === 'defaultMainTabOrder' && Array.isArray(value)) {
      const sanitized = value.filter((tab) => tab !== 'card')
      if (sanitized.length !== value.length) update.run(JSON.stringify(sanitized), row.key)
    } else if (row.key === 'shortcuts.config' && isJsonObject(value) && Object.hasOwn(value, 'card')) {
      delete value.card
      update.run(JSON.stringify(value), row.key)
    }
  }
}

/**
 * Remove the retired local project-management model before creating the current schema. initStore wraps
 * this and every later migration in one transaction, so an incompatible database cannot be left half
 * purged. Ordinary conversations and unrelated settings remain intact.
 */
function purgeLegacyProjectManagementSchema(): void {
  for (const table of LEGACY_MANAGEMENT_TABLES) db.exec(`DROP TABLE IF EXISTS ${table};`)

  if (tableExists('conversations') && tableHasColumn('conversations', 'kind')) {
    // Project-assistant transcripts are part of the retired surface. Remove their detached usage rows too;
    // provider binding delete triggers may still enqueue the native-session cleanup they require.
    if (tableExists('chat_usage_ledger')) {
      const ownerPredicates: string[] = []
      if (tableHasColumn('chat_usage_ledger', 'conversation_id'))
        ownerPredicates.push("conversation_id IN (SELECT id FROM conversations WHERE kind = 'assistant')")
      // Older or partially backfilled ledgers can still be joined through their message before the cascade.
      if (tableExists('chat_messages') && tableHasColumn('chat_messages', 'conversation_id'))
        ownerPredicates.push(
          "message_id IN (SELECT id FROM chat_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE kind = 'assistant'))"
        )
      if (ownerPredicates.length) db.exec(`DELETE FROM chat_usage_ledger WHERE ${ownerPredicates.join(' OR ')};`)
    }
    db.exec("DELETE FROM conversations WHERE kind = 'assistant';")
    db.exec('ALTER TABLE conversations DROP COLUMN kind;')
  }

  purgeLegacyConversationPreferences()

  if (tableExists('workspaces') && tableHasColumn('workspaces', 'next_card_number')) {
    db.exec('ALTER TABLE workspaces DROP COLUMN next_card_number;')
  }

  if (tableExists('app_settings')) {
    db.exec(`
      DELETE FROM app_settings
       WHERE key IN (
         'dispatch.maxPerCardPerColumn',
         'dispatch.breakerWindowMs',
         'dispatch.conversationTimeoutMs'
       );
    `)
  }
  purgeLegacyAppPreferences()
  if (tableExists('schema_migrations')) {
    db.exec("DELETE FROM schema_migrations WHERE id LIKE 'board-%';")
  }
}

/**
 * Open/create SQLite and ensure schema, migrations, and backfills. Tests may inject paths for real
 * WAL/FK behavior. Production resolves its userData database after a consistent legacy snapshot
 * migration; explicit test paths never enter that migration.
 */
export function initStore(file?: string): void {
  const productionMigration = file ? undefined : prepareProductionDatabasePath(app.getPath('userData'))
  const dbFile = file ?? productionMigration!.databasePath
  db = new DatabaseSync(dbFile)
  db.exec('PRAGMA journal_mode = WAL;')
  // Enable foreign keys explicitly because conversation/repository cleanup depends on cascades, regardless
  // of driver defaults.
  db.exec('PRAGMA foreign_keys = ON;')
  try {
    // One durable commit for schema upgrades and backfills avoids an fsync per DDL statement.
    transaction(initializeSchema)
  } catch (error) {
    closeStore()
    throw error
  }
  productionMigration?.finalizeAfterSuccessfulBoot()
}

function initializeSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_chat_sessions (
      instance_id TEXT NOT NULL, session_id TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY(instance_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS platform_chat_turns (
      turn_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, lease_id TEXT NOT NULL,
      state TEXT NOT NULL, completion TEXT
    );
    CREATE TABLE IF NOT EXISTS platform_chat_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS platform_chat_outbox_turn ON platform_chat_outbox(turn_id,seq);
  `)
  // Drop known ledger triggers before schema creation because IF NOT EXISTS would preserve an outdated
  // privacy implementation.
  db.exec(`
    DROP TRIGGER IF EXISTS trg_chat_usage_ledger_after_insert;
    DROP TRIGGER IF EXISTS trg_chat_usage_ledger_after_usage_update;
  `)
  purgeLegacyProjectManagementSchema()
  const usageLedgerCols = db.prepare('PRAGMA table_info(chat_usage_ledger)').all() as Array<{ name: string }>
  if (usageLedgerCols.length > 0 && !usageLedgerCols.some((column) => column.name === 'conversation_id')) {
    // The ledger deliberately has no FK: this optional owner key keeps per-conversation billing history after
    // its transcript anchor is deleted without making usage depend on conversation lifetime.
    db.exec('ALTER TABLE chat_usage_ledger ADD COLUMN conversation_id TEXT;')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id            TEXT PRIMARY KEY,
      path          TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      added_at      INTEGER NOT NULL,
      position      INTEGER NOT NULL DEFAULT 0
    );
    -- Virtual application-wide sidebar groups (#218), with persisted collapse state and no disk/Git
    -- effects. Workspace association uses plain group_id; defensive migration and app logic maintain
    -- membership.
    CREATE TABLE IF NOT EXISTS workspace_groups (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      collapsed  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      branch       TEXT NOT NULL,
      mode         TEXT NOT NULL,
      experience   TEXT NOT NULL DEFAULT 'standard',
      cwd          TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'idle',
      created_at   INTEGER NOT NULL,
      archived     INTEGER NOT NULL DEFAULT 0,
      pinned_at    INTEGER,
      last_activity_at INTEGER NOT NULL DEFAULT 0,
      position     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_conv_ws ON conversations(workspace_id);
    CREATE TABLE IF NOT EXISTS conversation_migrations (
      id                        TEXT PRIMARY KEY,
      conversation_id           TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      -- Legacy nonterminal journals alone use successor compatibility state; new migrations keep one
      -- conversation identity.
      legacy_successor_conversation_id TEXT,
      source_workspace_id       TEXT NOT NULL,
      source_branch             TEXT NOT NULL,
      destination_branch        TEXT NOT NULL,
      source_cwd                TEXT NOT NULL,
      destination_cwd           TEXT NOT NULL,
      source_head_oid           TEXT NOT NULL,
      changes_json              TEXT NOT NULL,
      ignored_json              TEXT NOT NULL DEFAULT '[]',
      selected_ignored_json     TEXT NOT NULL DEFAULT '[]',
      confirmed_sensitive_json  TEXT NOT NULL DEFAULT '[]',
      git_plan_json             TEXT NOT NULL,
      sidecars_json             TEXT NOT NULL DEFAULT '[]',
      phase                     TEXT NOT NULL,
      status                    TEXT NOT NULL,
      stash_oid                 TEXT,
      stash_marker              TEXT,
      baseline_assistants       INTEGER NOT NULL DEFAULT 0,
      error                     TEXT,
      created_at                INTEGER NOT NULL,
      updated_at                INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_repos (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
      repo_top        TEXT NOT NULL,
      branch          TEXT NOT NULL,
      base            TEXT NOT NULL,
      worktree_path   TEXT NOT NULL,
      link_name       TEXT NOT NULL,
      position        INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_convrepos_ws ON conversation_repos(workspace_id);

    -- Private durable Memory Center records use opaque conversation provenance without FK so transcript
    -- deletion cannot erase explicitly saved decisions.
    CREATE TABLE IF NOT EXISTS local_memories (
      id                     TEXT PRIMARY KEY,
      workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
    );
    CREATE INDEX IF NOT EXISTS idx_local_memories_workspace_status
      ON local_memories(workspace_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_local_memories_workspace_type
      ON local_memories(workspace_id, type, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_local_memories_workspace_pinned
      ON local_memories(workspace_id, pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_local_memories_workspace_hash
      ON local_memories(workspace_id, content_hash);
    CREATE TABLE IF NOT EXISTS local_memory_migrations (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source_hash  TEXT NOT NULL,
      imported_count INTEGER NOT NULL DEFAULT 0,
      backup_path TEXT,
      status      TEXT NOT NULL,
      error       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, source_hash)
    );

    -- ===== CONFIG GLOBAL DO APP (key/value de 1 linha; ex.: flag da power assertion) =====
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    -- Native Chat messages: one thread per conversation with JSON parts/metadata and monotonic
    -- per-conversation seq. Foreign-key cascades clean messages on conversation deletion.
    CREATE TABLE IF NOT EXISTS chat_messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,                 -- 'user' | 'assistant'
      parts_json      TEXT NOT NULL DEFAULT '[]',    -- JSON MessagePart[]
      meta_json       TEXT,                          -- JSON { model?, finishReason?, usage?, error? }
      seq             INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_msg_conv ON chat_messages(conversation_id, seq);

    -- Host-owned Maestro run identity stays stable across provider transport and before the visual
    -- assistant message exists. Permit one active run per conversation and preserve terminal history for
    -- reconciliation.
    CREATE TABLE IF NOT EXISTS chat_maestro_runs (
      id                   TEXT PRIMARY KEY,
      conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      assistant_message_id TEXT,
      status               TEXT NOT NULL CHECK (status IN ('active','completed','error','aborted','interrupted')),
      started_at           INTEGER NOT NULL,
      finished_at          INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_maestro_runs_active
      ON chat_maestro_runs(conversation_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_chat_maestro_runs_conversation
      ON chat_maestro_runs(conversation_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_maestro_runs_assistant
      ON chat_maestro_runs(assistant_message_id) WHERE assistant_message_id IS NOT NULL;

    -- Messages arriving during an active run queue separately from the visual transcript. Per-run seq
    -- orders them; checkpoint_id atomically reserves embedded confirmation.
    CREATE TABLE IF NOT EXISTS chat_maestro_run_messages (
      id                  TEXT PRIMARY KEY,
      run_id              TEXT NOT NULL REFERENCES chat_maestro_runs(id) ON DELETE CASCADE,
      seq                 INTEGER NOT NULL CHECK (seq > 0),
      text                TEXT NOT NULL,
      agent_mentions_json TEXT NOT NULL DEFAULT '[]',
      status              TEXT NOT NULL CHECK (status IN ('pending','embedded','rolled_over','cancelled')),
      checkpoint_id       TEXT,
      created_at          INTEGER NOT NULL,
      embedded_at         INTEGER,
      UNIQUE (run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_maestro_messages_pending
      ON chat_maestro_run_messages(run_id, status, checkpoint_id, seq);
    CREATE INDEX IF NOT EXISTS idx_chat_maestro_messages_checkpoint
      ON chat_maestro_run_messages(run_id, checkpoint_id) WHERE checkpoint_id IS NOT NULL;

    -- Subagent child transcripts remain separate from parent message parts to avoid automatic
    -- replay/context inflation. Versioned parts plus message ID/role/sequence reconstruct read-only panel
    -- messages.
    CREATE TABLE IF NOT EXISTS chat_subagent_sessions (
      id                         TEXT PRIMARY KEY,
      conversation_id            TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      parent_message_id          TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      tool_call_id               TEXT NOT NULL,
      origin                     TEXT NOT NULL CHECK (origin IN ('task', 'delegate')),
      agent_name                 TEXT NOT NULL,
      task                       TEXT NOT NULL,
      status                     TEXT NOT NULL CHECK (status IN ('preparing','running','completed','failed','cancelled','interrupted')),
      phase                      TEXT,
      current_tool               TEXT,
      profile_json               TEXT,
      maestro_json               TEXT,
      usage_json                 TEXT,
      runtime_estimated_cost_usd REAL,
      summary_json               TEXT NOT NULL DEFAULT '{}',
      error                      TEXT,
      revision                   INTEGER NOT NULL DEFAULT 0,
      started_at                 INTEGER NOT NULL,
      last_activity_at           INTEGER NOT NULL,
      finished_at                INTEGER,
      UNIQUE (conversation_id, parent_message_id, tool_call_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_subagent_sessions_conv
      ON chat_subagent_sessions(conversation_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_subagent_sessions_parent
      ON chat_subagent_sessions(parent_message_id, started_at);

    CREATE TABLE IF NOT EXISTS chat_subagent_transcript (
      session_id   TEXT NOT NULL REFERENCES chat_subagent_sessions(id) ON DELETE CASCADE,
      part_id      TEXT NOT NULL,
      message_id   TEXT NOT NULL,
      message_seq  INTEGER NOT NULL,
      role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      position     INTEGER NOT NULL,
      part_json    TEXT NOT NULL,
      revision     INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (session_id, part_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_subagent_transcript_order
      ON chat_subagent_transcript(session_id, message_seq, position);
    CREATE INDEX IF NOT EXISTS idx_chat_subagent_transcript_revision
      ON chat_subagent_transcript(session_id, revision);

    -- Durable usage ledger intentionally has no FK: historical consumption survives transcript,
    -- conversation, and workspace deletion.
    CREATE TABLE IF NOT EXISTS chat_usage_ledger (
      message_id  TEXT PRIMARY KEY,
      conversation_id TEXT,
      provider_id TEXT NOT NULL DEFAULT '',
      model_id    TEXT NOT NULL DEFAULT '',
      usage_json  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_usage_ledger_created ON chat_usage_ledger(created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_usage_ledger_conversation ON chat_usage_ledger(conversation_id);

    -- SQLite is the persistence boundary: repeated streaming checkpoints upsert snapshots; absent usage
    -- does not create or erase billing. Strip private contextIdentity and guard corrupt JSON in triggers.
    CREATE TRIGGER IF NOT EXISTS trg_chat_usage_ledger_after_insert
    AFTER INSERT ON chat_messages
    FOR EACH ROW
    WHEN NEW.role = 'assistant'
      AND json_type(CASE WHEN json_valid(COALESCE(NEW.meta_json, '')) THEN NEW.meta_json ELSE '{}' END, '$.usage') = 'object'
      AND json_type(CASE WHEN json_valid(COALESCE(NEW.meta_json, '')) THEN NEW.meta_json ELSE '{}' END, '$.usage.input') IN ('integer', 'real')
      AND json_type(CASE WHEN json_valid(COALESCE(NEW.meta_json, '')) THEN NEW.meta_json ELSE '{}' END, '$.usage.output') IN ('integer', 'real')
    BEGIN
      INSERT INTO chat_usage_ledger (message_id, conversation_id, provider_id, model_id, usage_json, created_at)
      VALUES (
        NEW.id,
        NEW.conversation_id,
        CASE
          WHEN json_type(NEW.meta_json, '$.model.providerId') = 'text'
          THEN json_extract(NEW.meta_json, '$.model.providerId')
          ELSE ''
        END,
        CASE
          WHEN json_type(NEW.meta_json, '$.model.modelId') = 'text'
          THEN json_extract(NEW.meta_json, '$.model.modelId')
          ELSE ''
        END,
        json_remove(json_extract(NEW.meta_json, '$.usage'), '$.contextIdentity'),
        NEW.created_at
      )
      ON CONFLICT(message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        usage_json = excluded.usage_json,
        created_at = excluded.created_at;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_usage_ledger_after_usage_update
    AFTER UPDATE OF meta_json ON chat_messages
    FOR EACH ROW
    WHEN NEW.role = 'assistant'
      AND json_type(CASE WHEN json_valid(COALESCE(NEW.meta_json, '')) THEN NEW.meta_json ELSE '{}' END, '$.usage') = 'object'
      AND json_type(CASE WHEN json_valid(COALESCE(NEW.meta_json, '')) THEN NEW.meta_json ELSE '{}' END, '$.usage.input') IN ('integer', 'real')
      AND json_type(CASE WHEN json_valid(COALESCE(NEW.meta_json, '')) THEN NEW.meta_json ELSE '{}' END, '$.usage.output') IN ('integer', 'real')
    BEGIN
      INSERT INTO chat_usage_ledger (message_id, conversation_id, provider_id, model_id, usage_json, created_at)
      VALUES (
        NEW.id,
        NEW.conversation_id,
        CASE
          WHEN json_type(NEW.meta_json, '$.model.providerId') = 'text'
          THEN json_extract(NEW.meta_json, '$.model.providerId')
          ELSE ''
        END,
        CASE
          WHEN json_type(NEW.meta_json, '$.model.modelId') = 'text'
          THEN json_extract(NEW.meta_json, '$.model.modelId')
          ELSE ''
        END,
        json_remove(json_extract(NEW.meta_json, '$.usage'), '$.contextIdentity'),
        NEW.created_at
      )
      ON CONFLICT(message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        usage_json = excluded.usage_json,
        created_at = excluded.created_at;
    END;

    -- Provider-native inference transcript stays separate from visual parts and is never sent to renderer.
    -- It may contain encrypted reasoning and opaque replay IDs. Message cascades remove the sidecar when
    -- its anchor is deleted.
    CREATE TABLE IF NOT EXISTS chat_inference_state (
      message_id       TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
      provider_id      TEXT NOT NULL,
      model_id         TEXT NOT NULL,
      harness_profile  TEXT NOT NULL,
      state_json       TEXT NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    -- Bind visual conversation to a durable official Codex thread. Native transcript/compaction stays in
    -- isolated CODEX_HOME; store only IDs and compatibility identity. Validate last_message_id and start a
    -- new thread after incompatible transcript/model/tool changes.
    CREATE TABLE IF NOT EXISTS chat_codex_threads (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      thread_id       TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      tool_signature  TEXT NOT NULL,
      instruction_hash TEXT NOT NULL DEFAULT '',
      harness_profile TEXT NOT NULL DEFAULT 'openai-default-v1',
      last_message_id TEXT NOT NULL,
      usage_json      TEXT NOT NULL DEFAULT '{}',
      account_id      TEXT NOT NULL DEFAULT '',
      updated_at      INTEGER NOT NULL
    );

    -- Durable native-runtime deletion queue has no FK so cleanup can retry after local
    -- conversation/workspace removal.
    CREATE TABLE IF NOT EXISTS chat_codex_thread_cleanup (
      thread_id       TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      last_error      TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      account_id      TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_codex_cleanup_created
      ON chat_codex_thread_cleanup(created_at, thread_id);

    -- Every binding invalidation, including cascades outside adapters, creates a tombstone before removal.
    -- Upsert preserves original creation time and prior retry history.
    CREATE TRIGGER IF NOT EXISTS trg_chat_codex_thread_cleanup_before_delete
    BEFORE DELETE ON chat_codex_threads
    FOR EACH ROW
    BEGIN
      INSERT INTO chat_codex_thread_cleanup
        (thread_id, conversation_id, last_error, attempts, account_id, created_at, updated_at)
      VALUES (
        OLD.thread_id,
        OLD.conversation_id,
        NULL,
        0,
        OLD.account_id,
        CAST(unixepoch('subsec') * 1000 AS INTEGER),
        CAST(unixepoch('subsec') * 1000 AS INTEGER)
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        account_id = excluded.account_id,
        updated_at = excluded.updated_at;
    END;

    -- Official Copilot binding includes account fingerprint to prevent cross-identity resume. Harness
    -- profile is part of compatibility because one transport can serve different model families.
    CREATE TABLE IF NOT EXISTS chat_github_copilot_sessions (
      conversation_id    TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      session_id         TEXT NOT NULL,
      model_id           TEXT NOT NULL,
      harness_profile    TEXT NOT NULL,
      tool_signature     TEXT NOT NULL,
      last_message_id    TEXT NOT NULL,
      account_fingerprint TEXT NOT NULL,
      account_id         TEXT NOT NULL DEFAULT '',
      updated_at         INTEGER NOT NULL
    );

    -- Native deletion survives local cascades and retries when the runtime becomes available; intentionally
    -- no FK.
    CREATE TABLE IF NOT EXISTS chat_github_copilot_session_cleanup (
      session_id       TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL,
      last_error       TEXT,
      attempts         INTEGER NOT NULL DEFAULT 0,
      account_id       TEXT NOT NULL DEFAULT '',
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_github_copilot_cleanup_created
      ON chat_github_copilot_session_cleanup(created_at, session_id);

    CREATE TRIGGER IF NOT EXISTS trg_chat_github_copilot_session_cleanup_before_delete
    BEFORE DELETE ON chat_github_copilot_sessions
    FOR EACH ROW
    BEGIN
      INSERT INTO chat_github_copilot_session_cleanup
        (session_id, conversation_id, last_error, attempts, account_id, created_at, updated_at)
      VALUES (
        OLD.session_id,
        OLD.conversation_id,
        NULL,
        0,
        OLD.account_id,
        CAST(unixepoch('subsec') * 1000 AS INTEGER),
        CAST(unixepoch('subsec') * 1000 AS INTEGER)
      )
      ON CONFLICT(session_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        account_id = excluded.account_id,
        updated_at = excluded.updated_at;
    END;

    -- Claude Agent SDK transcript lives in isolated CLAUDE_CONFIG_DIR. Store only resume identity, harness
    -- compatibility, and usage/context snapshots.
    CREATE TABLE IF NOT EXISTS chat_claude_sessions (
      conversation_id     TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      session_id          TEXT NOT NULL,
      model_id            TEXT NOT NULL,
      effort              TEXT NOT NULL DEFAULT '',
      fast_mode           INTEGER NOT NULL DEFAULT 0,
      cwd                 TEXT NOT NULL,
      harness_profile     TEXT NOT NULL,
      prompt_hash         TEXT NOT NULL,
      tool_signature      TEXT NOT NULL,
      last_message_id     TEXT NOT NULL,
      last_assistant_uuid TEXT,
      account_fingerprint TEXT NOT NULL,
      account_epoch       INTEGER NOT NULL DEFAULT 0,
      account_id          TEXT NOT NULL DEFAULT '',
      usage_json          TEXT NOT NULL DEFAULT '{}',
      context_json        TEXT,
      updated_at          INTEGER NOT NULL
    );

    -- SDK edit/resend UUIDs reference messages so transcript truncation removes rewinds without a remaining
    -- visual anchor.
    CREATE TABLE IF NOT EXISTS chat_claude_message_map (
      conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      maestrly_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      session_id          TEXT NOT NULL,
      sdk_user_uuid       TEXT,
      sdk_assistant_uuid  TEXT,
      created_at          INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, maestrly_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_claude_map_session
      ON chat_claude_message_map(session_id, created_at);

    -- Tombstones survive cascades for retryable native-session deletion.
    CREATE TABLE IF NOT EXISTS chat_claude_session_cleanup (
      session_id       TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL,
      cwd              TEXT NOT NULL,
      last_error       TEXT,
      attempts         INTEGER NOT NULL DEFAULT 0,
      account_id       TEXT NOT NULL DEFAULT '',
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_claude_cleanup_created
      ON chat_claude_session_cleanup(created_at, session_id);

    CREATE TRIGGER IF NOT EXISTS trg_chat_claude_session_cleanup_before_delete
    BEFORE DELETE ON chat_claude_sessions
    FOR EACH ROW
    BEGIN
      INSERT INTO chat_claude_session_cleanup
        (session_id, conversation_id, cwd, last_error, attempts, account_id, created_at, updated_at)
      VALUES (
        OLD.session_id,
        OLD.conversation_id,
        OLD.cwd,
        NULL,
        0,
        OLD.account_id,
        CAST(unixepoch('subsec') * 1000 AS INTEGER),
        CAST(unixepoch('subsec') * 1000 AS INTEGER)
      )
      ON CONFLICT(session_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        cwd = excluded.cwd,
        account_id = excluded.account_id,
        updated_at = excluded.updated_at;
    END;

    -- Durable tool results keyed by call_id prevent repeated side effects when sampling resumes after tool
    -- completion but before provider confirmation.
    CREATE TABLE IF NOT EXISTS chat_tool_executions (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id      TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      call_id          TEXT NOT NULL,
      tool_name        TEXT NOT NULL,
      input_hash       TEXT NOT NULL,
      status           TEXT NOT NULL,
      output_json      TEXT,
      updated_at       INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, call_id)
    );

    -- Workspace-scoped saved always-allow rules for BYOK Chat.
    CREATE TABLE IF NOT EXISTS permission_saved (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      action     TEXT NOT NULL,
      resource   TEXT NOT NULL,
      UNIQUE(project_id, action, resource)
    );
  `)

  // Early inference-table rows lack message ownership and cannot be safely associated after clear/edit.
  // Migrate to strong message FK ownership before startup.
  const toolExecutionCols = db.prepare('PRAGMA table_info(chat_tool_executions)').all() as Array<{ name: string }>
  if (!toolExecutionCols.some((column) => column.name === 'message_id')) {
    // Wrap DDL in a transaction so a failed CREATE after DROP cannot leave the database without its table.
    transaction(() => {
      db.exec(`
        DROP TABLE chat_tool_executions;
        CREATE TABLE chat_tool_executions (
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          message_id      TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
          call_id         TEXT NOT NULL,
          tool_name       TEXT NOT NULL,
          input_hash      TEXT NOT NULL,
          status          TEXT NOT NULL,
          output_json     TEXT,
          updated_at      INTEGER NOT NULL,
          PRIMARY KEY (conversation_id, call_id)
        );
      `)
    })
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_tool_exec_message ON chat_tool_executions(message_id);')

  // Compatibility with Codex adapter development databases predating usage snapshots.
  const codexThreadCols = db.prepare('PRAGMA table_info(chat_codex_threads)').all() as Array<{ name: string }>
  if (!codexThreadCols.some((column) => column.name === 'usage_json')) {
    db.exec("ALTER TABLE chat_codex_threads ADD COLUMN usage_json TEXT NOT NULL DEFAULT '{}';")
  }
  if (!codexThreadCols.some((column) => column.name === 'instruction_hash')) {
    db.exec("ALTER TABLE chat_codex_threads ADD COLUMN instruction_hash TEXT NOT NULL DEFAULT '';")
  }
  if (!codexThreadCols.some((column) => column.name === 'harness_profile')) {
    db.exec(
      "ALTER TABLE chat_codex_threads ADD COLUMN harness_profile TEXT NOT NULL DEFAULT 'openai-default-v1';"
    )
  }

  // Subscription bindings/tombstones add account slots, defaulting to the empty slot. Check columns per
  // table because old and newly created tables can differ. Recreate tombstone triggers to propagate
  // account_id; IF NOT EXISTS cannot replace old definitions.
  const accountIdTables = [
    'chat_codex_threads',
    'chat_codex_thread_cleanup',
    'chat_github_copilot_sessions',
    'chat_github_copilot_session_cleanup',
    'chat_claude_sessions',
    'chat_claude_session_cleanup',
  ]
  const tablesMissingAccountId = accountIdTables.filter(
    (table) =>
      !(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
        (column) => column.name === 'account_id'
      )
  )
  if (tablesMissingAccountId.length > 0) {
    transaction(() => {
      for (const table of tablesMissingAccountId) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN account_id TEXT NOT NULL DEFAULT '';`)
      }
      db.exec(`
        DROP TRIGGER IF EXISTS trg_chat_codex_thread_cleanup_before_delete;
        CREATE TRIGGER trg_chat_codex_thread_cleanup_before_delete
        BEFORE DELETE ON chat_codex_threads
        FOR EACH ROW
        BEGIN
          INSERT INTO chat_codex_thread_cleanup
            (thread_id, conversation_id, last_error, attempts, account_id, created_at, updated_at)
          VALUES (
            OLD.thread_id,
            OLD.conversation_id,
            NULL,
            0,
            OLD.account_id,
            CAST(unixepoch('subsec') * 1000 AS INTEGER),
            CAST(unixepoch('subsec') * 1000 AS INTEGER)
          )
          ON CONFLICT(thread_id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            account_id = excluded.account_id,
            updated_at = excluded.updated_at;
        END;
        DROP TRIGGER IF EXISTS trg_chat_github_copilot_session_cleanup_before_delete;
        CREATE TRIGGER trg_chat_github_copilot_session_cleanup_before_delete
        BEFORE DELETE ON chat_github_copilot_sessions
        FOR EACH ROW
        BEGIN
          INSERT INTO chat_github_copilot_session_cleanup
            (session_id, conversation_id, last_error, attempts, account_id, created_at, updated_at)
          VALUES (
            OLD.session_id,
            OLD.conversation_id,
            NULL,
            0,
            OLD.account_id,
            CAST(unixepoch('subsec') * 1000 AS INTEGER),
            CAST(unixepoch('subsec') * 1000 AS INTEGER)
          )
          ON CONFLICT(session_id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            account_id = excluded.account_id,
            updated_at = excluded.updated_at;
        END;
        DROP TRIGGER IF EXISTS trg_chat_claude_session_cleanup_before_delete;
        CREATE TRIGGER trg_chat_claude_session_cleanup_before_delete
        BEFORE DELETE ON chat_claude_sessions
        FOR EACH ROW
        BEGIN
          INSERT INTO chat_claude_session_cleanup
            (session_id, conversation_id, cwd, last_error, attempts, account_id, created_at, updated_at)
          VALUES (
            OLD.session_id,
            OLD.conversation_id,
            OLD.cwd,
            NULL,
            0,
            OLD.account_id,
            CAST(unixepoch('subsec') * 1000 AS INTEGER),
            CAST(unixepoch('subsec') * 1000 AS INTEGER)
          )
          ON CONFLICT(session_id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            cwd = excluded.cwd,
            account_id = excluded.account_id,
            updated_at = excluded.updated_at;
        END;
      `)
    })
  }

  // Defensive migrations for databases created before each column existed.
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
  const hasCol = (n: string) => cols.some((c) => c.name === n)
  if (!hasCol('is_multi')) {
    db.exec('ALTER TABLE conversations ADD COLUMN is_multi INTEGER NOT NULL DEFAULT 0;')
  }
  if (!hasCol('archived')) {
    db.exec('ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;')
  }
  if (!hasCol('pinned_at')) {
    db.exec('ALTER TABLE conversations ADD COLUMN pinned_at INTEGER;')
  }
  if (!hasCol('last_activity_at')) {
    db.exec('ALTER TABLE conversations ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0;')
    db.exec('UPDATE conversations SET last_activity_at = created_at;')
  }
  if (!hasCol('ui_prefs')) {
    db.exec("ALTER TABLE conversations ADD COLUMN ui_prefs TEXT NOT NULL DEFAULT '{}';")
  }
  // Structural chat experience. Existing rows migrate as Standard; explicit idle Maestro → Standard handoff is allowed.
  if (!hasCol('experience')) {
    db.exec("ALTER TABLE conversations ADD COLUMN experience TEXT NOT NULL DEFAULT 'standard';")
  }
  // Workspace project memory defaults enabled.
  const wsCols = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>
  if (!wsCols.some((c) => c.name === 'memory_enabled')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1;')
  }
  // Workspace group membership and collapse state (#218). Keep group_id nullable and enforce integrity in
  // app operations: group deletion ungroups members and moves validate IDs. null means ungrouped; collapse
  // persists per workspace.
  if (!wsCols.some((c) => c.name === 'group_id')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN group_id TEXT;')
  }
  if (!wsCols.some((c) => c.name === 'collapsed')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;')
  }
  const migrationCols = db.prepare('PRAGMA table_info(conversation_migrations)').all() as Array<{ name: string }>
  // Forward-only Chat conversation migration preserves conversation/history ID. Keep older direct/successor
  // journals for explicit safe rollback without reintroducing CLI runtime concepts.
  if (!migrationCols.some((column) => column.name === 'conversation_id')) {
    const confirmedSensitive = migrationCols.some((column) => column.name === 'confirmed_sensitive_json')
      ? 'confirmed_sensitive_json'
      : "'[]'"
    const legacySuccessor = migrationCols.some((column) => column.name === 'successor_conversation_id')
      ? `CASE WHEN status NOT IN ('completed','cancelled','rolled-back') THEN successor_conversation_id END`
      : 'NULL'
    transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS trg_conversation_migration_source_delete_guard;
        DROP TRIGGER IF EXISTS trg_conversation_migration_successor_delete_guard;
        DROP TABLE IF EXISTS conversation_successions;
        ALTER TABLE conversation_migrations RENAME TO conversation_migrations_legacy_cli;
        CREATE TABLE conversation_migrations (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          legacy_successor_conversation_id TEXT,
          source_workspace_id TEXT NOT NULL,
          source_branch TEXT NOT NULL,
          destination_branch TEXT NOT NULL,
          source_cwd TEXT NOT NULL,
          destination_cwd TEXT NOT NULL,
          source_head_oid TEXT NOT NULL,
          changes_json TEXT NOT NULL,
          ignored_json TEXT NOT NULL DEFAULT '[]',
          selected_ignored_json TEXT NOT NULL DEFAULT '[]',
          confirmed_sensitive_json TEXT NOT NULL DEFAULT '[]',
          git_plan_json TEXT NOT NULL,
          sidecars_json TEXT NOT NULL DEFAULT '[]',
          phase TEXT NOT NULL,
          status TEXT NOT NULL,
          stash_oid TEXT,
          stash_marker TEXT,
          baseline_assistants INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO conversation_migrations
          (id, conversation_id, legacy_successor_conversation_id, source_workspace_id, source_branch, destination_branch, source_cwd,
           destination_cwd, source_head_oid, changes_json, ignored_json, selected_ignored_json,
           confirmed_sensitive_json, git_plan_json, sidecars_json, phase, status, stash_oid,
           stash_marker, baseline_assistants, error, created_at, updated_at)
        SELECT id, source_conversation_id, ${legacySuccessor}, source_workspace_id, source_branch, destination_branch,
          source_cwd, destination_cwd, source_head_oid, changes_json, ignored_json,
          selected_ignored_json, ${confirmedSensitive}, git_plan_json, sidecars_json,
          CASE WHEN status IN ('completed','cancelled','rolled-back') THEN phase ELSE 'rolling-back' END,
          CASE WHEN status IN ('completed','cancelled','rolled-back') THEN status ELSE 'recovery-required' END,
          stash_oid, stash_marker, baseline_assistants,
          CASE WHEN status IN ('completed','cancelled','rolled-back') THEN error
               ELSE 'Legacy CLI migration: only safe rollback is available.' END,
          created_at, updated_at
        FROM conversation_migrations_legacy_cli;
        DROP TABLE conversation_migrations_legacy_cli;
      `)
    })
  }
  const currentMigrationCols = db.prepare('PRAGMA table_info(conversation_migrations)').all() as Array<{ name: string }>
  if (!currentMigrationCols.some((column) => column.name === 'legacy_successor_conversation_id')) {
    // DBs upgraded by the first Chat-only build cannot recover a successor that was already discarded; this
    // additive column still makes subsequent upgrades safe and keeps all new journals single-identity.
    db.exec('ALTER TABLE conversation_migrations ADD COLUMN legacy_successor_conversation_id TEXT;')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_migrations_conversation ON conversation_migrations(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_migrations_status ON conversation_migrations(status);
    DROP TRIGGER IF EXISTS trg_conversation_migration_source_delete_guard;
    CREATE TRIGGER trg_conversation_migration_source_delete_guard
    BEFORE DELETE ON conversations
    WHEN EXISTS (
      SELECT 1 FROM conversation_migrations
      WHERE (conversation_id = OLD.id OR legacy_successor_conversation_id = OLD.id)
        AND status NOT IN ('completed','cancelled','rolled-back')
    )
    BEGIN
      SELECT RAISE(ABORT, 'conversation has an incomplete migration');
    END;
  `)
  // Subagent continuity lets the same author revise and reviewer recheck. Each turn remains a row;
  // resumed_from records lineage and private runtime_handle_json permits native resume and parent-end
  // cleanup.
  const subagentSessionCols = db.prepare('PRAGMA table_info(chat_subagent_sessions)').all() as Array<{ name: string }>
  if (!subagentSessionCols.some((c) => c.name === 'resumed_from'))
    db.exec('ALTER TABLE chat_subagent_sessions ADD COLUMN resumed_from TEXT;')
  if (!subagentSessionCols.some((c) => c.name === 'resume_status'))
    db.exec('ALTER TABLE chat_subagent_sessions ADD COLUMN resume_status TEXT;')
  if (!subagentSessionCols.some((c) => c.name === 'resume_reason'))
    db.exec('ALTER TABLE chat_subagent_sessions ADD COLUMN resume_reason TEXT;')
  if (!subagentSessionCols.some((c) => c.name === 'runtime_handle_json'))
    db.exec('ALTER TABLE chat_subagent_sessions ADD COLUMN runtime_handle_json TEXT;')
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_subagent_sessions_resumed_from ON chat_subagent_sessions(resumed_from);')
  // #31: Add persisted sidebar position and densely backfill once; a zero default alone would tie every
  // row. Preserve old added_at/id workspace order and per-workspace created_at conversation order.
  if (!wsCols.some((c) => c.name === 'position')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN position INTEGER NOT NULL DEFAULT 0;')
    db.exec(`UPDATE workspaces SET position = (
      SELECT COUNT(*) FROM workspaces w2
       WHERE w2.added_at < workspaces.added_at
          OR (w2.added_at = workspaces.added_at AND w2.id < workspaces.id));`)
  }
  if (!hasCol('position')) {
    db.exec('ALTER TABLE conversations ADD COLUMN position INTEGER NOT NULL DEFAULT 0;')
    db.exec(`UPDATE conversations SET position = (
      SELECT COUNT(*) FROM conversations c2
       WHERE c2.workspace_id = conversations.workspace_id
         AND (c2.created_at < conversations.created_at
           OR (c2.created_at = conversations.created_at AND c2.id < conversations.id)));`)
  }
  sanitizeChatUsageLedger()
  backfillChatUsageLedger()
}

/**
 * Idempotently backfill usage still present in transcripts on every boot, covering interrupted
 * upgrades. Upsert by message_id; skip individually corrupt metadata without blocking startup.
 */
function backfillChatUsageLedger(): void {
  const rows = db
    .prepare("SELECT id, conversation_id, meta_json, created_at FROM chat_messages WHERE role = 'assistant'")
    .all() as Array<{ id: string; conversation_id: string; meta_json: string | null; created_at: number }>
  if (!rows.length) return

  const upsert = db.prepare(
    `INSERT INTO chat_usage_ledger (message_id, conversation_id, provider_id, model_id, usage_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       conversation_id = excluded.conversation_id,
       provider_id = excluded.provider_id,
       model_id = excluded.model_id,
       usage_json = excluded.usage_json,
       created_at = excluded.created_at`
  )

  transaction(() => {
    for (const row of rows) {
      if (!row.meta_json) continue
      let meta: unknown
      try {
        meta = JSON.parse(row.meta_json)
      } catch {
        continue
      }
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue
      const source = meta as {
        model?: { providerId?: unknown; modelId?: unknown }
        usage?: { input?: unknown; output?: unknown }
      }
      const usage = source.usage
      if (
        !usage ||
        typeof usage !== 'object' ||
        Array.isArray(usage) ||
        typeof usage.input !== 'number' ||
        !Number.isFinite(usage.input) ||
        typeof usage.output !== 'number' ||
        !Number.isFinite(usage.output)
      ) {
        continue
      }
      const providerId = typeof source.model?.providerId === 'string' ? source.model.providerId : ''
      const modelId = typeof source.model?.modelId === 'string' ? source.model.modelId : ''
      const { contextIdentity: _private, ...accountingUsage } = usage as Record<string, unknown>
      upsert.run(row.id, row.conversation_id, providerId, modelId, JSON.stringify(accountingUsage), row.created_at)
    }
  })
}

/** Remove private identities from older ledger rows, including deleted-message history. */
function sanitizeChatUsageLedger(): void {
  transaction(() => {
    db.prepare(
      `UPDATE chat_usage_ledger
       SET usage_json = json_remove(usage_json, '$.contextIdentity')
       WHERE json_type(CASE WHEN json_valid(usage_json) THEN usage_json ELSE '{}' END, '$.contextIdentity') IS NOT NULL`
    ).run()
  })
}

let transactionSequence = 0

/** Savepoints preserve atomicity for both independent operations and nested migration steps. */
export function transaction(fn: () => void): void {
  const savepoint = `maestrly_transaction_${++transactionSequence}`
  db.exec(`SAVEPOINT ${savepoint}`)
  try {
    fn()
    db.exec(`RELEASE SAVEPOINT ${savepoint}`)
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    db.exec(`RELEASE SAVEPOINT ${savepoint}`)
    throw error
  }
}

/** Expose DatabaseSync to focused persistence modules. */
export function getDb(): DatabaseSync {
  return db
}

/**
 * Close SQLite and release database/WAL handles between tests. Safe if uninitialized/already closed;
 * production process exit also releases them.
 */
export function closeStore(): void {
  try {
    db?.close()
  } catch {
    /* Already closed or never initialized. */
  }
}
