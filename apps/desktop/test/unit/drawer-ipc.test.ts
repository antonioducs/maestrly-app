import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createTestRegistrar } from './ipc-registrar-test-utils'

vi.mock('../../src/main/standalone-conversation-service', () => ({
  validateStandaloneConversationDirectory: vi.fn(),
}))

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
  queryOmnibox: vi.fn(async () => ({ history: [], tabs: [], searchSuggestions: [] })),
  removeBrowserHistoryEntry: vi.fn(),
  reorderBrowserTab: vi.fn(),
  reloadAllVSCode: vi.fn(),
  setLayout: vi.fn(),
  setDialogSuppressionOwners: vi.fn(),
  setOmniboxOverlay: vi.fn(async () => null),
  setViewsSuppressed: vi.fn(),
  showVSCodeLoadingAll: vi.fn(),
  switchBrowserTab: vi.fn(),
  toggleBrowserDevTools: vi.fn(),
}))

vi.mock('../../src/main/drawer/browser-stream', () => ({
  acknowledgeBrowserFrame: vi.fn(),
  chooseBrowserStreamOption: vi.fn(),
  closeBrowserStreamPopup: vi.fn(),
  copyBrowserStream: vi.fn(),
  inputBrowserStream: vi.fn(),
  pasteBrowserStream: vi.fn(),
  resizeBrowserStream: vi.fn(),
  startBrowserStream: vi.fn(),
  stopBrowserStream: vi.fn(),
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

import { validateStandaloneConversationDirectory } from '../../src/main/standalone-conversation-service'
import { getConversation } from '../../src/main/store'
import { createShellTerminal } from '../../src/main/terminal-manager'
import * as floatingManager from '../../src/main/floating-manager'
import * as popupManager from '../../src/main/popup-manager'
import {
  applyLayout,
  ensurePanelTab,
  isTabVisibleInSlot,
  navigateBrowser,
  queryOmnibox,
  removeBrowserHistoryEntry,
  setDialogSuppressionOwners,
  setLayout,
  setOmniboxOverlay,
  showVSCodeLoadingAll,
} from '../../src/main/drawer-manager'
import { hasBrowserKeyboardFocus } from '../../src/main/browser-hotkeys'
import { setRemoteEditorHosts } from '../../src/main/drawer-scope'
import { waitForEditorReady } from '../../src/main/vscode/vscode-server'
import { registerDrawerIpc } from '../../src/main/drawer-ipc'
import {
  acknowledgeBrowserFrame,
  copyBrowserStream,
  inputBrowserStream,
  startBrowserStream,
} from '../../src/main/drawer/browser-stream'

describe('registerDrawerIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getConversation).mockReset()
    vi.mocked(floatingManager.isChatGptVisible).mockReturnValue(false)
    vi.mocked(popupManager.isChatGptVisible).mockReturnValue(false)
  })

  it('sanitizes forged standalone review layouts and blocks panel, popup, and float requests', () => {
    vi.mocked(getConversation).mockReturnValue({ scope: 'standalone' } as never)
    const { reg, mons } = createTestRegistrar()
    const openPopup = vi.fn()
    registerDrawerIpc(reg, { loadVSCodeFolder: vi.fn(), openPopup })
    mons.get('drawer:layout')!({} as never, { convId: 'chat', visibleKind: 'review' })
    mons.get('drawer:detach')!({} as never, 'chat', 'review')
    mons.get('popup:open')!({} as never, 'chat', 'review')
    mons.get('drawer:ensure-panel')!({} as never, 'chat', 'review')
    expect(setLayout).toHaveBeenCalledWith({ convId: 'chat', visibleKind: null })
    expect(floatingManager.detach).not.toHaveBeenCalled()
    expect(openPopup).not.toHaveBeenCalled()
    expect(ensurePanelTab).not.toHaveBeenCalled()
  })

  it('validates the stored standalone directory before terminal/editor opens and rejects forged editor folders', async () => {
    const conv = { id: 'chat', scope: 'standalone', cwd: '/managed/chat' }
    vi.mocked(getConversation).mockReturnValue(conv as never)
    const validate = vi.mocked(validateStandaloneConversationDirectory)
    validate.mockResolvedValue('/managed/chat')
    const { reg, mons, mhandles } = createTestRegistrar()
    const loadVSCodeFolder = vi.fn()
    registerDrawerIpc(reg, { loadVSCodeFolder, openPopup: vi.fn() })
    await expect(mhandles.get('drawer:load-vscode')!({} as never, 'chat', '/forged')).rejects.toThrow(
      'Unsafe standalone'
    )
    expect(loadVSCodeFolder).not.toHaveBeenCalled()
    await mhandles.get('drawer:load-vscode')!({} as never, 'chat', '/managed/chat')
    expect(loadVSCodeFolder).toHaveBeenCalledWith('chat', '/managed/chat')
    await mons.get('drawer:create-terminal')!({} as never, 'chat')
    expect(createShellTerminal).toHaveBeenCalledWith('chat', '/managed/chat')
    vi.mocked(createShellTerminal).mockClear()
    validate.mockRejectedValue(new Error('Unsafe standalone chat directory.'))
    await expect(mons.get('drawer:create-terminal')!({} as never, 'chat')).rejects.toThrow('Unsafe standalone')
    expect(createShellTerminal).not.toHaveBeenCalled()
  })

  it('registers drawer, popup, and standalone terminal channels', () => {
    const { reg, handles, mhandles, ons, mons } = createTestRegistrar()

    registerDrawerIpc(reg, {
      loadVSCodeFolder: vi.fn(),
      openPopup: vi.fn(),
    })

    expect([...handles.keys()].sort()).toEqual([
      'drawer:browser-state-get',
      'drawer:capture-slot',
      'drawer:chatgpt-visible',
      'drawer:floating-state-get',
      'drawer:read-terminal',
      'drawer:terminal-state-get',
      'panel:plan-draft-get',
    ])
    expect([...mhandles.keys()].sort()).toEqual([
      'drawer:browser-copy',
      'drawer:browser-stream-start',
      'drawer:clear-cache',
      'drawer:load-vscode',
      'drawer:omnibox-overlay',
      'drawer:omnibox-query',
      'drawer:restart-vscode',
      'popup:state-get',
    ])
    expect([...ons.keys()]).toEqual([])
    expect([...mons.keys()].sort()).toEqual([
      'drawer:back',
      'drawer:browser-input',
      'drawer:browser-keyboard-focus',
      'drawer:browser-paste',
      'drawer:browser-popup-close',
      'drawer:browser-select-choose',
      'drawer:browser-stream-ack',
      'drawer:browser-stream-resize',
      'drawer:browser-stream-stop',
      'drawer:close-terminal',
      'drawer:create-terminal',
      'drawer:detach',
      'drawer:devtools',
      'drawer:dispose-conversation',
      'drawer:ensure-browser',
      'drawer:ensure-panel',
      'drawer:focus-terminal',
      'drawer:forward',
      'drawer:history-remove',
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

  it('hands the browser stream calls their sender, which the stream checks itself', async () => {
    const { reg, mons, mhandles } = createTestRegistrar()
    registerDrawerIpc(reg, { loadVSCodeFolder: vi.fn(), openPopup: vi.fn() })
    const sender = { id: -1000 }
    await mhandles.get('drawer:browser-stream-start')!({ sender } as never, 'conv', 800, 600)
    mons.get('drawer:browser-stream-ack')!({ sender } as never, 'conv', 'stream-id', 3)
    mons.get('drawer:browser-input')!({ sender } as never, 'conv', 'stream-id', { type: 'text', text: 'a' })
    await mhandles.get('drawer:browser-copy')!({ sender } as never, 'conv', 'stream-id', true)
    expect(startBrowserStream).toHaveBeenCalledWith(sender, 'conv', 800, 600)
    expect(acknowledgeBrowserFrame).toHaveBeenCalledWith(sender, 'conv', 'stream-id', 3)
    expect(inputBrowserStream).toHaveBeenCalledWith(sender, 'conv', 'stream-id', { type: 'text', text: 'a' })
    expect(copyBrowserStream).toHaveBeenCalledWith(sender, 'conv', 'stream-id', true)
  })

  it("restarts a remote host's editor for its conversation, and this computer's otherwise", async () => {
    const { reg, mhandles } = createTestRegistrar()
    const restartRemoteVSCode = vi.fn(async () => undefined)
    registerDrawerIpc(reg, { loadVSCodeFolder: vi.fn(), openPopup: vi.fn(), restartRemoteVSCode })
    const restart = mhandles.get('drawer:restart-vscode')!
    // A host that does not serve its editor has no Code tab to restart.
    await restart({} as never, 'server-1/workspaces#conv-1')
    expect(restartRemoteVSCode).not.toHaveBeenCalled()
    setRemoteEditorHosts(() => true)
    try {
      await restart({} as never, 'server-1/workspaces#conv-1')
    } finally {
      setRemoteEditorHosts(() => false)
    }
    expect(restartRemoteVSCode).toHaveBeenCalledWith('server-1/workspaces#conv-1')
    expect(showVSCodeLoadingAll).not.toHaveBeenCalled()
    vi.mocked(waitForEditorReady).mockResolvedValue(undefined)
    await restart({} as never, undefined)
    expect(showVSCodeLoadingAll).toHaveBeenCalledWith('restarting')
    expect(restartRemoteVSCode).toHaveBeenCalledTimes(1)
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

  it('forwards address-bar navigation as typed only when the renderer says so', () => {
    const { reg, mons } = createTestRegistrar()
    registerDrawerIpc(reg, { loadVSCodeFolder: vi.fn(), openPopup: vi.fn() })
    const navigate = mons.get('drawer:navigate')!

    navigate({} as never, 'c1', 'example.com')
    navigate({} as never, 'c1', 'example.com', { typed: true })
    navigate({} as never, 'c1', 'example.com', { typed: 'yes' })

    expect(vi.mocked(navigateBrowser).mock.calls).toEqual([
      ['c1', 'example.com', { typed: false }],
      ['c1', 'example.com', { typed: true }],
      ['c1', 'example.com', { typed: false }],
    ])
  })

  it('validates omnibox queries and keys suggestion cancellation by the asking renderer', async () => {
    const { reg, mhandles } = createTestRegistrar()
    registerDrawerIpc(reg, { loadVSCodeFolder: vi.fn(), openPopup: vi.fn() })
    const query = mhandles.get('drawer:omnibox-query')!

    expect(await query({ sender: { id: 7 } } as never, 42, 'text')).toEqual({
      history: [],
      tabs: [],
      searchSuggestions: [],
    })
    expect(queryOmnibox).not.toHaveBeenCalled()

    await query({ sender: { id: 7 } } as never, 'c1', 'olivia', { search: true, locale: 'pt-BR', extra: 1 })
    await query({ sender: { id: 8 } } as never, 'c1', 'oli', { search: 'yes', locale: 3 })
    expect(vi.mocked(queryOmnibox).mock.calls).toEqual([
      ['c1', 'olivia', { search: true, locale: 'pt-BR' }, 7],
      ['c1', 'oli', { search: false }, 8],
    ])
  })

  it('accepts only known overlay modes and passes the owning renderer', async () => {
    const { reg, mhandles } = createTestRegistrar()
    registerDrawerIpc(reg, { loadVSCodeFolder: vi.fn(), openPopup: vi.fn() })
    const overlay = mhandles.get('drawer:omnibox-overlay')!
    const sender = { id: 3 }

    expect(await overlay({ sender } as never, 'c1', 'hide-everything')).toBeNull()
    expect(await overlay({ sender } as never, null, 'open')).toBeNull()
    expect(setOmniboxOverlay).not.toHaveBeenCalled()

    await overlay({ sender } as never, 'c1', 'prepare')
    await overlay({ sender } as never, 'c1', 'open')
    await overlay({ sender } as never, 'c1', 'close')
    expect(vi.mocked(setOmniboxOverlay).mock.calls).toEqual([
      ['c1', 'prepare', sender],
      ['c1', 'open', sender],
      ['c1', 'close', sender],
    ])
  })

  it('removes history entries only for string URLs', () => {
    const { reg, mons } = createTestRegistrar()
    registerDrawerIpc(reg, { loadVSCodeFolder: vi.fn(), openPopup: vi.fn() })
    const remove = mons.get('drawer:history-remove')!

    remove({} as never, { url: 'https://example.com/' })
    remove({} as never, 'https://example.com/')

    expect(vi.mocked(removeBrowserHistoryEntry).mock.calls).toEqual([['https://example.com/']])
  })

  it('tracks browser keyboard focus per reporting renderer', () => {
    const { reg, mons } = createTestRegistrar()
    registerDrawerIpc(reg, { loadVSCodeFolder: vi.fn(), openPopup: vi.fn() })
    const focus = mons.get('drawer:browser-keyboard-focus')!

    focus({ sender: { id: 51 } } as never, true)
    focus({ sender: { id: 52 } } as never, true)
    expect(hasBrowserKeyboardFocus(51)).toBe(true)
    expect(hasBrowserKeyboardFocus(52)).toBe(true)

    focus({ sender: { id: 51 } } as never, false)
    focus({ sender: { id: 52 } } as never, 'yes')
    expect(hasBrowserKeyboardFocus(51)).toBe(false)
    expect(hasBrowserKeyboardFocus(52)).toBe(false)
  })
})
