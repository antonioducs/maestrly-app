create or replace function maestrly_current_user_id()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.user_id', true), '')
$$;

create policy member_self_lookup on organization_members
  for select
  using (user_id = maestrly_current_user_id());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'maestrly_runtime') then
    grant execute on function maestrly_current_user_id() to maestrly_runtime;
  end if;
end $$;
