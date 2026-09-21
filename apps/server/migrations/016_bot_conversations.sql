-- Personal bot conversations. A person connects their own bot to the native chats running on their own
-- desktop: no organization, project, board, card or runner takes part, so no column here references one.
-- Every row is scoped by its owner, its desktop and its bot connection, and row level security is forced
-- with no SECURITY DEFINER and no BYPASSRLS: the runtime role only sees what its actor context allows.

create table bot_desktops (
  id uuid primary key default gen_random_uuid(),
  owner_user_id text not null check (length(owner_user_id) between 1 and 191),
  name text not null check (length(name) between 1 and 160),
  credential_hash bytea not null,
  inventory jsonb,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);
create index bot_desktops_owner_idx on bot_desktops(owner_user_id, created_at desc);
create unique index bot_desktops_credential_idx on bot_desktops(credential_hash);

create table bot_connections (
  id uuid primary key default gen_random_uuid(),
  owner_user_id text not null check (length(owner_user_id) between 1 and 191),
  desktop_id uuid not null,
  client_id text not null check (length(client_id) between 1 and 191),
  name text not null check (length(name) between 1 and 160),
  version bigint not null default 1 check (version > 0),
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (owner_user_id, client_id),
  foreign key (desktop_id, owner_user_id) references bot_desktops(id, owner_user_id) on delete cascade
);
create index bot_connections_client_idx on bot_connections(client_id) where revoked_at is null;
create index bot_connections_desktop_idx on bot_connections(desktop_id);

create table bot_connection_grants (
  connection_id uuid not null,
  owner_user_id text not null,
  desktop_id uuid not null,
  workspace_id text not null check (length(workspace_id) between 1 and 191),
  actions jsonb not null check (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) > 0),
  created_at timestamptz not null default now(),
  primary key (connection_id, workspace_id),
  foreign key (connection_id, owner_user_id) references bot_connections(id, owner_user_id) on delete cascade
);

create table bot_conversations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id text not null,
  connection_id uuid not null,
  desktop_id uuid not null,
  workspace_id text not null check (length(workspace_id) between 1 and 191),
  name text not null check (length(name) between 1 and 160),
  base_branch text not null check (length(base_branch) between 1 and 240),
  selection jsonb not null,
  management_state text not null default 'active' check (management_state in ('active', 'paused', 'revoked')),
  version bigint not null default 1 check (version > 0),
  event_sequence bigint not null default 0,
  command_sequence bigint not null default 0,
  command_fence bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (connection_id, owner_user_id) references bot_connections(id, owner_user_id) on delete cascade
);
create index bot_conversations_connection_idx on bot_conversations(connection_id, created_at desc);
create index bot_conversations_desktop_idx on bot_conversations(desktop_id, updated_at);

create table bot_commands (
  id uuid primary key default gen_random_uuid(),
  owner_user_id text not null,
  connection_id uuid not null,
  desktop_id uuid not null,
  conversation_id uuid not null,
  kind text not null check (kind in ('create', 'send', 'configure', 'cancel', 'answer')),
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
  lease_token uuid,
  lease_expires_at timestamptz,
  -- Monotonic per conversation. A reply that carries an older fence lost its lease and is refused.
  fence bigint not null default 0,
  sequence bigint not null,
  attempt integer not null default 0,
  error text,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (id, conversation_id),
  foreign key (conversation_id, owner_user_id) references bot_conversations(id, owner_user_id) on delete cascade
);
-- Commands of one conversation run strictly one at a time and in the order they were accepted.
create unique index bot_commands_serial on bot_commands(conversation_id) where status = 'leased' and kind not in ('answer','cancel');
create unique index bot_commands_control_serial on bot_commands(conversation_id) where status = 'leased' and kind in ('answer','cancel');
create unique index bot_commands_order on bot_commands(conversation_id, sequence);
create index bot_commands_queue on bot_commands(desktop_id, sequence) where status = 'queued';
create index bot_commands_lease on bot_commands(lease_expires_at) where status = 'leased';

create table bot_messages (
  id uuid primary key,
  owner_user_id text not null,
  connection_id uuid not null,
  desktop_id uuid not null,
  conversation_id uuid not null,
  command_id uuid,
  role text not null check (role in ('user', 'assistant')),
  parts jsonb not null check (jsonb_typeof(parts) = 'array' and octet_length(parts::text) <= 4000000),
  created_at timestamptz not null default now(),
  unique (id, conversation_id),
  foreign key (conversation_id, owner_user_id) references bot_conversations(id, owner_user_id) on delete cascade
);
create index bot_messages_page on bot_messages(conversation_id, created_at, id);

-- Ordinary questions only. Permission prompts, plan approvals and escalations never reach a bot.
create table bot_questions (
  id uuid primary key,
  owner_user_id text not null,
  connection_id uuid not null,
  desktop_id uuid not null,
  conversation_id uuid not null,
  command_id uuid not null,
  questions jsonb not null check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) > 0),
  state text not null default 'pending' check (state in ('pending', 'answered', 'expired')),
  answers jsonb,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, owner_user_id) references bot_conversations(id, owner_user_id) on delete cascade,
  foreign key (command_id, conversation_id) references bot_commands(id, conversation_id) on delete cascade
);
create index bot_questions_conversation_idx on bot_questions(conversation_id, created_at);

