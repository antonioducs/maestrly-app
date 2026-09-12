create extension if not exists pgcrypto;

create or replace function maestrly_current_organization_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.organization_id', true), '')::uuid
$$;

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table organization_members (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_id_idx on organization_members(user_id);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'member')),
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  check (used_at is null or used_at >= created_at)
);
create index invitations_organization_id_idx on invitations(organization_id);
create index invitations_email_lower_idx on invitations(lower(email));

create table projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (length(name) between 1 and 160),
  description text not null default '' check (length(description) <= 20000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index projects_organization_id_idx on projects(organization_id);

create table project_members (
  organization_id uuid not null,
  project_id uuid not null,
  user_id text not null,
  role text not null check (role in ('maintainer', 'contributor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, project_id, user_id),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade,
  foreign key (organization_id, user_id) references organization_members(organization_id, user_id) on delete cascade
);
create index project_members_user_id_idx on project_members(user_id);
create index project_members_project_id_idx on project_members(project_id);

create table repository_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  name text not null check (length(name) between 1 and 160),
  clone_url text,
  delivery_mode text not null default 'patch' check (delivery_mode in ('patch', 'commit', 'push')),
  created_at timestamptz not null default now(),
  unique (organization_id, project_id, id),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade
);
create index repository_bindings_project_idx on repository_bindings(organization_id, project_id);

create table boards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  name text not null check (length(name) between 1 and 160),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, id),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade
);
create index boards_project_idx on boards(organization_id, project_id);

create table execution_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  policy_key uuid not null default gen_random_uuid(),
  version bigint not null check (version > 0),
  name text not null check (length(name) between 1 and 160),
  task_type text not null,
  execution_profile_id text not null,
  required_capabilities jsonb not null default '[]'::jsonb check (jsonb_typeof(required_capabilities) = 'array'),
  repository_binding_id uuid,
  provider text not null check (provider in ('codex', 'claude-agent')),
  model text not null,
  effort text,
  approval_required boolean not null default true,
  max_duration_seconds bigint not null default 3600 check (max_duration_seconds between 1 and 86400),
  max_log_bytes bigint not null default 10485760 check (max_log_bytes > 0),
  delivery jsonb not null default '{"mode":"patch","requireHumanApproval":true}'::jsonb check (jsonb_typeof(delivery) = 'object'),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, id),
  unique (organization_id, project_id, policy_key, version),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade,
  foreign key (organization_id, project_id, repository_binding_id)
    references repository_bindings(organization_id, project_id, id) on delete restrict
);
create index execution_policies_project_idx on execution_policies(organization_id, project_id);
create index execution_policies_repository_idx on execution_policies(repository_binding_id) where repository_binding_id is not null;

create table board_columns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  board_id uuid not null,
  name text not null check (length(name) between 1 and 120),
  position bigint not null check (position >= 0),
  execution_policy_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, board_id, id),
  unique (board_id, position),
  foreign key (organization_id, project_id, board_id) references boards(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, project_id, execution_policy_id)
    references execution_policies(organization_id, project_id, id) on delete restrict
);
create index board_columns_board_idx on board_columns(organization_id, project_id, board_id);
create index board_columns_policy_idx on board_columns(execution_policy_id) where execution_policy_id is not null;

create table cards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  board_id uuid not null,
  column_id uuid not null,
  parent_card_id uuid,
  title text not null check (length(title) between 1 and 500),
  description text not null default '' check (length(description) <= 100000),
  acceptance_criteria jsonb not null default '[]'::jsonb check (jsonb_typeof(acceptance_criteria) = 'array'),
  priority text not null default 'none' check (priority in ('none', 'low', 'medium', 'high', 'urgent')),
  labels jsonb not null default '[]'::jsonb check (jsonb_typeof(labels) = 'array'),
  assignee_user_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(assignee_user_ids) = 'array'),
  position bigint not null check (position >= 0),
  version bigint not null default 1 check (version > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, board_id, id),
  foreign key (organization_id, project_id, board_id, column_id)
    references board_columns(organization_id, project_id, board_id, id) on delete restrict,
  foreign key (organization_id, project_id, board_id, parent_card_id)
    references cards(organization_id, project_id, board_id, id) on delete restrict
);
create index cards_column_position_idx on cards(organization_id, project_id, board_id, column_id, position) where archived_at is null;
create index cards_parent_idx on cards(parent_card_id) where parent_card_id is not null;

