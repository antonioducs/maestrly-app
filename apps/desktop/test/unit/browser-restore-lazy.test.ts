import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeWebContents {
    currentUrl = 'about:blank'
    currentTitle = ''
    destroyed = false
    listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    loadURL = vi.fn(async (url: string) => {
      this.currentUrl = url
    })
    setBackgroundThrottling = vi.fn()
    setWindowOpenHandler = vi.fn()
    close = vi.fn(() => {
      this.destroyed = true
      this.emit('destroyed')
    })
    reload = vi.fn()
    canGoBack = vi.fn(() => false)
    canGoForward = vi.fn(() => false)
    isDevToolsOpened = vi.fn(() => false)
    isLoading = vi.fn(() => false)
    isFocused = vi.fn(() => false)
    goBack = vi.fn()
    goForward = vi.fn()
    openDevTools = vi.fn()
    closeDevTools = vi.fn()
    focus = vi.fn()

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
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]) => {
        this.removeListener(event, wrapped)
        listener(...args)
      }
      return this.on(event, wrapped)
    }
    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener)
      )
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
    }
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents()
    setBackgroundColor = vi.fn()
    setBounds = vi.fn()
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 }))
  }

  const views: FakeWebContentsView[] = []
  class TrackedWebContentsView extends FakeWebContentsView {
    constructor() {
      super()
      views.push(this)
    }
  }
  return { views, WebContentsView: TrackedWebContentsView }
})