create table bot_conversation_events (
  conversation_id uuid not null,
  owner_user_id text not null,
  connection_id uuid not null,
  desktop_id uuid not null,
  command_id uuid,
  sequence bigint not null,
  event_id text not null check (length(event_id) between 1 and 191),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, sequence),
  unique (conversation_id, event_id),
  foreign key (conversation_id, owner_user_id) references bot_conversations(id, owner_user_id) on delete cascade
);

-- Personal idempotency ledger: the platform one is keyed by organization and none exists here.
create table bot_idempotency_records (
  owner_user_id text not null,
  actor_id text not null check (length(actor_id) between 1 and 191),
  idempotency_key text not null check (length(idempotency_key) between 1 and 191),
  request_hash text not null,
  response_status integer not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (owner_user_id, actor_id, idempotency_key)
);
create index bot_idempotency_expiry on bot_idempotency_records(expires_at);

create function bot_actor() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('app.actor', true), '')::jsonb, '{}'::jsonb)
$$;

-- `bot_desktop_auth` and `bot_connection_auth` are the narrow bootstrap contexts trusted server code
-- establishes to verify a device credential or resolve a token's connection. Neither can read a chat.
create function bot_desktop_visible(owner text, desktop uuid) returns boolean language sql stable as $$
  select case bot_actor()->>'type'
    when 'bot_owner' then owner = maestrly_current_user_id()
    when 'bot_desktop' then owner = maestrly_current_user_id() and bot_actor()->>'desktopId' = desktop::text
    when 'bot_connection' then owner = maestrly_current_user_id() and bot_actor()->>'desktopId' = desktop::text
    when 'bot_connection_auth' then owner = maestrly_current_user_id()
    when 'bot_desktop_auth' then bot_actor()->>'desktopId' = desktop::text
    else false end
$$;

create function bot_connection_visible(owner text, connection uuid, desktop uuid) returns boolean
language sql stable as $$
  select case bot_actor()->>'type'
    when 'bot_owner' then owner = maestrly_current_user_id()
    when 'bot_connection_auth' then owner = maestrly_current_user_id()
    when 'bot_desktop' then owner = maestrly_current_user_id() and bot_actor()->>'desktopId' = desktop::text
    when 'bot_connection' then owner = maestrly_current_user_id() and bot_actor()->>'connectionId' = connection::text
    else false end
$$;

-- Chats, commands, messages, questions and events. A bot connection sees only its own conversations, so
-- a human chat or another bot's chat is unreachable even with a valid token.
create function bot_scope_visible(owner text, connection uuid, desktop uuid) returns boolean
language sql stable as $$
  select owner = maestrly_current_user_id() and case bot_actor()->>'type'
    when 'bot_owner' then true
    when 'bot_desktop' then bot_actor()->>'desktopId' = desktop::text
    when 'bot_connection' then bot_actor()->>'connectionId' = connection::text
    else false end
$$;

alter table bot_desktops enable row level security;
alter table bot_desktops force row level security;
create policy bot_desktop_scope on bot_desktops
  using (bot_desktop_visible(owner_user_id, id)) with check (bot_desktop_visible(owner_user_id, id));

alter table bot_connections enable row level security;
alter table bot_connections force row level security;
create policy bot_connection_scope on bot_connections
  using (bot_connection_visible(owner_user_id, id, desktop_id))
  with check (bot_connection_visible(owner_user_id, id, desktop_id));

alter table bot_idempotency_records enable row level security;
alter table bot_idempotency_records force row level security;
create policy bot_idempotency_scope on bot_idempotency_records
  using (owner_user_id = maestrly_current_user_id()) with check (owner_user_id = maestrly_current_user_id());

do $$
declare tab text;
begin
  foreach tab in array array['bot_connection_grants', 'bot_conversations', 'bot_commands', 'bot_messages',
    'bot_questions', 'bot_conversation_events']
  loop
    execute format('alter table %I enable row level security', tab);
    execute format('alter table %I force row level security', tab);
    execute format(
      'create policy bot_child_scope on %I using (bot_scope_visible(owner_user_id, connection_id, desktop_id)) with check (bot_scope_visible(owner_user_id, connection_id, desktop_id))',
      tab
    );
  end loop;
  if exists (select 1 from pg_roles where rolname = 'maestrly_runtime') then
    grant select, insert, update, delete on bot_desktops, bot_connections, bot_connection_grants,
      bot_conversations, bot_commands, bot_messages, bot_questions, bot_conversation_events,
      bot_idempotency_records to maestrly_runtime;
    grant execute on function bot_actor() to maestrly_runtime;
    grant execute on function bot_desktop_visible(text, uuid) to maestrly_runtime;
    grant execute on function bot_connection_visible(text, uuid, uuid) to maestrly_runtime;
    grant execute on function bot_scope_visible(text, uuid, uuid) to maestrly_runtime;
  end if;
end $$;
