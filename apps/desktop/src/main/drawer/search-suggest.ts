import { net } from 'electron'
import { isSearchSuggestEligible } from '../../shared/browser-omnibox'

/**
 * Google search suggestions for text typed in the drawer browser's address bar. Requests carry no cookies and do
 * not use the browser partition; a newer request from the same address bar cancels the previous one. Every failure
 * (offline, timeout, cancellation, unexpected body) yields an empty list.
 */

const ENDPOINT = 'https://suggestqueries.google.com/complete/search'
export const SEARCH_SUGGEST_TIMEOUT_MS = 1500
export const SEARCH_SUGGEST_LIMIT = 4

export type SuggestFetch = (url: string, init: RequestInit) => Promise<Response>

export function searchSuggestUrl(query: string, locale?: string): string {
  const params = new URLSearchParams({ client: 'chrome', ie: 'UTF-8', oe: 'UTF-8', q: query })
  if (locale && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale)) params.set('hl', locale)
  return `${ENDPOINT}?${params.toString()}`
}

/** Query suggestions from a `client=chrome` response, skipping navigation entries and repeats of the input. */
export function parseSearchSuggestions(body: unknown, query: string, limit = SEARCH_SUGGEST_LIMIT): string[] {
  if (!Array.isArray(body) || !Array.isArray(body[1])) return []
  const meta = body[4] && typeof body[4] === 'object' ? (body[4] as Record<string, unknown>) : null
  const rawTypes = meta ? meta['google:suggesttype'] : undefined
  const types: unknown[] | null = Array.isArray(rawTypes) ? rawTypes : null
  const seen = new Set([query.trim().toLowerCase()])
  const out: string[] = []
  for (const [index, value] of (body[1] as unknown[]).entries()) {
    if (out.length >= limit) break
    if (typeof value !== 'string') continue
    if (types && types[index] !== undefined && types[index] !== 'QUERY') continue
    const text = value.trim()
    if (!text || text.length > 200 || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    out.push(text)
  }
  return out
}

export async function fetchSearchSuggestions(
  query: string,
  options: { signal?: AbortSignal; locale?: string; fetch?: SuggestFetch; timeoutMs?: number } = {}
): Promise<string[]> {
  const text = query.trim()
  if (!isSearchSuggestEligible(text)) return []
  const fetchImpl: SuggestFetch = options.fetch ?? ((url, init) => net.fetch(url, init))
  const timeout = AbortSignal.timeout(options.timeoutMs ?? SEARCH_SUGGEST_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  try {
    const response = await fetchImpl(searchSuggestUrl(text, options.locale), {
      signal,
      credentials: 'omit',
      cache: 'no-store',
    })
    if (!response.ok) return []
    return parseSearchSuggestions(JSON.parse(await response.text()), text)
  } catch {
    return []
  }
}

const pending = new Map<number, AbortController>()

/** Suggestions for one address bar (keyed by its renderer); a newer request cancels the previous one. */
export function requestSearchSuggestions(
  key: number,
  query: string,
  locale?: string,
  fetchImpl?: SuggestFetch
): Promise<string[]> {
  pending.get(key)?.abort()
  const controller = new AbortController()
  pending.set(key, controller)
  return fetchSearchSuggestions(query, {
    signal: controller.signal,
    ...(locale ? { locale } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  }).finally(() => {
    if (pending.get(key) === controller) pending.delete(key)
  })
}
