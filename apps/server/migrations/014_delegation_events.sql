-- Follow-up subscriptions and the external events that wake a task.
create table delegation_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  source text not null check (source in ('github','timer','dependency')),
  /** Rule describing what to do when the source fires; validated by the API. */
  rule jsonb not null check (jsonb_typeof(rule) = 'object'),
  enabled boolean not null default true,
  -- Timers carry an explicit timezone and a persisted next occurrence.
  timezone text not null default 'UTC' check (length(timezone) between 1 and 80),
  next_fire_at timestamptz,
  last_fired_at timestamptz,
  expires_at timestamptz,
  fired_count bigint not null default 0 check (fired_count >= 0),
  created_by_user_id text not null,
  connection_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, id),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, connection_id)
    references connector_connections(organization_id, id) on delete set null
);
create index delegation_subscriptions_task_idx on delegation_subscriptions(task_id);
create index delegation_subscriptions_due_idx on delegation_subscriptions(next_fire_at)
  where enabled and next_fire_at is not null;
create index delegation_subscriptions_source_idx on delegation_subscriptions(organization_id, source) where enabled;

create table delegation_source_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  subscription_id uuid,
  source text not null check (source in ('github','timer','dependency')),
  -- Stable external identifier; a repeated delivery is recognized instead of acted on twice.
  external_id text not null check (length(external_id) between 1 and 300),
  type text not null check (length(type) between 1 and 120),
  pull_request_number bigint,
  head_sha text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  state text not null default 'received' check (state in ('received','applied','ignored','superseded')),
  reason text check (reason is null or length(reason) <= 500),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (organization_id, source, external_id),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, project_id, subscription_id)
    references delegation_subscriptions(organization_id, project_id, id) on delete set null
);
create index delegation_source_events_pending_idx on delegation_source_events(task_id, created_at)
  where state = 'received';

-- Optional inbound GitHub webhook. The secret is stored encrypted; the binding names the repository.
create table delegation_webhook_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  repository text not null check (length(repository) between 1 and 200),
  secret_cipher bytea not null,
  secret_nonce bytea not null,
  secret_fingerprint text not null,
  key_id text not null,
  enabled boolean not null default true,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, repository),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade
);

do $$
declare tab text;
begin
  foreach tab in array array['delegation_subscriptions','delegation_source_events','delegation_webhook_bindings']
  loop
    execute format('alter table %I enable row level security', tab);
    execute format('alter table %I force row level security', tab);
    execute format(
      'create policy tenant_isolation on %I using (organization_id = maestrly_current_organization_id()) with check (organization_id = maestrly_current_organization_id())',
      tab
    );
  end loop;
  if exists (select 1 from pg_roles where rolname = 'maestrly_runtime') then
    grant select, insert, update, delete on
      delegation_subscriptions, delegation_source_events, delegation_webhook_bindings to maestrly_runtime;
  end if;
end $$;
