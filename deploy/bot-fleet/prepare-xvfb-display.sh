#!/bin/sh
set -eu

display="${1:-:0}"
lock="${2:-/tmp/.X0-lock}"
socket="${3:-/tmp/.X11-unix/X0}"
if xdpyinfo -display "$display" >/dev/null 2>&1; then
  echo "[bot] X display $display is already active" >&2
  exit 1
fi
rm -f -- "$lock" "$socket"
