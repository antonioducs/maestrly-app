import type { WebSearchProvider } from '../../../shared/web-search'
import type { WebSearchBackend, WebSearchBackendId, WebSearchOutcome, WebSearchRequest } from './types'

/** A configured key is an explicit choice, is faster, and does not spend subscription quota. */
export const AUTO_WEB_SEARCH_ORDER: readonly WebSearchBackendId[] = ['tavily', 'brave', 'chatgpt', 'duckduckgo']

export function webSearchBackendOrder(provider: WebSearchProvider): readonly WebSearchBackendId[] {
  if (provider === 'off') return []
  return provider === 'auto' ? AUTO_WEB_SEARCH_ORDER : [provider]
}

export interface WebSearchRun {
  backend: WebSearchBackend
  outcome: WebSearchOutcome
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Automatic mode tries each backend in order; an explicit provider never falls back. */
export async function runWebSearch(args: {
  provider: WebSearchProvider
  backends: Readonly<Record<WebSearchBackendId, WebSearchBackend>>
  request: WebSearchRequest
}): Promise<WebSearchRun> {
  const order = webSearchBackendOrder(args.provider)
  if (!order.length) throw new Error('Web search is turned off in Maestrly settings (Settings → Tools → Web search).')
  const failures: string[] = []
  for (const id of order) {
    const backend = args.backends[id]
    args.request.signal.throwIfAborted()
    if (!(await backend.available())) {
      if (args.provider !== 'auto') throw new Error(`${backend.label} is not available: ${backend.unavailableReason}.`)
      failures.push(`${backend.label}: ${backend.unavailableReason}`)
      continue
    }
    try {
      return { backend, outcome: await backend.search(args.request) }
    } catch (error) {
      args.request.signal.throwIfAborted()
      if (args.provider !== 'auto') throw error
      failures.push(`${backend.label}: ${message(error)}`)
    }
  }
  throw new Error(`Web search failed. ${failures.join('; ')}.`)
}
