#!/bin/sh
# Fresh installation only. The administrator must stage a reviewed root-owned package.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 022
fail() { printf '%s\n' "maestrly-host install blocked: $1" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'macOS required'
[ "$(id -u)" = 0 ] || fail 'installation requires administrator privileges'
[ "$#" = 8 ] && [ "$1" = --authorize-install ] || fail 'explicit authorization, namespace, identity three caps, manifest SHA256 and operator choice required'
namespace=$2
expected_identity=$3
cpu_cap=$4
memory_cap=$5
disk_cap=$6
manifest_sha=$7
operator=$8
printf '%s\n' "$manifest_sha" | grep -Eq '^[a-f0-9]{64}$' || fail 'invalid manifest SHA256'
if [ "$operator" != --no-operator ]; then
 printf '%s\n' "$operator" | grep -Eq '^[a-z][a-z0-9_-]{0,30}$' || fail 'invalid operator'
 [ "$operator" != root ] && dscl . -read "/Users/$operator" UniqueID >/dev/null 2>&1 || fail 'operator must be an existing nonroot local account'
fi
printf '%s\n' "$namespace" | grep -Eq '^lab-[a-z0-9][a-z0-9-]{0,39}$' || fail 'invalid namespace'
printf '%s\n' "$expected_identity" | grep -Eiq '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' || fail 'invalid expected identity'
for cap in "$cpu_cap" "$memory_cap" "$disk_cap"; do
 case "$cap" in *[!0-9]*|'') fail 'invalid capacity';; esac
 [ "${#cap}" -le 7 ] && [ "$cap" -gt 0 ] || fail 'invalid capacity'
done
[ "$cpu_cap" -le 128 ] && [ "$memory_cap" -le 1048576 ] && [ "$disk_cap" -le 16384 ] || fail 'capacity exceeds limits'
actual_identity=$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F '"' '/"IOPlatformUUID"/ {print $(NF-1)}' | tr '[:lower:]' '[:upper:]')
[ "$actual_identity" = "$(printf '%s' "$expected_identity" | tr '[:lower:]' '[:upper:]')" ] || fail 'hardware identity mismatch'
physical_cpu=$(sysctl -n hw.physicalcpu)
physical_memory=$(sysctl -n hw.memsize)
free_disk=$(df -Pk /Library | awk 'NR==2 {print $4}')
for fact in "$physical_cpu" "$physical_memory" "$free_disk"; do
 case "$fact" in *[!0-9]*|'') fail 'physical capacity unavailable';; esac
done
[ "$cpu_cap" -le "$physical_cpu" ] && [ "$memory_cap" -le "$((physical_memory / 1048576))" ] && [ "$disk_cap" -le "$((free_disk / 1048576))" ] || fail 'caps exceed measured physical resources on /Library'
base=/Library/MaestrlyHost
stage=/private/var/tmp/maestrly-host-package
plist=/Library/LaunchDaemons/com.maestrly.host.plist
[ ! -e "$base" ] && [ ! -L "$base" ] || fail 'installation path already exists; upgrades require manual review'
[ ! -e "$plist" ] && [ ! -L "$plist" ] || fail 'launchd definition already exists'
! launchctl print system/com.maestrly.host >/dev/null 2>&1 || fail 'launchd service already loaded'
! dscl . -read /Users/_maestrlyhost >/dev/null 2>&1 || fail 'service account already exists'
! dscl . -read /Groups/_maestrlyhost >/dev/null 2>&1 || fail 'operator group already exists'
[ -d "$stage" ] && [ ! -L "$stage" ] || fail 'root-owned staged package required'
# Reject symlinks, hardlinks, special files and anything writable by a non-root user.
[ -z "$(find "$stage" ! -user root -print -quit)" ] || fail 'package must be root owned'
[ -z "$(find "$stage" \( -perm -002 -o -perm -020 -o -type l \) -print -quit)" ] || fail 'package must not contain writable entries or symlinks'
[ -z "$(find "$stage" ! -type f ! -type d -print -quit)" ] || fail 'package contains special files'
[ -z "$(find "$stage" -type f -links +1 -print -quit)" ] || fail 'package contains hardlinks'
for file in bin/maestrly-host bin/hvf-smoke runtime/bin/node app/cli.mjs etc/host.json install/com.maestrly.host.plist install/check-compatibility.mjs manifest.json; do
 [ -f "$stage/$file" ] || fail "missing packaged artifact: $file"
