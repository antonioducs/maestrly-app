#!/bin/sh
set -eu

if [ -z "${MAESTRLY_DB_RUNTIME_PASSWORD:-}" ]; then
  echo "MAESTRLY_DB_RUNTIME_PASSWORD is required" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=runtime_password="$MAESTRLY_DB_RUNTIME_PASSWORD" <<'SQL'
create role maestrly_runtime login nosuperuser nocreatedb nocreaterole noinherit nobypassrls password :'runtime_password';
grant connect on database maestrly to maestrly_runtime;
SQL
