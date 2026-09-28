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
exec gosu node "$@"
