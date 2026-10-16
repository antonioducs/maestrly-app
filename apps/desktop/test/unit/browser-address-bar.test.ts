import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  let nextId = 1
  class FakeWebContents {
    readonly id = nextId++
    currentUrl = 'about:blank'
    currentTitle = ''
    destroyed = false
    focused = false
    listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    loadURL = vi.fn(async (url: string) => {
      this.currentUrl = url
    })
    capturePage = vi.fn(async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,FRAME' }))
    setBackgroundThrottling = vi.fn()
    setWindowOpenHandler = vi.fn()
    reload = vi.fn()
    close = vi.fn(() => {
      this.destroyed = true
      this.emit('destroyed')
    })
    focus = vi.fn(() => {
      this.focused = true
    })
    isFocused = vi.fn(() => this.focused)
    isLoading = vi.fn(() => false)
    canGoBack = vi.fn(() => false)
    canGoForward = vi.fn(() => false)
    isDevToolsOpened = vi.fn(() => false)
    isDestroyed(): boolean {
      return this.destroyed
    }
    getURL(): string {
      return this.currentUrl
    }
    getTitle(): string {
      return this.currentTitle
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]) => {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped)
        )
        listener(...args)
      }
      return this.on(event, wrapped)
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
    }
  }

  const views: FakeWebContentsView[] = []
  class FakeWebContentsView {
    readonly webContents = new FakeWebContents()
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    setBackgroundColor = vi.fn()
    setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
      this.bounds = { ...bounds }
    })
    getBounds = vi.fn(() => ({ ...this.bounds }))
    constructor() {
      views.push(this)
    }
  }

  const mainWindow = {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { getZoomFactor: vi.fn(() => 1), focus: vi.fn() },
    isDestroyed: () => false,
    isVisible: () => true,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  }
  const faviconFetch = vi.fn(
    async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
  )
  const clearCache = vi.fn(async () => undefined)
  const clearStorageData = vi.fn(async () => undefined)
  return { views, mainWindow, faviconFetch, clearCache, clearStorageData, WebContentsView: FakeWebContentsView }
})

vi.mock('electron', () => ({
  WebContentsView: h.WebContentsView,
  session: {
    fromPartition: vi.fn(() => ({
      setPermissionRequestHandler: vi.fn(),
      fetch: h.faviconFetch,
      clearCache: h.clearCache,
      clearStorageData: h.clearStorageData,
    })),
  },
}))
vi.mock('../../src/main/window-ipc', () => ({ broadcast: vi.fn(), sendToConversation: vi.fn() }))
vi.mock('../../src/main/browser-control', () => ({
  attachToView: vi.fn(),
  setBrowserCdpActivity: vi.fn(async () => undefined),
}))
vi.mock('../../src/main/performance/resource-governor', () => ({
  acquireAgentActivity: vi.fn(() => vi.fn()),
  registerThrottleTarget: vi.fn(),
  resourceNeedsFullSpeed: vi.fn(() => false),
  touchAgentActivity: vi.fn(),
  unregisterThrottleTarget: vi.fn(),
}))
vi.mock('../../src/main/performance/metrics', () => ({
  registerPerformanceWebContents: vi.fn(),
  unregisterPerformanceWebContents: vi.fn(),
}))
vi.mock('../../src/main/store', () => ({ getConvUiPrefs: vi.fn(() => ({})), patchConvUiPrefs: vi.fn() }))
vi.mock('../../src/main/hotkeys', () => ({ attachHotkeyCapture: vi.fn() }))
vi.mock('../../src/main/oauth-popup', () => ({
  isPopupDisposition: vi.fn(() => false),
  oauthChildWindowOptions: vi.fn(() => ({})),
}))
vi.mock('../../src/main/mouse-navigation', () => ({ attachMacMouseNavigation: vi.fn() }))
vi.mock('../../src/main/drawer/layout', () => ({ applyLayout: vi.fn() }))
vi.mock('../../src/main/drawer/float', () => ({ layoutFloatingTab: vi.fn() }))
vi.mock('../../src/main/drawer/popup', () => ({ focusViewInMain: vi.fn() }))
vi.mock('../../src/main/drawer/performance', () => ({ setDrawerPlacementPerformance: vi.fn() }))
vi.mock('../../src/main/drawer/search-suggest', () => ({
  requestSearchSuggestions: vi.fn(async () => ['olivia rodrigo']),
}))

