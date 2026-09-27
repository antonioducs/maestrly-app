import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fleetEnvironmentTile } from '@maestrly/bot-fleet-protocol'

const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  interface Bounds {
    x: number
    y: number
    width: number
    height: number
  }
  class FakeEvents {
    private readonly listeners = new Map<string, Listener[]>()
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    once(event: string, listener: Listener): this {
      const wrapped: Listener = (...args) => {
        this.removeListener(event, wrapped)
        listener(...args)
      }
      return this.on(event, wrapped)
    }
    removeListener(event: string, listener: Listener): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener)
      )
      return this
    }
    listenerCount(event: string): number {
      return this.listeners.get(event)?.length ?? 0
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
    }
  }
  class FakeWebContents extends FakeEvents {
    url = 'about:blank'
    loadURL = vi.fn(async (url: string) => {
      this.url = url
    })
    setBackgroundThrottling = vi.fn()
    setWindowOpenHandler = vi.fn()
    isDestroyed = vi.fn(() => false)
    isLoading = vi.fn(() => false)
    isFocused = vi.fn(() => false)
    isDevToolsOpened = vi.fn(() => false)
    canGoBack = vi.fn(() => false)
    canGoForward = vi.fn(() => false)
    getURL = vi.fn(() => this.url)
    getTitle = vi.fn(() => '')
  }
  const views: FakeWebContentsView[] = []
  class FakeWebContentsView {
    webContents = new FakeWebContents()
    setBackgroundColor = vi.fn()
    setBounds = vi.fn()
    constructor() {
      views.push(this)
    }
  }
  const app = new FakeEvents()
  /**
   * The keyboard focus of the environment display, as measured there (Xvfb, the environment openbox configuration and
   * Electron 42): `focus()` and `show()` activate only a focusable window, but mapping a hidden window with `show()`
   * lets the window manager focus it anyway; `showInactive()` leaves the focus alone; a disabled window drops the keys
   * it gets.
   */
  const display: { focused: FakeWindow | null } = { focused: null }
  const windows: FakeWindow[] = []
  /** A native window: the app's own ones and the popups Chromium opens. Electron announces each while building it. */
  class FakeWindow extends FakeEvents {
    static getAllWindows(): FakeWindow[] {
      return windows.filter((win) => !win.destroyed)
    }
    readonly options: Record<string, unknown>
    bounds: Bounds
    destroyed = false
    visible = false
    focusable: boolean
    enabled = true
    typed = ''
    webContents = new FakeWebContents()
    setBounds = vi.fn((bounds: Bounds) => {
      this.bounds = { ...bounds }
    })
    getBounds = vi.fn(() => ({ ...this.bounds }))
    center = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    setMenuBarVisibility = vi.fn()
    setTitle = vi.fn()
    isDestroyed = vi.fn(() => this.destroyed)
    isVisible = vi.fn(() => this.visible)
    isFocused = vi.fn(() => display.focused === this)
    isFocusable = vi.fn(() => this.focusable)
    setFocusable = vi.fn((focusable: boolean) => {
      this.focusable = focusable
    })
    isEnabled = vi.fn(() => this.enabled)
    setEnabled = vi.fn((enabled: boolean) => {
      this.enabled = enabled
    })
    focus = vi.fn(() => {
      if (this.visible && this.focusable) display.focused = this
    })
    show = vi.fn(() => {
      const mapped = !this.visible
      this.visible = true
      if (this.focusable || mapped) display.focused = this
    })
    showInactive = vi.fn(() => {
      this.visible = true
    })
    hide = vi.fn(() => {
      this.visible = false
      if (display.focused === this) display.focused = null
    })
    destroy = vi.fn(() => {
      this.destroyed = true
      this.visible = false
      if (display.focused === this) display.focused = null
      this.emit('closed')
    })
    constructor(options: Record<string, unknown> = {}) {
      super()
      this.options = options
      this.focusable = options.focusable !== false
      this.bounds = {
        x: Number(options.x ?? 0),
        y: Number(options.y ?? 0),
        width: Number(options.width ?? 800),
        height: Number(options.height ?? 600),
      }
      windows.push(this)
      app.emit('browser-window-created', { preventDefault: () => {} }, this)
    }
  }
  /** The person in control types: the keys go to the focused window, unless it drops them. */
  const type = (text: string): void => {
    if (display.focused?.enabled) display.focused.typed += text
  }
  return { FakeWebContentsView, FakeWindow, views, app, display, windows, type }
})

