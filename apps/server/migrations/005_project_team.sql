alter table projects add column team_version bigint not null default 1;
alter table invitations add column project_id uuid;
alter table invitations add column project_role text check(project_role in ('viewer','contributor','maintainer'));
alter table invitations add column revoked_at timestamptz;
alter table invitations add constraint invitation_project_scope foreign key(organization_id,project_id) references projects(organization_id,id) on delete restrict;
alter table invitations add constraint invitation_project_role check((project_id is null and project_role is null) or (project_id is not null and project_role is not null and role='member'));
create index invitations_project_idx on invitations(organization_id,project_id,created_at);
