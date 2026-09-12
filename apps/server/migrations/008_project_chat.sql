alter table runners add column chat_capabilities jsonb;
alter table runners add column chat_seen_at timestamptz;

create table chat_sessions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, project_id uuid not null,
  owner_user_id text not null, runner_id uuid not null, workspace_key text not null,
  title text not null check(length(title) between 1 and 160), model text not null,
  mode text not null check(mode in ('chat','agent')), base_branch text not null,
  board_id uuid, card_id uuid, version integer not null default 1 check(version>0),
  event_sequence bigint not null default 0, archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(organization_id,project_id,id),
  foreign key(organization_id,project_id) references projects(organization_id,id),
  foreign key(organization_id,runner_id) references runners(organization_id,id),
  foreign key(organization_id,project_id,board_id) references boards(organization_id,project_id,id),
  foreign key(organization_id,project_id,board_id,card_id) references cards(organization_id,project_id,board_id,id),
  check(card_id is null or board_id is not null)
);
create index chat_sessions_history on chat_sessions(organization_id,project_id,owner_user_id,created_at desc,id desc);
create index chat_sessions_runner on chat_sessions(runner_id,project_id);
create table chat_messages (
  id uuid primary key, organization_id uuid not null, project_id uuid not null, session_id uuid not null,
  turn_id uuid, client_message_id uuid, role text not null check(role in ('user','assistant')),
  parts jsonb not null check(jsonb_typeof(parts)='array' and octet_length(parts::text)<=4000000),
  created_at timestamptz not null default now(),
  unique(organization_id,project_id,session_id,id), unique(session_id,client_message_id),
  foreign key(organization_id,project_id,session_id) references chat_sessions(organization_id,project_id,id)
);
create index chat_messages_page on chat_messages(session_id,created_at,id);
create table chat_turns (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, project_id uuid not null,
  session_id uuid not null, message_id uuid not null, runner_id uuid not null,
  state text not null default 'queued' check(state in ('queued','running','waiting_input','cancelling','succeeded','failed','cancelled','interrupted')),
  lease_id uuid, lease_expires_at timestamptz, attempt integer not null default 0,
  continuation jsonb, error text, created_at timestamptz not null default now(), completed_at timestamptz,
  unique(organization_id,project_id,session_id,id),
  foreign key(organization_id,project_id,session_id) references chat_sessions(organization_id,project_id,id),
  foreign key(organization_id,project_id,session_id,message_id) references chat_messages(organization_id,project_id,session_id,id),
  foreign key(organization_id,runner_id) references runners(organization_id,id)
);
alter table chat_messages add foreign key(organization_id,project_id,session_id,turn_id) references chat_turns(organization_id,project_id,session_id,id);
create unique index chat_one_active_turn on chat_turns(session_id) where state in ('queued','running','waiting_input','cancelling');
create index chat_turn_queue on chat_turns(runner_id,created_at,id) where state='queued';
create index chat_turn_lease on chat_turns(lease_expires_at) where state in ('running','waiting_input','cancelling');
create index chat_turn_message on chat_turns(message_id);
create table chat_events (
  organization_id uuid not null, project_id uuid not null, session_id uuid not null, turn_id uuid,
  sequence bigint not null, event_id text not null, payload jsonb not null,
  created_at timestamptz not null default now(), primary key(session_id,sequence), unique(session_id,event_id),
  foreign key(organization_id,project_id,session_id) references chat_sessions(organization_id,project_id,id),
  foreign key(organization_id,project_id,session_id,turn_id) references chat_turns(organization_id,project_id,session_id,id)
);
create index chat_events_turn on chat_events(turn_id);
create table chat_interactions (
  id uuid primary key, organization_id uuid not null, project_id uuid not null, session_id uuid not null, turn_id uuid not null,
  version integer not null check(version>0), payload jsonb not null,
  state text not null default 'pending' check(state in ('pending','decided','expired')),
  decision jsonb, created_at timestamptz not null default now(),
  foreign key(organization_id,project_id,session_id,turn_id) references chat_turns(organization_id,project_id,session_id,id)
);
create index chat_interactions_session on chat_interactions(session_id,turn_id);
create table chat_turn_tokens (
  organization_id uuid not null, project_id uuid not null, session_id uuid not null, turn_id uuid not null,
  token_hash bytea primary key, lease_id uuid not null, expires_at timestamptz not null, revoked_at timestamptz,
  foreign key(organization_id,project_id,session_id,turn_id) references chat_turns(organization_id,project_id,session_id,id)
);
create index chat_tokens_turn on chat_turn_tokens(turn_id);

-- No SECURITY DEFINER or BYPASSRLS. Runner and reconciliation contexts are established only by trusted server code.
create function chat_session_visible(org uuid, project uuid, owner_id text, executor uuid) returns boolean
language sql stable as $$
  select org=maestrly_current_organization_id() and (
    (owner_id=maestrly_current_user_id() and exists(
      select 1 from organization_members om left join project_members pm
        on pm.organization_id=om.organization_id and pm.project_id=project and pm.user_id=om.user_id
      where om.organization_id=org and om.user_id=owner_id and (om.role in ('owner','admin') or pm.user_id is not null)))
    or (nullif(current_setting('app.actor',true),'')::jsonb->>'type'='runner'
      and nullif(current_setting('app.actor',true),'')::jsonb->>'runnerId'=executor::text)
    or (nullif(current_setting('app.actor',true),'')::jsonb->>'type'='system'
      and nullif(current_setting('app.actor',true),'')::jsonb->>'service'='chat-reconcile')
  )
$$;
alter table chat_sessions enable row level security;
alter table chat_sessions force row level security;
create policy chat_session_scope on chat_sessions using(chat_session_visible(organization_id,project_id,owner_user_id,runner_id)) with check(chat_session_visible(organization_id,project_id,owner_user_id,runner_id));
do $$ declare tab text; begin
  foreach tab in array array['chat_turns','chat_messages','chat_events','chat_interactions','chat_turn_tokens'] loop
    execute format('alter table %I enable row level security',tab);
    execute format('alter table %I force row level security',tab);
    execute format('create policy chat_child_scope on %I using (organization_id=maestrly_current_organization_id() and exists(select 1 from chat_sessions s where s.id=session_id)) with check (organization_id=maestrly_current_organization_id() and exists(select 1 from chat_sessions s where s.id=session_id))',tab);
  end loop;
  if exists(select 1 from pg_roles where rolname='maestrly_runtime') then
    grant select,insert,update,delete on chat_sessions,chat_turns,chat_messages,chat_events,chat_interactions,chat_turn_tokens to maestrly_runtime;
    grant execute on function chat_session_visible(uuid,uuid,text,uuid) to maestrly_runtime;
  end if;
end $$;
create index cards_chat_search on cards using gin(to_tsvector('simple',coalesce(title,'') || ' ' || coalesce(description,''))) where deleted_at is null;