vi.mock('electron', () => ({
  app: { on: (event: string, listener: (...args: unknown[]) => void) => h.app.on(event, listener) },
  BrowserWindow: h.FakeWindow,
  WebContentsView: h.FakeWebContentsView,
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 3840, height: 2400 } }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 3840, height: 2400 } }],
  },
  session: { fromPartition: () => ({ setPermissionRequestHandler: () => undefined }) },
}))
vi.mock('../../src/main/window-ipc', () => ({
  broadcast: vi.fn(),
  registerPanelTarget: vi.fn(),
  sendToConversation: vi.fn(),
}))
vi.mock('../../src/main/store', () => ({
  getAppFlag: vi.fn(() => undefined),
  setAppFlag: vi.fn(),
  getConversation: vi.fn(() => undefined),
  getWorkspace: vi.fn(() => undefined),
  getConvUiPrefs: vi.fn(() => ({})),
  patchConvUiPrefs: vi.fn(),
}))
vi.mock('../../src/main/drawer-scope', () => ({ conversationTabAllowed: vi.fn(() => true) }))
vi.mock('../../src/main/drawer-manager', () => ({
  FLOAT_CHROME_H: 32,
  floatView: vi.fn(() => true),
  unfloatView: vi.fn(),
  layoutFloatingTab: vi.fn(),
  floatingTabsOf: vi.fn(() => []),
  focusFloatingContent: vi.fn(),
  navigateFocusedBrowser: vi.fn(() => false),
  navigateFocusedVSCode: vi.fn(() => false),
}))
vi.mock('../../src/main/resolve-preload', () => ({ resolvePreload: () => '/synthetic/preload.js' }))
vi.mock('../../src/main/hotkeys', () => ({ attachHotkeyCapture: vi.fn() }))
vi.mock('../../src/main/i18n', () => ({ tMain: () => (key: string) => key }))
vi.mock('../../src/main/popup-manager', () => ({ restoreFocusAfterFloatingClose: vi.fn() }))
vi.mock('../../src/main/mouse-navigation', () => ({
  attachMacMouseNavigation: vi.fn(),
  attachWindowNavigation: vi.fn(),
}))
vi.mock('../../src/main/drawer/performance', () => ({ setDrawerPlacementPerformance: vi.fn() }))
vi.mock('../../src/main/fleet/instance/config', () => ({ isBotMode: vi.fn(() => true) }))
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
vi.mock('../../src/main/drawer/layout', () => ({ applyLayout: vi.fn() }))
vi.mock('../../src/main/drawer/float', () => ({ layoutFloatingTab: vi.fn() }))
vi.mock('../../src/main/drawer/popup', () => ({ focusViewInMain: vi.fn() }))

import {
  holdScreenFocus,
  mayTakeScreenFocus,
  setScreenFocusOwner,
  showWindow,
  type ScreenFocusOwner,
} from '../../src/main/screen-focus'
import { setConversationScreen, type ScreenArea } from '../../src/main/conversation-screen'
import {
  detach,
  disposeAll,
  disposeConversation,
  focusFloatIfAny,
  getFloatWin,
  initFloatingManager,
  reattach,
  setPinned,
} from '../../src/main/floating-manager'
import {
  createBrowserTab,
  disposeBrowserTabEviction,
  flushPendingBrowserPersists,
  focusBrowserPopup,
} from '../../src/main/drawer/browser'
import { initDrawer } from '../../src/main/drawer/state'
import { focusFloatingContent } from '../../src/main/drawer-manager'
import { disposeMemoryReclaimer } from '../../src/main/performance/memory-reclaimer'

type FakeWindow = InstanceType<typeof h.FakeWindow>
type FakeView = InstanceType<typeof h.FakeWebContentsView>
type OpenHandler = (details: { url: string; disposition?: string; features?: string }) => {
  action: 'allow' | 'deny'
  overrideBrowserWindowOptions?: Record<string, unknown>
}

const mainWindow = {
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  webContents: { getZoomFactor: vi.fn(() => 1) },
}
const conversations = ['bot-alpha', 'bot-beta', 'bot-gamma']
const holds: Array<() => void> = []
const conversation = (conversationId: string): ScreenFocusOwner => ({ kind: 'conversation', conversationId })
const native = (win: FakeWindow) => win as never
const state = (win: FakeWindow) => ({ focusable: win.focusable, enabled: win.enabled })
const restricted = { focusable: false, enabled: false }
const free = { focusable: true, enabled: true }
const inside = (bounds: ScreenArea, area: ScreenArea): boolean =>
  bounds.x >= area.x &&
  bounds.y >= area.y &&
  bounds.x + bounds.width <= area.x + area.width &&
  bounds.y + bounds.height <= area.y + area.height

