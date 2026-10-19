import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeWebContents {
    destroyed = false
    listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    loadURL = vi.fn(async () => undefined)
    loadFile = vi.fn(async () => undefined)
    send = vi.fn()
    focus = vi.fn()
    setBackgroundThrottling = vi.fn()
    close = vi.fn(() => {
      this.destroyed = true
      this.emit('destroyed')
    })

    isDestroyed(): boolean {
      return this.destroyed
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      return this.on(event, listener)
    }
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents()
    setBackgroundColor = vi.fn()
    setBounds = vi.fn()
  }

  const views: FakeWebContentsView[] = []
  class TrackedWebContentsView extends FakeWebContentsView {
    constructor() {
      super()
      views.push(this)
    }
  }
  const throttleTargets = new Map<string, { onFullSpeedChange?: (fullSpeed: boolean) => void }>()
  return { views, WebContentsView: TrackedWebContentsView, throttleTargets, fullSpeed: false }
})

vi.mock('electron', () => ({ WebContentsView: h.WebContentsView }))
vi.mock('../../src/main/window-ipc', () => ({
  registerPanelTarget: vi.fn(),
  sendToPanel: vi.fn(),
  unregisterPanelTarget: vi.fn(),
  preparePanelMemoryEviction: vi.fn(async () => ({ ok: true })),
  safeWindowSend: vi.fn(),
}))
vi.mock('../../src/main/hotkeys', () => ({ attachHotkeyCapture: vi.fn() }))
vi.mock('../../src/main/terminal-hotkeys', () => ({ attachTerminalHotkeyCapture: vi.fn() }))
vi.mock('../../src/main/browser-hotkeys', () => ({
  attachBrowserHotkeyCapture: vi.fn(),
  attachMainWindowBrowserHotkeys: vi.fn(),
}))
vi.mock('../../src/main/drawer/browser', () => ({
  disposeBrowserTabEviction: vi.fn(),
  emitBrowserState: vi.fn(),
  ensureBrowser: vi.fn(),
  noteBrowserSurfaceVisibility: vi.fn(),
  persistTimers: new Map(),
  scheduleColdBrowserEviction: vi.fn(),
}))
vi.mock('../../src/main/drawer/vscode', () => ({
  closeVSCodeView: vi.fn(),
  ensureVSCodeView: vi.fn(),
  noteVSCodeSurfaceVisibility: vi.fn(),
}))
vi.mock('../../src/main/drawer/stream-window', () => ({ disposeStreamWindow: vi.fn() }))
vi.mock('../../src/main/chat/chatgpt-web/companion-window', () => ({
  closeChatGptWebView: vi.fn(),
  disposeChatGptWebViews: vi.fn(),
  noteChatGptSurfaceVisibility: vi.fn(),
}))
vi.mock('../../src/main/performance/resource-governor', () => ({
  disposeConversationResources: vi.fn(),
  disposeResourceGovernor: vi.fn(),
  registerThrottleTarget: vi.fn(
    (kind: string, convId: string, id: string, target: { onFullSpeedChange?: (fullSpeed: boolean) => void }) =>
      h.throttleTargets.set(`${kind}:${convId}:${id}`, target)
  ),
  resourceNeedsFullSpeed: vi.fn(() => h.fullSpeed),
  unregisterThrottleTarget: vi.fn(),
  setResourcePlacementActive: vi.fn(),
  setResourceVisible: vi.fn(),
}))
vi.mock('../../src/main/store', () => ({ getConversation: vi.fn() }))
vi.mock('../../src/main/conversation-screen', () => ({
  presentedBrowserSize: vi.fn(() => null),
  presentsBrowserInArea: vi.fn(() => false),
}))
vi.mock('../../src/main/fleet/instance/window-bounds', () => ({
  floatingStripHeight: vi.fn((_presented: boolean, height: number) => height),
}))

import { ensureViewFor, placeViewInMain } from '../../src/main/drawer/popup'
import { FLOAT_CHROME_H, floatView, unfloatView } from '../../src/main/drawer/float'
import { onPlacementChange, setPlacement } from '../../src/main/drawer/layout'
import { setDrawerPlacementPerformance } from '../../src/main/drawer/performance'
import { disposeConversation } from '../../src/main/drawer/lifecycle'
import {
  drawers,
  getDrawer,
  initDrawer,
  outOfSlotTabsOf,
  placementByConv,
  REMOTE_BROWSER_RESOURCE,
  REMOTE_COMPUTER_RESOURCE,
} from '../../src/main/drawer/state'
import { ensureBrowser } from '../../src/main/drawer/browser'
import { attachBrowserHotkeyCapture, attachMainWindowBrowserHotkeys } from '../../src/main/browser-hotkeys'
import { registerPanelTarget } from '../../src/main/window-ipc'
import { setResourcePlacementActive, unregisterThrottleTarget } from '../../src/main/performance/resource-governor'