import { applyLayout } from '../../src/main/drawer/layout'
import { requestSearchSuggestions } from '../../src/main/drawer/search-suggest'
import {
  browserClearCache,
  createBrowserTab,
  disposeBrowserTabEviction,
  flushPendingBrowserPersists,
  navigateBrowser,
  queryOmnibox,
  setOmniboxOverlay,
} from '../../src/main/drawer/browser'
import {
  browserHistoryIconFor,
  configureBrowserHistoryFile,
  flushBrowserHistory,
  queryBrowserHistory,
} from '../../src/main/drawer/browser-history'
import {
  OFFSCREEN,
  drawers,
  getDrawer,
  initDrawer,
  isBrowserPageHiddenByOmnibox,
  omniboxOverlays,
  placementByConv,
  setActiveConvId,
  setSlot,
  setVisibleKind,
} from '../../src/main/drawer/state'
import { disposeMemoryReclaimer } from '../../src/main/performance/memory-reclaimer'

type FakeView = InstanceType<typeof h.WebContentsView>

let dir: string

function tabView(convId: string, tabId: string): FakeView {
  return getDrawer(convId).browserTabs.find((tab) => tab.id === tabId)!.view as unknown as FakeView
}

function commit(view: FakeView, url: string, code = 200): void {
  view.webContents.currentUrl = url
  view.webContents.emit('did-navigate', {}, url, code)
}

function showInSlot(convId: string): void {
  setActiveConvId(convId)
  setVisibleKind('browser')
  setSlot({ x: 400, y: 80, width: 800, height: 700 })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.views.length = 0
  drawers.clear()
  omniboxOverlays.clear()
  placementByConv.clear()
  initDrawer(h.mainWindow as never)
  dir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-address-bar-'))
  configureBrowserHistoryFile(path.join(dir, 'browser-history.json'))
})

afterEach(() => {
  flushPendingBrowserPersists()
  disposeBrowserTabEviction()
  disposeMemoryReclaimer()
  configureBrowserHistoryFile(null)
  rmSync(dir, { recursive: true, force: true })
  setActiveConvId(null)
  setVisibleKind(null)
  setSlot(null)
})