/** A control of the environment display, as bot mode starts one: the controlled screen gets the keyboard. */
function control(owner: ScreenFocusOwner | null, focus?: () => void): () => void {
  const release = holdScreenFocus(
    owner,
    focus ??
      (() => {
        if (owner?.kind !== 'conversation') return
        if (!focusBrowserPopup(owner.conversationId)) focusFloatIfAny(owner.conversationId, 'browser')
      })
  )
  holds.push(release)
  return release
}

/** A bot's browser with one page, pinned in its tile of the environment display as its tools show it. */
function bot(conversationId: string, slot: number): { window: FakeWindow; page: FakeView; tile: ScreenArea } {
  const tile = fleetEnvironmentTile(slot)
  setConversationScreen(conversationId, { display: `:${slot}`, width: 1280, height: 800, windowArea: tile })
  detach(conversationId, 'browser', { focus: false })
  setPinned(conversationId, 'browser', true)
  createBrowserTab(conversationId, 'https://site.test')
  const page = h.views.at(-1)
  if (!page) throw new Error('No browser page')
  return { window: getFloatWin(conversationId, 'browser') as unknown as FakeWindow, page, tile }
}

/** A page opens a popup: Electron builds the window with the options its handler gave, then reports it. */
function openPopup(page: FakeView, size = { width: 500, height: 400 }): FakeWindow {
  const handler = page.webContents.setWindowOpenHandler.mock.calls.at(-1)?.[0] as OpenHandler
  const decision = handler({
    url: 'https://sign-in.test',
    disposition: 'new-window',
    features: `popup,width=${size.width},height=${size.height}`,
  })
  expect(decision.action).toBe('allow')
  const popup = new h.FakeWindow({ show: true, ...size, ...decision.overrideBrowserWindowOptions })
  // A window built with `show: true` is shown, and activated, before anyone hears of it.
  if (popup.options.show !== false) popup.show()
  page.webContents.emit('did-create-window', popup)
  return popup
}

afterEach(() => {
  for (const release of holds.splice(0)) release()
  for (const win of [...h.windows]) if (!win.destroyed) win.destroy()
  h.windows.length = 0
  h.display.focused = null
  for (const id of conversations) setConversationScreen(id, null)
  disposeAll()
  flushPendingBrowserPersists()
  disposeBrowserTabEviction()
  disposeMemoryReclaimer()
  vi.clearAllMocks()
  h.views.length = 0
})

