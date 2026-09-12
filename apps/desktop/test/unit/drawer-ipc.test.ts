import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createTestRegistrar } from './ipc-registrar-test-utils'

vi.mock('../../src/main/terminal-manager', () => ({
  closeShellTerminal: vi.fn(),
  createShellTerminal: vi.fn(),
  focusShellTerminal: vi.fn(),
  getTerminalState: vi.fn(),
  reorderShellTerminal: vi.fn(),
  setActiveShellTerminal: vi.fn(),
}))

vi.mock('../../src/main/pty-manager', () => ({
  readPtyOutput: vi.fn(),
}))

vi.mock('../../src/main/floating-manager', () => ({
  detach: vi.fn(),
  reattach: vi.fn(),
  setFloatBounds: vi.fn(),
  setPinned: vi.fn(),
  listFloating: vi.fn(),
  isChatGptVisible: vi.fn(() => false),
  visibleFloatingTabsOf: vi.fn(() => []),
  showFor: vi.fn(),
}))

vi.mock('../../src/main/popup-manager', () => ({
  closePopup: vi.fn(),
  closeTopPopup: vi.fn(),
  releasePopupForFloating: vi.fn(),
  setSuppressedByDialog: vi.fn(),
  setDialogSuppressionOwners: vi.fn(),
  setSuppressedByOverlay: vi.fn(),
  isChatGptVisible: vi.fn(() => false),
  showFor: vi.fn(),
  stateFor: vi.fn(),
}))

vi.mock('../../src/main/drawer-manager', () => ({
  browserBack: vi.fn(),
  browserClearCache: vi.fn(),
  browserForward: vi.fn(),
  browserReload: vi.fn(),
  closeBrowserTab: vi.fn(),
  createBrowserTab: vi.fn(),
  disposeConversation: vi.fn(),
  ensureBrowser: vi.fn(),
  ensurePanelTab: vi.fn(),
  getBrowserState: vi.fn(),
  isTabVisibleInSlot: vi.fn(() => false),
  applyLayout: vi.fn(),
  navigateBrowser: vi.fn(),
  reorderBrowserTab: vi.fn(),
  reloadAllVSCode: vi.fn(),
  setLayout: vi.fn(),
  setDialogSuppressionOwners: vi.fn(),
  setViewsSuppressed: vi.fn(),
  showVSCodeLoadingAll: vi.fn(),
  switchBrowserTab: vi.fn(),
  toggleBrowserDevTools: vi.fn(),
}))

vi.mock('../../src/main/vscode/vscode-server', () => ({
  getMergedSettingsJson: vi.fn(),
  getVSCodeUrl: vi.fn(),
  restartVSCodeServer: vi.fn(),
  waitForEditorReady: vi.fn(),
}))

vi.mock('../../src/main/store', () => ({
  getConversation: vi.fn(),
}))

vi.mock('../../src/main/selection-bridge', () => ({
  setVisibleConversation: vi.fn(),
}))

import { getConversation } from '../../src/main/store'
import { createShellTerminal } from '../../src/main/terminal-manager'
import * as floatingManager from '../../src/main/floating-manager'
import * as popupManager from '../../src/main/popup-manager'
import { applyLayout, isTabVisibleInSlot, setDialogSuppressionOwners, setLayout } from '../../src/main/drawer-manager'
import { registerDrawerIpc } from '../../src/main/drawer-ipc'

