import { conversationTabAllowed, isRemoteConversation } from './drawer-scope'
import { validateStandaloneConversationDirectory } from './standalone-conversation-service'
import {
  closeShellTerminal,
  createShellTerminal,
  focusShellTerminal,
  getTerminalState,
  reorderShellTerminal,
  setActiveShellTerminal,
} from './terminal-manager'
import { readPtyOutputSnapshot } from './pty-manager'
import * as floatingManager from './floating-manager'
import * as popupManager from './popup-manager'
import {
  browserBack,
  browserClearCache,
  browserForward,
  browserReload,
  closeBrowserTab,
  createBrowserTab,
  disposeConversation,
  ensureBrowser,
  ensurePanelTab,
  getBrowserState,
  isTabVisibleInSlot,
  applyLayout,
  captureSlotView,
  navigateBrowser,
  queryOmnibox,
  removeBrowserHistoryEntry,
  reorderBrowserTab,
  reloadAllVSCode,
  setLayout,
  setDialogSuppressionOwners,
  setOmniboxOverlay,
  showVSCodeLoadingAll,
  switchBrowserTab,
  toggleBrowserDevTools,
  type Bounds,
  type PanelTab,
} from './drawer-manager'
import { setBrowserKeyboardFocus } from './browser-hotkeys'
import type { OmniboxQueryResult } from '../shared/browser-omnibox'
import { getMergedSettingsJson, getVSCodeUrl, restartVSCodeServer, waitForEditorReady } from './vscode/vscode-server'
import { setVisibleConversation } from './selection-bridge'
import { getConversation, patchConvUiPrefs, type FloatingBounds, type FloatTab } from './store'
import { receiveMemoryEvictionReady } from './window-ipc'
import type { IpcRegistrar } from './ipc-registrar'
import { createDialogSuppressionLeases } from './drawer/dialog-suppression'
import { openComputerForViewer } from './remote-host/server/computers-registry'
import {
  acknowledgeBrowserFrame,
  chooseBrowserStreamOption,
  closeBrowserStreamPopup,
  copyBrowserStream,
  inputBrowserStream,
  pasteBrowserStream,
  resizeBrowserStream,
  setBrowserStreamTransport,
  startBrowserStream,
  stopBrowserStream,
} from './drawer/browser-stream'

const EMPTY_OMNIBOX_RESULT: OmniboxQueryResult = { history: [], tabs: [], searchSuggestions: [] }

export interface DrawerIpcDeps {
  loadVSCodeFolder: (convId: string, folder: string) => Promise<void>
  openPopup: (convId: string, tab: FloatTab) => void
  /** Recreates a cold-evicted ChatGPT view only when the conversation still owns an active session. */
  restoreChatGptView?: (convId: string) => Promise<boolean>
  openConversation?: (convId: string) => void
  /** Restarts a remote host's editor and reloads this computer's views of it (drawer/remote-vscode). */
  restartRemoteVSCode?: (convId: string) => Promise<void>
}

/** Canonical source for deciding whether a Companion completion is visible to the user. */
export function isChatGptVisible(convId: string): boolean {
  return (
    isTabVisibleInSlot(convId, 'chatgpt') ||
    popupManager.isChatGptVisible(convId) ||
    floatingManager.isChatGptVisible(convId)
  )
}

