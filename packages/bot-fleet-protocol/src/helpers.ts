import type { FleetLoginKind } from './api.js'
import { FLEET_ENVIRONMENT_DISPLAY, FLEET_REASONING_QUERY, FLEET_UPDATE_BUSY_STATUSES } from './constants.js'
import type { FleetBot, FleetTranscriptItem } from './domain.js'
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

/** Whether a reader of transcripts or events asked for `reasoning` items (`transcript-reasoning`). */
export function fleetReaderWantsReasoning(search: URLSearchParams): boolean {
  return search.get(FLEET_REASONING_QUERY) === '1'
}

/** Whether a transcript item may go to a reader: `reasoning` items only to one that asked for them. */
export function fleetTranscriptItemReadable(item: Pick<FleetTranscriptItem, 'kind'>, reasoning: boolean): boolean {
  return reasoning || item.kind !== 'reasoning'
}

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

const MEMORY_INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u
const MEMORY_INJECTION = [
  /\bignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|messages)\b/i,
  /\bdisregard\s+(?:the\s+|all\s+)?(?:system|previous|prior)\s+(?:prompt|instructions)\b/i,
  /\bignor[ea]\s+(?:todas\s+)?(?:as\s+)?instru[cç](?:[oõ]es|[aã]o)\s+anteriores\b/i,
  /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:ba|z)?sh\b/i,
]
export type MemoryContentProblem = 'invisible-characters' | 'instruction-injection'
/** Memory text is replayed into prompts: reject hidden characters and blatant attempts to plant instructions. */
export function memoryContentProblem(text: string): MemoryContentProblem | null {
  if (MEMORY_INVISIBLE.test(text)) return 'invisible-characters'
  return MEMORY_INJECTION.some((pattern) => pattern.test(text)) ? 'instruction-injection' : null
}
/** Trim, fold tabs and runs of spaces, and keep at most one blank line between paragraphs. */
export function normalizeMemoryText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Whether restarting the bot's environment now would interrupt it: an environment update waits for such bots. */
export function fleetBotBlocksUpdate(bot: Pick<FleetBot, 'status'>): boolean {
  return (FLEET_UPDATE_BUSY_STATUSES as readonly string[]).includes(bot.status)
}

export type FleetScreenArea = { x: number; y: number; width: number; height: number }
/**
 * A tile of the environment display, in pixels: tile 0 holds the environment screen and tile k (1 to 8) the browser
 * of the bot in slot k. Tiles fill the display row by row.
 */
export function fleetEnvironmentTile(index: number): FleetScreenArea {
  const { columns, rows, width, height } = FLEET_ENVIRONMENT_DISPLAY
  if (!Number.isInteger(index) || index < 0 || index >= columns * rows)
    throw new RangeError('tile index must be an integer from 0 to ' + (columns * rows - 1))
  const tileWidth = width / columns
  const tileHeight = height / rows
  return {
    x: (index % columns) * tileWidth,
    y: Math.floor(index / columns) * tileHeight,
    width: tileWidth,
    height: tileHeight,
  }
}

/** True when a sign-in page belongs to the provider: the Mac opens nothing else a bot sends. */
export function fleetLoginUrlAllowed(kind: FleetLoginKind, value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  if (kind === 'codex') return url.origin === 'https://auth.openai.com'
  if (kind === 'claude')
    return ['https://claude.com', 'https://claude.ai', 'https://platform.claude.com'].includes(url.origin)
  return url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai')
}
/** The loopback redirect (`http://localhost:<port>/<path>`) an authorize URL sends the browser back to. */
export function fleetLoginCallbackFromAuthUrl(authUrl: string): { port: number; path: string } | null {
  try {
    const redirect = new URL(new URL(authUrl).searchParams.get('redirect_uri') ?? '')
    if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)) return null
    const port = Number(redirect.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return null
    return /^\/[A-Za-z0-9/_-]{0,100}$/.test(redirect.pathname) ? { port, path: redirect.pathname } : null
  } catch {
    return null
  }
}
