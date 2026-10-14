import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { BROWSER_UA } from '../tools/webfetch'
import { cleanText, isHttpUrl, webSearchFetch } from './http'
import type { WebSearchBackend, WebSearchHit } from './types'

const DUCKDUCKGO_HTML_URL = 'https://html.duckduckgo.com/html/'
const LABEL = 'DuckDuckGo'
const BOT_CHECK = /anomaly-modal|anomaly\.js|challenge-form/i

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

const isElement = (node: Node): node is Element => 'tagName' in node

function classes(element: Element): string[] {
  return (element.attrs.find((attr) => attr.name === 'class')?.value ?? '').split(/\s+/).filter(Boolean)
}

/** First descendant (or the root itself) matching the predicate; iterative for untrusted, deeply nested markup. */
function find(root: Node, match: (element: Element) => boolean): Element | null {
  const pending: Node[] = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (isElement(node) && match(node)) return node
    if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i])
  }
  return null
}

function textOf(root: Node): string {
  const chunks: string[] = []
  const pending: Node[] = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (node.nodeName === '#text' && 'value' in node) chunks.push(node.value)
    else if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i])
  }
  return chunks.join('')
}

/** DuckDuckGo's own hosts only: a suffix match would also accept look-alikes such as `evilduckduckgo.com`. */
function isDuckDuckGoHost(hostname: string): boolean {
  return hostname === 'duckduckgo.com' || hostname.endsWith('.duckduckgo.com')
}

/** Result links go through `//duckduckgo.com/l/?uddg=<target>`; return the target. */
function resultUrl(href: string): string | null {
  let url: URL
  try {
    url = new URL(href, 'https://duckduckgo.com')
  } catch {
    return null
  }
  const target = isDuckDuckGoHost(url.hostname) && url.pathname === '/l/' ? url.searchParams.get('uddg') : href
  if (!isHttpUrl(target)) return null
  if (isDuckDuckGoHost(new URL(target).hostname)) return null
  return target
}

export function parseDuckDuckGoHtml(html: string): WebSearchHit[] {
  const hits: WebSearchHit[] = []
  const seen = new Set<string>()
  const pending: Node[] = [parse(html)]
  while (pending.length) {
    const node = pending.pop()!
    if (isElement(node)) {
      const names = classes(node)
      if (names.includes('result')) {
        // A result block never contains another one; ads are skipped entirely.
        if (names.includes('result--ad')) continue
        const link = find(node, (el) => el.tagName === 'a' && classes(el).includes('result__a'))
        const href = link?.attrs.find((attr) => attr.name === 'href')?.value
        const url = href ? resultUrl(href) : null
        if (link && url && !seen.has(url)) {
          seen.add(url)
          const snippet = find(node, (el) => classes(el).includes('result__snippet'))
          hits.push({ title: cleanText(textOf(link), 200) || url, url, snippet: snippet ? cleanText(textOf(snippet)) : '' })
        }
        continue
      }
    }
    if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i])
  }
  return hits
}

export function createDuckDuckGoBackend(): WebSearchBackend {
  return {
    id: 'duckduckgo',
    label: LABEL,
    unavailableReason: '',
    available: () => true,
    search: async ({ query, maxResults, signal }) => {
      const res = await webSearchFetch(
        LABEL,
        DUCKDUCKGO_HTML_URL,
        {
          method: 'POST',
          headers: {
            'User-Agent': BROWSER_UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          body: new URLSearchParams({ q: query }).toString(),
        },
        signal,
        { keyed: false }
      )
      const html = await res.text()
      const hits = parseDuckDuckGoHtml(html)
      if (!hits.length && BOT_CHECK.test(html))
        throw new Error('DuckDuckGo blocked the request with a bot check. Add a search API key or connect ChatGPT.')
      return { kind: 'results', hits: hits.slice(0, maxResults) }
    },
  }
}
