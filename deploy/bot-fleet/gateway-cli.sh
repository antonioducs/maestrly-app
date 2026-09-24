#!/bin/sh
# Operator CLI inside the gateway container, e.g.
#   docker compose exec maestrly-bot-gateway maestrly-bot-gateway pair
# `docker compose exec` runs as root: drop to the service user so the gateway's SQLite files stay owned by it.
set -eu
cd /app
if [ "$(id -u)" = 0 ]; then
  exec gosu node node /app/apps/bot-gateway/dist/main.js "$@"
fi
exec node /app/apps/bot-gateway/dist/main.js "$@"
