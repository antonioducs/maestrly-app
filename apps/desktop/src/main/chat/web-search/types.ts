import type { WebSearchProvider } from '../../../shared/web-search'

export type WebSearchBackendId = Exclude<WebSearchProvider, 'auto' | 'off'>

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

export interface WebSearchRequest {
  query: string
  maxResults: number
  signal: AbortSignal
  conversationId: string
  cwd: string
}

/** List backends return hits; the ChatGPT backend returns the model's findings with their sources. */
export type WebSearchOutcome = { kind: 'results'; hits: WebSearchHit[] } | { kind: 'summary'; text: string }

export interface WebSearchBackend {
  id: WebSearchBackendId
  label: string
  /** Why the backend cannot run (missing key, no account); '' when always available. */
  unavailableReason: string
  available: () => boolean | Promise<boolean>
  search: (request: WebSearchRequest) => Promise<WebSearchOutcome>
}
