import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/window-ipc', () => ({ safeWindowSend: vi.fn() }))
vi.mock('../../src/main/drawer/browser', () => ({
  emitBrowserState: vi.fn(),
  ensureBrowser: vi.fn(),
  noteBrowserSurfaceVisibility: vi.fn(),
}))
vi.mock('../../src/main/drawer/vscode', () => ({
  ensureVSCodeView: vi.fn(),
  noteVSCodeSurfaceVisibility: vi.fn(),
}))
vi.mock('../../src/main/drawer/performance', () => ({ syncDrawerResourcePerformance: vi.fn() }))
vi.mock('../../src/main/drawer/panels', () => ({
  ensureBrowserChrome: vi.fn(),
  ensurePanelView: vi.fn(),
  scheduleColdPanelEviction: vi.fn(),
}))
vi.mock('../../src/main/conversation-screen', () => ({ presentedBrowserSize: vi.fn(() => null) }))
vi.mock('../../src/main/fleet/instance/config', () => ({ isBotMode: vi.fn(() => false) }))
vi.mock('../../src/main/fleet/instance/window-bounds', () => ({
  floatingStripHeight: vi.fn((_presented: boolean, height: number) => height),
}))

import { applyLayout } from '../../src/main/drawer/layout'
import { FLOAT_CHROME_H, layoutFloatingTab } from '../../src/main/drawer/float'
import { placeViewInMain } from '../../src/main/drawer/popup'
import {
  BROWSER_CHROME_H,
  OFFSCREEN,
  drawers,
  getDrawer,
  initDrawer,
  omniboxOverlays,
  placementByConv,
  setActiveConvId,
  setSlot,
  setVisibleKind,
} from '../../src/main/drawer/state'

function fakeView() {
  return { setBounds: vi.fn(), webContents: { id: 1, isDestroyed: () => false } }
}

const mainWindow = {
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  webContents: { getZoomFactor: () => 1 },
}
const SLOT = { x: 400, y: 80, width: 800, height: 700 }

function browserWithTabs(convId: string) {
  const drawer = getDrawer(convId)
  const active = fakeView()
  const inactive = fakeView()
  drawer.browserTabs.push(
    { id: 'active', view: active as never, url: 'https://a.example/', title: '' },
    { id: 'inactive', view: inactive as never, url: 'https://b.example/', title: '' }
  )
  drawer.activeBrowserId = 'active'
  return { drawer, active, inactive }
}

beforeEach(() => {
  drawers.clear()
  omniboxOverlays.clear()
  placementByConv.clear()
  initDrawer(mainWindow as never)
})

afterEach(() => {
  setActiveConvId(null)
  setVisibleKind(null)
  setSlot(null)
})

describe('page placement while address-bar suggestions are open', () => {
  it('keeps the docked page in the slot until the suggestions open, then moves it offscreen', () => {
    const { active, inactive } = browserWithTabs('docked')
    setActiveConvId('docked')
    setVisibleKind('browser')
    setSlot(SLOT)

    applyLayout()
    expect(active.setBounds).toHaveBeenLastCalledWith(SLOT)

    omniboxOverlays.set('docked', 'prepared')
    applyLayout()
    expect(active.setBounds).toHaveBeenLastCalledWith(SLOT)

    omniboxOverlays.set('docked', 'open')
    applyLayout()
    expect(active.setBounds).toHaveBeenLastCalledWith(OFFSCREEN)
    expect(inactive.setBounds).toHaveBeenLastCalledWith(OFFSCREEN)

    omniboxOverlays.delete('docked')
    applyLayout()
    expect(active.setBounds).toHaveBeenLastCalledWith(SLOT)
  })

  it('extends the floating chrome over the page area and hides the page only once open', () => {
    const { drawer, active } = browserWithTabs('floating')
    const chrome = fakeView()
    drawer.browserChromeView = chrome as never
    const floatWin = { isDestroyed: () => false, getContentSize: () => [1000, 700] }
    const below = 700 - FLOAT_CHROME_H
    const page = { x: 0, y: FLOAT_CHROME_H + BROWSER_CHROME_H, width: 1000, height: below - BROWSER_CHROME_H }

    layoutFloatingTab('floating', 'browser', floatWin as never)
    expect(chrome.setBounds).toHaveBeenLastCalledWith({ x: 0, y: FLOAT_CHROME_H, width: 1000, height: BROWSER_CHROME_H })
    expect(active.setBounds).toHaveBeenLastCalledWith(page)

    omniboxOverlays.set('floating', 'prepared')
    layoutFloatingTab('floating', 'browser', floatWin as never)
    expect(chrome.setBounds).toHaveBeenLastCalledWith({ x: 0, y: FLOAT_CHROME_H, width: 1000, height: below })
    expect(active.setBounds).toHaveBeenLastCalledWith(page)

    omniboxOverlays.set('floating', 'open')
    layoutFloatingTab('floating', 'browser', floatWin as never)
    expect(chrome.setBounds).toHaveBeenLastCalledWith({ x: 0, y: FLOAT_CHROME_H, width: 1000, height: below })
    expect(active.setBounds).toHaveBeenLastCalledWith(OFFSCREEN)
  })

  it('hides the popup page only while the suggestions are open', () => {
    const { active } = browserWithTabs('popup')
    const bounds = { x: 100, y: 158, width: 900, height: 500 }

    placeViewInMain('popup', 'browser', bounds)
    expect(active.setBounds).toHaveBeenLastCalledWith(bounds)

    omniboxOverlays.set('popup', 'open')
    mainWindow.contentView.addChildView.mockClear()
    placeViewInMain('popup', 'browser', bounds)
    expect(active.setBounds).toHaveBeenLastCalledWith(OFFSCREEN)
    expect(mainWindow.contentView.addChildView).not.toHaveBeenCalled()
  })
})
