import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  type Paint = 'before-scroll' | 'after-scroll'

  /**
   * Chromium-like frame pipeline. While shown, each animation frame first submits the paint produced by the
   * previous main frame, then runs requestAnimationFrame callbacks and paints the current document. Captures
   * copy the last submitted surface, which stays retained while the renderer is hidden.
   */
  class FakeRenderer {
    document: Paint = 'before-scroll'
    submitted: Paint = 'before-scroll'
    private shown = false
    private produced: Paint | null = null
    private callbacks: Array<() => void> = []
    private timer: ReturnType<typeof setTimeout> | undefined

    readonly requestAnimationFrame = (callback: () => void): void => {
      this.callbacks.push(callback)
      this.schedule()
    }

    setShown(shown: boolean): void {
      this.shown = shown
      this.schedule()
    }

    private schedule(): void {
      if (!this.shown || this.timer) return
      this.timer = setTimeout(() => this.frame(), 1)
    }

    private frame(): void {
      this.timer = undefined
      if (!this.shown) return
      if (this.produced) this.submitted = this.produced
      this.produced = null
      for (const callback of this.callbacks.splice(0)) callback()
      if (this.document !== this.submitted) this.produced = this.document
      if (this.callbacks.length > 0 || this.produced) this.schedule()
    }
  }

  const frame = (paint: Paint) => ({ paint, isEmpty: () => false })

  class FakeWebContents {
    readonly renderer = new FakeRenderer()
    private throttled = true
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    // An unthrottled renderer keeps painting wherever its view is parked.
    setBackgroundThrottling = vi.fn((throttled: boolean) => {
      this.throttled = throttled
      this.renderer.setShown(!throttled)
    })
    getBackgroundThrottling = vi.fn(() => this.throttled)
    mainFrame = {
      executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
        const evaluate = new Function('requestAnimationFrame', `return (${code})`) as (raf: unknown) => unknown
        return evaluate(this.renderer.requestAnimationFrame)
      }),
    }
    capturePage = vi.fn(async () => frame(this.renderer.submitted))
    // The first subscribed frame is a refresh of the retained surface, not a new paint.
    beginFrameSubscription = vi.fn((_onlyDirty: boolean, callback: (image: unknown) => void) => {
      const refreshed = frame(this.renderer.submitted)
      queueMicrotask(() => callback(refreshed))
    })
    endFrameSubscription = vi.fn()
    invalidate = vi.fn()
    loadURL = vi.fn(async () => undefined)
    setWindowOpenHandler = vi.fn()
    isFocused = vi.fn(() => false)
    focus = vi.fn()
    isDestroyed = vi.fn(() => false)
    getURL = vi.fn(() => 'https://fixture.test/')
    getTitle = vi.fn(() => 'Fixture')
    isLoading = vi.fn(() => false)
    canGoBack = vi.fn(() => false)
    canGoForward = vi.fn(() => false)
    isDevToolsOpened = vi.fn(() => false)

    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      return this.on(event, listener)
    }
  }

  class FakeContentView {
    readonly children: unknown[] = []
    addChildView = vi.fn((view: unknown, index?: number) => {
      this.children.splice(index ?? this.children.length, 0, view)
    })
    removeChildView = vi.fn((view: unknown) => {
      const index = this.children.indexOf(view)
      if (index >= 0) this.children.splice(index, 1)
    })
  }

  const views: FakeWebContentsView[] = []
  class FakeWebContentsView {
    readonly webContents = new FakeWebContents()
    private bounds = { x: 0, y: 0, width: 0, height: 0 }
    setBackgroundColor = vi.fn()
    setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
      this.bounds = { ...bounds }
    })
    getBounds = vi.fn(() => ({ ...this.bounds }))
    constructor() {
      views.push(this)
    }
  }

  const hosts: FakeBrowserWindow[] = []
  let liveHosts = 0
  let maxLiveHosts = 0
  class FakeBrowserWindow {
    readonly contentView = new FakeContentView()
    private destroyed = false
    showInactive = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    constructor(readonly options: Record<string, unknown>) {
      hosts.push(this)
      liveHosts += 1
      maxLiveHosts = Math.max(maxLiveHosts, liveHosts)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      liveHosts -= 1
    }
  }

  const mainWindow = {
    contentView: new FakeContentView(),
    webContents: { getZoomFactor: vi.fn(() => 1) },
    isDestroyed: () => false,
    isVisible: () => true,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  }

  return {
    views,
    hosts,
    mainWindow,
    WebContentsView: FakeWebContentsView,
    BrowserWindow: FakeBrowserWindow,
    maxLiveHosts: () => maxLiveHosts,
    resetHosts: () => {
      hosts.length = 0
      liveHosts = 0
      maxLiveHosts = 0
    },
  }
})

