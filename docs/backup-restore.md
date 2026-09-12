# Backup and restore

A complete platform backup contains all three parts captured from one maintenance window:

1. a PostgreSQL custom-format dump;
2. the attachment/artifact volume; and
3. installation identity and secret configuration needed to validate existing sessions and tokens.

Example for the Compose installation:

```bash
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml stop server web
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml exec -T postgres \
  pg_dump -U maestrly_migrator -d maestrly -Fc > maestrly.pgdump
docker run --rm -v maestrly_attachments:/data:ro -v "$PWD":/backup alpine \
  tar -C /data -czf /backup/maestrly-attachments.tar.gz .
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml start server web
```

Store the `.env` values in a secrets manager, not in the backup directory. Encrypt backups at rest.

To validate restoration, create an empty installation, stop its application services, restore the database with `pg_restore --clean --if-exists`, restore the attachment archive, run explicit migrations, and start the services. Confirm readiness, sign-in, an authorized artifact download, and a runner reconnect. A database dump that references missing attachment keys is not a complete backup.

Never restore untrusted SQL using the runtime role. Use the migration owner only for the controlled restore window, then verify that `maestrly_runtime` remains `NOSUPERUSER NOBYPASSRLS` and does not own protected tables.
