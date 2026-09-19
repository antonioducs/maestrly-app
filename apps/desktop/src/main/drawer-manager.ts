import { conversationTabAllowed } from './drawer-scope'
import { setLayout as setDrawerLayout } from './drawer/layout'
import { ensurePanelTab as ensureDrawerPanelTab } from './drawer/panels'
import { ensureViewFor as ensureDrawerViewFor } from './drawer/popup'

/**
 * Stable barrel for conversation-isolated drawer views. Implementation lives in drawer/state, layout,
 * float, popup, panels, browser, vscode, and lifecycle. Reexports preserve existing IPC, MCP, manager,
 * entry-point, and test imports.
 */

export {
  initDrawer,
  getActiveConvId,
  getPlacement,
  isTabVisibleInSlot,
  isTabDialogSuppressionOwner,
  isTabFloating,
  isTabOutOfSlot,
  floatingTabsOf,
  type ViewKind,
  type PanelTab,
  type Bounds,
  type Placement,
  type BrowserState,
} from './drawer/state'
export {
  applyLayout,
  captureSlotView,
  setDialogSuppressionOwners,
  setPlacement,
  setViewsSuppressed,
} from './drawer/layout'
export {
  FLOAT_CHROME_H,
  setFloatFocuser,
  requestVSCodeForDebug,
  floatView,
  unfloatView,
  layoutFloatingTab,
  focusFloatingContent,
} from './drawer/float'
export function ensurePanelTab(...args: Parameters<typeof ensureDrawerPanelTab>): void {
  if (conversationTabAllowed(args[0], args[1])) ensureDrawerPanelTab(...args)
}

export function setLayout(opts: Parameters<typeof setDrawerLayout>[0]): void {
  const visibleKind =
    opts.convId && opts.visibleKind && !conversationTabAllowed(opts.convId, opts.visibleKind) ? null : opts.visibleKind
  setDrawerLayout({ ...opts, visibleKind })
}
export {
  PANEL_COLD_RETRY_MS,
  PANEL_COLD_TTL_MS,
  disposePanelEviction,
  scheduleColdPanelEviction,
} from './drawer/panels'
export function ensureViewFor(...args: Parameters<typeof ensureDrawerViewFor>): boolean {
  return conversationTabAllowed(args[0], args[1]) && ensureDrawerViewFor(...args)
}
export { placeViewInMain, hideViewOffscreen, focusViewInMain } from './drawer/popup'
export {
  hardenBrowserSession,
  setPopupBrowserRelayout,
  scheduleColdBrowserEviction,
  disposeBrowserTabEviction,
  flushPendingBrowserPersists,
  reorderBrowserTab,
  createBrowserTab,
  type CreateBrowserTabOptions,
  ensureBrowser,
  closeBrowserTab,
  switchBrowserTab,
  getBrowserTabOwnerScopeId,
  listBrowserTabIdsOwnedByScope,
  closeBrowserWindowsOwnedByScope,
  navigateBrowser,
  navigateFocusedBrowser,
  browserBack,
  browserForward,
  browserReload,
  browserClearCache,
  acquireBrowserForControl,
  acquireBrowserTabForControl,
  type AcquiredBrowserForControl,
  type AcquiredBrowserTab,
  touchActiveBrowserActivity,
  browserForControl,
  getBrowserState,
  getBrowserStateForScope,
  toggleBrowserDevTools,
} from './drawer/browser'
export {
  showVSCodeLoading,
  showVSCodeLoadingAll,
  showVSCodeError,
  isVSCodeShowing,
  isVSCodePending,
  loadVSCode,
  navigateFocusedVSCode,
  reloadAllVSCode,
} from './drawer/vscode'
export { disposeConversation, disposeDrawer } from './drawer/lifecycle'
