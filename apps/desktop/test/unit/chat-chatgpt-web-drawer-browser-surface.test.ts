import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/drawer/browser', () => ({
  BROWSER_PARTITION: 'persist:drawer-browser',
  acquireBrowserTabForControl: vi.fn(),
}))

vi.mock('../../src/main/browser-control', () => ({
  attachToView: vi.fn(),
  setBrowserCdpActivity: vi.fn(async () => undefined),
  navigate: vi.fn(async (wc: FakeWebContents, url: string) => {
    wc.url = url
    return { url }
  }),
  navHistory: vi.fn(async (wc: FakeWebContents) => ({ moved: true, url: wc.url })),
  waitFor: vi.fn(async () => ({})),
  snapshot: vi.fn(async (wc: FakeWebContents) => ({ url: wc.url, elements: [] })),
  screenshot: vi.fn(async () => 'png-base64'),
  scrollPosition: vi.fn(async () => ({ x: 0, y: 0, maxX: 0, maxY: 0 })),
  readText: vi.fn(async () => 'text'),
  scroll: vi.fn(async () => ({ x: 0, y: 1, maxX: 0, maxY: 10 })),
  getConsoleLogs: vi.fn(async () => []),
  getNetworkLogs: vi.fn(async () => []),
  clickRef: vi.fn(async () => undefined),
  doubleClickRef: vi.fn(async () => undefined),
  typeRef: vi.fn(async () => undefined),
  pressKey: vi.fn(async () => undefined),
  dragRef: vi.fn(async () => undefined),
}))

import * as browserControl from '../../src/main/browser-control'
import type { AcquiredBrowserTab } from '../../src/main/drawer/browser'
import {
  createDrawerBrowserSurface,
  drawerBrowserUrlAllowedForOrigin,
} from '../../src/main/chat/chatgpt-web/drawer-browser-surface'

class FakeWebContents extends EventEmitter {
  url = 'about:blank'
  destroyed = false
  stop = vi.fn()
  getURL = () => this.url
  isDestroyed = () => this.destroyed
}

function harness() {
  const wc = new FakeWebContents()
  let current = true
  const acquired: AcquiredBrowserTab = {
    tabId: 'conv-1:b7',
    webContents: wc as never,
    captureFrame: vi.fn(),
    isCurrent: vi.fn(() => current && !wc.destroyed),
    getBounds: vi.fn(() => ({ width: 900, height: 640 })),
    show: vi.fn(() => true),
    release: vi.fn(),
  }
  return {
    wc,
    acquired,
    replace: () => {
      current = false
    },
  }
}

describe('drawer browser surface adapter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pins the exact tab and initial loopback origin while retaining the BrowserSurface operations', async () => {
    const h = harness()
    const abortController = new AbortController()
    h.wc.url = 'http://localhost:4173/start'
    const surface = await createDrawerBrowserSurface({
      convId: 'conv-1',
      tabId: h.acquired.tabId,
      url: 'http://localhost:4173/start',
      signal: abortController.signal,
      acquireTab: () => h.acquired,
    })

    expect(surface.partition).toBe('persist:drawer-browser')
    expect(surface.origin).toBe('http://localhost:4173')
    expect(browserControl.attachToView).toHaveBeenCalledWith(h.wc)
    expect(browserControl.navigate).not.toHaveBeenCalled()
    expect(surface.info()).toEqual({ state: 'ready', url: 'http://localhost:4173/start' })
    await expect(surface.snapshot()).resolves.toEqual({
      url: 'http://localhost:4173/start',
      elements: [],
    })
    await expect(surface.screenshot()).resolves.toMatchObject({
      data: 'png-base64',
      metadata: {
        url: 'http://localhost:4173/start',
        viewport: { width: 900, height: 640 },
      },
    })
    expect(browserControl.screenshot).toHaveBeenCalledWith(h.wc, {
      signal: abortController.signal,
      captureFrame: h.acquired.captureFrame,
    })
    expect(browserControl.scrollPosition).toHaveBeenCalledWith(h.wc, {
      signal: abortController.signal,
      timeoutMs: 1_000,
    })
    expect(surface.show()).toBe(true)
    expect(h.acquired.show).toHaveBeenCalledOnce()

    h.replace()
    expect(surface.show()).toBe(false)
    await expect(surface.readText()).rejects.toThrow('closed, destroyed, or replaced')
    await surface.dispose()
    expect(h.acquired.release).toHaveBeenCalledOnce()
  })

  it('rejects cross-origin main-frame navigation and never destroys or clears the user surface on dispose', async () => {
    const h = harness()
    h.wc.url = 'http://127.0.0.1:5173/'
    const surface = await createDrawerBrowserSurface({
      convId: 'conv-1',
      tabId: h.acquired.tabId,
      url: 'http://127.0.0.1:5173/',
      acquireTab: () => h.acquired,
    })
    const event = { preventDefault: vi.fn() }

    h.wc.emit('will-navigate', event, 'https://example.com/')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(h.wc.stop).toHaveBeenCalledOnce()
    expect(surface.info().state).toBe('error')
    await expect(surface.navigate('http://localhost:5173/')).rejects.toThrow('approved local origin')

    await surface.dispose()
    await surface.dispose()
    expect(h.acquired.release).toHaveBeenCalledOnce()
    expect(browserControl.setBrowserCdpActivity).not.toHaveBeenCalledWith(h.wc, false)
    expect(h.wc.destroyed).toBe(false)
  })

  it('keeps a valid screenshot when only scroll metadata fails', async () => {
    const h = harness()
    h.wc.url = 'http://localhost:4173/start'
    vi.mocked(browserControl.scrollPosition).mockRejectedValueOnce(new Error('Runtime.evaluate timed out'))
    const surface = await createDrawerBrowserSurface({
      convId: 'conv-1',
      tabId: h.acquired.tabId,
      url: 'http://localhost:4173/start',
      acquireTab: () => h.acquired,
    })

    await expect(surface.screenshot()).resolves.toMatchObject({
      data: 'png-base64',
      metadata: { scroll: null },
    })

    await surface.dispose()
  })

  it('freezes protocol, host, and port as part of the exact initial origin', () => {
    const origin = 'http://localhost:5173'
    expect(drawerBrowserUrlAllowedForOrigin('http://localhost:5173/next', origin)).toBe('http://localhost:5173/next')
    for (const url of [
      'https://localhost:5173/',
      'http://localhost:3000/',
      'http://127.0.0.1:5173/',
      'http://192.168.1.2:5173/',
      'file:///tmp/index.html',
      'https://example.com/',
    ]) {
      expect(drawerBrowserUrlAllowedForOrigin(url, origin), url).toBeNull()
    }
  })
})
