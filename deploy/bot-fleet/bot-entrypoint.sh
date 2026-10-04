#!/bin/bash
set -Eeuo pipefail

if [[ "$(id -u)" == 0 ]]; then
  if [[ "${MAESTRLY_BOT_EGRESS:-open}" == public ]]; then
    /usr/local/bin/maestrly-egress-guard
    export MAESTRLY_EGRESS_GUARDED=1
  fi
  exec setpriv --reuid=1000 --regid=1000 --init-groups --bounding-set=-net_admin -- "$0" "$@"
fi
if [[ "${MAESTRLY_BOT_EGRESS:-open}" == public && "${MAESTRLY_EGRESS_GUARDED:-}" != 1 ]]; then
  echo '[bot] MAESTRLY_BOT_EGRESS=public needs the container to start as root; refusing to start without the network guard' >&2
  exit 1
fi

if [[ "${1:-}" == --session ]]; then
  shift
else
  exec dbus-run-session -- /usr/local/bin/bot-entrypoint --session "$@"
fi

# The environment display :0 is a 3x3 grid of 1280x800 tiles: tile 0 shows the environment screen (Maestrly's
# settings) and tile k the browser of the bot in slot k. openbox places the windows. Maestrly's display manager runs
# each bot's apps display (:1 to :8) and every VNC server.
readonly environment_screen=3840x2400x24
readonly electron=/opt/maestrly/node_modules/electron/dist/electron
readonly exit_wait_tenths=80

children=()
app_pid=''
sleep_pid=''

# Stops what a Maestrly process left running in its own session after it exited: the bots' apps displays (Xvfb, their
# D-Bus buses, openbox and tint2), the VNC servers and the other programs it started. Its replacement can then start
# the same displays again. The environment display, its window manager, the keyring and the environment's bus run in
# this script's session and are never touched.
stop_app_session() {
  local session="$1" tenth left
  [[ "$session" =~ ^[1-9][0-9]*$ ]] || return 0
  left=$(pgrep -c -s "$session" 2>/dev/null || true)
  [[ "$left" =~ ^[1-9][0-9]*$ ]] || return 0
  echo "[bot] Stopping $left programs left by Maestrly" >&2
  pkill -TERM -s "$session" 2>/dev/null || true
  for ((tenth = 0; tenth < exit_wait_tenths; tenth++)); do
    pgrep -s "$session" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  echo '[bot] Programs left by Maestrly did not exit; killing them' >&2
  pkill -KILL -s "$session" 2>/dev/null || true
}

# Waits a few seconds at most for a process to exit.
wait_for_exit() {
  local pid="$1" tenth
  for ((tenth = 0; tenth < exit_wait_tenths; tenth++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
}

stop() {
  trap - TERM INT
  if [[ -n "$sleep_pid" ]]; then kill "$sleep_pid" 2>/dev/null || true; fi
  if [[ -n "$app_pid" ]]; then
    kill -TERM "$app_pid" 2>/dev/null || true
    wait_for_exit "$app_pid"
    stop_app_session "$app_pid"
  fi
  for pid in "${children[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait || true
  exit 0
}
trap stop TERM INT

mkdir -p "$HOME/.config/tint2" "$HOME/.config/gtk-3.0" "$HOME/.local/share/keyrings"
# The bots' apps displays run tint2 with this configuration.
cp /opt/maestrly/tint2rc "$HOME/.config/tint2/tint2rc"
cat > "$HOME/.config/mimeapps.list" <<'MIME'
[Default Applications]
x-scheme-handler/http=maestrly-url.desktop
x-scheme-handler/https=maestrly-url.desktop
text/html=maestrly-url.desktop
text/plain=org.xfce.mousepad.desktop
MIME
# GTK 3 programs of the bots take their dark theme from GTK_THEME, which only the bots' programs get. The file manager is
# GTK 2 and reads this file; nothing else in the container does.
cat > "$HOME/.gtkrc-2.0" <<'GTK2'
gtk-theme-name = "Adwaita-dark"
gtk-icon-theme-name = "Adwaita"
gtk-font-name = "DejaVu Sans 10"
GTK2

if [[ -z "${MAESTRLY_BOT_KEYRING_PASSWORD:-}" ]]; then
  echo '[bot] MAESTRLY_BOT_KEYRING_PASSWORD is required for encrypted safeStorage' >&2
  exit 1
fi
# D-Bus session is already active. Unlock the persistent Secret Service collection.
printf '%s\n' "$MAESTRLY_BOT_KEYRING_PASSWORD" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
unset MAESTRLY_BOT_KEYRING_PASSWORD

/usr/local/bin/prepare-xvfb-display
Xvfb :0 -screen 0 "$environment_screen" -nolisten tcp -noreset & children+=("$!")
for _ in {1..50}; do
  if xdpyinfo -display :0 >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display :0 >/dev/null
openbox --config-file /opt/maestrly/openbox-environment-rc.xml & children+=("$!")

export MAESTRLY_BOT_MODE=1
export BROWSER=/usr/bin/chromium
while true; do
  # Maestrly runs in a session of its own, so everything it starts can be stopped once it exits. Without job control a
  # background command is never a process group leader, so setsid does not fork: the session id is Maestrly's pid.
  setsid "$electron" /opt/maestrly/apps/desktop --disable-gpu --password-store=gnome-libsecret "$@" &
  app_pid=$!
  wait "$app_pid" || true
  stop_app_session "$app_pid"
  app_pid=''
  echo '[bot] Maestrly exited; restarting in 3 seconds' >&2
  sleep 3 &
  sleep_pid=$!
  wait "$sleep_pid" || true
  sleep_pid=''
done
