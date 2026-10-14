import { htmlToText } from '../tools/webfetch'
import { getWebSearchKey } from './settings'
import { cleanText, isHttpUrl, isRecord, webSearchFetch } from './http'
import type { WebSearchBackend, WebSearchHit } from './types'

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'
const LABEL = 'Brave Search'

/** Brave wraps matched terms in <strong>; extract text rather than trusting the markup. */
const plain = (value: unknown) => (typeof value === 'string' ? htmlToText(value) : '')

export function createBraveBackend(getKey: () => string | null = () => getWebSearchKey('brave')): WebSearchBackend {
  return {
    id: 'brave',
    label: LABEL,
    unavailableReason: 'add a Brave Search API key in Settings → Tools → Web search',
    available: () => Boolean(getKey()),
    search: async ({ query, maxResults, signal }) => {
      const key = getKey()
      if (!key) throw new Error('Add a Brave Search API key in Settings → Tools → Web search.')
      const params = new URLSearchParams({ q: query, count: String(maxResults) })
      const res = await webSearchFetch(
        LABEL,
        `${BRAVE_SEARCH_URL}?${params}`,
        { method: 'GET', headers: { Accept: 'application/json', 'X-Subscription-Token': key } },
        signal,
        { keyed: true }
      )
      const body: unknown = await res.json()
      const web = isRecord(body) && isRecord(body.web) ? body.web : null
      const results = web && Array.isArray(web.results) ? web.results : []
      const hits: WebSearchHit[] = results
        .filter(isRecord)
        .filter((r) => isHttpUrl(r.url))
        .map((r) => ({
          title: cleanText(plain(r.title), 200) || String(r.url),
          url: String(r.url),
          snippet: cleanText(plain(r.description)),
        }))
      return { kind: 'results', hits: hits.slice(0, maxResults) }
    },
  }
}
