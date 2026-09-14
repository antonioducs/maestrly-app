#!/bin/sh
set -eu
: "${DISPLAY:?}" "${XAUTHORITY:?}"
attempt=0
until /usr/bin/xdpyinfo >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 100 ] || { echo DESKTOP_NOT_READY >&2; exit 1; }
  sleep 0.1
done
