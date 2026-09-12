alter table execution_policies drop constraint execution_policies_provider_check;
alter table execution_policies add constraint execution_policies_provider_check check(provider in ('codex','claude-agent','maestrly'));
