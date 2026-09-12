import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/browser-control', () => ({
  attachToView: vi.fn(),
  setBrowserCdpActivity: vi.fn(async () => undefined),
  navigate: vi.fn(async (_wc: unknown, url: string) => ({ url })),
  navHistory: vi.fn(async () => ({ moved: true, url: 'http://localhost:5173/' })),
  waitFor: vi.fn(async () => ({ matched: true, waitedMs: 1 })),
  snapshot: vi.fn(async () => ({ url: 'http://localhost:5173/', elements: [] })),
  screenshot: vi.fn(async () => 'png-base64'),
  scrollPosition: vi.fn(async () => ({ x: 0, y: 0, maxX: 0, maxY: 0 })),
  readText: vi.fn(async () => 'visible'),
  scroll: vi.fn(async () => ({ x: 0, y: 1, maxX: 0, maxY: 10 })),
  getConsoleLogs: vi.fn(async () => []),
  getNetworkLogs: vi.fn(async () => []),
  clickRef: vi.fn(async () => undefined),
  doubleClickRef: vi.fn(async () => undefined),
  typeRef: vi.fn(async () => undefined),
  pressKey: vi.fn(async () => undefined),
  dragRef: vi.fn(async () => undefined),
}))

import { createVisualBrowser, visualBrowserUrlAllowedForOrigin } from '../../src/main/chat/chatgpt-web/visual-browser'
import * as browserControl from '../../src/main/browser-control'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class FakeWebContents extends EventEmitter {
  url = ''
  destroyed = false
  stopped = false
  windowOpenHandler: (() => { action: string }) | null = null
  getURL = () => this.url
  isDestroyed = () => this.destroyed
  stop = () => {
    this.stopped = true
  }
  setWindowOpenHandler = (handler: () => { action: string }) => {
    this.windowOpenHandler = handler
  }
}

function startupHarness(loadURL: (url: string) => Promise<void>) {
  const wc = new FakeWebContents()
  const isolatedSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setProxy: vi.fn(async () => undefined),
    webRequest: { onBeforeRequest: vi.fn() },
    clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    clearAuthCache: vi.fn(async () => undefined),
  }
  let destroyed = false
  const destroy = vi.fn(() => {
    destroyed = true
    wc.destroyed = true
  })
  const fakeWindow = Object.assign(new EventEmitter(), {
    webContents: wc,
    loadURL: vi.fn(loadURL),
    getContentBounds: () => ({ width: 1280, height: 900, x: 0, y: 0 }),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    destroy,
    isDestroyed: () => destroyed,
  })
  return { wc, isolatedSession, fakeWindow, destroy }
}