const REMOTE = 'server-1/workspaces#conv-1'

const mainWindow = {
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  webContents: { getZoomFactor: () => 1 },
}

function floatingWindow() {
  return {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentSize: () => [900, 700],
    isDestroyed: () => false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.views.length = 0
  h.throttleTargets.clear()
  h.fullSpeed = false
  drawers.clear()
  placementByConv.clear()
  initDrawer(mainWindow as never)
  process.env.ELECTRON_RENDERER_URL = 'http://renderer.test'
})

afterEach(() => {
  onPlacementChange(null)
  drawers.clear()
  placementByConv.clear()
  delete process.env.ELECTRON_RENDERER_URL
})

describe("a remote host's browser out of the drawer", () => {
  it('opens as a panel streaming the host page, never as a browser of this computer', () => {
    expect(ensureViewFor(REMOTE, 'browser')).toBe(true)

    const view = getDrawer(REMOTE).remoteBrowserView as unknown as (typeof h.views)[number]
    expect(h.views).toEqual([view])
    expect(ensureBrowser).not.toHaveBeenCalled()
    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      'http://renderer.test/panel.html?panel=browser&conv=conv-1&host=server-1%2Fworkspaces'
    )
    expect(registerPanelTarget).toHaveBeenCalledWith(view.webContents, {
      convId: REMOTE,
      panel: 'browser',
      resourceId: REMOTE_BROWSER_RESOURCE,
    })
    // Cmd/Ctrl+T and W go back to the page, which acts on the host: none reaches a browser of this computer.
    expect(attachMainWindowBrowserHotkeys).toHaveBeenCalledWith(view.webContents)
    expect(attachBrowserHotkeyCapture).not.toHaveBeenCalled()

    // A second request reuses the panel.
    ensureViewFor(REMOTE, 'browser')
    expect(h.views).toHaveLength(1)

    const bounds = { x: 100, y: 140, width: 800, height: 560 }
    placeViewInMain(REMOTE, 'browser', bounds)
    expect(view.setBounds).toHaveBeenLastCalledWith(bounds)
  })

  it('streams only while the governor keeps it at full speed, and says so again once loaded', () => {
    ensureViewFor(REMOTE, 'browser')
    const view = h.views[0]
    const target = h.throttleTargets.get(`panel:${REMOTE}:${REMOTE_BROWSER_RESOURCE}`)

    target?.onFullSpeedChange?.(true)
    expect(view.webContents.send).toHaveBeenLastCalledWith('drawer:browser-activity', {
      convId: REMOTE,
      fullSpeed: true,
    })

    h.fullSpeed = false
    view.webContents.emit('did-finish-load')
    expect(view.webContents.send).toHaveBeenLastCalledWith('drawer:browser-activity', {
      convId: REMOTE,
      fullSpeed: false,
    })

    setDrawerPlacementPerformance(REMOTE, 'browser', 'popup', true)
    expect(setResourcePlacementActive).toHaveBeenCalledWith('panel', REMOTE, REMOTE_BROWSER_RESOURCE, 'popup', true)
  })

  it('closes once the browser is back in the slot, telling the window each placement', () => {
    const changed = vi.fn()
    onPlacementChange(changed)
    ensureViewFor(REMOTE, 'browser')
    const view = h.views[0]

    setPlacement(REMOTE, 'browser', 'popup')
    expect(outOfSlotTabsOf(REMOTE)).toEqual(['browser'])
    expect(changed).toHaveBeenLastCalledWith(REMOTE)
    expect(view.webContents.close).not.toHaveBeenCalled()

    setPlacement(REMOTE, 'browser', 'slot')
    expect(outOfSlotTabsOf(REMOTE)).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
    expect(view.webContents.close).toHaveBeenCalledOnce()
    expect(getDrawer(REMOTE).remoteBrowserView).toBeNull()
    expect(unregisterThrottleTarget).toHaveBeenCalledWith('panel', REMOTE, REMOTE_BROWSER_RESOURCE)
  })

  it('floats whole below the strip and is not handed back to the main window', () => {
    const win = floatingWindow()

    expect(floatView(REMOTE, 'browser', win as never)).toBe(true)
    const view = h.views[0]
    expect(ensureBrowser).not.toHaveBeenCalled()
    expect(getDrawer(REMOTE).browserChromeView).toBeNull()
    expect(win.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(view)
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: FLOAT_CHROME_H,
      width: 900,
      height: 700 - FLOAT_CHROME_H,
    })
    expect(view.webContents.focus).toHaveBeenCalled()
    mainWindow.contentView.addChildView.mockClear()

    unfloatView(REMOTE, 'browser', win as never)
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(mainWindow.contentView.addChildView).not.toHaveBeenCalled()
    expect(view.webContents.close).toHaveBeenCalledOnce()
    expect(outOfSlotTabsOf(REMOTE)).toEqual([])
  })

  it('closes with its conversation', () => {
    ensureViewFor(REMOTE, 'browser')
    const view = h.views[0]
    disposeConversation(REMOTE)
    expect(view.webContents.close).toHaveBeenCalledOnce()
    expect(drawers.has(REMOTE)).toBe(false)
  })

  it("leaves this computer's browser as it was", () => {
    expect(ensureViewFor('conv-1', 'browser')).toBe(true)
    expect(ensureBrowser).toHaveBeenCalledWith('conv-1')
    expect(h.views).toEqual([])
    expect(getDrawer('conv-1').remoteBrowserView).toBeNull()
  })
})

