/**
 * Google Search grounding cites its sources as `grounding-api-redirect` links on Google's own host, which hide the
 * page and stop working after a while. Each one is swapped for the page it points to by reading the redirect's
 * Location header; the page itself is never requested. A link that cannot be resolved stays as it was.
 */
import { isHttpUrl } from './http'

export const GROUNDING_REDIRECT_TIMEOUT_MS = 5_000
/** Upper bound on lookups for one answer; links past it stay as redirects. */
const MAX_GROUNDING_REDIRECTS = 20
const GROUNDING_REDIRECT = /https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[A-Za-z0-9_\-=%.~]+/g

/** Parentheses would close a Markdown link early, and the answers use `[title](url)` links. */
const markdownSafe = (url: string) => url.replace(/\(/g, '%28').replace(/\)/g, '%29')

async function resolveGroundingRedirect(
  link: string,
  signal: AbortSignal,
  fetchImpl: typeof globalThis.fetch
): Promise<string | null> {
  try {
    const response = await fetchImpl(link, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(GROUNDING_REDIRECT_TIMEOUT_MS)]),
    })
    void response.body?.cancel().catch(() => undefined)
    if (response.status < 300 || response.status >= 400) return null
    const location = response.headers.get('location')
    if (!location) return null
    const target = new URL(location, link).href
    return isHttpUrl(target) ? markdownSafe(target) : null
  } catch {
    return null
  }
}

/**
 * Replaces the grounding redirect links in `text` with their targets, looking each distinct link up once. Uses
 * Node's fetch, as the runtime downloader does, because it exposes the Location header of a manual redirect.
 */
export async function resolveGroundingLinks(
  text: string,
  signal: AbortSignal,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<string> {
  const links = [...new Set(text.match(GROUNDING_REDIRECT) ?? [])].slice(0, MAX_GROUNDING_REDIRECTS)
  if (!links.length) return text
  const targets = new Map<string, string>()
  await Promise.all(
    links.map(async (link) => {
      const target = await resolveGroundingRedirect(link, signal, fetchImpl)
      if (target) targets.set(link, target)
    })
  )
  return text.replace(GROUNDING_REDIRECT, (link) => targets.get(link) ?? link)
}
