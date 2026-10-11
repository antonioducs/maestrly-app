import { afterEach, describe, expect, it, vi } from 'vitest'

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
  /** Stands for floating BrowserWindows and for native popups created by Chromium. */
  class FakeWindow extends FakeEvents {
    bounds: Bounds
    readonly options: Record<string, unknown>
    webContents = new FakeWebContents()
    setBounds = vi.fn((bounds: Bounds) => {
      this.bounds = { ...bounds }
    })
    getBounds = vi.fn(() => ({ ...this.bounds }))
    center = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    setMenuBarVisibility = vi.fn()
    isDestroyed = vi.fn(() => false)
    isVisible = vi.fn(() => false)
    isFocused = vi.fn(() => false)
    show = vi.fn()
    showInactive = vi.fn()
    hide = vi.fn()
    focus = vi.fn()
    destroy = vi.fn()
    setTitle = vi.fn()
    constructor(options: Record<string, unknown>) {
      super()
      this.options = options
      this.bounds = {
        x: Number(options.x),
        y: Number(options.y),
        width: Number(options.width),
        height: Number(options.height),
      }
    }
  }
  return { FakeWebContentsView, FakeWindow, views, primaryWorkArea: { x: 0, y: 0, width: 3840, height: 2400 } }
})

vi.mock('electron', () => ({
  BrowserWindow: h.FakeWindow,
  WebContentsView: h.FakeWebContentsView,
  screen: {
    getPrimaryDisplay: () => ({ workArea: h.primaryWorkArea }),
    getAllDisplays: () => [{ workArea: h.primaryWorkArea }],
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
  conversationScreen,
  onConversationScreenChange,
  presentedBrowserSize,
  setConversationScreen,
  setPresentedBrowserSize,
  type ConversationScreen,
} from '../../src/main/conversation-screen'
import { layoutFloatingTab } from '../../src/main/drawer-manager'
import { centerInArea, clampToArea, environmentScreenBounds } from '../../src/main/fleet/instance/window-bounds'
import { detach, disposeAll, getFloatWin, initFloatingManager, setFloatBounds } from '../../src/main/floating-manager'
import { getConvUiPrefs, type FloatTab } from '../../src/main/store'
import { isBotMode } from '../../src/main/fleet/instance/config'
import { createBrowserTab, disposeBrowserTabEviction, flushPendingBrowserPersists } from '../../src/main/drawer/browser'
import { initDrawer } from '../../src/main/drawer/state'
import { disposeMemoryReclaimer } from '../../src/main/performance/memory-reclaimer'

const botA: ConversationScreen = {
  display: ':2',
  width: 1024,
  height: 768,
  windowArea: { x: 1280, y: 800, width: 1280, height: 800 },
}
const conversations = ['bot-a', 'bot-late', 'plain', 'popup-bot', 'popup-plain', 'bot-presented', 'popup-presented']

it('keeps the environment settings window and its native frame inside tile zero', () => {
  const bounds = environmentScreenBounds({ x: 0, y: 0, width: 3840, height: 2400 })
  expect(bounds).toEqual({ x: 1, y: 20, width: 1278, height: 775 })
  expect({
    x: bounds.x - 1,
    y: bounds.y - 20,
    width: bounds.width + 2,
    height: bounds.height + 25,
  }).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
})

/** The fake native window behind a floating tab, with the options it was created with. */
function nativeWindow(convId: string, tab: FloatTab): InstanceType<typeof h.FakeWindow> {
  const win = getFloatWin(convId, tab)
  if (!win) throw new Error(`No floating ${tab} window for ${convId}`)
  return win as unknown as InstanceType<typeof h.FakeWindow>
}

/**
 * The whole window openbox draws on the environment display for a framed client: it reports frame extents of 1, 1, 20
 * and 5 px (left, right, top, bottom) with the Clearlooks theme, and keeps the client where it was asked to be.
 */
const withOpenboxFrame = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x - 1,
  y: b.y - 20,
  width: b.width + 2,
  height: b.height + 25,
})

afterEach(() => {
  for (const id of conversations) {
    setConversationScreen(id, null)
    setPresentedBrowserSize(id, null)
  }
  disposeAll()
  flushPendingBrowserPersists()
  disposeBrowserTabEviction()
  disposeMemoryReclaimer()
  vi.clearAllMocks()
  vi.mocked(isBotMode).mockReturnValue(true)
  h.views.length = 0
})

describe('conversation screens', () => {
  it('registers a copy of a conversation screen until it is cleared', () => {
    const input = { ...botA, windowArea: { ...botA.windowArea } }
    setConversationScreen('bot-a', input)
    input.display = ':9'
    input.windowArea.x = 0

    expect(conversationScreen('bot-a')).toEqual(botA)
    expect(conversationScreen('plain')).toBeNull()
    expect(conversationScreen(undefined)).toBeNull()

    setConversationScreen('bot-a', null)
    expect(conversationScreen('bot-a')).toBeNull()
  })

  it('rejects invalid screens and keeps the registered one', () => {
    setConversationScreen('bot-a', botA)
    for (const screen of [
      { ...botA, display: '' },
      { ...botA, display: 'DISPLAY=:2' },
      { ...botA, display: ':2 -crop 1x1' },
      { ...botA, width: 0 },
      { ...botA, height: 1.5 },
      { ...botA, windowArea: { ...botA.windowArea, width: -1 } },
      { ...botA, windowArea: { ...botA.windowArea, x: Number.NaN } },
    ])
      expect(() => setConversationScreen('bot-a', screen)).toThrow('Invalid screen')
    expect(() => setConversationScreen('', botA)).toThrow()

    expect(conversationScreen('bot-a')).toEqual(botA)
  })

  it('notifies listeners of registrations and removals until they unsubscribe', () => {
    const seen: Array<[string, string | null]> = []
    const stop = onConversationScreenChange((id, screen) => seen.push([id, screen?.display ?? null]))

    setConversationScreen('bot-a', botA)
    setConversationScreen('bot-a', null)
    setConversationScreen('bot-a', null)
    stop()
    setConversationScreen('bot-a', botA)

    expect(seen).toEqual([
      ['bot-a', ':2'],
      ['bot-a', null],
    ])
  })
})

describe('window placement inside an area', () => {
  const area = { x: 1280, y: 800, width: 1280, height: 800 }

  it('moves bounds into the area and shrinks windows that do not fit', () => {
    expect(clampToArea({ x: 1300, y: 900, width: 400, height: 300 }, area)).toEqual({
      x: 1300,
      y: 900,
      width: 400,
      height: 300,
    })
    expect(clampToArea({ x: 0, y: 5000, width: 400, height: 300 }, area)).toEqual({
      x: 1280,
      y: 1300,
      width: 400,
      height: 300,
    })
    expect(clampToArea({ x: 0, y: 0, width: 4000, height: 3000 }, area)).toEqual(area)
  })

  it('centers a window in the area and shrinks it when it is larger', () => {
    expect(centerInArea({ width: 500, height: 600 }, area)).toEqual({ x: 1670, y: 900, width: 500, height: 600 })
    expect(centerInArea({ width: 1600, height: 900 }, area)).toEqual(area)
  })
})

describe('floating windows of a conversation', () => {
  it('fills the registered area with the bot browser and keeps its other windows inside it', () => {
    initFloatingManager({} as never)
    setConversationScreen('bot-a', botA)

    detach('bot-a', 'browser')
    expect(getFloatWin('bot-a', 'browser')?.getBounds()).toEqual(botA.windowArea)

    vi.mocked(getConvUiPrefs).mockReturnValueOnce({
      floating: { terminal: { x: 10, y: 10, width: 2000, height: 500 } },
    })
    detach('bot-a', 'terminal')
    const terminal = getFloatWin('bot-a', 'terminal')
    expect(terminal?.getBounds()).toEqual({ x: 1280, y: 800, width: 1280, height: 500 })

    setFloatBounds('bot-a', 'terminal', { x: 5000, y: 5000, width: 400, height: 300 })
    expect(terminal?.getBounds()).toEqual({ x: 2160, y: 1300, width: 400, height: 300 })
  })

  it('opens the bot browser without a window manager frame, so nothing is drawn outside its area', () => {
    initFloatingManager({} as never)
    setConversationScreen('bot-a', botA)

    detach('bot-a', 'browser')
    detach('bot-a', 'terminal')

    // A framed window would get a title bar and borders around these bounds, outside the area.
    expect(nativeWindow('bot-a', 'browser').options).toMatchObject({ frame: false, ...botA.windowArea })
    expect(nativeWindow('bot-a', 'browser').getBounds()).toEqual(botA.windowArea)
    // Its other windows keep their frame, so they can still be moved and closed.
    expect(nativeWindow('bot-a', 'terminal').options).not.toHaveProperty('frame')
  })

  it('keeps the native frame of floating browsers outside bot mode', () => {
    vi.mocked(isBotMode).mockReturnValue(false)
    initFloatingManager({} as never)

    detach('plain', 'browser')

    expect(nativeWindow('plain', 'browser').options).not.toHaveProperty('frame')
  })

  it('keeps the primary work area for a conversation without a screen', () => {
    initFloatingManager({} as never)

    detach('plain', 'browser')

    expect(getFloatWin('plain', 'browser')?.getBounds()).toEqual(h.primaryWorkArea)
  })

  it('places a bot browser its desktop presents at the top left of its area, at the presented size', () => {
    initFloatingManager({} as never)
    setConversationScreen('bot-presented', botA)
    setPresentedBrowserSize('bot-presented', { width: 1120, height: 672 })
    expect(presentedBrowserSize('bot-presented')).toEqual({ width: 1120, height: 672 })

    detach('bot-presented', 'browser')
    expect(nativeWindow('bot-presented', 'browser').options).toMatchObject({ frame: false })
    expect(getFloatWin('bot-presented', 'browser')?.getBounds()).toEqual({ x: 1280, y: 800, width: 1120, height: 672 })

    // The presented window was resized on the desktop: the browser follows, and its views are laid out again even
    // when its size did not change, since it has no identity strip any more.
    vi.mocked(layoutFloatingTab).mockClear()
    setPresentedBrowserSize('bot-presented', { width: 900, height: 600 })
    expect(getFloatWin('bot-presented', 'browser')?.getBounds()).toEqual({ x: 1280, y: 800, width: 900, height: 600 })
    expect(layoutFloatingTab).toHaveBeenCalledWith('bot-presented', 'browser', expect.anything())

    setPresentedBrowserSize('bot-presented', null)
    expect(getFloatWin('bot-presented', 'browser')?.getBounds()).toEqual(botA.windowArea)
    expect(() => setPresentedBrowserSize('bot-presented', { width: 0, height: 600 })).toThrow()
  })

  it('moves an open bot browser into an area registered after it opened', () => {
    initFloatingManager({} as never)
    detach('bot-late', 'browser')
    expect(getFloatWin('bot-late', 'browser')?.getBounds()).toEqual(h.primaryWorkArea)

    setConversationScreen('bot-late', botA)

    expect(getFloatWin('bot-late', 'browser')?.getBounds()).toEqual(botA.windowArea)
  })
})

describe('browser popups of a conversation', () => {
  const mainWindow = {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { getZoomFactor: vi.fn(() => 1) },
  }
  const popup = (bounds: { x: number; y: number; width: number; height: number }) => new h.FakeWindow({ ...bounds })

  it('centers popups, and popups they open, with their frame inside the conversation area', () => {
    const area = { x: 2560, y: 0, width: 1280, height: 800 }
    initDrawer(mainWindow as never)
    setConversationScreen('popup-bot', { ...botA, windowArea: area })
    createBrowserTab('popup-bot', 'https://site.test')
    const signIn = popup({ x: 0, y: 0, width: 500, height: 600 })

    h.views.at(-1)?.webContents.emit('did-create-window', signIn)

    // Popups keep their title bar and its close button, so the client is centered in the area minus that frame.
    expect(signIn.getBounds()).toEqual({ x: 2950, y: 107, width: 500, height: 600 })
    expect(withOpenboxFrame(signIn.getBounds())).toEqual({ x: 2949, y: 87, width: 502, height: 625 })
    expect(signIn.center).not.toHaveBeenCalled()
    expect(signIn.show).toHaveBeenCalledOnce()

    const consent = popup({ x: 0, y: 0, width: 1600, height: 900 })
    signIn.webContents.emit('did-create-window', consent)

    expect(consent.getBounds()).toEqual({ x: 2561, y: 20, width: 1278, height: 775 })
    expect(withOpenboxFrame(consent.getBounds())).toEqual(area)
    expect(consent.center).not.toHaveBeenCalled()
  })

  it('centers the popups of a presented browser inside it, where its desktop shows them', () => {
    const area = { x: 2560, y: 0, width: 1280, height: 800 }
    initDrawer(mainWindow as never)
    setConversationScreen('popup-presented', { ...botA, windowArea: area })
    setPresentedBrowserSize('popup-presented', { width: 900, height: 600 })
    createBrowserTab('popup-presented', 'https://site.test')
    const signIn = popup({ x: 0, y: 0, width: 500, height: 400 })

    h.views.at(-1)?.webContents.emit('did-create-window', signIn)

    const framed = withOpenboxFrame(signIn.getBounds())
    expect(framed.x).toBeGreaterThanOrEqual(area.x)
    expect(framed.y).toBeGreaterThanOrEqual(area.y)
    expect(framed.x + framed.width).toBeLessThanOrEqual(area.x + 900)
    expect(framed.y + framed.height).toBeLessThanOrEqual(area.y + 600)
    expect(signIn.getBounds()).toEqual({ x: 2760, y: 107, width: 500, height: 400 })
  })

  it('keeps centering popups on the display for a conversation without a screen', () => {
    initDrawer(mainWindow as never)
    createBrowserTab('popup-plain', 'https://site.test')
    const signIn = popup({ x: 0, y: 0, width: 500, height: 600 })

    h.views.at(-1)?.webContents.emit('did-create-window', signIn)

    expect(signIn.center).toHaveBeenCalledOnce()
    expect(signIn.setBounds).not.toHaveBeenCalled()
    expect(signIn.show).toHaveBeenCalledOnce()
  })
})
