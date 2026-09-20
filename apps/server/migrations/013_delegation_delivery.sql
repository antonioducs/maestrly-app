-- Delivery is a durable intention recorded before any external effect, so a retry can reconcile instead of
-- repeating a push, a pull request or a merge.
create table delegation_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  attempt_id uuid,
  mode text not null check (mode in ('patch','commit','push','draft_pr','ready_pr','merge')),
  -- Revision the delivery was authorized for; a later edit invalidates it.
  expected_revision text not null,
  state text not null default 'intended' check (state in ('intended','confirmed','failed','needs_attention')),
  commit_sha text,
  branch text,
  pull_request_number bigint,
  pull_request_url text,
  observed_account text,
  error text check (error is null or length(error) <= 4000),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, id),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, project_id, attempt_id)
    references delegation_attempts(organization_id, project_id, id) on delete set null
);
create index delegation_deliveries_task_idx on delegation_deliveries(task_id, created_at desc);
-- One live intention per task and mode; a retry reuses it instead of creating a second effect.
create unique index delegation_deliveries_live_idx on delegation_deliveries(task_id, mode)
  where state = 'intended';

create table delegation_pull_requests (
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  repository_binding_id uuid,
  number bigint not null check (number > 0),
  url text not null,
  branch text not null,
  base_branch text not null,
  head_sha text,
  state text not null default 'open' check (state in ('open','closed','merged')),
  ready boolean not null default false,
  review_decision text,
  mergeable text,
  checks jsonb not null default '[]'::jsonb check (jsonb_typeof(checks) = 'array'),
  merged_at timestamptz,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (task_id, number),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, project_id, repository_binding_id)
    references repository_bindings(organization_id, project_id, id) on delete set null
);
create index delegation_pull_requests_task_idx on delegation_pull_requests(task_id, updated_at desc);

do $$
declare tab text;
begin
  foreach tab in array array['delegation_deliveries', 'delegation_pull_requests']
  loop
    execute format('alter table %I enable row level security', tab);
    execute format('alter table %I force row level security', tab);
    execute format(
      'create policy tenant_isolation on %I using (organization_id = maestrly_current_organization_id()) with check (organization_id = maestrly_current_organization_id())',
      tab
    );
  end loop;
  if exists (select 1 from pg_roles where rolname = 'maestrly_runtime') then
    grant select, insert, update, delete on delegation_deliveries, delegation_pull_requests to maestrly_runtime;
  end if;
end $$;
