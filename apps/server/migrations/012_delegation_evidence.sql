-- Named project checks, delegation artifacts and typed inspections.
create table delegation_check_configs (
  organization_id uuid not null,
  project_id uuid not null,
  check_id text not null check (check_id ~ '^[a-z0-9][a-z0-9:_-]{0,119}$'),
  label text not null check (length(label) between 1 and 200),
  description text not null default '' check (length(description) <= 2000),
  command text not null check (length(command) between 1 and 200),
  args jsonb not null default '[]'::jsonb check (jsonb_typeof(args) = 'array'),
  working_directory text not null default '' check (length(working_directory) <= 300),
  timeout_seconds bigint not null default 900 check (timeout_seconds between 1 and 7200),
  required boolean not null default false,
  mutates_workspace boolean not null default false,
  environment_allowlist jsonb not null default '[]'::jsonb check (jsonb_typeof(environment_allowlist) = 'array'),
  setup jsonb not null default '[]'::jsonb check (jsonb_typeof(setup) = 'array'),
  enabled boolean not null default true,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, project_id, check_id),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade
);

create table delegation_artifacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  attempt_id uuid,
  kind text not null check (kind in ('patch','log','report','screenshot','recording','snapshot','attachment')),
  name text not null check (length(name) between 1 and 500),
  content_type text not null check (length(content_type) between 1 and 200),
  storage_key text not null unique,
  size_bytes bigint not null check (size_bytes >= 0),
  digest text not null,
  code_revision_digest text,
  created_at timestamptz not null default now(),
  unique (organization_id, project_id, id),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, project_id, attempt_id)
    references delegation_attempts(organization_id, project_id, id) on delete set null
);
create index delegation_artifacts_task_idx on delegation_artifacts(task_id, created_at desc);
create index delegation_artifacts_attempt_idx on delegation_artifacts(attempt_id) where attempt_id is not null;

-- Chunked upload state. Incomplete uploads expire and are removed; nothing partial becomes an artifact.
create table delegation_artifact_uploads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  attempt_id uuid,
  kind text not null check (kind in ('patch','log','report','screenshot','recording','snapshot','attachment')),
  name text not null check (length(name) between 1 and 500),
  content_type text not null check (length(content_type) between 1 and 200),
  code_revision_digest text,
  temp_key text not null unique,
  received_bytes bigint not null default 0 check (received_bytes >= 0),
  next_index bigint not null default 0 check (next_index >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade
);
create index delegation_artifact_uploads_expiry_idx on delegation_artifact_uploads(expires_at);

create table delegation_check_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  attempt_id uuid,
  check_id text not null,
  resolved_command text not null check (length(resolved_command) <= 2000),
  passed boolean not null,
  exit_code bigint,
  duration_ms bigint not null check (duration_ms >= 0),
  timed_out boolean not null default false,
  truncated boolean not null default false,
  code_revision_digest text not null,
  log_artifact_id uuid,
  setup_issue text check (setup_issue is null or length(setup_issue) <= 2000),
  created_at timestamptz not null default now(),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, project_id, attempt_id)
    references delegation_attempts(organization_id, project_id, id) on delete set null,
  foreign key (organization_id, project_id, log_artifact_id)
    references delegation_artifacts(organization_id, project_id, id) on delete set null
);
-- One result per check and revision; a rerun of the same revision replaces it.
create unique index delegation_check_results_revision_idx
  on delegation_check_results(task_id, check_id, code_revision_digest);

create table delegation_inspections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  requested_by_user_id text not null,
  connection_id uuid,
  operation jsonb not null check (jsonb_typeof(operation) = 'object'),
  state text not null default 'queued' check (state in ('queued','running','succeeded','failed','cancelled')),
  result jsonb,
  artifact_id uuid,
  error text check (error is null or length(error) <= 4000),
  code_revision_digest text,
  lease_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (organization_id, project_id, id),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, project_id, artifact_id)
    references delegation_artifacts(organization_id, project_id, id) on delete set null,
  foreign key (organization_id, connection_id)
    references connector_connections(organization_id, id) on delete set null
);
create index delegation_inspections_task_idx on delegation_inspections(task_id, created_at desc);
create index delegation_inspections_queue_idx on delegation_inspections(task_id) where state = 'queued';

do $$
declare tab text;
begin
  foreach tab in array array[
    'delegation_check_configs','delegation_artifacts','delegation_artifact_uploads',
    'delegation_check_results','delegation_inspections'
  ]
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
      delegation_check_configs, delegation_artifacts, delegation_artifact_uploads,
      delegation_check_results, delegation_inspections
      to maestrly_runtime;
  end if;
end $$;
