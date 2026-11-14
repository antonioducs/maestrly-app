/**
 * Google AI-subscription web search: the Antigravity ACP server's built-in `search_web` (Google Search grounding) in
 * a throwaway session on the first signed-in Google AI account this conversation may use, as image generation picks
 * one. The grounded answer's redirect links are resolved to the pages they cite. Runtime modules load dynamically to
 * keep the tool registry lightweight.
 */
import { resolveGroundingLinks } from './grounding-links'
import type { WebSearchBackend, WebSearchRequest } from './types'

export const GOOGLE_SEARCH_TIMEOUT_MS = 90_000

async function googleAccount(conversationId: string): Promise<{ accountId: string | null } | null> {
  const { antigravityHelperAccount } = await import('../image-gen')
  return antigravityHelperAccount(conversationId)
}

export async function searchWebWithGoogle(request: WebSearchRequest): Promise<{ kind: 'summary'; text: string }> {
  const account = await googleAccount(request.conversationId)
  if (!account) throw new Error('Connect a Google AI account in Maestrly settings to search with Google AI.')
  const [{ getAntigravitySubscriptionManager }, { searchWebWithAntigravityRuntime }] = await Promise.all([
    import('../antigravity-subscription/manager'),
    import('../antigravity-subscription/web-search'),
  ])
  const manager = getAntigravitySubscriptionManager(account.accountId)
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(GOOGLE_SEARCH_TIMEOUT_MS)])
  const { text } = await searchWebWithAntigravityRuntime({
    manager,
    accountIdentity: manager.getAccountIdentity(),
    query: request.query,
    signal,
  })
  const resolved = await resolveGroundingLinks(text, signal)
  request.signal.throwIfAborted()
  return { kind: 'summary', text: resolved }
}

export function createGoogleBackend(): WebSearchBackend {
  return {
    id: 'google',
    label: 'Google AI',
    unavailableReason: 'connect a Google AI account in Settings → Accounts',
    available: async (request) => (await googleAccount(request.conversationId)) !== null,
    search: searchWebWithGoogle,
  }
}
