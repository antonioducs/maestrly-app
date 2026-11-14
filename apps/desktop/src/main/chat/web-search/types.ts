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

/** List backends return hits; the subscription backends return the findings with their sources. */
export type WebSearchOutcome = { kind: 'results'; hits: WebSearchHit[] } | { kind: 'summary'; text: string }

export interface WebSearchBackend {
  id: WebSearchBackendId
  label: string
  /** Why the backend cannot run (missing key, no account); '' when always available. */
  unavailableReason: string
  /** Receives the request because a subscription account may be off limits to its conversation. */
  available: (request: WebSearchRequest) => boolean | Promise<boolean>
  search: (request: WebSearchRequest) => Promise<WebSearchOutcome>
}
