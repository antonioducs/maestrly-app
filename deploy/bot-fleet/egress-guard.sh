#!/bin/bash
set -Eeuo pipefail

pick() {
  local tool
  for tool in "$1" "$1-legacy"; do
    if command -v "$tool" >/dev/null 2>&1 && "$tool" -w -S OUTPUT >/dev/null 2>&1; then
      printf '%s' "$tool"
      return 0
    fi
  done
  echo "[egress] No usable $1 command; refusing to start" >&2
  return 1
}

ipv4=$(pick iptables)
"$ipv4" -w -F OUTPUT
rules=0
"$ipv4" -w -A OUTPUT -o lo -j ACCEPT
"$ipv4" -w -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
rules=$((rules + 2))

default_routes=$(ip -4 route show default) || { echo '[egress] Cannot inspect the default IPv4 route' >&2; exit 1; }
while read -r destination via gateway rest; do
  if [[ "$destination" == default && "$via" == via && -n "$gateway" ]]; then
    "$ipv4" -w -A OUTPUT -d "$gateway" -j REJECT
    rules=$((rules + 1))
  fi
done <<< "$default_routes"

seen=' '
for hostname in host.docker.internal gateway.docker.internal host.internal host.lima.internal host.orb.internal; do
  while read -r address rest; do
    [[ "$address" == *.* ]] || continue
    if [[ "$seen" != *" $address "* ]]; then
      "$ipv4" -w -A OUTPUT -d "$address" -j REJECT
      rules=$((rules + 1))
      seen+="$address "
    fi
  done < <(getent ahostsv4 "$hostname" || true)
done

link_routes=$(ip -4 -o route show scope link) || { echo '[egress] Cannot inspect local IPv4 routes' >&2; exit 1; }
while read -r subnet rest; do
  [[ "$subnet" == */* ]] || continue
  "$ipv4" -w -A OUTPUT -d "$subnet" -j ACCEPT
  rules=$((rules + 1))
done <<< "$link_routes"

for subnet in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  "$ipv4" -w -A OUTPUT -d "$subnet" -j REJECT
  rules=$((rules + 1))
done

# A kernel without IPv6 fails this query and has no IPv6 traffic to guard.
global_ipv6=$(ip -6 -o addr show scope global 2>/dev/null) || global_ipv6=''
if [[ -n "$global_ipv6" ]]; then
  ipv6=$(pick ip6tables)
  "$ipv6" -w -F OUTPUT
  "$ipv6" -w -A OUTPUT -o lo -j ACCEPT
  "$ipv6" -w -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  "$ipv6" -w -A OUTPUT -p ipv6-icmp -j ACCEPT
  rules=$((rules + 3))
  # As with IPv4, the default gateway is the host side of the network and sits inside the accepted prefix.
  default_ipv6_routes=$(ip -6 route show default) || { echo '[egress] Cannot inspect the default IPv6 route' >&2; exit 1; }
  while read -r destination via gateway rest; do
    if [[ "$destination" == default && "$via" == via && -n "$gateway" ]]; then
      "$ipv6" -w -A OUTPUT -d "$gateway" -j REJECT
      rules=$((rules + 1))
    fi
  done <<< "$default_ipv6_routes"
  ipv6_routes=$(ip -6 -o route show) || { echo '[egress] Cannot inspect IPv6 routes' >&2; exit 1; }
  while read -r prefix rest; do
    [[ "$prefix" == */* && "$prefix" != fe80::/64 && " $rest " == *" proto kernel "* ]] || continue
    "$ipv6" -w -A OUTPUT -d "$prefix" -j ACCEPT
    rules=$((rules + 1))
  done <<< "$ipv6_routes"
  for prefix in ::1/128 fc00::/7 fe80::/10 ff00::/8; do
    "$ipv6" -w -A OUTPUT -d "$prefix" -j REJECT
    rules=$((rules + 1))
  done
fi

echo "[egress] Private networks blocked ($rules rules)" >&2
