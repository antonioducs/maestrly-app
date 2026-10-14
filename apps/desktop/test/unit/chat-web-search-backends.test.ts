import { net } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTavilyBackend } from '../../src/main/chat/web-search/tavily'
import { createBraveBackend } from '../../src/main/chat/web-search/brave'
import { createDuckDuckGoBackend, parseDuckDuckGoHtml } from '../../src/main/chat/web-search/duckduckgo'
import type { WebSearchRequest } from '../../src/main/chat/web-search/types'
import { BROWSER_UA } from '../../src/main/chat/tools/webfetch'

afterEach(() => vi.restoreAllMocks())

function request(query: string, maxResults: number, signal = new AbortController().signal): WebSearchRequest {
  return { query, maxResults, signal, conversationId: 'web-search-test', cwd: '.' }
}

function mockFetch(response: () => Response) {
  return vi.spyOn(net, 'fetch').mockImplementation((async () => response()) as never)
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function call(spy: ReturnType<typeof mockFetch>, index = 0): { url: string; init: RequestInit } {
  const [url, init] = spy.mock.calls[index] as unknown as [string, RequestInit]
  return { url, init }
}

describe('Tavily backend', () => {
  it('sends the query with the key and maps results', async () => {
    const fetch = mockFetch(() =>
      json({
        results: [
          { title: 'Docs', url: 'https://docs.example.test/a', content: 'First\n result' },
          { title: 'Bad', url: 'ftp://x', content: 'skip' },
          { title: '', url: 'https://two.example.test/b', content: 'Second' },
          { title: 'Third', url: 'https://three.example.test/c', content: 'cut' },
        ],
      })
    )
    const outcome = await createTavilyBackend(() => 'test-key').search(request('electron vibrancy', 2))
    expect(outcome).toEqual({
      kind: 'results',
      hits: [
        { title: 'Docs', url: 'https://docs.example.test/a', snippet: 'First result' },
        { title: 'https://two.example.test/b', url: 'https://two.example.test/b', snippet: 'Second' },
      ],
    })
    const { url, init } = call(fetch)
    expect(url).toBe('https://api.tavily.com/search')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key')
    expect(JSON.parse(String(init.body))).toEqual({ query: 'electron vibrancy', max_results: 2, search_depth: 'basic' })
  })

  it('maps key and quota errors', async () => {
    mockFetch(() => json({}, 401))
    await expect(createTavilyBackend(() => 'test-key').search(request('q', 5))).rejects.toThrow(
      'Tavily rejected the API key (HTTP 401).'
    )
    vi.restoreAllMocks()
    mockFetch(() => json({}, 429))
    await expect(createTavilyBackend(() => 'test-key').search(request('q', 5))).rejects.toThrow(/quota exhausted/)
  })

  it('is unavailable without a key', async () => {
    const backend = createTavilyBackend(() => null)
    expect(await backend.available()).toBe(false)
    await expect(backend.search(request('q', 5))).rejects.toThrow(/Add a Tavily API key/)
  })
})

describe('Brave backend', () => {
  it('sends the query with the subscription token and strips inline HTML', async () => {
    const fetch = mockFetch(() =>
      json({
        web: {
          results: [
            { title: 'Vibrancy <strong>guide</strong>', url: 'https://docs.example.test/v', description: 'Use <strong>vibrancy</strong> now' },
          ],
        },
      })
    )
    const outcome = await createBraveBackend(() => 'test-key').search(request('electron vibrancy', 3))
    expect(outcome).toEqual({
      kind: 'results',
      hits: [{ title: 'Vibrancy guide', url: 'https://docs.example.test/v', snippet: 'Use vibrancy now' }],
    })
    const { url, init } = call(fetch)
    expect(url).toContain('https://api.search.brave.com/res/v1/web/search?')
    expect(url).toContain('q=electron+vibrancy&count=3')
    expect(new Headers(init.headers).get('x-subscription-token')).toBe('test-key')
  })

  it('is unavailable without a key', async () => {
    expect(await createBraveBackend(() => null).available()).toBe(false)
  })
})

const DDG_FIXTURE = [
  '<div class="result results_links result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>',
  '<div class="result results_links web-result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.test%2Fguide%3Fa%3D1&amp;rut=abc">Guide &amp; <b>tips</b></a></h2><a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Learn the <b>basics</b> fast.</a></div>',
  '<div class="result web-result"><a class="result__a" href="https://plain.example.test/page">Plain</a></div>',
].join('\n')

const DDG_HITS = [
  { title: 'Guide & tips', url: 'https://docs.example.test/guide?a=1', snippet: 'Learn the basics fast.' },
  { title: 'Plain', url: 'https://plain.example.test/page', snippet: '' },
]

describe('DuckDuckGo backend', () => {
  it('parses results, decodes redirects and skips ads', () => {
    expect(parseDuckDuckGoHtml(DDG_FIXTURE)).toEqual(DDG_HITS)
  })

  it('treats only DuckDuckGo hosts as DuckDuckGo', () => {
    const result = (href: string) => `<div class="result"><a class="result__a" href="${href}">Title</a></div>`
    const urls = (html: string) => parseDuckDuckGoHtml(html).map((hit) => hit.url)
    // A look-alike domain is an ordinary site: kept as a result, and its /l/ path is not a redirect.
    expect(urls(result('https://evilduckduckgo.com/page'))).toEqual(['https://evilduckduckgo.com/page'])
    expect(urls(result('https://evilduckduckgo.com/l/?uddg=https%3A%2F%2Fother.example.test%2F'))).toEqual([
      'https://evilduckduckgo.com/l/?uddg=https%3A%2F%2Fother.example.test%2F',
    ])
    // DuckDuckGo's own hosts, subdomains included, are redirects or internal links, never results.
    expect(urls(result('https://duckduckgo.com/y.js?ad=1'))).toEqual([])
    expect(urls(result('https://links.duckduckgo.com/d.js?q=x'))).toEqual([])
    expect(urls(result('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.test%2F'))).toEqual([
      'https://docs.example.test/',
    ])
  })

  it('posts the query as a browser and limits results', async () => {
    const fetch = mockFetch(() => new Response(DDG_FIXTURE, { headers: { 'content-type': 'text/html' } }))
    const backend = createDuckDuckGoBackend()
    expect(await backend.available()).toBe(true)
    expect(await backend.search(request('electron vibrancy', 1))).toEqual({ kind: 'results', hits: [DDG_HITS[0]] })
    const { url, init } = call(fetch)
    expect(url).toBe('https://html.duckduckgo.com/html/')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toBe('q=electron+vibrancy')
    expect(new Headers(init.headers).get('user-agent')).toBe(BROWSER_UA)
  })

  it('reports a bot check', async () => {
    mockFetch(() => new Response('<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>'))
    await expect(createDuckDuckGoBackend().search(request('q', 5))).rejects.toThrow(/blocked the request/)
  })

  it('returns no hits for an empty result page', async () => {
    mockFetch(() => new Response('<div class="no-results">No results.</div>'))
    expect(await createDuckDuckGoBackend().search(request('q', 5))).toEqual({ kind: 'results', hits: [] })
  })
})

describe('abort', () => {
  it('rejects with the abort reason', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('Aborted', 'AbortError'))
    vi.spyOn(net, 'fetch').mockImplementation((async (_url: string, init: RequestInit) => {
      throw init.signal?.reason
    }) as never)
    await expect(createTavilyBackend(() => 'test-key').search(request('q', 5, controller.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
