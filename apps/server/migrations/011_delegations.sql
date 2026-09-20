-- Delegation stages reuse the existing runner registry: an executor advertises its own additive
-- inventory (`delegation:stages:v1`) next to the chat inventory it already publishes.
alter table runners add column delegation_capabilities jsonb;
alter table runners add column delegation_seen_at timestamptz;

create table delegation_presets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  name text not null check (length(name) between 1 and 160),
  description text not null default '' check (length(description) <= 2000),
  version bigint not null default 1 check (version > 0),
  policy jsonb not null check (jsonb_typeof(policy) = 'object'),
  stages jsonb not null check (jsonb_typeof(stages) = 'array' and jsonb_array_length(stages) between 1 and 50),
  built_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, id),
  unique (organization_id, project_id, name),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade
);
create index delegation_presets_project_idx on delegation_presets(organization_id, project_id);

create table delegation_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  board_id uuid not null,
  card_id uuid not null,
  owner_user_id text not null,
  connection_id uuid,
  title text not null check (length(title) between 1 and 500),
  objective text not null default '' check (length(objective) <= 100000),
  acceptance_criteria jsonb not null default '[]'::jsonb check (jsonb_typeof(acceptance_criteria) = 'array'),
  executor_id uuid not null,
  workspace_key text not null check (length(workspace_key) between 1 and 191),
  base_branch text not null check (length(base_branch) between 1 and 240),
  repository_binding_id uuid,
  preset_id uuid,
  policy jsonb not null check (jsonb_typeof(policy) = 'object'),
  state text not null default 'draft' check (state in (
    'draft','queued','running','pausing','paused','waiting_input','waiting_review','watching',
    'needs_attention','completed','cancelling','cancelled','failed'
  )),
  blocker jsonb,
  settings_revision bigint not null default 1 check (settings_revision > 0),
  version bigint not null default 1 check (version > 0),
  event_sequence bigint not null default 0 check (event_sequence >= 0),
  pause_requested boolean not null default false,
  interrupt_requested boolean not null default false,
  -- Stage whose attempt must stop before the replacement configuration is admitted.
  interrupt_stage_id uuid,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, id),
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade,
  foreign key (organization_id, project_id, board_id, card_id)
    references cards(organization_id, project_id, board_id, id) on delete restrict,
  foreign key (organization_id, executor_id) references runners(organization_id, id) on delete restrict,
  foreign key (organization_id, project_id, repository_binding_id)
    references repository_bindings(organization_id, project_id, id) on delete restrict,
  foreign key (organization_id, project_id, preset_id)
    references delegation_presets(organization_id, project_id, id) on delete set null,
  foreign key (organization_id, connection_id)
    references connector_connections(organization_id, id) on delete set null
);
create index delegation_tasks_project_idx on delegation_tasks(organization_id, project_id, created_at desc, id desc);
create index delegation_tasks_card_idx on delegation_tasks(organization_id, project_id, card_id);
create index delegation_tasks_owner_idx on delegation_tasks(organization_id, owner_user_id);
create index delegation_tasks_executor_idx on delegation_tasks(executor_id);
create index delegation_tasks_connection_idx on delegation_tasks(connection_id) where connection_id is not null;
create index delegation_tasks_active_idx on delegation_tasks(organization_id, state)
  where state in ('queued','running','pausing','waiting_input','waiting_review','cancelling','watching');
-- One workspace has at most one live delegation writer.
create unique index delegation_tasks_one_writer_idx on delegation_tasks(executor_id, workspace_key)
  where state in ('queued','running','pausing','waiting_input','cancelling');

create table delegation_stages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  type text not null check (type in ('plan','implement','review','fix','qa','verify','deliver','inspect')),
  title text not null check (length(title) between 1 and 200),
  instructions text not null default '' check (length(instructions) <= 100000),
  position bigint not null check (position >= 0),
  depends_on jsonb not null default '[]'::jsonb check (jsonb_typeof(depends_on) = 'array'),
  settings jsonb,
  action jsonb,
  required_for_completion boolean not null default true,
  state text not null default 'pending' check (state in (
    'pending','queued','running','waiting_input','succeeded','failed','cancelled','interrupted','superseded'
  )),
  attempts bigint not null default 0 check (attempts >= 0),
  settings_revision bigint not null default 1 check (settings_revision > 0),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, task_id, id),
  unique (task_id, position),
  check ((settings is null) <> (type in ('plan','implement','review','fix','qa'))),
  check ((action is null) <> (type in ('verify','deliver','inspect'))),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade
);
create index delegation_stages_task_idx on delegation_stages(task_id, position);
create index delegation_stages_queue_idx on delegation_stages(task_id) where state in ('queued','running');

create table delegation_settings_revisions (
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  revision bigint not null check (revision > 0),
  /** Stage id to resolved settings; stage ids absent from the map keep their previous revision. */
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  reason text not null default '' check (length(reason) <= 500),
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  primary key (task_id, revision),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade
);

