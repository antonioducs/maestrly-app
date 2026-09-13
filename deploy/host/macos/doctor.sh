#!/bin/sh
# Audited read-only remote discovery. No installation, sudo, scans or SSH discovery.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
if [ -f /Library/MaestrlyHost/bin/maestrly-host ] && [ ! -L /Library/MaestrlyHost/bin/maestrly-host ]; then
  for entry in /Library/MaestrlyHost /Library/MaestrlyHost/bin /Library/MaestrlyHost/bin/maestrly-host /Library/MaestrlyHost/runtime /Library/MaestrlyHost/runtime/bin /Library/MaestrlyHost/runtime/bin/node /Library/MaestrlyHost/app /Library/MaestrlyHost/app/cli.mjs; do
    [ ! -L "$entry" ] && [ "$(/usr/bin/stat -f %u "$entry")" = 0 ] || exit 1
    mode=$(/usr/bin/stat -f %Lp "$entry")
    [ "$((0$mode & 022))" = 0 ] || exit 1
  done
  exec /Library/MaestrlyHost/bin/maestrly-host doctor
fi
[ "$(uname -s)" = Darwin ] || { printf '%s\n' '{"version":1,"status":"blocked","facts":{"platform":"unsupported","identity":null}}'; exit 2; }
identity=$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F '"' '/"IOPlatformUUID"/ {print $(NF-1)}')
model=$(sysctl -n hw.model)
version=$(sw_vers -productVersion)
memory=$(sysctl -n hw.memsize)
cpus=$(sysctl -n hw.physicalcpu)
filevault=$(fdesetup status 2>/dev/null || true)
case "$filevault" in "FileVault is On.") filevault=true;; "FileVault is Off.") filevault=false;; *) filevault=null;; esac
sleep_minutes=$(pmset -g custom | awk '$1=="sleep" && $2 ~ /^[0-9]+$/ {if ($2>max) max=$2; found=1} END {if(found) print max+0; else print "null"}')
disk_kib=$(df -Pk /Library | awk 'NR==2 {print $4}')
arch=$(sysctl -n hw.machine)
arm=$(sysctl -n hw.optional.arm64 2>/dev/null || true)
[ "$arm" != 1 ] || arch=arm64
translated=$(sysctl -n sysctl.proc_translated 2>/dev/null || true)
# Allowlisted values only reach JSON; unknown facts remain unavailable.
case "$identity" in *[!0-9a-fA-F-]*|'') exit 1;; esac
case "$model" in *[!A-Za-z0-9,._-]*|'') exit 1;; esac
case "$version" in *[!0-9.]*|'') exit 1;; esac
case "$cpus" in *[!0-9]*|'') exit 1;; esac
case "$memory" in *[!0-9]*|'') exit 1;; esac
case "$disk_kib" in *[!0-9]*|'') exit 1;; esac
case "$arch" in arm64|x86_64) ;; *) arch=unknown;; esac
case "$translated" in 1) translated=true;; 0) translated=false;; *) translated=null;; esac
printf '{"version":1,"status":"needs_action","facts":{"platform":"darwin","identity":"%s","model":"%s","macOS":"%s","physicalArch":"%s","translated":%s,"memoryMiB":%s,"freeDiskGiB":%s,"hvf":null,"physicalCpus":%s,"fileVault":%s,"sleepMinutes":%s,"runtimeSmoke":null},"reason":"Packaged host and signed HVF probe are not installed; hardware support remains unverified"}\n' "$identity" "$model" "$version" "$arch" "$translated" "$((memory / 1048576))" "$((disk_kib / 1048576))" "$cpus" "$filevault" "$sleep_minutes"
exit 2
