-- Outbound notifications to an external agent routine (for example a Grok Bot routine).
--
-- The endpoint belongs to a connector connection, so it inherits exactly the projects that connection was
-- granted: a notification never reveals a project the bot could not read through the MCP endpoint. The
-- shared secret is stored encrypted with the operator key and is never returned by the API.
create table connector_notification_endpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  connection_id uuid not null,
  url text not null check (length(url) between 1 and 2000),
  secret_cipher bytea not null,
  secret_nonce bytea not null,
  secret_fingerprint text not null check (length(secret_fingerprint) between 1 and 64),
  key_id text not null check (length(key_id) between 1 and 64),
  enabled boolean not null default true,
  -- Why the last attempt ended, so a disabled endpoint can explain itself instead of failing silently.
  last_status text check (length(last_status) <= 191),
  last_delivered_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0),
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, connection_id),
  foreign key (organization_id, connection_id)
    references connector_connections(organization_id, id) on delete cascade
);

-- Transactional outbox. A notification is written in the same transaction as the delegation event it
-- describes, so a crash cannot lose one and a retry cannot invent one. Delivery is at-least-once: the
-- receiver deduplicates on `eventId`.
create table connector_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  project_id uuid not null,
  endpoint_id uuid not null,
  connection_id uuid not null,
  task_id uuid not null,
  event_id uuid not null,
  sequence bigint not null check (sequence > 0),
  type text not null check (length(type) between 1 and 120),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  state text not null default 'pending' check (state in ('pending', 'delivering', 'delivered', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  -- A claim that outlives its lease is reclaimed, so a crashed delivery is retried instead of stranded.
  lease_expires_at timestamptz,
  last_error text check (length(last_error) <= 2000),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (endpoint_id, event_id),
  foreign key (organization_id, endpoint_id)
    references connector_notification_endpoints(organization_id, id) on delete cascade,
  foreign key (organization_id, connection_id)
    references connector_connections(organization_id, id) on delete cascade,
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade,
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade
);
create index connector_notifications_due_idx
  on connector_notifications(organization_id, next_attempt_at)
  where state in ('pending', 'delivering');
create index connector_notifications_task_idx on connector_notifications(task_id, sequence);
create index connector_notifications_endpoint_idx on connector_notifications(endpoint_id, created_at desc);

do $$
declare tab text;
begin
  foreach tab in array array['connector_notification_endpoints', 'connector_notifications']
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
      connector_notification_endpoints, connector_notifications to maestrly_runtime;
  end if;
end $$;
