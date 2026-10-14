import { net } from 'electron'

export const WEB_SEARCH_HTTP_TIMEOUT_MS = 20_000

export async function webSearchFetch(
  label: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  opts: { keyed: boolean }
): Promise<Response> {
  const fetchImpl = net.fetch as unknown as typeof globalThis.fetch
  const res = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.any([signal, AbortSignal.timeout(WEB_SEARCH_HTTP_TIMEOUT_MS)]),
  })
  if (opts.keyed && (res.status === 401 || res.status === 403))
    throw new Error(`${label} rejected the API key (HTTP ${res.status}).`)
  if (res.status === 429) throw new Error(`${label} rate limit or quota exhausted (HTTP 429).`)
  if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}.`)
  return res
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Single-line, bounded text for result titles and snippets. */
export function cleanText(value: unknown, max = 500): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