describe('registerDrawerIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(floatingManager.isChatGptVisible).mockReturnValue(false)
    vi.mocked(popupManager.isChatGptVisible).mockReturnValue(false)
  })

  it('registers drawer, popup, and standalone terminal channels', () => {
    const { reg, handles, mhandles, ons, mons } = createTestRegistrar()

    registerDrawerIpc(reg, {
      loadVSCodeFolder: vi.fn(),
      openPopup: vi.fn(),
    })

    expect([...handles.keys()].sort()).toEqual([
      'drawer:browser-state-get',
      'drawer:chatgpt-visible',
      'drawer:floating-state-get',
      'drawer:read-terminal',
      'drawer:terminal-state-get',
      'panel:plan-draft-get',
    ])
    expect([...mhandles.keys()].sort()).toEqual([
      'drawer:clear-cache',
      'drawer:load-vscode',
      'drawer:restart-vscode',
      'popup:state-get',
    ])
    expect([...ons.keys()]).toEqual([])
    expect([...mons.keys()].sort()).toEqual([
      'drawer:back',
      'drawer:close-terminal',
      'drawer:create-terminal',
      'drawer:detach',
      'drawer:devtools',
      'drawer:dispose-conversation',
      'drawer:ensure-browser',
      'drawer:ensure-panel',
      'drawer:focus-terminal',
      'drawer:forward',
      'drawer:layout',
      'drawer:navigate',
      'drawer:reattach',
      'drawer:reload',
      'drawer:set-active-terminal',
      'drawer:set-float-bounds',
      'drawer:suppress-views',
      'drawer:tab-close',
      'drawer:tab-new',
      'drawer:tab-reorder',
      'drawer:tab-switch',
      'drawer:terminal-reorder',
      'drawer:visible-conversation',
      'float:go-to-conversation',
      'float:set-pinned',
      'panel:memory-eviction-ready',
      'panel:plan-draft-save',
      'popup:close',
      'popup:close-top',
      'popup:open',
      'popup:open-floating',
      'popup:set-suppressed',
    ])
  })

  it('popup:open-floating releases the stack before detaching the same view', () => {
    const { reg, mons } = createTestRegistrar()
    registerDrawerIpc(reg, {
      loadVSCodeFolder: vi.fn(),
      openPopup: vi.fn(),
    })
    const openFloating = mons.get('popup:open-floating')!
    const release = vi.mocked(popupManager.releasePopupForFloating)
    const detach = vi.mocked(floatingManager.detach)
    release.mockReturnValue(true)

    openFloating({} as never, 'c1', 'notes')

    expect(release).toHaveBeenCalledWith('c1', 'notes')
    expect(detach).toHaveBeenCalledWith('c1', 'notes')
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(detach.mock.invocationCallOrder[0])
  })

  it('tracks leases per renderer and cleans up destroyed senders', () => {
    const { reg, mons } = createTestRegistrar()
    registerDrawerIpc(reg, {
      loadVSCodeFolder: vi.fn(),
      openPopup: vi.fn(),
    })
    const suppress = mons.get('drawer:suppress-views')!
    const first = Object.assign(new EventEmitter(), { id: 101 })
    const second = Object.assign(new EventEmitter(), { id: 202 })

    suppress({ sender: first } as never, true)
    suppress({ sender: second } as never, true)
    suppress({ sender: first } as never, false)

    expect(setDialogSuppressionOwners).toHaveBeenNthCalledWith(1, new Set([101]))
    expect(setDialogSuppressionOwners).toHaveBeenNthCalledWith(2, new Set([101, 202]))
    expect(setDialogSuppressionOwners).toHaveBeenNthCalledWith(3, new Set([202]))
    expect(popupManager.setDialogSuppressionOwners).toHaveBeenNthCalledWith(3, new Set([202]))

    second.emit('destroyed')

    expect(setDialogSuppressionOwners).toHaveBeenLastCalledWith(new Set())
    expect(popupManager.setDialogSuppressionOwners).toHaveBeenLastCalledWith(new Set())
  })

  it('popup:open-floating ignores tools that already left the stack', () => {
    const { reg, mons } = createTestRegistrar()
    registerDrawerIpc(reg, {
      loadVSCodeFolder: vi.fn(),
      openPopup: vi.fn(),
    })
    vi.mocked(popupManager.releasePopupForFloating).mockReturnValue(false)

    mons.get('popup:open-floating')!({} as never, 'c1', 'notes')

    expect(floatingManager.detach).not.toHaveBeenCalled()
  })

  it('restores a cold ChatGPT view when showing its slot and reapplies the current layout', async () => {
    const { reg, mons } = createTestRegistrar()
    let finishRestore!: (restored: boolean) => void
    const restoreChatGptView = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishRestore = resolve
        })
    )
    registerDrawerIpc(reg, {
      loadVSCodeFolder: vi.fn(),
      openPopup: vi.fn(),
      restoreChatGptView,
    })
    const payload = {
      convId: 'companion-cold',
      visibleKind: 'chatgpt' as const,
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    }

    mons.get('drawer:layout')!({} as never, payload)

    expect(setLayout).toHaveBeenCalledWith(payload)
    expect(restoreChatGptView).toHaveBeenCalledWith('companion-cold')
    expect(applyLayout).toHaveBeenCalledOnce()

    finishRestore(true)
    await Promise.resolve()

    expect(applyLayout).toHaveBeenCalledTimes(2)
    expect(setLayout).toHaveBeenCalledOnce()
  })

  it('drawer:create-terminal delegates admission to the terminal manager', () => {
    const { reg, mons } = createTestRegistrar()
    registerDrawerIpc(reg, {
      loadVSCodeFolder: vi.fn(),
      openPopup: vi.fn(),
    })
    const createTerminal = mons.get('drawer:create-terminal')!

    vi.mocked(getConversation).mockReturnValue({ id: 'c1', cwd: '/tmp/conv' } as never)
    createTerminal({} as never, 'c1')
    expect(createShellTerminal).toHaveBeenCalledWith('c1', '/tmp/conv')
  })

  it('ignores slots suppressed by other popups but includes ChatGPT atop the central popup', () => {
    const { reg, handles } = createTestRegistrar()
    registerDrawerIpc(reg, {
      loadVSCodeFolder: vi.fn(),
      openPopup: vi.fn(),
    })

    // Another tool popup makes the slot view effectively offscreen.
    vi.mocked(isTabVisibleInSlot).mockReturnValue(false)
    expect(handles.get('drawer:chatgpt-visible')!({} as never, 'background-conv')).toBe(false)

    // Popup-manager owns stacking order; ChatGPT is visible when on top.
    vi.mocked(popupManager.isChatGptVisible).mockReturnValue(true)

    expect(handles.get('drawer:chatgpt-visible')!({} as never, 'background-conv')).toBe(true)
  })

  it('considers ChatGPT visible in a pinned floating window for a background conversation', () => {
    const { reg, handles } = createTestRegistrar()
    registerDrawerIpc(reg, {
      loadVSCodeFolder: vi.fn(),
      openPopup: vi.fn(),
    })
    vi.mocked(floatingManager.isChatGptVisible).mockReturnValue(true)

    expect(handles.get('drawer:chatgpt-visible')!({} as never, 'background-conv')).toBe(true)
  })
})
