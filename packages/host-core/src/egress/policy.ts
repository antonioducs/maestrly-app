import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { NETWORK_PORTS, permitsDomain, isExactHostname, type NetworkPolicy } from '@maestrly/host-protocol'

export type Denial = { code: 'OFFLINE' | 'DOMAIN_DENIED' | 'PORT_DENIED' | 'LITERAL_IP' | 'INVALID_HOST' | 'ADDRESS_FORBIDDEN'; message: string }
/** Policy decision for a requested destination. Literal IPs are never allowed. */
export function decide(policy: NetworkPolicy, host: string, port: number): Denial | { host: string; port: number } {
  const lowered = host.trim().toLowerCase().replace(/\.$/, '')
  if (policy.mode === 'offline') return { code: 'OFFLINE', message: 'Este bot está sem acesso à internet' }
  if (isIP(lowered) || /^\[.*\]$/.test(lowered) || /^\d+$/.test(lowered) || /^0x/.test(lowered)) return { code: 'LITERAL_IP', message: 'Endereços IP literais não são permitidos' }
  if (!isExactHostname(lowered)) return { code: 'INVALID_HOST', message: 'Destino inválido' }
  if (!(NETWORK_PORTS as readonly number[]).includes(port)) return { code: 'PORT_DENIED', message: `Somente as portas ${NETWORK_PORTS.join(' e ')} são permitidas` }
  if (!permitsDomain(policy, lowered)) return { code: 'DOMAIN_DENIED', message: `O destino ${lowered} está bloqueado pela política deste bot` }
  return { host: lowered, port }
}
function parseIPv4(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined
  const octets = parts.map(Number)
  return octets.every((o) => o <= 255) ? octets : undefined
}
/** Normalizes IPv4-mapped/compatible IPv6 and other alternative representations to a canonical form. */
export function normalizeAddress(address: string): { family: 4 | 6; canonical: string; octets?: number[] } | undefined {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const kind = isIP(value)
  if (kind === 4) {
    const octets = parseIPv4(value)
    return octets ? { family: 4, canonical: octets.join('.'), octets } : undefined
  }
  if (kind !== 6) return undefined
  const mapped = /^(?:0*:)*:?(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value)
  if (mapped) {
    const octets = mapped[2]
      ? [
          Number.parseInt(mapped[1], 16) >> 8,
          Number.parseInt(mapped[1], 16) & 255,
          Number.parseInt(mapped[2], 16) >> 8,
          Number.parseInt(mapped[2], 16) & 255,
        ]
      : parseIPv4(mapped[1])
    return octets ? { family: 4, canonical: octets.join('.'), octets } : undefined
  }
  // Expand :: to a full 8-group form for stable prefix checks.
  const halves = value.split('::')
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const groups = halves.length > 1 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head
  if (groups.length !== 8) return undefined
  return { family: 6, canonical: groups.map((g) => g.padStart(4, '0')).join(':') }
}
const forbiddenV4 = (o: number[]) =>
  o[0] === 0 || // this network
  o[0] === 10 ||
  o[0] === 127 ||
  (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || // CGNAT
  (o[0] === 169 && o[1] === 254) || // link-local & metadata
  (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
  (o[0] === 192 && o[1] === 0 && o[2] === 0) ||
  (o[0] === 192 && o[1] === 0 && o[2] === 2) ||
  (o[0] === 192 && o[1] === 88 && o[2] === 99) ||
  (o[0] === 192 && o[1] === 168) ||
  (o[0] === 198 && (o[1] === 18 || o[1] === 19)) ||
  (o[0] === 198 && o[1] === 51 && o[2] === 100) ||
  (o[0] === 203 && o[1] === 0 && o[2] === 113) ||
  o[0] >= 224 // multicast, reserved, broadcast
export function isForbiddenAddress(address: string, hostAddresses: readonly string[] = localAddresses()): boolean {
  const normalized = normalizeAddress(address)
  if (!normalized) return true
  if (normalized.family === 4) return forbiddenV4(normalized.octets as number[]) || hostAddresses.includes(normalized.canonical)
  const c = normalized.canonical
  if (c === '0000:0000:0000:0000:0000:0000:0000:0000' || c === '0000:0000:0000:0000:0000:0000:0000:0001') return true
  const first = Number.parseInt(c.slice(0, 4), 16)
  if ((first & 0xfe00) === 0xfc00) return true // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true // link-local
  if ((first & 0xff00) === 0xff00) return true // multicast
  if (c.startsWith('2001:0db8')) return true // documentation
  if (c.startsWith('0064:ff9b')) return true // NAT64 well-known prefix maps to IPv4
  if (c.startsWith('2002:')) return true // 6to4 embeds IPv4
  if (first === 0) return true // ::/8 including compatible addresses
  return hostAddresses.some((a) => normalizeAddress(a)?.canonical === c)
}
export function localAddresses(): string[] {
  const result: string[] = []
  for (const list of Object.values(networkInterfaces())) for (const entry of list ?? []) result.push(normalizeAddress(entry.address)?.canonical ?? entry.address)
  return result
}
