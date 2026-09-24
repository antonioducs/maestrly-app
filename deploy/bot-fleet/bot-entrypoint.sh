#!/bin/bash
set -Eeuo pipefail

if [[ "${1:-}" == --session ]]; then
  shift
else
  exec dbus-run-session -- /usr/local/bin/bot-entrypoint --session "$@"
fi

children=()
stop() {
  trap - TERM INT
  for pid in "${children[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait || true
  exit 0
}
trap stop TERM INT

mkdir -p "$HOME/.config/tint2" "$HOME/.config/gtk-3.0" "$HOME/.local/share/keyrings"
cp /opt/maestrly/tint2rc "$HOME/.config/tint2/tint2rc"
cat > "$HOME/.config/mimeapps.list" <<'MIME'
[Default Applications]
x-scheme-handler/http=chromium.desktop
x-scheme-handler/https=chromium.desktop
text/html=chromium.desktop
MIME

if [[ -z "${MAESTRLY_BOT_KEYRING_PASSWORD:-}" ]]; then
  echo '[bot] MAESTRLY_BOT_KEYRING_PASSWORD is required for encrypted safeStorage' >&2
  exit 1
fi
# D-Bus session is already active. Unlock the persistent Secret Service collection.
printf '%s\n' "$MAESTRLY_BOT_KEYRING_PASSWORD" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
unset MAESTRLY_BOT_KEYRING_PASSWORD

/usr/local/bin/prepare-xvfb-display
Xvfb :0 -screen 0 1280x800x24 -nolisten tcp -noreset & children+=("$!")
for i in {1..50}; do
  if xdpyinfo -display :0 >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display :0 >/dev/null
openbox --config-file /opt/maestrly/openbox-rc.xml & children+=("$!")
tint2 -c "$HOME/.config/tint2/tint2rc" & children+=("$!")
# -nocursorshape draws the X cursor into framebuffer updates for passive viewers.
x11vnc -display :0 -rfbport 5900 -localhost -forever -shared -nopw -cursor arrow -nocursorshape -nocursorpos -noxfixes -quiet & children+=("$!")
x11vnc -display :0 -rfbport 5901 -localhost -forever -shared -nopw -viewonly -cursor arrow -nocursorshape -nocursorpos -noxfixes -quiet & children+=("$!")

export MAESTRLY_BOT_MODE=1
export BROWSER=/usr/bin/chromium
while true; do
  /opt/maestrly/node_modules/electron/dist/electron /opt/maestrly/apps/desktop \
    --disable-gpu --password-store=gnome-libsecret "$@" &
  app_pid=$!
  children+=("$app_pid")
  wait "$app_pid" || true
  echo '[bot] Maestrly exited; restarting in 3 seconds' >&2
  sleep 3 & sleep_pid=$!; children+=("$sleep_pid")
  wait "$sleep_pid" || true
done
