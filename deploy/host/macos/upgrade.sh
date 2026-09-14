#!/bin/sh
# Preserving upgrade of an installed Maestrly Host. Never deletes /Library/MaestrlyHost;
# keeps identity, state, catalogues and the running QEMU processes' runtime.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 022
fail() { printf '%s\n' "maestrly-host upgrade blocked: $1" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'macOS required'
[ "$(id -u)" = 0 ] || fail 'upgrade requires administrator privileges'
[ "$#" = 3 ] && [ "$1" = --authorize-upgrade ] || fail 'usage: --authorize-upgrade MANIFEST_SHA256 --window-confirmed'
manifest_sha=$2
[ "$3" = --window-confirmed ] || fail 'an authorized maintenance window must be confirmed explicitly'
printf '%s\n' "$manifest_sha" | grep -Eq '^[a-f0-9]{64}$' || fail 'invalid manifest SHA256'
base=/Library/MaestrlyHost
stage=/private/var/tmp/maestrly-host-package
plist=/Library/LaunchDaemons/com.maestrly.host.plist
[ -d "$base" ] && [ ! -L "$base" ] || fail 'no installation to upgrade; use install.sh for a fresh install'
[ "$(stat -f %u "$base")" = 0 ] || fail 'installation must be root owned'
[ -d "$stage" ] && [ ! -L "$stage" ] || fail 'root-owned staged package required'
[ -z "$(find "$stage" ! -user root -print -quit)" ] || fail 'package must be root owned'
[ -z "$(find "$stage" \( -perm -002 -o -perm -020 -o -type l \) -print -quit)" ] || fail 'package must not contain writable entries or symlinks'
for file in bin/maestrly-host runtime/bin/node app/cli.mjs etc/host.json install/check-upgrade.mjs install/verify-package.mjs install/check-compatibility.mjs manifest.json; do
 [ -f "$stage/$file" ] || fail "missing packaged artifact: $file"
done
"$stage/runtime/bin/node" "$stage/install/verify-package.mjs" "$stage" "$stage/manifest.json" "$manifest_sha" || fail 'package verification failed'
"$stage/runtime/bin/node" "$stage/install/check-compatibility.mjs" "$stage/manifest.json" || fail 'package compatibility failed'
MAESTRLY_UPGRADE_WINDOW=1 MAESTRLY_UPGRADE_BACKUP=1 "$stage/runtime/bin/node" "$stage/install/check-upgrade.mjs" "$stage" || fail 'upgrade preflight refused (active bots, quotas, downgrade or catalogue)'
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
backup="$base/backups/$stamp"
[ ! -e "$backup" ] || fail 'backup path already exists'
mkdir -p "$backup"
chmod 700 "$backup"
# Verify every retained artifact before stopping the service; record the actual operator config.
"$stage/runtime/bin/node" "$stage/install/check-upgrade.mjs" "$stage" --manifest "$backup/manifest.next.json" || fail 'retained installation integrity failed'
# Disconnect other clients for the window. Recheck immediately before stopping the daemon.
MAESTRLY_UPGRADE_WINDOW=1 MAESTRLY_UPGRADE_BACKUP=1 "$stage/runtime/bin/node" "$stage/install/check-upgrade.mjs" "$stage" > "$backup/preflight.json" || fail 'live evidence changed'
launchctl bootout system "$plist" || fail 'could not stop the service for a consistent backup'
trap 'launchctl bootstrap system "$plist" >/dev/null 2>&1 || true' EXIT
# launchd abandons the QEMU process group. Never copy disks while a guest may be alive.
# Treat pgrep errors as unknown, rather than idle.
if pgrep -u _maestrlyhost -f 'qemu-system' >/dev/null; then
 fail 'QEMU remains alive; shut down guests and retry'
else
 code=$?
 [ "$code" = 1 ] || fail 'cannot establish QEMU process state'
fi
[ -f "$base/state/host.sqlite" ] || fail 'installed SQLite database missing'
# Copy all state (guest disks, identity, bot data and WAL) while offline, retaining ownership.
# sqlite3 also produces a portable consistent database for explicit restore.
ditto "$base/state" "$backup/state"
sqlite3 "$base/state/host.sqlite" ".backup '$backup/host.sqlite'" || fail 'SQLite backup failed; installation unchanged'
[ "$(sqlite3 "$backup/host.sqlite" 'PRAGMA integrity_check;')" = ok ] || fail 'backup integrity check failed'
for directory in app bin install etc; do
 ditto "$base/$directory" "$backup/$directory"
done
cp -p "$base/manifest.json" "$backup/manifest.json"
cp -p "$plist" "$backup/launchd.plist"
# Stage before modifying the live code. Runtime and all catalogues remain byte-for-byte intact.
new="$base/app.new-$stamp"
ditto "$stage/app" "$new"
# From this point failures leave the daemon OFF; never start partially upgraded code.
trap 'printf "%s\n" "Upgrade interrupted; service left offline. Restore from $backup before starting it." >&2' EXIT
mv "$base/app" "$base/app.previous-$stamp"
mv "$new" "$base/app"
ditto "$stage/bin" "$base/bin"
ditto "$stage/install" "$base/install"
cp -p "$backup/manifest.next.json" "$base/manifest.json"
chown -R root:wheel "$base/app" "$base/bin" "$base/install" "$base/manifest.json"
chmod -R a+rX,go-w "$base/app" "$base/bin" "$base/install" "$base/manifest.json"
launchctl bootstrap system "$plist" || fail "service did not start; restore from $backup"
trap - EXIT
# Bounded health verification through the same fixed RPC transport.
attempt=0
until "$base/runtime/bin/node" --input-type=module -e 'import { liveRpc } from "/Library/MaestrlyHost/install/check-upgrade.mjs"; const host = liveRpc("host.inspect"); if (host?.health !== "ready") process.exit(1)' >/dev/null 2>&1; do
 attempt=$((attempt + 1))
 [ "$attempt" -lt 10 ] || fail "service health unverified; inspect locally and restore from $backup if needed"
 sleep 1
done
printf '%s\n' "Upgraded. Offline state backup: $backup. Runtime and configuration preserved. Verify and restart authorized guests explicitly."
