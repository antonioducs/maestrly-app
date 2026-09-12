alter table chat_sessions drop constraint chat_sessions_mode_check;
alter table chat_sessions add constraint chat_sessions_mode_check
  check(mode in ('chat','agent','plan','design','ask'));
alter table chat_sessions add column reasoning text
  check(reasoning is null or length(reasoning) between 1 and 191);
alter table chat_sessions add column fast_mode boolean not null default false;
alter table chat_sessions add column perm_mode text not null default 'ask'
  check(perm_mode in ('ask','auto','full'));