create table comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  board_id uuid not null,
  card_id uuid not null,
  body text not null check (length(body) between 1 and 100000),
  author_type text not null check (author_type in ('human', 'agent')),
  author_id text not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, project_id, board_id, card_id)
    references cards(organization_id, project_id, board_id, id) on delete cascade
);
create index comments_card_idx on comments(organization_id, project_id, card_id, created_at);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  board_id uuid not null,
  card_id uuid not null,
  storage_key text not null unique,
  filename text not null check (length(filename) between 1 and 500),
  content_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  digest text not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, project_id, board_id, card_id)
    references cards(organization_id, project_id, board_id, id) on delete cascade
);
create index attachments_card_idx on attachments(organization_id, project_id, card_id);

create table project_event_sequences (
  organization_id uuid not null,
  project_id uuid not null,
  next_sequence bigint not null check (next_sequence > 0),
  primary key (organization_id, project_id),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade
);

create or replace function next_project_event_sequence(target_organization_id uuid, target_project_id uuid)
returns bigint
language sql
volatile
as $$
  insert into project_event_sequences(organization_id, project_id, next_sequence)
  values (target_organization_id, target_project_id, 1)
  on conflict (organization_id, project_id)
  do update set next_sequence = project_event_sequences.next_sequence + 1
  returning next_sequence
$$;

create table domain_events (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  sequence bigint not null,
  type text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  actor jsonb not null check (jsonb_typeof(actor) = 'object'),
  reason text,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  primary key (organization_id, project_id, sequence),
  unique (id),
  unique (organization_id, project_id, id),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade
);
create index domain_events_id_idx on domain_events(id);
create index domain_events_aggregate_idx on domain_events(organization_id, project_id, aggregate_type, aggregate_id);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  board_id uuid not null,
  card_id uuid not null,
  source_event_id uuid not null unique,
  policy_id uuid not null,
  policy_version bigint not null check (policy_version > 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  state text not null check (state in ('waiting_approval', 'queued', 'active', 'waiting_input', 'needs_attention', 'completed', 'cancelled')),
  requested_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, id),
  foreign key (organization_id, project_id, board_id, card_id)
    references cards(organization_id, project_id, board_id, id) on delete restrict,
  foreign key (organization_id, project_id, policy_id)
    references execution_policies(organization_id, project_id, id) on delete restrict,
  foreign key (organization_id, project_id, source_event_id)
    references domain_events(organization_id, project_id, id) on delete restrict
);
create index jobs_claim_idx on jobs(state, created_at) where state in ('queued', 'active');
create index jobs_card_idx on jobs(organization_id, project_id, card_id, created_at);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  job_id uuid not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'revoked')),
  requested_by_user_id text not null,
  decided_by_user_id text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (job_id, status) deferrable initially immediate,
  foreign key (organization_id, project_id, job_id) references jobs(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade,
  check ((status = 'pending' and decided_at is null and decided_by_user_id is null) or status <> 'pending')
);
create index approvals_project_idx on approvals(organization_id, project_id, created_at);

create table information_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  job_id uuid not null,
  run_id uuid,
  question text not null,
  response text,
  requested_at timestamptz not null default now(),
  responded_at timestamptz,
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade,
  foreign key (organization_id, project_id, job_id) references jobs(organization_id, project_id, id) on delete cascade
);
create index information_requests_job_idx on information_requests(job_id);

create table runners (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (length(name) between 1 and 160),
  protocol_version text not null,
  capabilities jsonb not null default '[]'::jsonb check (jsonb_typeof(capabilities) = 'array'),
  max_concurrency bigint not null default 1 check (max_concurrency between 1 and 128),
  status text not null default 'offline' check (status in ('online', 'offline', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index runners_organization_idx on runners(organization_id);

create table runner_project_bindings (
  organization_id uuid not null,
  project_id uuid not null,
  runner_id uuid not null,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, project_id, runner_id),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade,
  foreign key (organization_id, runner_id) references runners(organization_id, id) on delete cascade
);
create index runner_project_bindings_runner_idx on runner_project_bindings(runner_id);

create table runner_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  runner_id uuid not null,
  secret_hash bytea not null unique,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, runner_id) references runners(organization_id, id) on delete cascade
);
create index runner_credentials_runner_idx on runner_credentials(runner_id);