describe('isolated Visual Review browser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('freezes exact loopback origin and rejects protocol/LAN/internet variants', () => {
    const origin = 'http://localhost:5173'
    expect(visualBrowserUrlAllowedForOrigin('http://localhost:5173/path', origin)).toBe('http://localhost:5173/path')
    for (const url of [
      'http://localhost:3000/',
      'http://127.0.0.1:5173/',
      'http://192.168.1.2:5173/',
      'https://localhost:5173/',
      'file:///tmp/a.html',
      'data:text/html,a',
      'javascript:alert(1)',
      'https://example.com/',
    ]) {
      expect(visualBrowserUrlAllowedForOrigin(url, origin), url).toBeNull()
    }
  })

  it('uses an ephemeral partition, denies permissions/popups/cross-origin main-frame and clears on teardown', async () => {
    const wc = new FakeWebContents()
    const clearStorageData = vi.fn<() => Promise<void>>(async () => undefined)
    const clearCache = vi.fn(async () => undefined)
    const clearAuthCache = vi.fn(async () => undefined)
    const abortController = new AbortController()
    let permissionRequest: ((_wc: unknown, permission: string, callback: (allowed: boolean) => void) => void) | null =
      null
    let permissionCheck: (() => boolean) | null = null
    let beforeRequest:
      | ((details: { resourceType: string; url: string }, callback: (result: { cancel: boolean }) => void) => void)
      | null = null
    const isolatedSession = {
      setPermissionRequestHandler: vi.fn((handler) => {
        permissionRequest = handler
      }),
      setPermissionCheckHandler: vi.fn((handler) => {
        permissionCheck = handler
      }),
      setProxy: vi.fn(async () => undefined),
      webRequest: { onBeforeRequest: vi.fn((handler) => (beforeRequest = handler)) },
      clearStorageData,
      clearCache,
      clearAuthCache,
    }
    let createdOptions: Electron.BrowserWindowConstructorOptions | undefined
    let shown = false
    let hidden = false
    let destroyed = false
    const destroyWindow = vi.fn(() => {
      destroyed = true
      wc.destroyed = true
    })
    const fakeWindow = Object.assign(new EventEmitter(), {
      webContents: wc,
      loadURL: vi.fn(async (url: string) => {
        wc.url = url
      }),
      getContentBounds: () => ({ width: 1280, height: 900, x: 0, y: 0 }),
      show: () => {
        shown = true
      },
      hide: () => {
        hidden = true
      },
      focus: vi.fn(),
      destroy: destroyWindow,
      isDestroyed: () => destroyed,
    })
    const fromPartition = vi.fn(() => isolatedSession as never)
    const browser = await createVisualBrowser({
      loopId: 'rl_security_test',
      url: 'http://localhost:5173/',
      signal: abortController.signal,
      fromPartition,
      createWindow: (options) => {
        createdOptions = options
        return fakeWindow as never
      },
    })

    expect(browser.partition).toBe('chatgpt-visual-review:rl_security_test')
    expect(browser.partition).not.toContain('persist:')
    expect(browser.partition).not.toBe('persist:drawer-browser')
    expect(createdOptions?.webPreferences).toMatchObject({
      partition: browser.partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    })
    expect(isolatedSession.setProxy).toHaveBeenCalledWith({ mode: 'direct' })
    let allowed = true
    expect(permissionRequest).not.toBeNull()
    ;(permissionRequest as unknown as (wc: unknown, permission: string, callback: (allowed: boolean) => void) => void)(
      wc,
      'camera',
      (value: boolean) => (allowed = value)
    )
    expect(allowed).toBe(false)
    expect((permissionCheck as unknown as () => boolean)()).toBe(false)
    expect(wc.windowOpenHandler?.()).toEqual({ action: 'deny' })

    let sameOriginCancelled = true
    ;(
      beforeRequest as unknown as (
        details: { resourceType: string; url: string },
        callback: (result: { cancel: boolean }) => void
      ) => void
    )(
      { resourceType: 'mainFrame', url: 'http://localhost:5173/next' },
      (result: { cancel: boolean }) => (sameOriginCancelled = result.cancel)
    )
    expect(sameOriginCancelled).toBe(false)
    let externalCancelled = false
    ;(
      beforeRequest as unknown as (
        details: { resourceType: string; url: string },
        callback: (result: { cancel: boolean }) => void
      ) => void
    )(
      { resourceType: 'mainFrame', url: 'https://example.com/' },
      (result: { cancel: boolean }) => (externalCancelled = result.cancel)
    )
    expect(externalCancelled).toBe(true)
    let subresourceCancelled = true
    ;(
      beforeRequest as unknown as (
        details: { resourceType: string; url: string },
        callback: (result: { cancel: boolean }) => void
      ) => void
    )(
      { resourceType: 'image', url: 'https://example.com/a.png' },
      (result: { cancel: boolean }) => (subresourceCancelled = result.cancel)
    )
    expect(subresourceCancelled).toBe(false)

    const event = { preventDefault: vi.fn() }
    wc.emit('will-navigate', event, 'https://example.com/')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(wc.stopped).toBe(true)
    await expect(browser.navigate('http://127.0.0.1:5173/')).rejects.toThrow('approved local origin')

    const closeEvent = { preventDefault: vi.fn() }
    fakeWindow.emit('close', closeEvent)
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(hidden).toBe(true)
    expect(wc.destroyed).toBe(false)
    await expect(browser.snapshot()).resolves.toEqual({ url: 'http://localhost:5173/', elements: [] })
    await expect(browser.screenshot()).resolves.toMatchObject({
      data: 'png-base64',
      metadata: { url: 'http://localhost:5173/' },
    })
    expect(browserControl.screenshot).toHaveBeenCalledWith(wc, { signal: abortController.signal })
    expect(browserControl.scrollPosition).toHaveBeenCalledWith(wc, {
      signal: abortController.signal,
      timeoutMs: 1_000,
    })
    expect(browser.show()).toBe(true)
    expect(shown).toBe(true)

    const cdpDisabled = deferred()
    const storageCleared = deferred()
    vi.mocked(browserControl.setBrowserCdpActivity).mockImplementation(async (_webContents, active) => {
      if (!active) await cdpDisabled.promise
    })
    clearStorageData.mockImplementation(() => storageCleared.promise)

    // Abort starts disposal synchronously through the listener. The explicit call must return that same
    // in-flight promise and therefore remain pending until CDP shutdown and session clearing finish.
    abortController.abort()
    const disposal = browser.dispose()
    expect(browser.dispose()).toBe(disposal)
    let settled = false
    void disposal.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    cdpDisabled.resolve()
    await vi.waitFor(() => expect(clearStorageData).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    storageCleared.resolve()
    await disposal
    expect(settled).toBe(true)

    expect(destroyed).toBe(true)
    expect(destroyWindow).toHaveBeenCalledOnce()
    expect(clearStorageData).toHaveBeenCalledOnce()
    expect(clearCache).toHaveBeenCalledOnce()
    expect(clearAuthCache).toHaveBeenCalledOnce()
  })

  it('bounds a hung CDP bootstrap and tears down the isolated surface', async () => {
    const h = startupHarness(async () => undefined)
    vi.mocked(browserControl.setBrowserCdpActivity).mockImplementation(async (_wc, active) => {
      if (active) await new Promise<void>(() => undefined)
    })

    await expect(
      createVisualBrowser({
        loopId: 'rl_cdp_timeout',
        url: 'http://localhost:5173/',
        startupTimeoutMs: 10,
        teardownTimeoutMs: 10,
        fromPartition: () => h.isolatedSession as never,
        createWindow: () => h.fakeWindow as never,
      })
    ).rejects.toThrow('timed out during CDP initialization')

    expect(h.fakeWindow.loadURL).toHaveBeenCalledOnce()
    expect(h.destroy).toHaveBeenCalledOnce()
    expect(h.isolatedSession.clearStorageData).toHaveBeenCalledOnce()
    expect(h.isolatedSession.clearCache).toHaveBeenCalledOnce()
    expect(h.isolatedSession.clearAuthCache).toHaveBeenCalledOnce()
  })

  it('bounds a hung direct-network setup and tears down the isolated surface', async () => {
    const h = startupHarness(async () => undefined)
    h.isolatedSession.setProxy.mockImplementation(async () => new Promise<undefined>(() => undefined))

    await expect(
      createVisualBrowser({
        loopId: 'rl_proxy_timeout',
        url: 'http://localhost:5173/',
        startupTimeoutMs: 10,
        teardownTimeoutMs: 10,
        fromPartition: () => h.isolatedSession as never,
        createWindow: () => h.fakeWindow as never,
      })
    ).rejects.toThrow('timed out during network setup')

    expect(h.fakeWindow.loadURL).not.toHaveBeenCalled()
    expect(h.destroy).toHaveBeenCalledOnce()
    expect(h.isolatedSession.clearStorageData).toHaveBeenCalledOnce()
  })

  it('starts navigation before awaiting CDP so a fresh webContents can initialize its target', async () => {
    let navigationStarted = false
    const h = startupHarness(async (url) => {
      navigationStarted = true
      h.wc.url = url
    })
    vi.mocked(browserControl.setBrowserCdpActivity).mockImplementation(async (_wc, active) => {
      if (active && !navigationStarted) await new Promise<void>(() => undefined)
    })

    const browser = await createVisualBrowser({
      loopId: 'rl_cdp_after_navigation',
      url: 'http://localhost:5173/',
      startupTimeoutMs: 50,
      teardownTimeoutMs: 10,
      fromPartition: () => h.isolatedSession as never,
      createWindow: () => h.fakeWindow as never,
    })

    expect(navigationStarted).toBe(true)
    expect(browser.info()).toMatchObject({ state: 'ready', url: 'http://localhost:5173/' })
    await browser.dispose()
  })

  it('bounds a hung page load and tears down after CDP was enabled', async () => {
    const h = startupHarness(async () => new Promise<void>(() => undefined))
    vi.mocked(browserControl.setBrowserCdpActivity).mockResolvedValue(undefined)

    await expect(
      createVisualBrowser({
        loopId: 'rl_load_timeout',
        url: 'http://localhost:5173/',
        startupTimeoutMs: 10,
        teardownTimeoutMs: 10,
        fromPartition: () => h.isolatedSession as never,
        createWindow: () => h.fakeWindow as never,
      })
    ).rejects.toThrow('timed out during page load')

    expect(browserControl.setBrowserCdpActivity).toHaveBeenCalledWith(h.wc, true)
    expect(browserControl.setBrowserCdpActivity).toHaveBeenCalledWith(h.wc, false)
    expect(h.destroy).toHaveBeenCalledOnce()
    expect(h.wc.stopped).toBe(true)
  })

  it('keeps a CDP-ready surface for an immediate main-document failure', async () => {
    const h = startupHarness(async (url) => {
      h.wc.url = url
      throw new Error('ERR_TOO_MANY_REDIRECTS (-310)')
    })
    vi.mocked(browserControl.setBrowserCdpActivity).mockResolvedValue(undefined)

    const browser = await createVisualBrowser({
      loopId: 'rl_load_error_reviewable',
      url: 'http://localhost:5173/',
      startupTimeoutMs: 50,
      teardownTimeoutMs: 10,
      fromPartition: () => h.isolatedSession as never,
      createWindow: () => h.fakeWindow as never,
    })

    expect(browser.info()).toMatchObject({ state: 'error', url: 'http://localhost:5173/' })
    expect(h.destroy).not.toHaveBeenCalled()
    await expect(browser.navigate('http://localhost:5173/pt')).resolves.toMatchObject({
      url: 'http://localhost:5173/pt',
    })
    expect(browser.info()).toMatchObject({ state: 'ready' })
    await browser.dispose()
  })

  it('rejects and cleans up when WebContents is destroyed during a failed load', async () => {
    const h = startupHarness(async () => {
      h.destroy()
      throw new Error('ERR_FAILED (-2)')
    })
    vi.mocked(browserControl.setBrowserCdpActivity).mockResolvedValue(undefined)

    await expect(
      createVisualBrowser({
        loopId: 'rl_destroyed_during_load',
        url: 'http://localhost:5173/',
        startupTimeoutMs: 50,
        teardownTimeoutMs: 10,
        fromPartition: () => h.isolatedSession as never,
        createWindow: () => h.fakeWindow as never,
      })
    ).rejects.toThrow('no longer available')

    expect(h.destroy).toHaveBeenCalledOnce()
    expect(h.isolatedSession.clearStorageData).toHaveBeenCalledOnce()
  })
})
