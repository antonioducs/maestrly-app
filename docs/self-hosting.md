# Self-hosting Maestrly

The platform services are independent from the desktop application. A local installation needs PostgreSQL, the API server, and the web application. Runners are enrolled separately and always initiate outbound connections.

[Project chat](project-chat.md) additionally requires an updated Maestrly desktop executor advertising `chat:interactive:v1`. Deploy its additive migration and API before the web bundle, then update and enable the executor. Existing CLI runners continue handling card jobs.

## Local installation

1. Copy `deploy/compose/.env.example` to `deploy/compose/.env`.
2. Generate independent random values for `POSTGRES_PASSWORD`, `MAESTRLY_DB_RUNTIME_PASSWORD`, and `BETTER_AUTH_SECRET`. The auth secret must contain at least 32 characters.
3. Keep the default canonical URLs for loopback-only use, then run:

   ```bash
   docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml up --build -d
   ```

4. Create the first owner with the controlled bootstrap command. It refuses to run after an organization exists:

   ```bash
   docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml run --rm \
     -e MAESTRLY_BOOTSTRAP_EMAIL -e MAESTRLY_BOOTSTRAP_PASSWORD server \
     node apps/server/dist/modules/auth/bootstrap.js
   ```

5. Open `http://127.0.0.1:4173`.

To connect a distributed desktop client, register a public native OAuth client while authenticated as an administrator, then paste the returned client ID into Desktop Settings → Platform:

```bash
MAESTRLY_ADMIN_EMAIL=owner@example.com MAESTRLY_ADMIN_PASSWORD='…' \
  npm run register-desktop-client --workspace @maestrly/server
```

The client has no secret, uses Device Authorization, requests an API audience and requires explicit browser consent.

The default Compose file publishes only loopback ports. For team use, place a TLS reverse proxy in front of `web` and `server`, use one canonical HTTPS origin, remove host port publication with `compose.production.yml`, and update both canonical URL variables. Forward only known proxy headers; the server does not trust arbitrary forwarded hosts.

Migrations are an explicit one-shot service and use a distinct migration credential. The API uses `maestrly_runtime`, which is not a table owner, superuser, or `BYPASSRLS` role.

## Updating

Back up the database and attachment volume first. Fetch the desired source revision, rebuild images, run the `migrate` service, then replace `server` and `web`. Do not run a newer server against a schema whose readiness check reports `schema_incompatible`.

Maestrly does not publish images, deploy infrastructure, or change desktop release channels as part of a source build.
