#!/bin/sh
set -eu
# MAESTRLY_BOT_INSTALL_ROOT is test-only. It prefixes destinations and skips system administration.
root=${MAESTRLY_BOT_INSTALL_ROOT:-}
bundle=
digest=
version=
fail() { echo "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || fail 'ARGUMENT_REQUIRED'
  case "$1" in
    --bundle) bundle=$2 ;;
    --sha256) digest=$2 ;;
    --version) version=$2 ;;
    *) fail 'UNKNOWN_ARGUMENT' ;;
  esac
  shift 2
done
[ -f "$bundle" ] && [ ! -L "$bundle" ] || fail 'BUNDLE_REQUIRED'
[ "${#digest}" -eq 64 ] || fail 'SHA256_REQUIRED'
case "$digest" in *[!a-f0-9]*) fail 'SHA256_REQUIRED' ;; esac
case "$version" in ''|*[!a-zA-Z0-9._-]*|.*) fail 'VERSION_REQUIRED' ;; esac
actual=$(sha256sum "$bundle")
actual=${actual%% *}
[ "$actual" = "$digest" ] || fail 'SHA256_MISMATCH'
case "$root" in ''|/*) ;; *) fail 'INSTALL_ROOT_MUST_BE_ABSOLUTE' ;; esac
# Check every ancestor, including existing final destinations.
safe() {
  check=$1
  while [ "$check" != / ] && [ -n "$check" ]; do
    [ ! -L "$check" ] || fail "SYMLINK_DESTINATION: $check"
    check=${check%/*}
  done
}
prefix() { printf '%s%s' "$root" "$1"; }
dest=$(prefix /opt/maestrly-bot)
staging="$dest.staging-$version"
previous="$dest.previous"
state=$(prefix /var/lib/maestrly-bot)
marker=$(prefix /var/lib/maestrly/bot-runtime)
home=$(prefix /home/maestrlybot)
for target in "$dest" "$staging" "$previous" "$state" "$state/installed.json" "$marker" "$marker/installed.json" "$home" "$home/workspace" "$(prefix /etc/udev/rules.d/90-maestrly-bot.rules)" "$(prefix /etc/sudoers.d/maestrly-bot)" "$(prefix /etc/systemd/system/maestrly-bot-runtime.service)" "$(prefix /etc/systemd/system/maestrly-bot-desktop.service)"; do safe "$target"; done
safe "$(prefix /etc/apparmor.d/maestrly-chromium)"
[ ! -e "$staging" ] || fail 'STAGING_EXISTS'
[ ! -e "$previous" ] || fail 'PREVIOUS_EXISTS: retain or move the previous installation before updating'
if [ -z "$root" ]; then
  getent group maestrlybot >/dev/null || groupadd --system maestrlybot
  id maestrlybot >/dev/null 2>&1 || useradd --system --gid maestrlybot --home-dir /home/maestrlybot --shell /usr/sbin/nologin maestrlybot
fi
mkdir -p "$home/workspace" "$state" "$marker" "$(dirname "$dest")"
chmod 0750 "$home/workspace"
chmod 0700 "$state" "$marker"
if [ -z "$root" ]; then chown maestrlybot:maestrlybot "$home" "$home/workspace" "$state"; fi
mkdir -m 0755 "$staging"
# Bundles are trusted, digest-verified private build products. Still reject path traversal.
tar -tf "$bundle" | while IFS= read -r entry; do
  case "$entry" in /*|../*|*/../*|*/..) fail 'UNSAFE_ARCHIVE_PATH' ;; esac