export function registerDrawerIpc(reg: IpcRegistrar, deps: DrawerIpcDeps): void {
  const dialogSuppression = createDialogSuppressionLeases((ownerIds) => {
    setDialogSuppressionOwners(ownerIds)
    popupManager.setDialogSuppressionOwners(ownerIds)
  })
  // Drawer WebContentsViews are isolated by conversation (convId).
  reg.mon('drawer:layout', (_e, payload: { convId: string | null; visibleKind: FloatTab | null; bounds?: Bounds }) => {
    if (payload.convId && payload.visibleKind && !conversationTabAllowed(payload.convId, payload.visibleKind)) {
      payload = { ...payload, visibleKind: null }
    }
    setLayout(payload)
    if (!payload.convId || payload.visibleKind !== 'chatgpt' || !deps.restoreChatGptView) return
    // Memory reclaim keeps the MCP session but closes the remote renderer. Once the current slot asks
    // for ChatGPT again, restore it and lay out against CURRENT global state. Reusing `payload` here
    // would race a slow chatgpt.com load with a later tab/conversation switch.
    const restoration = deps.restoreChatGptView(payload.convId)
    // Production restoration materializes the local loading view synchronously. Re-layout now so it is
    // painted and unthrottled while chatgpt.com hydrates; the completion layout still guards later state
    // changes (another selected tab/conversation) and handles asynchronous test/alternate implementations.
    applyLayout()
    void restoration
      .then((restored) => {
        if (restored) applyLayout()
      })
      .catch(() => {
        /* a failed remote load remains retryable on the next visibility signal */
      })
  })
  // Frozen frame of the docked native view, shown by the renderer under DOM overlays (tool palette).
  reg.handle('drawer:capture-slot', (_e, convId: string) => captureSlotView(convId))
  // hide native views while an HTML modal appears above them
  reg.mon('drawer:suppress-views', (event, suppress: boolean) => {
    dialogSuppression.update(event.sender, suppress)
  })
  reg.mon('drawer:ensure-browser', (_e, convId: string) => ensureBrowser(convId))
  reg.mon('drawer:tab-new', (_e, convId: string, url?: string) => createBrowserTab(convId, url))
  reg.mon('drawer:tab-close', (_e, convId: string, id: string) => closeBrowserTab(convId, id))
  reg.mon('drawer:tab-switch', (_e, convId: string, id: string) => switchBrowserTab(convId, id))
  reg.mon('drawer:tab-reorder', (_e, convId: string, from: number, to: number) => reorderBrowserTab(convId, from, to))
  reg.mon('drawer:navigate', (_e, convId: string, url: string, options?: { typed?: unknown }) =>
    navigateBrowser(convId, url, { typed: options?.typed === true })
  )
  // Address bar: history and tab candidates, optionally with Google suggestions (network egress, so guarded).
  reg.mhandle('drawer:omnibox-query', (event, convId: unknown, text: unknown, options: unknown) => {
    if (typeof convId !== 'string' || typeof text !== 'string') return EMPTY_OMNIBOX_RESULT
    const opts = options && typeof options === 'object' ? (options as { search?: unknown; locale?: unknown }) : {}
    return queryOmnibox(
      convId,
      text,
      { search: opts.search === true, ...(typeof opts.locale === 'string' ? { locale: opts.locale } : {}) },
      event.sender.id
    )
  })
  // Suggestions over the native page: frozen frame, then the page moves offscreen until closed.
  reg.mhandle('drawer:omnibox-overlay', (event, convId: unknown, mode: unknown) => {
    if (typeof convId !== 'string' || (mode !== 'prepare' && mode !== 'open' && mode !== 'close')) return null
    return setOmniboxOverlay(convId, mode, event.sender)
  })
  reg.mon('drawer:history-remove', (_e, url: unknown) => {
    if (typeof url === 'string') removeBrowserHistoryEntry(url)
  })
  // The main window catches Cmd/Ctrl+T and W only while its renderer reports the keyboard in a browser.
  reg.mon('drawer:browser-keyboard-focus', (event, focused: unknown) => {
    setBrowserKeyboardFocus(event.sender, focused === true)
  })
  reg.mon('drawer:back', (_e, convId: string) => browserBack(convId))
  reg.mon('drawer:forward', (_e, convId: string) => browserForward(convId))
  reg.mon('drawer:reload', (_e, convId: string) => browserReload(convId))
  // #314: Clear all embedded browser data (cache, storage, and cookies in the shared session), then reload
  // the conversation tabs. The renderer awaits and confirms the invoke result.
  reg.mhandle('drawer:clear-cache', (_e, convId: string) => browserClearCache(convId))
  reg.mon('drawer:devtools', (_e, convId: string) => toggleBrowserDevTools(convId))
  reg.handle('drawer:browser-state-get', (_e, convId: string) => {
    ensureBrowser(convId)
    return getBrowserState(convId)
  })
  // The browser streamed to a remote viewer (drawer/browser-stream): each call checks that it comes from the
  // viewer's renderer through the host bridge, and the stream it names is that viewer's.
  reg.mhandle('drawer:browser-stream-start', (e, convId: unknown, width: unknown, height: unknown, options: unknown) =>
    startBrowserStream(e.sender, convId, width, height, options)
  )
  reg.mon('drawer:browser-stream-transport', (e, convId: unknown, streamId: unknown, transport: unknown) =>
    setBrowserStreamTransport(e.sender, convId, streamId, transport)
  )
  reg.mon('drawer:browser-stream-resize', (e, convId: unknown, streamId: unknown, width: unknown, height: unknown) =>
    resizeBrowserStream(e.sender, convId, streamId, width, height)
  )
  reg.mon('drawer:browser-stream-ack', (e, convId: unknown, streamId: unknown, seq: unknown) =>
    acknowledgeBrowserFrame(e.sender, convId, streamId, seq)
  )
  reg.mon('drawer:browser-stream-stop', (e, convId: unknown, streamId: unknown) =>
    stopBrowserStream(e.sender, convId, streamId)
  )
  reg.mon('drawer:browser-input', (e, convId: unknown, streamId: unknown, input: unknown) =>
    inputBrowserStream(e.sender, convId, streamId, input)
  )
  reg.mhandle('drawer:browser-copy', (e, convId: unknown, streamId: unknown, cut: unknown) =>
    copyBrowserStream(e.sender, convId, streamId, cut)
  )
  reg.mon('drawer:browser-paste', (e, convId: unknown, streamId: unknown, data: unknown) =>
    pasteBrowserStream(e.sender, convId, streamId, data)
  )
  reg.mon('drawer:browser-select-choose', (e, convId: unknown, streamId: unknown, requestId: unknown, index: unknown) =>
    chooseBrowserStreamOption(e.sender, convId, streamId, requestId, index)
  )
  reg.mon('drawer:browser-popup-close', (e, convId: unknown, streamId: unknown) =>
    closeBrowserStreamPopup(e.sender, convId, streamId)
  )
  // The conversation's computer on a workspaces host, which another computer's Computer tab opens.
  reg.mhandle('drawer:computer-open', (e, convId: unknown) => openComputerForViewer(e.sender, convId))
  // loadVSCodeFolder owns serve-web startup, settings, URL, and the loading page (#318), allowing
  // popup-manager to reuse the flow when opening a cold editor and resolving cwd itself.
  reg.mhandle('drawer:load-vscode', async (_e, convId: string, folder: string) => {
    const conv = getConversation(convId)
    if (conv?.scope === 'standalone') {
      const cwd = await validateStandaloneConversationDirectory(conv)
      if (folder !== cwd) throw new Error('Unsafe standalone chat directory.')
    }
    return deps.loadVSCodeFolder(convId, folder)
  })
  // #318: Restart a stalled or crashed serve-web without closing the app, then reload all open Code tabs
  // with its new URL. The global server may choose a different port.
  reg.mhandle('drawer:restart-vscode', async (_e, convId?: unknown) => {
    // A remote host's conversation restarts that host's editor; this computer's editor server keeps running.
    if (typeof convId === 'string' && isRemoteConversation(convId)) {
      if (conversationTabAllowed(convId, 'vscode')) await deps.restartRemoteVSCode?.(convId)
      return
    }
    showVSCodeLoadingAll('restarting') // show immediate feedback in open tabs during server restart
    await restartVSCodeServer()
    const settingsJson = await getMergedSettingsJson()
    await waitForEditorReady().catch(() => {}) // wait for the new server to respond; continue on timeout
    reloadAllVSCode(getVSCodeUrl, settingsJson)
  })
  reg.mon('drawer:dispose-conversation', (_e, convId: string) => disposeConversation(convId))

  // ensure the docked React panel view when opening a panel tab
  reg.mon('drawer:ensure-panel', (_e, convId: string, tab: PanelTab) => {
    if (conversationTabAllowed(convId, tab)) ensurePanelTab(convId, tab)
  })

  // --- detach drawer tabs by reparenting their native views ---
  reg.mon('drawer:detach', (_e, convId: string, tab: FloatTab) => {
    // The tools of a remote host's conversation stay docked in the drawer.
    if (conversationTabAllowed(convId, tab) && !isRemoteConversation(convId)) floatingManager.detach(convId, tab)
  })
  reg.mon('drawer:reattach', (_e, convId: string, tab: FloatTab) => floatingManager.reattach(convId, tab))
  reg.mon('drawer:set-float-bounds', (_e, convId: string, tab: FloatTab, bounds: FloatingBounds) =>
    floatingManager.setFloatBounds(convId, tab, bounds)
  )
  // Pinning the floating window strip keeps it visible across conversation switches.
  reg.mon('float:set-pinned', (_e, convId: string, tab: FloatTab, pinned: boolean) =>
    floatingManager.setPinned(convId, tab, pinned)
  )
  reg.mon('float:go-to-conversation', (_e, convId: string) => deps.openConversation?.(convId))
  reg.handle('drawer:floating-state-get', (_e, convId: string) => ({
    convId,
    floating: floatingManager.listFloating(convId),
    visible: floatingManager.visibleFloatingTabsOf(convId),
  }))
  reg.handle('drawer:chatgpt-visible', (_e, convId: string) => isChatGptVisible(convId))
  // App reports the visible conversation (null for project notes/settings), controlling floating windows and
  // popups. It also routes VS Code selections to the visible sibling when conversations share a cwd (#322).
  reg.mon('drawer:visible-conversation', (_e, convId: string | null) => {
    setVisibleConversation(convId)
    floatingManager.showFor(convId)
    popupManager.showFor(convId) // isolate popups using the shared visible-conversation state
  })

  // Centered tool popups (#328) are opened by user shortcuts; popup-manager owns stacking.
  reg.mon('popup:open', (_e, convId: string, tab: FloatTab) => {
    if (conversationTabAllowed(convId, tab)) deps.openPopup(convId, tab)
  })
  reg.mon('popup:open-floating', (_e, convId: string, tab: FloatTab) => {
    if (!conversationTabAllowed(convId, tab) || isRemoteConversation(convId)) return
    // Release popup placement and stack state before floating-manager reparents the same view.
    if (popupManager.releasePopupForFloating(convId, tab)) floatingManager.detach(convId, tab)
  })
  reg.mon('popup:close', (_e, convId: string, tab: FloatTab) => popupManager.closePopup(convId, tab))
  reg.mon('popup:close-top', (_e, convId: string) => popupManager.closeTopPopup(convId))
  // Global App DOM overlays suppress native views.
  reg.mon('popup:set-suppressed', (_e, on: boolean) => popupManager.setSuppressedByOverlay(on))
  // Hydrate PopupOverlay on mount because the view may mount after the broadcast.
  reg.mhandle('popup:state-get', (_e, convId: string) => popupManager.stateFor(convId))

  // Main owns drawer shell terminals for both UI and MCP. Resolve cwd from the stored conversation; the
  // renderer cannot supply the terminal directory (#264).
  reg.mon('drawer:create-terminal', async (_e, convId: string) => {
    const conv = getConversation(convId)
    if (!conv) return
    const cwd = conv.scope === 'standalone' ? await validateStandaloneConversationDirectory(conv) : conv.cwd
    void createShellTerminal(convId, cwd)
  })
  // Current conversation terminal state hydrates the terminal panel on mount.
  reg.handle('drawer:terminal-state-get', (_e, convId: string) => getTerminalState(convId))
  reg.mon('drawer:close-terminal', (_e, convId: string, id: string) => closeShellTerminal(convId, id))
  reg.mon('drawer:set-active-terminal', (_e, convId: string, id: string | null) => setActiveShellTerminal(convId, id))
  reg.mon('drawer:terminal-reorder', (_e, convId: string, from: number, to: number) =>
    reorderShellTerminal(convId, from, to)
  )
  reg.mon('drawer:focus-terminal', (_e, convId: string, id: string) => focusShellTerminal(convId, id))
  // Replay the ring buffer when TerminalView mounts, including output produced before attachment.
  reg.handle('drawer:read-terminal', (_e, id: string) => readPtyOutputSnapshot(id))
  reg.mon('panel:memory-eviction-ready', (event, payload) => {
    receiveMemoryEvictionReady(event.sender, payload)
  })
  reg.mon('panel:plan-draft-save', (_e, convId: string, draft: unknown) => {
    if (typeof convId !== 'string') return
    if (!draft || typeof draft !== 'object') {
      patchConvUiPrefs(convId, { planDraft: undefined })
      return
    }
    const value = draft as Record<string, unknown>
    if (typeof value.version !== 'number' || typeof value.planHash !== 'string' || typeof value.text !== 'string')
      return
    patchConvUiPrefs(convId, {
      planDraft: {
        version: value.version,
        planHash: value.planHash,
        text: value.text,
        feedback: typeof value.feedback === 'string' ? value.feedback : '',
        lineComments:
          value.lineComments && typeof value.lineComments === 'object'
            ? (value.lineComments as Record<number, string>)
            : {},
        mode: value.mode === 'edit' || value.mode === 'diff' ? value.mode : 'read',
      },
    })
  })
  reg.handle('panel:plan-draft-get', (_e, convId: string) =>
    typeof convId === 'string' ? (getConversation(convId)?.uiPrefs?.planDraft ?? null) : null
  )
}
