import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_HISTORY_MAX_ENTRIES,
  browserHistoryIconFor,
  clearBrowserHistory,
  configureBrowserHistoryFile,
  flushBrowserHistory,
  noteBrowserHistoryFavicon,
  queryBrowserHistory,
  recordBrowserVisit,
  removeBrowserHistoryEntry,
  updateBrowserHistoryTitle,
} from '../../src/main/drawer/browser-history'

const NOW = Date.UTC(2026, 9, 12, 12)

let dir: string
let file: string

function stored(): { entries: Array<Record<string, unknown>>; icons: Record<string, { data: string }> } {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function iconResponse(body: Uint8Array, type: string | null, status = 200): Response {
  const headers = new Headers()
  if (type) headers.set('content-type', type)
  return new Response(Buffer.from(body), { status, headers })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-browser-history-'))
  file = path.join(dir, 'browser-history.json')
  configureBrowserHistoryFile(file)
})

afterEach(() => {
  configureBrowserHistoryFile(null)
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('browser history store', () => {
  it('records web visits, counts typed ones, and keeps the latest title', () => {
    recordBrowserVisit('https://example.com/a#top', { now: NOW })
    recordBrowserVisit('https://example.com/a#other', { typed: true, now: NOW + 1000 })
    updateBrowserHistoryTitle('https://example.com/a', '  Example A  ')
    recordBrowserVisit('file:///etc/hosts', { now: NOW })
    recordBrowserVisit('about:blank', { now: NOW })

    expect(queryBrowserHistory('example', 10, NOW)).toEqual([
      {
        url: 'https://example.com/a',
        title: 'Example A',
        visitCount: 2,
        typedCount: 1,
        lastVisitAt: NOW + 1000,
      },
    ])
    expect(queryBrowserHistory('hosts', 10, NOW)).toEqual([])
  })

  it('persists after the debounce and on flush, owner-only, and reloads from disk', async () => {
    vi.useFakeTimers()
    recordBrowserVisit('https://example.com/', { now: NOW })
    expect(existsSync(file)).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    vi.useRealTimers()
    await vi.waitFor(() => expect(existsSync(file)).toBe(true))
    expect(stored().entries.map((item) => item.url)).toEqual(['https://example.com/'])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)

    recordBrowserVisit('https://second.example/', { now: NOW })
    flushBrowserHistory()
    expect(stored().entries).toHaveLength(2)

    configureBrowserHistoryFile(file)
    expect(queryBrowserHistory('second', 10, NOW).map((item) => item.url)).toEqual(['https://second.example/'])
  })

  it('keeps an unreadable file aside instead of overwriting it', () => {
    writeFileSync(file, '{ not json')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(queryBrowserHistory('anything', 10, NOW)).toEqual([])
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe('{ not json')

    recordBrowserVisit('https://fresh.example/', { now: NOW })
    flushBrowserHistory()
    expect(stored().entries.map((item) => item.url)).toEqual(['https://fresh.example/'])
  })

  it('drops invalid stored entries while loading', () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          { url: 'https://ok.example/', title: 'Ok', visitCount: 2, typedCount: 1, lastVisitAt: NOW },
          { url: 'javascript:alert(1)', visitCount: 1, lastVisitAt: NOW },
          { url: 'https://bad.example/', visitCount: -1, lastVisitAt: NOW },
          'garbage',
        ],
        icons: { 'https://ok.example/favicon.ico': { data: 'https://not-a-data-url', usedAt: NOW } },
      })
    )
    expect(queryBrowserHistory('example', 10, NOW).map((item) => item.url)).toEqual(['https://ok.example/'])
  })

  it('prunes the least used entries beyond the limit', () => {
    recordBrowserVisit('https://keep.example/', { typed: true, now: NOW })
    for (let i = 0; i < BROWSER_HISTORY_MAX_ENTRIES; i++) {
      recordBrowserVisit(`https://filler${i}.example/`, { now: NOW - 100 * 86_400_000 })
    }
    flushBrowserHistory()
    const entries = stored().entries
    expect(entries.length).toBeLessThan(BROWSER_HISTORY_MAX_ENTRIES)
    expect(entries.some((item) => item.url === 'https://keep.example/')).toBe(true)
  })

  it('always returns the page visited at exactly the typed address', () => {
    recordBrowserVisit('https://docs.example/', { now: NOW - 300 * 86_400_000 })
    for (let i = 0; i < 5; i++) recordBrowserVisit(`https://docs.example/page-${i}`, { typed: true, now: NOW })

    const results = queryBrowserHistory('docs.example/', 2, NOW)
    expect(results).toHaveLength(3)
    expect(results.at(-1)?.url).toBe('https://docs.example/')
  })

  it('removes a page, and every visit of a removed search query', () => {
    recordBrowserVisit('https://example.com/', { now: NOW })
    recordBrowserVisit('https://www.google.com/search?q=Chuva+hoje&ei=1', { now: NOW })
    recordBrowserVisit('https://www.google.com/search?q=chuva+hoje&ei=2', { now: NOW })
    recordBrowserVisit('https://www.google.com/search?q=sol', { now: NOW })

    expect(removeBrowserHistoryEntry('https://example.com/#x')).toBe(true)
    expect(removeBrowserHistoryEntry('https://www.google.com/search?q=chuva+hoje&ei=2')).toBe(true)
    expect(removeBrowserHistoryEntry('https://missing.example/')).toBe(false)
    expect(removeBrowserHistoryEntry('not a url')).toBe(false)
    flushBrowserHistory()
    expect(stored().entries.map((item) => item.url)).toEqual(['https://www.google.com/search?q=sol'])
  })

  it('caches favicons as data URLs fetched through the given loader', async () => {
    recordBrowserVisit('https://example.com/', { now: NOW })
    const loader = vi.fn(async (_url: string, _signal: AbortSignal) =>
      iconResponse(new Uint8Array([1, 2, 3]), 'image/png')
    )
    noteBrowserHistoryFavicon('https://example.com/', 'https://example.com/favicon.png', loader)
    noteBrowserHistoryFavicon('https://example.com/', 'https://example.com/favicon.png', loader)
    await vi.waitFor(() => expect(browserHistoryIconFor('https://example.com/')).toBe('data:image/png;base64,AQID'))

    expect(loader).toHaveBeenCalledOnce()
    expect(loader.mock.calls[0]![0]).toBe('https://example.com/favicon.png')
    expect(queryBrowserHistory('example', 10, NOW)[0]?.icon).toBe('data:image/png;base64,AQID')
  })

  it('rejects favicons that are not images, too large, failed, or non-web', async () => {
    recordBrowserVisit('https://a.example/', { now: NOW })
    recordBrowserVisit('https://b.example/', { now: NOW })
    recordBrowserVisit('https://c.example/', { now: NOW })
    recordBrowserVisit('https://d.example/', { now: NOW })
    const loader = vi.fn(async (url: string) => {
      if (url.includes('a.example')) return iconResponse(new Uint8Array([1]), 'text/html')
      if (url.includes('b.example')) return iconResponse(new Uint8Array(40 * 1024), 'image/png')
      return iconResponse(new Uint8Array([1]), 'image/png', 404)
    })
    noteBrowserHistoryFavicon('https://a.example/', 'https://a.example/favicon.ico', loader)
    noteBrowserHistoryFavicon('https://b.example/', 'https://b.example/favicon.png', loader)
    noteBrowserHistoryFavicon('https://c.example/', 'https://c.example/favicon.png', loader)
    noteBrowserHistoryFavicon('https://d.example/', 'file:///tmp/icon.png', loader)
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(3))
    await settle()
    for (const host of ['a', 'b', 'c', 'd']) expect(browserHistoryIconFor(`https://${host}.example/`)).toBeUndefined()
  })

  it('accepts .ico files served as generic binaries and inline data favicons', async () => {
    recordBrowserVisit('https://ico.example/', { now: NOW })
    recordBrowserVisit('https://inline.example/', { now: NOW })
    const loader = vi.fn(async () => iconResponse(new Uint8Array([0, 0, 1, 0]), 'application/octet-stream'))
    noteBrowserHistoryFavicon('https://ico.example/', 'https://ico.example/favicon.ico', loader)
    noteBrowserHistoryFavicon('https://inline.example/', 'data:image/svg+xml;base64,PHN2Zy8+', loader)
    await vi.waitFor(() => expect(browserHistoryIconFor('https://ico.example/')).toBe('data:image/x-icon;base64,AAABAA=='))
    expect(browserHistoryIconFor('https://inline.example/')).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(loader).toHaveBeenCalledOnce()
  })

  it('ignores favicons for pages that are not in the history', async () => {
    const loader = vi.fn(async () => iconResponse(new Uint8Array([1]), 'image/png'))
    noteBrowserHistoryFavicon('https://unknown.example/', 'https://unknown.example/favicon.png', loader)
    await settle()
    expect(loader).not.toHaveBeenCalled()
  })

  it('clears memory and disk', () => {
    recordBrowserVisit('https://example.com/', { now: NOW })
    flushBrowserHistory()
    clearBrowserHistory()
    expect(existsSync(file)).toBe(false)
    expect(queryBrowserHistory('example', 10, NOW)).toEqual([])
    flushBrowserHistory()
    expect(existsSync(file)).toBe(false)
  })
})