done
tar -xf "$bundle" -C "$staging"
# Reject extracted symlinks before publishing privileged executables.
[ -z "$(find "$staging" -type l -print)" ] || fail 'SYMLINK_IN_BUNDLE'
[ -f "$staging/install/install.sh" ] && [ -f "$staging/app/main.js" ] && [ -f "$staging/runtime/bin/node" ] || fail 'INVALID_BUNDLE'
mkdir -p "$staging/bin"
cp "$staging/install/maestrly-bot-helper.sh" "$staging/bin/maestrly-bot-helper"
chmod 0755 "$staging/bin/maestrly-bot-helper" "$staging/runtime/bin/node" "$staging/codex/bin/codex"
# A prepared image can omit the addon. Existing phase1 disks receive it in place.
if [ -f "$staging/offline-dependencies/SHA256SUMS" ] && [ -z "$root" ]; then
  sh "$staging/offline-dependencies/install.sh"
fi
# Archive ownership comes from the build machine, never from the guest trust model.
if [ -z "$root" ]; then chown -R root:root "$staging"; fi
chmod -R go-w "$staging"
if [ -e "$dest" ]; then mv "$dest" "$previous"; fi
if ! mv "$staging" "$dest"; then
  if [ -e "$previous" ]; then mv "$previous" "$dest"; fi
  fail 'PUBLISH_FAILED'
fi
mkdir -p "$(prefix /etc/udev/rules.d)" "$(prefix /etc/sudoers.d)" "$(prefix /etc/systemd/system)"
cp "$dest/install/90-maestrly-bot.rules" "$(prefix /etc/udev/rules.d/90-maestrly-bot.rules)"
cp "$dest/install/sudoers.d-maestrly-bot" "$(prefix /etc/sudoers.d/maestrly-bot)"
chmod 0440 "$(prefix /etc/sudoers.d/maestrly-bot)"
for unit in maestrly-bot-runtime.service maestrly-bot-desktop.service maestrly-bot-vm.service maestrly-bot-runtime@.service maestrly-bot-desktop@.service maestrly-bot-desktop-services@.service maestrly-bot-desktop-services@.socket; do
  cp "$dest/install/$unit" "$(prefix /etc/systemd/system)/$unit"
done
mkdir -p "$(prefix /etc/apparmor.d)"
cp "$dest/install/apparmor-maestrly-chromium" "$(prefix /etc/apparmor.d/maestrly-chromium)"
chmod 0644 "$(prefix /etc/apparmor.d/maestrly-chromium)"
if [ -z "$root" ]; then
  # Permit Chromium's own namespace sandbox at this root-owned path. Keep the
  # Ubuntu-wide unprivileged-userns restriction and Chromium sandbox enabled.
  /usr/sbin/apparmor_parser -r /etc/apparmor.d/maestrly-chromium
  udevadm control --reload-rules
  udevadm trigger
  systemctl daemon-reload
  if [ -f "$dest/session-capacity.json" ]; then
    # The surrounding Host preparation owns the authorized backup/maintenance window.
    # Existing session data stays in place for explicit supervisor adoption.
    systemctl disable --now maestrly-bot-runtime.service maestrly-bot-desktop.service
    chmod 0600 /dev/virtio-ports/org.maestrly.bot.control.0 /dev/virtio-ports/org.maestrly.bot.egress.0 /dev/virtio-ports/org.maestrly.bot.desktop.0 2>/dev/null || true
    printf '%s\n' 'SUBSYSTEM=="virtio-ports", ATTR{name}=="org.maestrly.bot.*", OWNER="root", GROUP="root", MODE="0600"' > /etc/udev/rules.d/90-maestrly-bot.rules
    udevadm control --reload-rules
    udevadm trigger --subsystem-match=virtio-ports
    systemctl enable maestrly-bot-vm.service
  else
    systemctl enable maestrly-bot-runtime.service maestrly-bot-desktop.service
  fi
fi
installed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
printf '{"version":"%s","sha256":"%s","installedAt":"%s"}\n' "$version" "$digest" "$installed_at" > "$marker/installed.json"
cp "$marker/installed.json" "$state/installed.json"
chmod 0600 "$marker/installed.json" "$state/installed.json"
if [ -z "$root" ]; then chown maestrlybot:maestrlybot "$state/installed.json"; fi
