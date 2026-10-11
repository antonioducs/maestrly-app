-- Retire the external agent connection feature (migrations 010 to 016): OAuth connectors for external MCP
-- agents, delegated development tasks and personal bot conversations relayed through the server.
-- Maestrly has its own bots now, so nothing here is kept. Migrations 010 to 016 stay untouched because
-- deployed instances already applied them; this migration removes what they created or altered.
--
-- Every drop uses `if exists`, and tenant data goes with its table. The runtime role's grants on the
-- tables that remain are not touched.

-- 1. Stage conversations lived in the chat queue next to private project chats. Without the delegation
-- marker they would surface as the owner's own chat, and a stage turn still queued would be claimed as
-- ordinary chat. Archive those sessions and stop their turns first. These tables force row level security
-- even for their owner, so it is lifted around the two updates and restored right after.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'chat_sessions' and column_name = 'delegation_task_id'
  ) then
    alter table chat_sessions no force row level security;
    alter table chat_turns no force row level security;
    update chat_turns
      set state = 'cancelled', completed_at = coalesce(completed_at, now())
      where state in ('queued', 'running', 'waiting_input', 'cancelling')
        and session_id in (select id from chat_sessions where delegation_task_id is not null);
    update chat_sessions
      set archived_at = coalesce(archived_at, now()), updated_at = now()
      where delegation_task_id is not null;
    alter table chat_turns force row level security;
    alter table chat_sessions force row level security;
  end if;
end $$;

-- 2. Revoke the OAuth clients that external agents and bots registered, so their tokens stop working with
-- the feature. The OAuth provider owns these rows; deleting a client cascades to its tokens, consents and
-- resource links. The Maestrly desktop client is never touched.
do $$
begin
  if to_regclass('connector_connections') is not null and to_regclass('bot_connections') is not null then
    alter table connector_connections no force row level security;
    alter table bot_connections no force row level security;
    delete from "oauthClient"
      where "clientId" <> 'maestrly-desktop-personal-v1'
        and "clientId" in (
          select client_id from connector_connections
          union
          select client_id from bot_connections
        );
    -- The `/mcp` and `/mcp/bots` audiences existed only for these connections.
    delete from "oauthResource" where identifier ~ '/mcp(/bots)?$';
  end if;
end $$;

-- 3. Columns, constraints and indexes the retired migrations added to tables that stay.
alter table chat_sessions drop constraint if exists chat_sessions_delegation_stage_fkey;
alter table chat_sessions drop constraint if exists chat_sessions_delegation_pair_check;
drop index if exists chat_sessions_delegation_stage_idx;
drop index if exists chat_sessions_delegation_task_idx;
alter table chat_sessions drop column if exists delegation_stage_id;
alter table chat_sessions drop column if exists delegation_task_id;
alter table runners drop column if exists delegation_seen_at;
alter table runners drop column if exists delegation_capabilities;

-- 4. Tables, with their indexes, constraints, row level security policies and grants. Children first;
-- `cascade` only covers the foreign keys between these tables.
drop table if exists bot_idempotency_records cascade;
drop table if exists bot_conversation_events cascade;
drop table if exists bot_questions cascade;
drop table if exists bot_messages cascade;
drop table if exists bot_commands cascade;
drop table if exists bot_conversations cascade;
drop table if exists bot_connection_grants cascade;
drop table if exists bot_connections cascade;
drop table if exists bot_desktops cascade;

drop table if exists connector_notifications cascade;
drop table if exists connector_notification_endpoints cascade;

drop table if exists delegation_webhook_bindings cascade;
drop table if exists delegation_source_events cascade;
drop table if exists delegation_subscriptions cascade;
drop table if exists delegation_pull_requests cascade;
drop table if exists delegation_deliveries cascade;
drop table if exists delegation_inspections cascade;
drop table if exists delegation_check_results cascade;
drop table if exists delegation_artifact_uploads cascade;
drop table if exists delegation_artifacts cascade;
drop table if exists delegation_check_configs cascade;
drop table if exists delegation_reviews cascade;
drop table if exists delegation_findings cascade;
drop table if exists delegation_events cascade;
drop table if exists delegation_dependencies cascade;
drop table if exists delegation_commands cascade;
drop table if exists delegation_attempts cascade;
drop table if exists delegation_settings_revisions cascade;
drop table if exists delegation_stages cascade;
drop table if exists delegation_tasks cascade;
drop table if exists delegation_presets cascade;

drop table if exists connector_project_grants cascade;
drop table if exists connector_connections cascade;

-- 5. Row level security helpers of the bot conversations. Their policies went with the tables above.
drop function if exists bot_scope_visible(text, uuid, uuid);
drop function if exists bot_connection_visible(text, uuid, uuid);
drop function if exists bot_desktop_visible(text, uuid);
drop function if exists bot_actor();