create table delegation_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  stage_id uuid not null,
  attempt bigint not null check (attempt > 0),
  state text not null default 'queued' check (state in (
    'queued','running','waiting_input','succeeded','failed','cancelled','interrupted','superseded'
  )),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  session_id uuid,
  turn_id uuid,
  receipt jsonb,
  code_revision jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (stage_id, attempt),
  unique (organization_id, project_id, id),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, project_id, task_id, stage_id)
    references delegation_stages(organization_id, project_id, task_id, id) on delete cascade
);
create index delegation_attempts_task_idx on delegation_attempts(task_id, created_at);
-- A stage never has two live attempts, and a chat turn belongs to at most one attempt.
create unique index delegation_attempts_one_active_idx on delegation_attempts(stage_id)
  where state in ('queued','running','waiting_input');
create unique index delegation_attempts_turn_idx on delegation_attempts(turn_id) where turn_id is not null;

create table delegation_commands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 191),
  actor_user_id text not null,
  connection_id uuid,
  command jsonb not null check (jsonb_typeof(command) = 'object'),
  expected_version bigint not null check (expected_version > 0),
  state text not null default 'received' check (state in ('received','pending','applied','failed')),
  result jsonb,
  error text check (error is null or length(error) <= 4000),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (task_id, idempotency_key),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade
);
create index delegation_commands_pending_idx on delegation_commands(task_id, created_at)
  where state in ('received','pending');

create table delegation_dependencies (
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  depends_on_task_id uuid not null,
  satisfied_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, project_id, depends_on_task_id)
    references delegation_tasks(organization_id, project_id, id) on delete restrict
);
create index delegation_dependencies_source_idx on delegation_dependencies(depends_on_task_id);

create table delegation_findings (
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  finding_id text not null check (length(finding_id) between 1 and 128),
  severity text not null check (severity in ('blocking','important','optional')),
  title text not null check (length(title) between 1 and 200),
  details text not null default '' check (length(details) <= 4000),
  paths jsonb not null default '[]'::jsonb check (jsonb_typeof(paths) = 'array'),
  recommendation text not null default '' check (length(recommendation) <= 2000),
  state text not null default 'open' check (state in ('open','fixed','accepted','reopened')),
  -- Revision the finding was raised against and the one that resolved it, so evidence cannot drift.
  raised_revision text not null,
  resolved_revision text,
  raised_stage_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (task_id, finding_id),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade
);
create index delegation_findings_open_idx on delegation_findings(task_id) where state in ('open','reopened');

create table delegation_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  stage_id uuid not null,
  attempt_id uuid not null,
  verdict text not null check (verdict in ('approved','changes_requested','blocked')),
  code_revision_digest text not null,
  criteria_coverage jsonb not null default '[]'::jsonb check (jsonb_typeof(criteria_coverage) = 'array'),
  notes text not null default '' check (length(notes) <= 4000),
  created_at timestamptz not null default now(),
  unique (attempt_id),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade,
  foreign key (organization_id, project_id, attempt_id)
    references delegation_attempts(organization_id, project_id, id) on delete cascade
);
create index delegation_reviews_task_idx on delegation_reviews(task_id, created_at);

create table delegation_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  sequence bigint not null check (sequence > 0),
  type text not null check (length(type) between 1 and 120),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  unique (task_id, sequence),
  foreign key (organization_id, project_id, task_id)
    references delegation_tasks(organization_id, project_id, id) on delete cascade
);
create index delegation_events_task_idx on delegation_events(task_id, sequence);

-- Stage conversations live in the existing chat queue so leases, cancellation, event upload and the
-- journal are shared. They are never listed as a person's private project chat.
alter table chat_sessions add column delegation_task_id uuid;
alter table chat_sessions add column delegation_stage_id uuid;
alter table chat_sessions add constraint chat_sessions_delegation_pair_check
  check ((delegation_task_id is null) = (delegation_stage_id is null));
alter table chat_sessions add constraint chat_sessions_delegation_stage_fkey
  foreign key (organization_id, project_id, delegation_task_id, delegation_stage_id)
  references delegation_stages(organization_id, project_id, task_id, id) on delete cascade;
create unique index chat_sessions_delegation_stage_idx on chat_sessions(delegation_stage_id)
  where delegation_stage_id is not null;
create index chat_sessions_delegation_task_idx on chat_sessions(delegation_task_id)
  where delegation_task_id is not null;

alter table delegation_attempts add constraint delegation_attempts_turn_fkey
  foreign key (organization_id, project_id, session_id, turn_id)
  references chat_turns(organization_id, project_id, session_id, id) on delete set null;

do $$
declare tab text;
begin
  foreach tab in array array[
    'delegation_presets','delegation_tasks','delegation_stages','delegation_settings_revisions',
    'delegation_attempts','delegation_commands','delegation_dependencies','delegation_events',
    'delegation_findings','delegation_reviews'
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
      delegation_presets, delegation_tasks, delegation_stages, delegation_settings_revisions,
      delegation_attempts, delegation_commands, delegation_dependencies, delegation_events,
      delegation_findings, delegation_reviews
      to maestrly_runtime;
  end if;
end $$;