describe('browser history recording', () => {
  it('records committed visits of user-facing tabs and counts address-bar navigations as typed', () => {
    const id = createBrowserTab('history', 'https://start.example/')
    const view = tabView('history', id)
    commit(view, 'https://start.example/')

    navigateBrowser('history', 'docs.example', { typed: true })
    commit(view, 'https://docs.example/')
    commit(view, 'https://docs.example/')

    const [docs] = queryBrowserHistory('docs')
    expect(docs).toMatchObject({ url: 'https://docs.example/', visitCount: 2, typedCount: 1 })
    expect(queryBrowserHistory('start')).toHaveLength(1)
  })

  it('skips error pages, subframes, and fragment-only changes', () => {
    const id = createBrowserTab('errors', 'https://start.example/')
    const view = tabView('errors', id)

    navigateBrowser('errors', 'typo.example', { typed: true })
    commit(view, 'https://typo.example/', -1)
    expect(queryBrowserHistory('typo')).toEqual([])

    commit(view, 'https://app.example/page')
    view.webContents.emit('did-navigate-in-page', {}, 'https://app.example/page#a', true)
    view.webContents.emit('did-navigate-in-page', {}, 'https://app.example/page#b', true)
    view.webContents.emit('did-navigate-in-page', {}, 'https://ads.example/frame', false)
    view.webContents.emit('did-navigate-in-page', {}, 'https://app.example/other', true)

    expect(queryBrowserHistory('app').map((item) => [item.url, item.visitCount, item.typedCount])).toEqual(
      expect.arrayContaining([
        ['https://app.example/page', 1, 0],
        ['https://app.example/other', 1, 0],
      ])
    )
    expect(queryBrowserHistory('ads')).toEqual([])
  })

  it('stores titles and favicons fetched through the browser session', async () => {
    const id = createBrowserTab('meta', 'https://meta.example/')
    const view = tabView('meta', id)
    commit(view, 'https://meta.example/')
    view.webContents.emit('page-title-updated', {}, 'Meta Example')
    view.webContents.emit('page-favicon-updated', {}, ['https://meta.example/icon.png'])

    await vi.waitFor(() => expect(browserHistoryIconFor('https://meta.example/')).toMatch(/^data:image\/png/))
    expect(h.faviconFetch).toHaveBeenCalledWith('https://meta.example/icon.png', expect.anything())
    expect(queryBrowserHistory('meta')[0]?.title).toBe('Meta Example')
  })

  it('never records delegated worker tabs', () => {
    const id = createBrowserTab('owned', 'https://secret.example/', { ownerScopeId: 'worker', activate: false })
    const view = tabView('owned', id)
    commit(view, 'https://secret.example/')
    view.webContents.emit('page-title-updated', {}, 'Secret')

    expect(queryBrowserHistory('secret')).toEqual([])
  })
})

describe('clear browsing data', () => {
  it('deletes the history with the session data and reloads the conversation tabs', async () => {
    const id = createBrowserTab('clear', 'https://kept.example/')
    const view = tabView('clear', id)
    commit(view, 'https://kept.example/')
    flushBrowserHistory()
    const historyFile = path.join(dir, 'browser-history.json')
    expect(existsSync(historyFile)).toBe(true)

    await browserClearCache('clear')

    expect(h.clearCache).toHaveBeenCalledOnce()
    expect(h.clearStorageData).toHaveBeenCalledOnce()
    expect(queryBrowserHistory('kept')).toEqual([])
    expect(existsSync(historyFile)).toBe(false)
    expect(view.webContents.reload).toHaveBeenCalledOnce()
  })

  it('rejects without reloading when the history file cannot be deleted', async () => {
    const id = createBrowserTab('clear-fail', 'https://kept.example/')
    const view = tabView('clear-fail', id)
    // A non-empty directory where the file should be makes the deletion fail.
    const blocked = path.join(dir, 'blocked')
    mkdirSync(blocked)
    writeFileSync(path.join(blocked, 'child'), 'x')
    configureBrowserHistoryFile(blocked)

    await expect(browserClearCache('clear-fail')).rejects.toThrow()
    expect(view.webContents.reload).not.toHaveBeenCalled()
  })
})

describe('queryOmnibox', () => {
  it('returns public tabs with cached icons, history, and suggestions only when asked', async () => {
    const id = createBrowserTab('query', 'https://olivia.example/')
    commit(tabView('query', id), 'https://olivia.example/')
    createBrowserTab('query', 'https://hidden.example/', { ownerScopeId: 'worker', activate: false })

    const local = await queryOmnibox('query', 'oli', {}, 9)
    expect(local.tabs.map((tab) => tab.url)).toEqual(['https://olivia.example/'])
    expect(local.history.map((item) => item.url)).toEqual(['https://olivia.example/'])
    expect(local.searchSuggestions).toEqual([])
    expect(requestSearchSuggestions).not.toHaveBeenCalled()

    const remote = await queryOmnibox('query', 'oli', { search: true, locale: 'pt-BR' }, 9)
    expect(remote.searchSuggestions).toEqual(['olivia rodrigo'])
    expect(requestSearchSuggestions).toHaveBeenCalledWith(9, 'oli', 'pt-BR')
  })
})

