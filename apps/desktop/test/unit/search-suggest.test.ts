import { describe, expect, it, vi } from 'vitest'
import {
  fetchSearchSuggestions,
  parseSearchSuggestions,
  requestSearchSuggestions,
  searchSuggestUrl,
  type SuggestFetch,
} from '../../src/main/drawer/search-suggest'

const BODY = [
  'oli',
  ['olivia rodrigo', 'https://www.olive.example/', 'oli', 'olivia rodrigo', 'oliver twist', 'olimpíadas', 'oliva'],
  ['', '', '', '', '', '', ''],
  [],
  { 'google:suggesttype': ['QUERY', 'NAVIGATION', 'QUERY', 'QUERY', 'QUERY', 'QUERY', 'QUERY'] },
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('search suggestions', () => {
  it('builds the suggestion URL and accepts only well-formed locales', () => {
    const url = new URL(searchSuggestUrl('olivia rodrigo', 'pt-BR'))
    expect(url.origin + url.pathname).toBe('https://suggestqueries.google.com/complete/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client: 'chrome',
      ie: 'UTF-8',
      oe: 'UTF-8',
      q: 'olivia rodrigo',
      hl: 'pt-BR',
    })
    expect(new URL(searchSuggestUrl('x', 'en&q=y')).searchParams.has('hl')).toBe(false)
  })

  it('keeps distinct query suggestions only, up to the limit', () => {
    expect(parseSearchSuggestions(BODY, 'oli')).toEqual(['olivia rodrigo', 'oliver twist', 'olimpíadas', 'oliva'])
    expect(parseSearchSuggestions(BODY, 'oli', 2)).toEqual(['olivia rodrigo', 'oliver twist'])
    expect(parseSearchSuggestions(['q', ['a', 7, 'b']], 'q')).toEqual(['a', 'b'])
    expect(parseSearchSuggestions({}, 'q')).toEqual([])
    expect(parseSearchSuggestions(['q', 'nope'], 'q')).toEqual([])
  })

  it('fetches without credentials and parses the response', async () => {
    const fetch = vi.fn<SuggestFetch>(async () => jsonResponse(BODY))
    await expect(fetchSearchSuggestions('  oli ', { fetch, locale: 'en' })).resolves.toEqual([
      'olivia rodrigo',
      'oliver twist',
      'olimpíadas',
      'oliva',
    ])
    const [url, init] = fetch.mock.calls[0]!
    expect(new URL(url).searchParams.get('q')).toBe('oli')
    expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('never contacts the service for URLs or local addresses', async () => {
    const fetch = vi.fn<SuggestFetch>(async () => jsonResponse(BODY))
    await expect(fetchSearchSuggestions('https://intranet.example/x', { fetch })).resolves.toEqual([])
    await expect(fetchSearchSuggestions('localhost:3000', { fetch })).resolves.toEqual([])
    await expect(fetchSearchSuggestions('', { fetch })).resolves.toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns no suggestions on HTTP errors, bad bodies, network failures, and timeouts', async () => {
    await expect(fetchSearchSuggestions('oli', { fetch: async () => jsonResponse(BODY, 503) })).resolves.toEqual([])
    await expect(
      fetchSearchSuggestions('oli', { fetch: async () => new Response('<html>', { status: 200 }) })
    ).resolves.toEqual([])
    await expect(
      fetchSearchSuggestions('oli', {
        fetch: async () => {
          throw new Error('offline')
        },
      })
    ).resolves.toEqual([])
    const hanging: SuggestFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
    await expect(fetchSearchSuggestions('oli', { fetch: hanging, timeoutMs: 10 })).resolves.toEqual([])
  })

  it('cancels the previous request of the same address bar only', async () => {
    const signals: AbortSignal[] = []
    const fetch: SuggestFetch = (_url, init) => {
      signals.push(init.signal!)
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        setTimeout(() => resolve(jsonResponse(BODY)), 20)
      })
    }
    const first = requestSearchSuggestions(1, 'oli', undefined, fetch)
    const other = requestSearchSuggestions(2, 'oli', undefined, fetch)
    const second = requestSearchSuggestions(1, 'olivia', undefined, fetch)

    await expect(first).resolves.toEqual([])
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
    await expect(other).resolves.toHaveLength(4)
    await expect(second).resolves.toHaveLength(4)
  })
})