describe('the keyboard of the shared environment display', () => {
  beforeEach(() => {
    initDrawer(mainWindow as never)
    initFloatingManager(mainWindow as never)
  })

  it('keeps the bot browser in its tile when it is closed or docked, but still destroys it on uninstall', async () => {
    const alpha = bot('bot-alpha', 1)
    control(conversation('bot-alpha'))
    const preventDefault = vi.fn()
    alpha.window.emit('close', { preventDefault })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(alpha.window.destroyed).toBe(false)
    expect(getFloatWin('bot-alpha', 'browser')).toBe(alpha.window)
    reattach('bot-alpha', 'browser')
    expect(alpha.window.destroyed).toBe(false)
    expect(getFloatWin('bot-alpha', 'browser')).toBe(alpha.window)
    disposeConversation('bot-alpha')
    expect(alpha.window.destroyed).toBe(true)
  })

  it("keeps the owner's typing in the controlled bot's browser while another bot opens a popup", () => {
    const alpha = bot('bot-alpha', 1)
    const beta = bot('bot-beta', 2)
    expect(h.display.focused).toBeNull()

    control(conversation('bot-alpha'))
    // The controlled browser has the keyboard at once, before any click.
    expect(h.display.focused).toBe(alpha.window)

    const popup = openPopup(beta.page)
    expect(popup.options.show).toBe(false)
    expect(popup.visible).toBe(true)
    expect(inside(popup.getBounds(), beta.tile)).toBe(true)
    expect(h.display.focused).toBe(alpha.window)
    // Nothing Beta's pages or tools do takes the keyboard.
    popup.focus()
    detach('bot-beta', 'browser', { focus: false })
    detach('bot-beta', 'browser')
    focusFloatIfAny('bot-beta', 'browser')
    expect(h.display.focused).toBe(alpha.window)

    h.type('owner-alpha')
    expect(alpha.window.typed).toBe('owner-alpha')
    expect(popup.typed).toBe('')
    // Should the window manager hand the popup the focus anyway, the popup drops the keys.
    h.display.focused = popup
    h.type('hidden-text')
    expect(popup.typed).toBe('')
  })

  it('gives every window its previous state back when the control ends', () => {
    const alpha = bot('bot-alpha', 1)
    const beta = bot('bot-beta', 2)
    const release = control(conversation('bot-alpha'))
    const popup = openPopup(beta.page)
    expect([beta.window, popup].map(state)).toEqual([restricted, restricted])

    release()
    release()
    expect([alpha.window, beta.window, popup].map(state)).toEqual([free, free, free])
    popup.focus()
    h.type('after')
    expect(popup.typed).toBe('after')
    // Outside a control a popup takes the keyboard, as it always did.
    const next = openPopup(beta.page)
    expect(h.display.focused).toBe(next)
  })

  it("lets the controlled bot's popups take the keyboard inside its own tile", async () => {
    const alpha = bot('bot-alpha', 1)
    bot('bot-beta', 2)
    control(conversation('bot-alpha'))
    const signIn = openPopup(alpha.page)
    expect(h.display.focused).toBe(signIn)
    expect(state(signIn)).toEqual(free)
    expect(inside(signIn.getBounds(), alpha.tile)).toBe(true)
    h.type('123456')
    expect(signIn.typed).toBe('123456')

    // Its page cannot move or grow it out of the tile.
    const moved = { preventDefault: vi.fn() }
    signIn.webContents.emit('content-bounds-updated', moved, { x: 3000, y: 2000, width: 2000, height: 1500 })
    expect(moved.preventDefault).toHaveBeenCalledOnce()
    expect(inside(signIn.getBounds(), alpha.tile)).toBe(true)

    // Closing it gives the keyboard back to the browser page, which the window manager alone would not.
    signIn.destroy()
    expect(h.display.focused).toBe(alpha.window)
    await vi.waitFor(() => expect(focusFloatingContent).toHaveBeenLastCalledWith('bot-alpha', 'browser'))

    // A new control gives the keyboard to the popup above the browser, and to the browser without one.
    const consent = openPopup(alpha.page)
    h.display.focused = null
    control(conversation('bot-alpha'))
    expect(h.display.focused).toBe(consent)
    h.display.focused = null
    consent.hide()
    control(conversation('bot-alpha'))
    expect(h.display.focused).toBe(alpha.window)
  })

  it('sends the keyboard on from the strip to the page when a browser window is activated', async () => {
    const alpha = bot('bot-alpha', 1)
    vi.mocked(focusFloatingContent).mockClear()
    // Electron focused the strip, as it does on every activation.
    alpha.window.webContents.isFocused.mockReturnValue(true)
    alpha.window.emit('focus')
    await vi.waitFor(() => expect(focusFloatingContent).toHaveBeenCalledExactlyOnceWith('bot-alpha', 'browser'))
    // A click already put the keyboard elsewhere, such as the address bar: it stays there.
    alpha.window.webContents.isFocused.mockReturnValue(false)
    alpha.window.emit('focus')
    await new Promise((resolve) => setImmediate(resolve))
    expect(focusFloatingContent).toHaveBeenCalledOnce()
  })

  it("leaves the keyboard alone when another screen's popup closes", () => {
    const alpha = bot('bot-alpha', 1)
    const beta = bot('bot-beta', 2)
    const popup = openPopup(beta.page)
    control(conversation('bot-alpha'))
    h.display.focused = null
    popup.destroy()
    expect(h.display.focused).toBeNull()
    expect(alpha.window.focus).toHaveBeenCalledOnce()
  })

  it('shows the settings another device opens without taking the keyboard from the controlled bot', () => {
    // Bot mode builds the environment screen hidden.
    const settings = new h.FakeWindow({ title: 'Maestrly' })
    setScreenFocusOwner(native(settings), { kind: 'environment' })
    const alpha = bot('bot-alpha', 1)
    const release = control(conversation('bot-alpha'))
    showWindow(native(settings))
    expect(settings.visible).toBe(true)
    expect(settings.show).not.toHaveBeenCalled()
    expect(h.display.focused).toBe(alpha.window)
    release()

    // Controlling the environment screen gives it the keyboard; a bot browser that opens meanwhile cannot take it.
    control({ kind: 'environment' }, () => settings.focus())
    expect(h.display.focused).toBe(settings)
    const gamma = bot('bot-gamma', 3)
    expect(state(gamma.window)).toEqual(restricted)
    showWindow(native(settings))
    expect(h.display.focused).toBe(settings)
    h.type('api-key-text')
    expect(settings.typed).toBe('api-key-text')
    expect(alpha.window.typed).toBe('')
  })

  it("shows a bot's browser for its tools again and again without focusing it or raising it over its popups", () => {
    const beta = bot('bot-beta', 2)
    const signIn = openPopup(beta.page)
    expect(h.display.focused).toBe(signIn)
    const focusListeners = beta.window.listenerCount('focus')
    for (let call = 0; call < 3; call++) {
      detach('bot-beta', 'browser', { focus: false })
      setPinned('bot-beta', 'browser', true)
    }
    expect(beta.window.focus).not.toHaveBeenCalled()
    expect(beta.window.show).not.toHaveBeenCalled()
    // Nothing waits for a focus that never comes.
    expect(beta.window.listenerCount('focus')).toBe(focusListeners)
    expect(h.display.focused).toBe(signIn)
  })
})