describe('typed navigation focus', () => {
  it('hands the keyboard to the page only for address-bar navigations of a shown browser', () => {
    showInSlot('focus')
    const id = createBrowserTab('focus', 'https://start.example/')
    const wc = tabView('focus', id).webContents

    navigateBrowser('focus', 'agent.example')
    expect(wc.focus).not.toHaveBeenCalled()

    navigateBrowser('focus', 'user.example', { typed: true })
    expect(wc.focus).toHaveBeenCalledOnce()
    expect(wc.loadURL).toHaveBeenLastCalledWith('https://user.example')
  })

  it('leaves the keyboard of a streamed browser with the computer watching it', () => {
    const id = createBrowserTab('streamed', 'https://start.example/')
    const wc = tabView('streamed', id).webContents
    placementByConv.set('streamed', new Map([['browser', 'stream']]))

    navigateBrowser('streamed', 'user.example', { typed: true })

    expect(wc.loadURL).toHaveBeenLastCalledWith('https://user.example')
    expect(wc.focus).not.toHaveBeenCalled()
  })
})

describe('address-bar overlay over the native page', () => {
  function presentedTab(convId: string): FakeView {
    const id = createBrowserTab(convId, 'https://page.example/')
    const view = tabView(convId, id)
    view.setBounds({ x: 400, y: 80, width: 800, height: 700 })
    vi.mocked(applyLayout).mockClear()
    return view
  }

  it('captures the page, then hides it on open and restores it on close', async () => {
    presentedTab('overlay')

    await expect(setOmniboxOverlay('overlay', 'prepare')).resolves.toBe('data:image/png;base64,FRAME')
    expect(omniboxOverlays.get('overlay')).toBe('prepared')
    expect(isBrowserPageHiddenByOmnibox('overlay')).toBe(false)

    await setOmniboxOverlay('overlay', 'open')
    expect(isBrowserPageHiddenByOmnibox('overlay')).toBe(true)

    await setOmniboxOverlay('overlay', 'close')
    expect(omniboxOverlays.has('overlay')).toBe(false)
    expect(applyLayout).toHaveBeenCalledTimes(3)
  })

  it('has no frame for a page that is not on screen but still prepares', async () => {
    const view = presentedTab('offscreen')
    view.setBounds(OFFSCREEN)

    await expect(setOmniboxOverlay('offscreen', 'prepare')).resolves.toBeNull()
    expect(view.webContents.capturePage).not.toHaveBeenCalled()
    expect(omniboxOverlays.get('offscreen')).toBe('prepared')
  })

  it('ignores open without prepare and unknown conversations', async () => {
    presentedTab('unprepared')
    await setOmniboxOverlay('unprepared', 'open')
    expect(omniboxOverlays.has('unprepared')).toBe(false)
    await expect(setOmniboxOverlay('missing', 'prepare')).resolves.toBeNull()
    expect(omniboxOverlays.has('missing')).toBe(false)
  })

  it('lets a close issued during the capture win', async () => {
    const view = presentedTab('race')
    const late = { isEmpty: () => false as const, toDataURL: () => 'data:image/png;base64,FRAME' as const }
    let finish!: () => void
    view.webContents.capturePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(late)
        })
    )

    const prepared = setOmniboxOverlay('race', 'prepare')
    await setOmniboxOverlay('race', 'close')
    finish()

    await expect(prepared).resolves.toBeNull()
    expect(omniboxOverlays.has('race')).toBe(false)
  })

  it('restores the page when the requesting renderer goes away', async () => {
    presentedTab('owner')
    const owner = Object.assign(new EventEmitter(), { id: 500 })

    await setOmniboxOverlay('owner', 'prepare', owner as never)
    await setOmniboxOverlay('owner', 'open', owner as never)
    expect(isBrowserPageHiddenByOmnibox('owner')).toBe(true)

    owner.emit('render-process-gone')
    expect(omniboxOverlays.has('owner')).toBe(false)
  })
})
