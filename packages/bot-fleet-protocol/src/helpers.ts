export type FleetUrlResult = { ok: true; origin: string } | { ok: false; reason: string }

export function deriveBotId(name: string, existingIds: Iterable<string>): string {
  const normalized = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = normalized.slice(0, 32).replace(/-+$/g, '') || 'bot'
  const existing = new Set(existingIds)
  if (!existing.has(base)) return base
  for (let suffix = 2; ; suffix++) {
    const ending = '-' + suffix
    const stem = base.slice(0, 32 - ending.length).replace(/-+$/g, '')
    const candidate = stem + ending
    if (!existing.has(candidate)) return candidate
  }
}

export function isAllowedFleetUrl(input: string): FleetUrlResult {
  if (input !== input.trim()) return { ok: false, reason: 'URL contains surrounding whitespace' }
  if (/[?#]/.test(input)) return { ok: false, reason: 'URL must not contain a query or fragment' }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, reason: 'Invalid URL' }
  }
  const authority = input.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/)?.[1]
  if (authority?.includes('@')) return { ok: false, reason: 'URL must not contain credentials' }
  if (url.pathname !== '/') return { ok: false, reason: 'URL must have no path' }
  if (url.protocol === 'https:') return { ok: true, origin: url.origin }
  if (url.protocol !== 'http:') return { ok: false, reason: 'URL must use HTTPS or allowed HTTP' }

  const host = url.hostname.toLowerCase()
  const octets = host.split('.').map(Number)
  const isIpv4 = octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  const isLoopback = isIpv4 && octets[0] === 127
  const isTailnetIp = isIpv4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
  if (
    host === 'localhost' ||
    host === '[::1]' ||
    host === '::1' ||
    isLoopback ||
    isTailnetIp ||
    host.endsWith('.ts.net')
  ) {
    return { ok: true, origin: url.origin }
  }
  return { ok: false, reason: 'HTTP host is not loopback or tailnet' }
}

const CROCKFORD_ALPHABET = /^[0-9A-HJKMNP-TV-Z]{8}$/

export function normalizePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[-\s]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  return CROCKFORD_ALPHABET.test(code) ? code : null
}

export function formatPairingCode(input: string): string {
  const code = normalizePairingCode(input)
  if (!code) throw new Error('Invalid pairing code')
  return code.slice(0, 4) + '-' + code.slice(4)
}

export function summarizeText(input: string, max: number): string {
  if (!Number.isInteger(max) || max < 0) throw new RangeError('max must be a non-negative integer')
  if (max === 0) return ''
  const singleLine = input.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= max) return singleLine
  return singleLine.slice(0, max - 1).trimEnd() + '…'
}

const MESSAGE_PART_ID = /^(.*):(\d+)$/

/**
 * Transcript order, shared by the bot (pages) and the Mac (merges): by time, then by position. The items a chat
 * message produces share its time and have ids `<message>:<part index>`, so the index is compared as a number;
 * compared as text, `:10` sorted before `:2` and scrambled every turn with more than ten parts.
 */
export function compareFleetTranscriptItems(a: { id: string; at: string }, b: { id: string; at: string }): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  const left = MESSAGE_PART_ID.exec(a.id)
  const right = MESSAGE_PART_ID.exec(b.id)
  if (left && right && left[1] === right[1]) return Number(left[2]) - Number(right[2])
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}
