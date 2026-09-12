alter table boards add column version bigint not null default 1;
alter table board_columns add column deleted_at timestamptz;
alter table cards add column deleted_at timestamptz;
alter table comments add column version bigint not null default 1;
alter table comments add column updated_at timestamptz not null default now();
alter table comments add column deleted_at timestamptz;
alter table repository_bindings add column base_branch text not null default 'main';
alter table repository_bindings add column disabled_at timestamptz;
alter table repository_bindings add column version bigint not null default 1;
alter table repository_bindings add column updated_at timestamptz not null default now();
alter table projects add column default_repository_binding_id uuid;
alter table projects add constraint projects_default_repository_fk foreign key (organization_id, id, default_repository_binding_id)
  references repository_bindings(organization_id, project_id, id) on delete restrict;
alter table execution_policies add column repository_branch text;
alter table runners add column repositories jsonb not null default '[]'::jsonb;
alter table runners add column repositories_seen_at timestamptz;

create table card_description_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  board_id uuid not null,
  card_id uuid not null,
  card_version bigint not null,
  body text not null,
  actor jsonb not null,
  created_at timestamptz not null default now(),
  unique(card_id, card_version),
  foreign key (organization_id, project_id, board_id, card_id) references cards(organization_id, project_id, board_id, id) on delete restrict
);
create index card_description_versions_scope_idx on card_description_versions(organization_id, card_id, card_version desc);
alter table card_description_versions enable row level security;
alter table card_description_versions force row level security;
create policy tenant_isolation on card_description_versions using (organization_id = maestrly_current_organization_id())
  with check (organization_id = maestrly_current_organization_id());

-- Seed the current description; versions before this migration cannot be reconstructed.
insert into card_description_versions(organization_id, project_id, board_id, card_id, card_version, body, actor)
select organization_id, project_id, board_id, id, version, description, '{"type":"system","service":"migration"}'::jsonb from cards;

create function record_card_description() returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' or old.description is distinct from new.description then
    insert into card_description_versions(organization_id, project_id, board_id, card_id, card_version, body, actor)
    values(new.organization_id, new.project_id, new.board_id, new.id, new.version, new.description,
      coalesce(nullif(current_setting('app.actor', true), '')::jsonb, '{"type":"system","service":"unknown"}'::jsonb))
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger record_card_description after insert or update of description on cards for each row execute function record_card_description();

do $$
begin
  if exists(select 1 from pg_roles where rolname = 'maestrly_runtime') then
    grant select, insert on card_description_versions to maestrly_runtime;
  end if;
end $$;
do $$
begin
  if exists(select 1 from pg_roles where rolname='maestrly_runtime') then
    revoke update,delete on domain_events from maestrly_runtime;
  end if;
end $$;
