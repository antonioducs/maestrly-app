alter table board_columns add column role text not null default 'normal' check(role in ('backlog','normal','done'));
alter table boards add column roles_configured boolean not null default false;
alter table boards add column automation_limits jsonb not null default '{}'::jsonb;
alter table execution_policies add column automation_config jsonb;
alter table runners add column automation_capabilities jsonb;
alter table runners add column automation_seen_at timestamptz;

-- Only recognize unambiguous existing system endpoints in their boundary positions.
with candidates as (
  select board_id,
    count(*) filter(where lower(name) in ('backlog','to do','a fazer')) as backs,
    count(*) filter(where lower(name) in ('done','concluído','concluido')) as dones,
    min(position) as first_position,max(position) as last_position
  from board_columns where deleted_at is null group by board_id
), matched as (
  select c.id,case when lower(c.name) in ('backlog','to do','a fazer') and c.position=x.first_position then 'backlog'
    when lower(c.name) in ('done','concluído','concluido') and c.position=x.last_position then 'done' end as role
  from board_columns c join candidates x on x.board_id=c.board_id
  where x.backs=1 and x.dones=1 and c.deleted_at is null
)
update board_columns c set role=m.role from matched m where c.id=m.id and m.role is not null;
update boards b set roles_configured=true where exists(select 1 from board_columns c where c.board_id=b.id and c.role='backlog' and c.deleted_at is null)
 and exists(select 1 from board_columns c where c.board_id=b.id and c.role='done' and c.deleted_at is null);
-- Partial recognition is not enough: leave the board untouched for explicit configuration.
update board_columns c set role='normal' where not exists(select 1 from boards b where b.id=c.board_id and b.roles_configured);
create unique index board_backlog_role_idx on board_columns(board_id) where role='backlog' and deleted_at is null;
create unique index board_done_role_idx on board_columns(board_id) where role='done' and deleted_at is null;

create table card_automation_overrides(
 organization_id uuid not null,project_id uuid not null,board_id uuid not null,card_id uuid not null,column_id uuid not null,
 config jsonb not null,version bigint not null default 1,updated_at timestamptz not null default now(),
 primary key(card_id,column_id),
 foreign key(organization_id,project_id,board_id,card_id) references cards(organization_id,project_id,board_id,id) on delete restrict,
 foreign key(organization_id,project_id,board_id,column_id) references board_columns(organization_id,project_id,board_id,id) on delete restrict
);
create table automation_dispatch_guards(
 organization_id uuid not null,project_id uuid not null,board_id uuid not null,card_id uuid not null,column_id uuid not null,
 dispatch_count integer not null default 0,window_started_at timestamptz not null default now(),blocked_at timestamptz,
 primary key(card_id,column_id),
 foreign key(organization_id,project_id,board_id,card_id) references cards(organization_id,project_id,board_id,id) on delete restrict,
 foreign key(organization_id,project_id,board_id,column_id) references board_columns(organization_id,project_id,board_id,id) on delete restrict
);
do $$
declare tab text;
begin
 foreach tab in array array['card_automation_overrides','automation_dispatch_guards'] loop
  execute format('alter table %I enable row level security',tab);
  execute format('alter table %I force row level security',tab);
  execute format('create policy tenant_isolation on %I using (organization_id=maestrly_current_organization_id()) with check(organization_id=maestrly_current_organization_id())',tab);
  if exists(select 1 from pg_roles where rolname='maestrly_runtime') then
   execute format('grant select,insert,update,delete on %I to maestrly_runtime',tab);
  end if;
 end loop;
end $$;