vi.mock('electron', () => ({
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
  getConvUiPrefs: vi.fn(),
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

import { getConvUiPrefs, patchConvUiPrefs } from '../../src/main/store'
import { acquireAgentActivity } from '../../src/main/performance/resource-governor'
import {
  BROWSER_TAB_COLD_RETRY_MS,
  BROWSER_TAB_COLD_TTL_MS,
  acquireBrowserTabForControl,
  closeBrowserTab,
  createBrowserTab,
  disposeBrowserTabEviction,
  ensureBrowser,
  flushPendingBrowserPersists,
  getBrowserState,
  getBrowserTabOwnerScopeId,
  listBrowserTabIdsOwnedByScope,
  noteBrowserSurfaceVisibility,
  reorderBrowserTab,
  scheduleColdBrowserEviction,
  switchBrowserTab,
} from '../../src/main/drawer/browser'
import { drawers, getDrawer, initDrawer, setActiveConvId, setSlot, setVisibleKind } from '../../src/main/drawer/state'
import { disposeMemoryReclaimer, runMemoryReclaim } from '../../src/main/performance/memory-reclaimer'

describe('lazy restoration of persisted tabs', () => {
  const mainWindow = {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    // placedSlot reads the slot zoom; this fake suffices for visibility tests.
    webContents: { getZoomFactor: vi.fn(() => 1) },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    h.views.length = 0
    drawers.clear()
    initDrawer(mainWindow as never)
    vi.mocked(getConvUiPrefs).mockReturnValue({
      browserTabs: [
        { url: 'https://one.test', title: 'One' },
        { url: 'https://two.test', title: 'Two' },
        { url: 'https://three.test', title: 'Three' },
      ],
      browserActive: 1,
    })
  })

  afterEach(() => {
    disposeBrowserTabEviction()
    disposeMemoryReclaimer()
    setActiveConvId(null)
    setVisibleKind(null)
    setSlot(null)
    vi.useRealTimers()
  })

  it('restores all descriptors and materializes only the active or explicitly selected tab', () => {
    ensureBrowser('restore-lazy')

    const drawer = getDrawer('restore-lazy')
    expect(drawer.browserTabs).toHaveLength(3)
    expect(drawer.browserTabs.filter((tab) => tab.view)).toHaveLength(1)
    expect(h.views).toHaveLength(1)
    expect(h.views[0]?.webContents.loadURL).toHaveBeenCalledWith('https://two.test')
    expect(getBrowserState('restore-lazy').tabs.map((tab) => tab.url)).toEqual([
      'https://one.test',
      'https://two.test',
      'https://three.test',
    ])

    const coldId = drawer.browserTabs[0]!.id
    const warmId = drawer.browserTabs[1]!.id
    switchBrowserTab('restore-lazy', coldId)

    expect(h.views).toHaveLength(2)
    expect(drawer.browserTabs.filter((tab) => tab.view)).toHaveLength(2)
    expect(drawer.browserTabs[1]!.id).toBe(warmId)
    expect(drawer.browserTabs[2]!.view).toBeNull()
    expect(h.views[1]?.webContents.loadURL).toHaveBeenCalledWith('https://one.test')
  })

  it('acquires an exact cold tab without switching and detects later closure', () => {
    const release = vi.fn()
    vi.mocked(acquireAgentActivity).mockReturnValue(release)
    ensureBrowser('restore-exact-acquire')
    const drawer = getDrawer('restore-exact-acquire')
    const activeId = drawer.activeBrowserId
    const cold = drawer.browserTabs[0]!

    const acquired = acquireBrowserTabForControl('restore-exact-acquire', cold.id)

    expect(drawer.activeBrowserId).toBe(activeId)
    expect(cold.view).not.toBeNull()
    expect(acquired.webContents).toBe(cold.view!.webContents)
    expect(acquired.isCurrent()).toBe(true)
    expect(acquireAgentActivity).toHaveBeenCalledWith('browser', 'restore-exact-acquire', cold.id)

    closeBrowserTab('restore-exact-acquire', cold.id)
    expect(acquired.isCurrent()).toBe(false)
    acquired.release()
    acquired.release()
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps owned tabs in the background and inherits ownership through window.open', () => {
    ensureBrowser('restore-owned')
    const drawer = getDrawer('restore-owned')
    const uiActiveId = drawer.activeBrowserId

    const ownedId = createBrowserTab('restore-owned', 'https://owned.test', {
      ownerScopeId: 'delegate-a',
      activate: false,
    })
    const owned = drawer.browserTabs.find((tab) => tab.id === ownedId)!
    expect(drawer.activeBrowserId).toBe(uiActiveId)
    expect(getBrowserTabOwnerScopeId('restore-owned', ownedId)).toBe('delegate-a')

    const windowOpenHandler = vi.mocked(owned.view!.webContents.setWindowOpenHandler).mock.calls[0]![0]
    expect(
      windowOpenHandler({
        url: 'https://child.test',
        disposition: 'background-tab',
        features: '',
      } as never)
    ).toEqual({ action: 'deny' })

    const ownedIds = listBrowserTabIdsOwnedByScope('restore-owned', 'delegate-a')
    expect(ownedIds).toHaveLength(2)
    expect(drawer.browserTabs.find((tab) => tab.id === ownedIds[1])?.url).toBe('https://child.test')
    expect(drawer.activeBrowserId).toBe(uiActiveId)
    expect(getBrowserState('restore-owned').tabs.map((tab) => tab.id)).not.toEqual(expect.arrayContaining(ownedIds))

    // A public mutation may persist while workers are active, but only the public descriptors cross that boundary.
    switchBrowserTab('restore-owned', uiActiveId!)
    flushPendingBrowserPersists()
    expect(patchConvUiPrefs).toHaveBeenLastCalledWith(
      'restore-owned',
      expect.objectContaining({
        browserTabs: [
          { url: 'https://one.test', title: 'One' },
          { url: 'https://two.test', title: 'Two' },
          { url: 'https://three.test', title: 'Three' },
        ],
      })
    )

    for (const id of ownedIds) closeBrowserTab('restore-owned', id)
    flushPendingBrowserPersists()
    expect(drawer.browserTabs.map((tab) => tab.id)).not.toContain(ownedId)
  })

  it('creates a UI-owned tab instead of adopting a background worker tab', () => {
    const ownedId = createBrowserTab('restore-owned-only', 'https://worker.test', {
      ownerScopeId: 'delegate-a',
      activate: false,
    })
    const drawer = getDrawer('restore-owned-only')
    expect(drawer.activeBrowserId).toBeNull()
    expect(getBrowserState('restore-owned-only').tabs).toEqual([])

    ensureBrowser('restore-owned-only')

    expect(drawer.activeBrowserId).not.toBe(ownedId)
    expect(drawer.browserTabs.find((tab) => tab.id === drawer.activeBrowserId)?.ownerScopeId).toBeUndefined()
    expect(getBrowserState('restore-owned-only').tabs).toHaveLength(3)
    expect(getBrowserState('restore-owned-only').tabs.map((tab) => tab.id)).not.toContain(ownedId)
  })

  it('never flushes private-only browser mutations over saved UI preferences', () => {
    const ownedId = createBrowserTab('restore-private-persist', 'https://worker.test', {
      ownerScopeId: 'delegate-a',
      activate: false,
    })

    flushPendingBrowserPersists()
    expect(patchConvUiPrefs).not.toHaveBeenCalledWith('restore-private-persist', expect.anything())

    closeBrowserTab('restore-private-persist', ownedId)
    flushPendingBrowserPersists()
    expect(patchConvUiPrefs).not.toHaveBeenCalledWith('restore-private-persist', expect.anything())
  })

  it('keeps public reorder and close fallback isolated from interleaved worker tabs', () => {
    ensureBrowser('restore-public-order')
    const drawer = getDrawer('restore-public-order')
    const ownedId = createBrowserTab('restore-public-order', 'https://worker.test', {
      ownerScopeId: 'delegate-a',
      activate: false,
    })
    const newestUiId = createBrowserTab('restore-public-order', 'https://new-ui.test')
    expect(drawer.browserTabs.at(-2)?.id).toBe(ownedId)
    expect(drawer.browserTabs.at(-1)?.id).toBe(newestUiId)

    reorderBrowserTab('restore-public-order', 3, 0)
    expect(getBrowserState('restore-public-order').tabs.map((tab) => tab.url)).toEqual([
      'https://new-ui.test',
      'https://one.test',
      'https://two.test',
      'https://three.test',
    ])
    expect(drawer.browserTabs.findIndex((tab) => tab.id === ownedId)).toBe(3)

    closeBrowserTab('restore-public-order', newestUiId)
    expect(drawer.activeBrowserId).not.toBe(ownedId)
    expect(drawer.browserTabs.find((tab) => tab.id === drawer.activeBrowserId)?.ownerScopeId).toBeUndefined()
  })

  it('updates the outgoing tab usage and delegates eviction to the central policy', async () => {
    vi.useFakeTimers()
    ensureBrowser('restore-switch-touch')
    const drawer = getDrawer('restore-switch-touch')
    const outgoing = drawer.browserTabs[1]!
    const incoming = drawer.browserTabs[0]!

    vi.advanceTimersByTime(BROWSER_TAB_COLD_TTL_MS + 1)
    switchBrowserTab('restore-switch-touch', incoming.id)

    expect(outgoing.lastUsedAt).toBe(Date.now())
    expect(outgoing.view).not.toBeNull()
    await vi.advanceTimersByTimeAsync(BROWSER_TAB_COLD_TTL_MS - 1)
    expect(outgoing.view).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(outgoing.view).toBeNull()
  })

  it('updates the active tab usage and delegates eviction to the central policy', async () => {
    vi.useFakeTimers()
    ensureBrowser('restore-create-touch')
    const drawer = getDrawer('restore-create-touch')
    const outgoing = drawer.browserTabs[1]!

    vi.advanceTimersByTime(BROWSER_TAB_COLD_TTL_MS + 1)
    createBrowserTab('restore-create-touch', 'https://new.test')

    expect(outgoing.lastUsedAt).toBe(Date.now())
    await vi.advanceTimersByTimeAsync(BROWSER_TAB_COLD_TTL_MS - 1)
    expect(outgoing.view).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(outgoing.view).toBeNull()
  })

  it('reorders, closes and persists cold descriptors without materializing them', () => {
    ensureBrowser('restore-persist')
    const drawer = getDrawer('restore-persist')
    const coldId = drawer.browserTabs[2]!.id

    reorderBrowserTab('restore-persist', 2, 0)
    closeBrowserTab('restore-persist', coldId)
    flushPendingBrowserPersists()

    expect(h.views).toHaveLength(1)
    expect(patchConvUiPrefs).toHaveBeenCalledWith(
      'restore-persist',
      expect.objectContaining({
        browserTabs: [
          { url: 'https://one.test', title: 'One' },
          { url: 'https://two.test', title: 'Two' },
        ],
      })
    )
  })

  it('evicts an old inactive materialized tab while retaining its descriptor and the active view', async () => {
    vi.useFakeTimers()
    ensureBrowser('restore-evict')
    const drawer = getDrawer('restore-evict')
    const inactive = drawer.browserTabs[1]!
    const active = drawer.browserTabs[0]!

    switchBrowserTab('restore-evict', active.id)
    ;(active.view!.webContents as unknown as { currentTitle: string }).currentTitle = 'Active title'
    ;(inactive.view!.webContents as unknown as { currentTitle: string }).currentTitle = 'Cold title'
    inactive.lastUsedAt = Date.now() - BROWSER_TAB_COLD_TTL_MS - 1
    scheduleColdBrowserEviction()

    await vi.runOnlyPendingTimersAsync()

    expect(inactive.view).toBeNull()
    expect(active.view).not.toBeNull()
    expect(inactive.url).toBe('https://two.test')
    expect(inactive.title).toBe('Cold title')
    expect(patchConvUiPrefs).toHaveBeenCalledWith(
      'restore-evict',
      expect.objectContaining({
        browserTabs: expect.arrayContaining([{ url: 'https://two.test', title: 'Cold title' }]),
      })
    )
  })

  it('retries protected tabs and evicts them after DevTools closes', async () => {
    vi.useFakeTimers()
    ensureBrowser('restore-devtools')
    const drawer = getDrawer('restore-devtools')
    const active = drawer.browserTabs[1]!
    const protectedTab = drawer.browserTabs[0]!
    switchBrowserTab('restore-devtools', protectedTab.id)
    vi.spyOn(active.view!.webContents, 'isDevToolsOpened').mockReturnValue(true)
    active.lastUsedAt = Date.now() - BROWSER_TAB_COLD_TTL_MS - 1
    scheduleColdBrowserEviction()

    await vi.runOnlyPendingTimersAsync()
    expect(active.view).not.toBeNull()

    vi.spyOn(active.view!.webContents, 'isDevToolsOpened').mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(BROWSER_TAB_COLD_RETRY_MS)

    expect(active.view).toBeNull()
  })

  it('evicts the active descriptor of a hidden conversation and rematerializes it as active', async () => {
    vi.useFakeTimers()
    ensureBrowser('restore-hidden-active')
    const drawer = getDrawer('restore-hidden-active')
    const active = drawer.browserTabs[1]!
    setActiveConvId('other-conv')
    setVisibleKind('browser')
    active.lastUsedAt = Date.now() - BROWSER_TAB_COLD_TTL_MS - 1
    scheduleColdBrowserEviction()

    await vi.runOnlyPendingTimersAsync()

    expect(drawer.activeBrowserId).toBe(active.id)
    expect(active.view).toBeNull()
    expect(active.url).toBe('https://two.test')

    setActiveConvId('restore-hidden-active')
    ensureBrowser('restore-hidden-active')
    expect(drawer.activeBrowserId).toBe(active.id)
    expect(active.view).not.toBeNull()
    expect(h.views.at(-1)?.webContents.loadURL).toHaveBeenCalledWith('https://two.test')
  })

  it('restarts the warm TTL when a visible tab becomes hidden', async () => {
    vi.useFakeTimers()
    ensureBrowser('restore-visible-hide')
    const drawer = getDrawer('restore-visible-hide')
    const active = drawer.browserTabs[1]!

    // The browser has remained visible beyond TTL without events, aging lastUsedAt.
    setActiveConvId('restore-visible-hide')
    setVisibleKind('browser')
    setSlot({ x: 0, y: 0, width: 800, height: 600 })
    noteBrowserSurfaceVisibility('restore-visible-hide') // Visible protection applies without touching the usage timestamp.
    active.lastUsedAt = Date.now() - BROWSER_TAB_COLD_TTL_MS - 1
    scheduleColdBrowserEviction()

    // An aged TTL cannot evict a visible tab.
    await vi.runOnlyPendingTimersAsync()
    expect(active.view).not.toBeNull()

    // Hiding the conversation restarts the warm TTL.
    setActiveConvId('other-conv')
    noteBrowserSurfaceVisibility('restore-visible-hide')
    expect(active.lastUsedAt).toBe(Date.now())

    // The warm period prevents immediate eviction after hiding.
    await vi.advanceTimersByTimeAsync(BROWSER_TAB_COLD_TTL_MS - 1)
    expect(active.view).not.toBeNull()
    // Evict at the new visibility deadline while retaining the descriptor.
    await vi.advanceTimersByTimeAsync(1)
    expect(active.view).toBeNull()
    expect(active.url).toBe('https://two.test')
  })

  it('hard pressure bypasses a fresh visibility TTL to preserve aggressive reclaim', async () => {
    vi.useFakeTimers()
    ensureBrowser('restore-hard-reclaim')
    const drawer = getDrawer('restore-hard-reclaim')
    const active = drawer.browserTabs[1]!

    // Recent hiding refreshed lastUsedAt, leaving the whole warm period.
    setActiveConvId('other-conv')
    noteBrowserSurfaceVisibility('restore-hard-reclaim')
    expect(active.lastUsedAt).toBe(Date.now())

    await runMemoryReclaim('hard')

    expect(active.view).toBeNull()
  })
})