create table runner_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  token_hash bytea not null unique,
  project_ids jsonb not null check (jsonb_typeof(project_ids) = 'array'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by_user_id text not null,
  created_at timestamptz not null default now()
);
create index runner_enrollments_organization_idx on runner_enrollments(organization_id);

create table runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  job_id uuid not null,
  runner_id uuid not null,
  attempt bigint not null check (attempt > 0),
  state text not null check (state in ('claimed', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted', 'needs_input')),
  lease_id uuid not null unique,
  lease_expires_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  outcome jsonb,
  created_at timestamptz not null default now(),
  unique (job_id, attempt),
  unique (organization_id, project_id, id),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade,
  foreign key (organization_id, project_id, job_id) references jobs(organization_id, project_id, id) on delete restrict,
  foreign key (organization_id, runner_id) references runners(organization_id, id) on delete restrict
);
create index runs_runner_idx on runs(runner_id, state);
create index runs_job_idx on runs(job_id);
create unique index runs_one_active_job_idx on runs(job_id) where state in ('claimed', 'running', 'cancelling');

alter table information_requests
  add constraint information_requests_run_id_fkey
  foreign key (organization_id, project_id, run_id)
  references runs(organization_id, project_id, id) on delete restrict;

create table execution_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  run_id uuid not null,
  lease_id uuid not null,
  client_event_id text not null,
  type text not null,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  unique (run_id, client_event_id),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade,
  foreign key (organization_id, project_id, run_id) references runs(organization_id, project_id, id) on delete cascade
);
create index execution_events_run_idx on execution_events(run_id, created_at);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  run_id uuid not null,
  kind text not null check (kind in ('summary', 'patch', 'commit', 'log', 'verification', 'attachment', 'orphaned_evidence')),
  name text not null check (length(name) between 1 and 500),
  content_type text not null,
  storage_key text not null unique,
  size_bytes bigint not null check (size_bytes >= 0),
  digest text not null,
  orphaned boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade,
  foreign key (organization_id, project_id, run_id) references runs(organization_id, project_id, id) on delete restrict
);
create index artifacts_run_idx on artifacts(run_id, created_at);

create table execution_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  board_id uuid not null,
  card_id uuid not null,
  run_id uuid not null unique,
  token_hash bytea not null unique,
  allowed_operations jsonb not null check (jsonb_typeof(allowed_operations) = 'array'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, project_id, board_id, card_id)
    references cards(organization_id, project_id, board_id, id) on delete cascade,
  foreign key (organization_id, project_id, run_id)
    references runs(organization_id, project_id, id) on delete cascade
);
create index execution_tokens_scope_idx on execution_tokens(organization_id, project_id, board_id, card_id);

create table idempotency_records (
  organization_id uuid not null references organizations(id) on delete cascade,
  actor_id text not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 191),
  request_hash text not null,
  response_status bigint not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (organization_id, actor_id, idempotency_key)
);
create index idempotency_records_expiry_idx on idempotency_records(expires_at);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'organization_members', 'invitations', 'projects', 'project_members', 'repository_bindings',
    'boards', 'execution_policies', 'board_columns', 'cards', 'comments', 'attachments',
    'project_event_sequences', 'domain_events', 'jobs', 'approvals', 'information_requests',
    'runners', 'runner_project_bindings', 'runner_credentials', 'runner_enrollments', 'runs',
    'execution_events', 'artifacts', 'execution_tokens', 'idempotency_records'
  ]
  loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy tenant_isolation on %I using (organization_id = maestrly_current_organization_id()) with check (organization_id = maestrly_current_organization_id())',
      table_name
    );
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'maestrly_runtime') then
    grant usage on schema public to maestrly_runtime;
    grant select, insert, update, delete on all tables in schema public to maestrly_runtime;
    grant usage, select on all sequences in schema public to maestrly_runtime;
    grant execute on function maestrly_current_organization_id() to maestrly_runtime;
    grant execute on function next_project_event_sequence(uuid, uuid) to maestrly_runtime;
    alter default privileges in schema public grant select, insert, update, delete on tables to maestrly_runtime;
    alter default privileges in schema public grant usage, select on sequences to maestrly_runtime;
  end if;
end $$;