vi.mock('electron', () => ({
  BrowserWindow: h.BrowserWindow,
  WebContentsView: h.WebContentsView,
  session: {
    fromPartition: vi.fn(() => ({
      setPermissionRequestHandler: vi.fn(),
      clearCache: vi.fn(async () => undefined),
      clearStorageData: vi.fn(async () => undefined),
    })),
  },
}))
vi.mock('../../src/main/window-ipc', () => ({
  broadcast: vi.fn(),
  sendToConversation: vi.fn(),
}))
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
vi.mock('../../src/main/store', () => ({
  getConvUiPrefs: vi.fn(() => ({})),
  patchConvUiPrefs: vi.fn(),
}))
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

import {
  acquireBrowserForControl,
  createBrowserTab,
  disposeBrowserTabEviction,
  flushPendingBrowserPersists,
} from '../../src/main/drawer/browser'
import { OFFSCREEN, drawers, initDrawer } from '../../src/main/drawer/state'
import { disposeMemoryReclaimer } from '../../src/main/performance/memory-reclaimer'

type FakeView = InstanceType<typeof h.WebContentsView>

function parkedBrowser(convId: string) {
  createBrowserTab(convId, 'https://fixture.test/')
  const acquired = acquireBrowserForControl(convId)
  const view = h.views.at(-1)!
  return { acquired, view, wc: view.webContents, index: h.mainWindow.contentView.children.indexOf(view) }
}

function expectRestored(view: FakeView, index: number): void {
  expect(h.mainWindow.contentView.children.filter((child) => child === view)).toHaveLength(1)
  expect(h.mainWindow.contentView.children.indexOf(view)).toBe(index)
  expect(view.getBounds()).toEqual(OFFSCREEN)
  expect(view.webContents.getBackgroundThrottling()).toBe(true)
  expect(h.hosts.every((host) => host.isDestroyed())).toBe(true)
}

describe('parked drawer browser capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.views.length = 0
    h.resetHosts()
    h.mainWindow.contentView.children.length = 0
    drawers.clear()
    initDrawer(h.mainWindow as never)
  })

  afterEach(() => {
    flushPendingBrowserPersists()
    disposeBrowserTabEviction()
    disposeMemoryReclaimer()
  })

  it('waits for the renderer to paint changes made while the tab was parked', async () => {
    const { acquired, view, wc, index } = parkedBrowser('capture-fresh')
    expect(index).toBeGreaterThanOrEqual(0)
    // A scroll applied while the parked renderer was hidden has not reached the retained surface.
    wc.renderer.document = 'after-scroll'

    const image = await acquired.captureFrame(new AbortController().signal)

    expect(image).toMatchObject({ paint: 'after-scroll' })
    expect(wc.mainFrame.executeJavaScript).toHaveBeenCalledOnce()
    expect(h.hosts).toHaveLength(1)
    expectRestored(view, index)
  })

  it('serializes concurrent captures through one capture host at a time', async () => {
    const { acquired, view, wc, index } = parkedBrowser('capture-concurrent')
    wc.renderer.document = 'after-scroll'
    const signal = new AbortController().signal

    const images = await Promise.all([acquired.captureFrame(signal), acquired.captureFrame(signal)])

    expect(images).toEqual([
      expect.objectContaining({ paint: 'after-scroll' }),
      expect.objectContaining({ paint: 'after-scroll' }),
    ])
    expect(h.hosts).toHaveLength(2)
    expect(h.maxLiveHosts()).toBe(1)
    expectRestored(view, index)
  })

  it('cancels a capture whose renderer never paints and restores the parked tab', async () => {
    const { acquired, view, wc, index } = parkedBrowser('capture-abort')
    wc.mainFrame.executeJavaScript.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()

    const capture = acquired.captureFrame(controller.signal)
    await vi.waitFor(() => expect(wc.mainFrame.executeJavaScript).toHaveBeenCalledOnce())
    controller.abort()

    await expect(capture).rejects.toThrow('browser surface capture canceled')
    expect(wc.capturePage).not.toHaveBeenCalled()
    expectRestored(view, index)
  })

  it('captures the presented surface when the page frame cannot evaluate script', async () => {
    const { acquired, view, wc, index } = parkedBrowser('capture-disposed-frame')
    wc.mainFrame.executeJavaScript.mockRejectedValue(
      new Error('Render frame was disposed before WebFrameMain could be accessed')
    )

    const image = await acquired.captureFrame(new AbortController().signal)

    expect(image).toMatchObject({ paint: 'before-scroll' })
    expect(wc.capturePage).toHaveBeenCalled()
    expectRestored(view, index)
  })
})