describe("a remote conversation's computer out of the drawer", () => {
  it('opens as a panel watching its screen, and only for a remote conversation', () => {
    expect(ensureViewFor('conv-1', 'computer')).toBe(false)
    expect(h.views).toEqual([])

    expect(ensureViewFor(REMOTE, 'computer')).toBe(true)
    const view = getDrawer(REMOTE).remoteComputerView as unknown as (typeof h.views)[number]
    expect(h.views).toEqual([view])
    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      'http://renderer.test/panel.html?panel=computer&conv=conv-1&host=server-1%2Fworkspaces'
    )
    expect(registerPanelTarget).toHaveBeenCalledWith(view.webContents, {
      convId: REMOTE,
      panel: 'computer',
      resourceId: REMOTE_COMPUTER_RESOURCE,
    })
    // Its keys go to the screen: no browser tab shortcuts are caught on it.
    expect(attachMainWindowBrowserHotkeys).not.toHaveBeenCalled()
    expect(getDrawer(REMOTE).remoteBrowserView).toBeNull()

    ensureViewFor(REMOTE, 'computer')
    expect(h.views).toHaveLength(1)
    const bounds = { x: 100, y: 140, width: 800, height: 560 }
    placeViewInMain(REMOTE, 'computer', bounds)
    expect(view.setBounds).toHaveBeenLastCalledWith(bounds)
  })

  it('watches only while the governor keeps it at full speed', () => {
    ensureViewFor(REMOTE, 'computer')
    const view = h.views[0]
    h.throttleTargets.get(`panel:${REMOTE}:${REMOTE_COMPUTER_RESOURCE}`)?.onFullSpeedChange?.(true)
    expect(view.webContents.send).toHaveBeenLastCalledWith('drawer:computer-activity', {
      convId: REMOTE,
      fullSpeed: true,
    })
    view.webContents.emit('did-finish-load')
    expect(view.webContents.send).toHaveBeenLastCalledWith('drawer:computer-activity', {
      convId: REMOTE,
      fullSpeed: false,
    })
    setDrawerPlacementPerformance(REMOTE, 'computer', 'floating', true)
    expect(setResourcePlacementActive).toHaveBeenCalledWith('panel', REMOTE, REMOTE_COMPUTER_RESOURCE, 'floating', true)
  })

  it('closes once back in the slot, and floats whole below the strip', () => {
    ensureViewFor(REMOTE, 'computer')
    const popup = h.views[0]
    setPlacement(REMOTE, 'computer', 'popup')
    expect(outOfSlotTabsOf(REMOTE)).toEqual(['computer'])
    setPlacement(REMOTE, 'computer', 'slot')
    expect(popup.webContents.close).toHaveBeenCalledOnce()
    expect(getDrawer(REMOTE).remoteComputerView).toBeNull()
    expect(unregisterThrottleTarget).toHaveBeenCalledWith('panel', REMOTE, REMOTE_COMPUTER_RESOURCE)

    const win = floatingWindow()
    expect(floatView(REMOTE, 'computer', win as never)).toBe(true)
    const floating = h.views[1]
    expect(win.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(floating)
    expect(floating.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: FLOAT_CHROME_H,
      width: 900,
      height: 700 - FLOAT_CHROME_H,
    })
    expect(floating.webContents.focus).toHaveBeenCalled()
    mainWindow.contentView.addChildView.mockClear()

    unfloatView(REMOTE, 'computer', win as never)
    expect(mainWindow.contentView.addChildView).not.toHaveBeenCalled()
    expect(floating.webContents.close).toHaveBeenCalledOnce()
    expect(outOfSlotTabsOf(REMOTE)).toEqual([])
    expect(floatView('conv-1', 'computer', floatingWindow() as never)).toBe(false)
  })

  it('closes with its conversation', () => {
    ensureViewFor(REMOTE, 'computer')
    const view = h.views[0]
    disposeConversation(REMOTE)
    expect(view.webContents.close).toHaveBeenCalledOnce()
  })
})
