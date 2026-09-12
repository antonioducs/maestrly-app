import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  broadcast: vi.fn(),
  ensureViewFor: vi.fn(),
  placeViewInMain: vi.fn(),
  hideViewOffscreen: vi.fn(),
  focusViewInMain: vi.fn(() => true),
  setPlacement: vi.fn(),
  getPlacement: vi.fn(() => 'slot' as const),
  setPopupBrowserRelayout: vi.fn(),
  isTabDialogSuppressionOwner: vi.fn(() => false),
}))

vi.mock('../../src/main/window-ipc', () => ({ broadcast: h.broadcast }))
vi.mock('../../src/main/drawer-manager', () => ({
  ensureViewFor: h.ensureViewFor,
  placeViewInMain: h.placeViewInMain,
  hideViewOffscreen: h.hideViewOffscreen,
  focusViewInMain: h.focusViewInMain,
  setPlacement: h.setPlacement,
  getPlacement: h.getPlacement,
  setPopupBrowserRelayout: h.setPopupBrowserRelayout,
  isTabDialogSuppressionOwner: h.isTabDialogSuppressionOwner,
}))

import * as popupManager from '../../src/main/popup-manager'

function init(): void {
  popupManager.initPopupManager({
    on: vi.fn(),
    getContentSize: () => [1000, 800],
    webContents: { getZoomFactor: () => 1, focus: vi.fn() },
  } as never)
  popupManager.showFor('c1')
}

afterEach(() => {
  popupManager.disposeAll()
  vi.clearAllMocks()
})

describe('popup-manager — transfer to a floating window', () => {
  it('removes only the selected tool from the stack and releases its placement', () => {
    init()
    popupManager.openPopup('c1', 'notes')
    popupManager.openPopup('c1', 'terminal')

    expect(popupManager.releasePopupForFloating('c1', 'notes')).toBe(true)

    expect(popupManager.stateFor('c1').stack.map((slot) => slot.tab)).toEqual(['terminal'])
    expect(h.setPlacement).toHaveBeenCalledWith('c1', 'notes', 'slot')
  })

  it('restores focus to the remaining popup when the floating window closes', () => {
    init()
    popupManager.openPopup('c1', 'notes')
    popupManager.openPopup('c1', 'terminal')
    popupManager.releasePopupForFloating('c1', 'terminal')
    h.focusViewInMain.mockClear()

    popupManager.restoreFocusAfterFloatingClose('c1')

    expect(h.focusViewInMain).toHaveBeenCalledWith('c1', 'notes')
  })

  it('is idempotent when the tool is already absent from the stack', () => {
    init()

    expect(popupManager.releasePopupForFloating('c1', 'notes')).toBe(false)
    expect(h.setPlacement).not.toHaveBeenCalled()
  })
})

describe('popup-manager — stack z-order', () => {
  it('considers ChatGPT visible only at the top of the stack', () => {
    init()
    popupManager.openPopup('c1', 'chatgpt')

    expect(popupManager.isChatGptVisible('c1')).toBe(true)

    popupManager.openPopup('c1', 'notes')
    expect(popupManager.isChatGptVisible('c1')).toBe(false)
  })

  it('keeps only the top browser onscreen when opened above VS Code', () => {
    init()
    popupManager.openPopup('c1', 'vscode')
    h.placeViewInMain.mockClear()
    h.hideViewOffscreen.mockClear()

    popupManager.openPopup('c1', 'browser')

    expect(popupManager.stateFor('c1').stack.map((slot) => slot.tab)).toEqual(['vscode', 'browser'])
    expect(h.hideViewOffscreen).toHaveBeenCalledExactlyOnceWith('c1', 'vscode')
    expect(h.placeViewInMain).toHaveBeenCalledTimes(1)
    expect(h.placeViewInMain).toHaveBeenCalledWith('c1', 'browser', expect.any(Object))
  })

  it('restores the previous view when the top popup closes', () => {
    init()
    popupManager.openPopup('c1', 'vscode')
    popupManager.openPopup('c1', 'browser')
    h.placeViewInMain.mockClear()
    h.hideViewOffscreen.mockClear()

    expect(popupManager.closeTopPopup('c1')).toBe(true)

    expect(popupManager.stateFor('c1').stack.map((slot) => slot.tab)).toEqual(['vscode'])
    expect(h.hideViewOffscreen).not.toHaveBeenCalled()
    expect(h.placeViewInMain).toHaveBeenCalledExactlyOnceWith('c1', 'vscode', expect.any(Object))
  })

  it('hides the old top when bringing an existing popup forward', () => {
    init()
    popupManager.openPopup('c1', 'vscode')
    popupManager.openPopup('c1', 'browser')
    h.placeViewInMain.mockClear()
    h.hideViewOffscreen.mockClear()

    popupManager.openPopup('c1', 'vscode')

    expect(popupManager.stateFor('c1').stack.map((slot) => slot.tab)).toEqual(['browser', 'vscode'])
    expect(h.hideViewOffscreen).toHaveBeenCalledExactlyOnceWith('c1', 'browser')
    expect(h.placeViewInMain).toHaveBeenCalledExactlyOnceWith('c1', 'vscode', expect.any(Object))
  })
})

describe('popup-manager — Dialog hosted in its own panel-view', () => {
  it('keeps the owner popup visible while blocking new shortcuts and popups', () => {
    init()
    popupManager.openPopup('c1', 'plan')
    h.placeViewInMain.mockClear()
    h.hideViewOffscreen.mockClear()
    h.isTabDialogSuppressionOwner.mockReturnValue(true)

    popupManager.setDialogSuppressionOwners(new Set([42]))

    expect(popupManager.isSuppressed()).toBe(true)
    expect(h.hideViewOffscreen).not.toHaveBeenCalled()
    expect(h.placeViewInMain).toHaveBeenCalledWith('c1', 'plan', expect.any(Object))
    expect(popupManager.stateFor('c1').stack.map((slot) => slot.tab)).toEqual(['plan'])

    popupManager.openPopup('c1', 'notes')
    expect(h.ensureViewFor).not.toHaveBeenCalledWith('c1', 'notes')
  })

  it('hides the popup when the Dialog belongs to another renderer', () => {
    init()
    popupManager.openPopup('c1', 'plan')
    h.hideViewOffscreen.mockClear()
    h.isTabDialogSuppressionOwner.mockReturnValue(false)

    popupManager.setDialogSuppressionOwners(new Set([99]))

    expect(h.hideViewOffscreen).toHaveBeenCalledWith('c1', 'plan')
    expect(popupManager.stateFor('c1').stack).toEqual([])
  })

  it('reevaluates the popup when its owner changes without lifting global suppression', () => {
    init()
    popupManager.openPopup('c1', 'plan')
    h.isTabDialogSuppressionOwner.mockReturnValue(false)
    popupManager.setDialogSuppressionOwners(new Set([1]))
    h.placeViewInMain.mockClear()

    h.isTabDialogSuppressionOwner.mockReturnValue(true)
    popupManager.setDialogSuppressionOwners(new Set([2]))

    expect(popupManager.isSuppressed()).toBe(true)
    expect(h.placeViewInMain).toHaveBeenCalledWith('c1', 'plan', expect.any(Object))
  })
})