done
[ -x "$stage/bin/maestrly-host" ] && [ -x "$stage/bin/hvf-smoke" ] && [ -x "$stage/runtime/bin/node" ] || fail 'executables must be executable'
# Node is bootstrapped only after the administrator has established root ownership.
# The expected manifest digest comes from the explicit private local configuration.
"$stage/runtime/bin/node" --input-type=module - "$stage" "$manifest_sha" <<'VERIFY_PACKAGE'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export async function verifyPackage(directory, manifestPath, expectedHash) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw Error('Explicit manifest SHA256 required')
  const root = await lstat(directory)
  const info = await lstat(manifestPath)
  if (!root.isDirectory() || !info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) throw Error('Unsafe package manifest')
  if (await sha256(manifestPath) !== expectedHash) throw Error('Manifest checksum mismatch')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid manifest')
  const expected = new Map()
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(entry.path) || entry.path.split('/').some(p => !p || p === '.' || p === '..') || entry.path === 'manifest.json' || expected.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid manifest entry')
    expected.set(entry.path, entry.sha256)
  }
  async function walk(dir, prefix = '') {
    for (const name of await readdir(dir)) {
      const relative = prefix + name
      const path = resolve(dir, name)
      const stat = await lstat(path)
      if (stat.isDirectory()) await walk(path, relative + '/')
      else if (stat.isFile() && stat.nlink === 1) {
        const hash = relative === 'manifest.json' ? expectedHash : expected.get(relative)
        if (!hash || await sha256(path) !== hash) throw Error('Package checksum or inventory mismatch')
        expected.delete(relative)
      } else throw Error('Unsafe package entry')
    }
  }
  await walk(directory)
  if (expected.size || await sha256(resolve(directory, 'manifest.json')) !== expectedHash) throw Error('Incomplete package')
  return manifest
}
await verifyPackage(process.argv[2], resolve(process.argv[2], 'manifest.json'), process.argv[3])
VERIFY_PACKAGE
"$stage/runtime/bin/node" "$stage/install/check-compatibility.mjs" "$stage/manifest.json" || fail 'package does not support this physical Mac or macOS version'
codesign --verify --strict "$stage/bin/hvf-smoke" || fail 'HVF helper signature invalid'
# Reserve an unused local system identity. Existing identities are never modified.
service_id=450
while [ "$service_id" -lt 500 ]; do
 if ! dscl . -list /Users UniqueID | awk '{print $NF}' | grep -qx "$service_id" && ! dscl . -list /Groups PrimaryGroupID | awk '{print $NF}' | grep -qx "$service_id"; then break; fi
 service_id=$((service_id + 1))
done
[ "$service_id" -lt 500 ] || fail 'no free dedicated system identity'
# Atomic directory creation refuses a concurrent or pre-existing installation.
mkdir -m 755 "$base" || fail 'cannot reserve installation path'
# Failure deliberately leaves evidence for an administrator; never recursively clean unknown state.
ditto "$stage" "$base"
"$base/runtime/bin/node" --input-type=module - "$base/etc/host.json" "$cpu_cap" "$memory_cap" "$disk_cap" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [path,cpus,memoryMiB,diskGiB]=process.argv.slice(2);
const value=JSON.parse(readFileSync(path,'utf8'));
if(!Array.isArray(value.runtimes)||!Array.isArray(value.images))throw Error('Explicit asset catalogues required');
if(Object.keys(value).some(key=>!['runtimes','images','templates','accounts','stateDirectory','capacity'].includes(key)))throw Error('Unknown service option');
value.stateDirectory='/Library/MaestrlyHost/state';
value.capacity={cpus:Number(cpus),memoryMiB:Number(memoryMiB),diskGiB:Number(diskGiB)};
writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o644});
JS
printf '%s\n' "$namespace" > "$base/etc/namespace"
dscl . -create /Groups/_maestrlyhost
dscl . -create /Groups/_maestrlyhost PrimaryGroupID "$service_id"
dscl . -create /Groups/_maestrlyhost RealName 'Maestrly Host operators'
if [ "$operator" != --no-operator ]; then
 dseditgroup -o edit -a "$operator" -t user _maestrlyhost
fi
dscl . -create /Users/_maestrlyhost
dscl . -create /Users/_maestrlyhost UniqueID "$service_id"
dscl . -create /Users/_maestrlyhost PrimaryGroupID "$service_id"
dscl . -create /Users/_maestrlyhost UserShell /usr/bin/false
dscl . -create /Users/_maestrlyhost NFSHomeDirectory /var/empty
dscl . -create /Users/_maestrlyhost IsHidden 1
dscl . -create /Users/_maestrlyhost Password '*'
chown -R root:wheel "$base"
chmod -R a+rX,go-w "$base"
mkdir -m 700 "$base/state" "$base/log"
mkdir -m 750 "$base/run"
chown _maestrlyhost:_maestrlyhost "$base/state" "$base/log" "$base/run"
# Run hardware probe with the daemon identity; no root VM runtime.
sudo -n -u _maestrlyhost "$base/bin/hvf-smoke" || fail 'HVF smoke failed as dedicated user; installation remains unloaded'
install -o root -g wheel -m 644 "$base/install/com.maestrly.host.plist" "$plist"
launchctl bootstrap system "$plist"
printf '%s\n' 'Installed. Reconnect the selected operator SSH session to refresh group membership. --no-operator leaves access intentionally disabled.'
