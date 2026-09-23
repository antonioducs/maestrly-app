#!/bin/sh
set -eu
socket="${MAESTRLY_GATEWAY_DOCKER_SOCKET:-/var/run/docker.sock}"
if [ -S "$socket" ]; then
  socket_gid="$(stat -c %g "$socket")"
  if ! getent group "$socket_gid" >/dev/null; then
    groupadd -g "$socket_gid" bot-docker
  fi
  socket_group="$(getent group "$socket_gid" | cut -d: -f1)"
  usermod -aG "$socket_group" node
fi
chown node:node /data
if [ "${MAESTRLY_GATEWAY_BOT_SECURITY_OPT:-auto}" = auto ]; then
  # The Engine API expects inline JSON, unlike the Docker CLI's seccomp=file syntax.
  MAESTRLY_GATEWAY_BOT_SECURITY_OPT="$(node -e 'const fs=require("node:fs"); const profile=JSON.parse(fs.readFileSync("/etc/maestrly-bot/seccomp-bot.json","utf8")); process.stdout.write(JSON.stringify(["seccomp="+JSON.stringify(profile)]))')"
  export MAESTRLY_GATEWAY_BOT_SECURITY_OPT
fi
exec gosu node "$@"
