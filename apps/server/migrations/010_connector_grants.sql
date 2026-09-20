-- External agent connections (Grok Bot and similar MCP clients). OAuth tokens stay in Better Auth
-- storage; this domain only records which projects and actions the owner authorized.
create table connector_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  owner_user_id text not null,
  client_id text not null check (length(client_id) between 1 and 191),
  name text not null check (length(name) between 1 and 160),
  cancel_on_revoke boolean not null default true,
  version bigint not null default 1 check (version > 0),
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, owner_user_id, client_id),
  foreign key (organization_id, owner_user_id)
    references organization_members(organization_id, user_id) on delete cascade
);
create index connector_connections_owner_idx on connector_connections(organization_id, owner_user_id);
create index connector_connections_client_idx on connector_connections(client_id) where revoked_at is null;

create table connector_project_grants (
  organization_id uuid not null,
  connection_id uuid not null,
  project_id uuid not null,
  actions jsonb not null check (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) > 0),
  created_at timestamptz not null default now(),
  primary key (organization_id, connection_id, project_id),
  foreign key (organization_id, connection_id)
    references connector_connections(organization_id, id) on delete cascade,
  foreign key (organization_id, project_id) references projects(organization_id, id) on delete cascade
);
create index connector_project_grants_project_idx on connector_project_grants(organization_id, project_id);
create index connector_project_grants_connection_idx on connector_project_grants(connection_id);

do $$
declare tab text;
begin
  foreach tab in array array['connector_connections', 'connector_project_grants']
  loop
    execute format('alter table %I enable row level security', tab);
    execute format('alter table %I force row level security', tab);
    execute format(
      'create policy tenant_isolation on %I using (organization_id = maestrly_current_organization_id()) with check (organization_id = maestrly_current_organization_id())',
      tab
    );
  end loop;
  if exists (select 1 from pg_roles where rolname = 'maestrly_runtime') then
    grant select, insert, update, delete on connector_connections, connector_project_grants to maestrly_runtime;
  end if;
end $$;
