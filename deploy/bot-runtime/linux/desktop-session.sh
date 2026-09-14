#!/bin/sh
set -eu
if [ "${MAESTRLY_BOT_SESSION_REQUIRED:-}" = 1 ]; then
  : "${MAESTRLY_BOT_SESSION_ID:?}" "${MAESTRLY_BOT_STATE:?}" "${XAUTHORITY:?}"
fi
export DISPLAY=${DISPLAY:-:10}
export HOME=${HOME:-/home/maestrlybot}
config=${MAESTRLY_DESKTOP_CONFIG:-/opt/maestrly-bot/install}
# A private session bus keeps pcmanfm independent of a system desktop/login manager.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  exec dbus-run-session -- sh "$0"
fi
pids=
cleanup() {
  trap - EXIT HUP INT TERM
  [ -z "$pids" ] || kill $pids 2>/dev/null || true
  wait || true
}
trap cleanup EXIT
trap 'exit 0' HUP INT TERM
mkdir -p "$HOME/workspace" "$HOME/.config/openbox"
cp "$config/openbox-menu.xml" "$HOME/.config/openbox/menu.xml"
width=${MAESTRLY_DESKTOP_WIDTH:-1280}
height=${MAESTRLY_DESKTOP_HEIGHT:-800}
if [ -n "${MAESTRLY_BOT_SESSION_ID:-}" ]; then
  : "${MAESTRLY_BOT_STATE:?}" "${XAUTHORITY:?}"
  umask 077
  touch "$XAUTHORITY"
  cookie=$(/usr/bin/mcookie)
  /usr/bin/xauth -f "$XAUTHORITY" add "$DISPLAY" MIT-MAGIC-COOKIE-1 "$cookie"
  unset cookie
  /opt/maestrly-bot/runtime/bin/node -e 'process.stdout.write(require("node:crypto").randomUUID())' > "$MAESTRLY_BOT_STATE/desktop-generation"
  /usr/bin/Xvfb "$DISPLAY" -screen 0 "${width}x${height}x24" -nolisten tcp -auth "$XAUTHORITY" &
else
  /usr/bin/Xvfb "$DISPLAY" -screen 0 "${width}x${height}x24" -nolisten tcp &
fi
pids="$!"
attempt=0
until xdpyinfo >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 100 ] || exit 1
  sleep 0.1
done
/usr/bin/openbox --config-file "$config/openbox-rc.xml" &
pids="$pids $!"
/usr/bin/pcmanfm --no-desktop "$HOME/workspace" &
pids="$pids $!"
/usr/bin/xterm -title 'Maestrly Terminal' -e /bin/bash &
pids="$pids $!"
# Restart the service if the display or window manager dies. Applications can be
# closed and reopened from Openbox's right-click menu without ending the session.
set -- $pids
display_pid=$1
wm_pid=$2
while kill -0 "$display_pid" && kill -0 "$wm_pid"; do sleep 2; done
exit 1