describe('holding the focus of a shared display', () => {
  it('restricts windows that open during a control until their owner is known, and restores what each had', () => {
    const own = new h.FakeWindow()
    setScreenFocusOwner(native(own), conversation('bot-alpha'))
    // Like the hidden host of a browser screenshot, which is never focusable.
    const captureHost = new h.FakeWindow({ focusable: false })
    const closing = new h.FakeWindow()
    const release = control(conversation('bot-alpha'), () => {})
    expect([own, captureHost, closing].map(state)).toEqual([free, restricted, restricted])
    closing.destroy()

    const late = new h.FakeWindow()
    expect(state(late)).toEqual(restricted)
    expect(mayTakeScreenFocus(native(late))).toBe(false)
    setScreenFocusOwner(native(late), conversation('bot-alpha'))
    expect(state(late)).toEqual(free)
    const other = new h.FakeWindow()
    setScreenFocusOwner(native(other), conversation('bot-beta'))
    expect(state(other)).toEqual(restricted)

    release()
    expect(state(captureHost)).toEqual({ focusable: false, enabled: true })
    expect(state(other)).toEqual(free)
    expect(closing.setFocusable).toHaveBeenCalledOnce()
    // Outside a control nothing is restricted.
    const after = new h.FakeWindow()
    expect(after.setFocusable).not.toHaveBeenCalled()
    expect(mayTakeScreenFocus(native(other))).toBe(true)
  })

  it('watches a window for closing once, however many controls restrict it', () => {
    const other = new h.FakeWindow()
    setScreenFocusOwner(native(other), conversation('bot-beta'))
    for (let hold = 0; hold < 5; hold++) {
      control(conversation('bot-alpha'), () => {})()
      control({ kind: 'environment' }, () => {})()
    }
    expect(other.listenerCount('closed')).toBe(1)
    expect(state(other)).toEqual(free)
    control(conversation('bot-alpha'), () => {})
    other.destroy()
    expect(other.listenerCount('closed')).toBe(0)
  })

  it('lets a newer control replace an older one, whose release then changes nothing', () => {
    const alpha = new h.FakeWindow()
    setScreenFocusOwner(native(alpha), conversation('bot-alpha'))
    const beta = new h.FakeWindow()
    setScreenFocusOwner(native(beta), conversation('bot-beta'))
    const first = control(conversation('bot-alpha'), () => {})
    control(conversation('bot-beta'), () => {})
    expect([alpha, beta].map(state)).toEqual([restricted, free])
    first()
    expect([alpha, beta].map(state)).toEqual([restricted, free])
  })

  it('keeps every window out of a control of a screen without windows, even when focusing fails', () => {
    const alpha = new h.FakeWindow()
    setScreenFocusOwner(native(alpha), conversation('bot-alpha'))
    const settings = new h.FakeWindow()
    setScreenFocusOwner(native(settings), { kind: 'environment' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const release = control(null, () => {
        throw new Error('The window is gone.')
      })
      expect([alpha, settings].map(state)).toEqual([restricted, restricted])
      expect(error).toHaveBeenCalledOnce()
      release()
      expect([alpha, settings].map(state)).toEqual([free, free])
    } finally {
      error.mockRestore()
    }
  })
})
