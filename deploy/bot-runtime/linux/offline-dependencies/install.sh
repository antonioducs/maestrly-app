#!/bin/sh
# Apply a digest-verified addon directory without repositories or downloads.
set -eu
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] || { echo ROOT_REQUIRED >&2; exit 1; }
. /etc/os-release
[ "$ID:$VERSION_ID:$(dpkg --print-architecture)" = ubuntu:24.04:arm64 ] || { echo UNSUPPORTED_GUEST >&2; exit 1; }
sha256sum -c SHA256SUMS
# Empty source lists and --no-download make missing closure a hard error.
export DEBIAN_FRONTEND=noninteractive
apt-get -y --no-download --no-remove --no-install-recommends -o Dir::Cache::archives="$PWD/debs" -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=- -o Dpkg::Options::=--force-confold install "$PWD"/debs/*.deb
while IFS="$(printf '\t')" read -r package version; do
  [ "$(dpkg-query -W -f='${Version}' "$package")" = "$version" ] || { echo "VERSION_MISMATCH: $package" >&2; exit 1; }
done < expected.tsv
[ -z "$(dpkg --audit)" ] || { echo DPKG_AUDIT_FAILED >&2; exit 1; }
