-- Shared runners retain NULL ownership; personal devices are never members of the shared pool.
alter table runners add column owner_user_id text;
alter table runners add column personal_enabled boolean not null default false;
alter table runners add constraint personal_device_enabled_owner check (not personal_enabled or owner_user_id is not null);
create index runners_personal_owner_idx on runners(organization_id,owner_user_id) where owner_user_id is not null;

-- Public native client: the device flow still requires explicit approval by the signed-in user.
insert into "oauthClient" (id,"clientId",name,"applicationType","tokenEndpointAuthMethod","grantTypes","redirectUris",scopes,disabled,"skipConsent","createdAt","updatedAt")
values ('maestrly-desktop-personal-v1','maestrly-desktop-personal-v1','Maestrly Desktop','native','none',
 '["urn:ietf:params:oauth:grant-type:device_code","refresh_token"]'::jsonb,'[]'::jsonb,
 '["openid","profile","email","offline_access","api:read","api:write"]'::jsonb,false,false,now(),now())
on conflict ("clientId") do nothing;
