import { getWebSearchKey } from './settings'
import { cleanText, isHttpUrl, isRecord, webSearchFetch } from './http'
import type { WebSearchBackend, WebSearchHit } from './types'

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
const LABEL = 'Tavily'

export function createTavilyBackend(getKey: () => string | null = () => getWebSearchKey('tavily')): WebSearchBackend {
  return {
    id: 'tavily',
    label: LABEL,
    unavailableReason: 'add a Tavily API key in Settings → Tools → Web search',
    available: () => Boolean(getKey()),
    search: async ({ query, maxResults, signal }) => {
      const key = getKey()
      if (!key) throw new Error('Add a Tavily API key in Settings → Tools → Web search.')
      const res = await webSearchFetch(
        LABEL,
        TAVILY_SEARCH_URL,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
        },
        signal,
        { keyed: true }
      )
      const body: unknown = await res.json()
      const results = isRecord(body) && Array.isArray(body.results) ? body.results : []
      const hits: WebSearchHit[] = results
        .filter(isRecord)
        .filter((r) => isHttpUrl(r.url))
        .map((r) => ({ title: cleanText(r.title, 200) || String(r.url), url: String(r.url), snippet: cleanText(r.content) }))
      return { kind: 'results', hits: hits.slice(0, maxResults) }
    },
  }
}
