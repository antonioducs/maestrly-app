import type { WebContentsView } from 'electron'
import type { FloatTab } from '../store'
import { isRemoteConversation } from '../drawer-scope'
import {
  OFFSCREEN,
  drawers,
  getDrawer,
  isBrowserPageHiddenByOmnibox,
  round,
  win,
  type Bounds,
  type ConvDrawer,
  type PanelTab,
} from './state'
import { ensureBrowser } from './browser'
import { ensureVSCodeView } from './vscode'
import { ensurePanelView, ensureRemoteBrowserView } from './panels'

// Centered popups reuse the same mainWindow WebContentsView without cross-window reparenting. Set bounds
// and raise z-order while preserving view state; no remount occurs.

/** The one view of a tab other than this computer's browser, whose pages are views of their own. */
function singleView(d: ConvDrawer, tab: FloatTab): WebContentsView | null | undefined {
  if (tab === 'browser') return d.remoteBrowserView
  if (tab === 'vscode') return d.vscodeView
  if (tab === 'chatgpt') return d.chatgptView
  return d.panelViews.get(tab as PanelTab)
}

/**
 * Ensure tab views exist offscreen in mainWindow; popup-manager positions them afterward. Create an
 * empty VS Code view and let its injected loader start serve-web. Browser popup chrome is DOM, so
 * ensure only pages, not floating browserChromeView. A remote host's browser has no page here: it is
 * a panel with its own chrome, streaming the host's page.
 */
export function ensureViewFor(convId: string, tab: FloatTab): boolean {
  const d = getDrawer(convId)
  if (tab === 'browser') {
    if (isRemoteConversation(convId)) ensureRemoteBrowserView(d, convId)
    else ensureBrowser(convId)
  } else if (tab === 'vscode') ensureVSCodeView(d, convId)
  else if (tab === 'chatgpt') {
    // The companion view is created by the explicit session start. A shortcut/IPC cannot silently
    // create a ChatGPT session or a remote renderer when no session exists.
    if (!d.chatgptView) return false
  } else ensurePanelView(d, convId, tab as PanelTab)
  return true
}

/**
 * Position popup content in supplied DIP bounds below DOM chrome and raise it. Browser popups show
 * only the active page; PopupOverlay owns tabs/toolbar.
 */
export function placeViewInMain(convId: string, tab: FloatTab, viewBounds: Bounds): void {
  if (!win) return
  const d = drawers.get(convId)
  if (!d) return
  const b = round(viewBounds)
  // Deterministically raise a view by removing and readding it as the last child.
  const toTop = (v: WebContentsView): void => {
    win!.contentView.removeChildView(v)
    win!.contentView.addChildView(v)
  }
  if (tab === 'browser' && !d.remoteBrowserView) {
    const pageHidden = isBrowserPageHiddenByOmnibox(convId)
    for (const t of d.browserTabs) {
      if (!t.view) continue
      const on = t.id === d.activeBrowserId && !pageHidden
      t.view.setBounds(on ? b : OFFSCREEN)
      if (on) toTop(t.view) // raise the active page
    }
    return
  }
  const v = singleView(d, tab)
  if (!v) return
  v.setBounds(b)
  toTop(v)
}

/**
 * Move tab views offscreen without changing placement, preserving hidden popup stacks during
 * conversation changes or modal suppression.
 */
export function hideViewOffscreen(convId: string, tab: FloatTab): void {
  const d = drawers.get(convId)
  if (!d) return
  if (tab === 'browser') for (const t of d.browserTabs) t.view?.setBounds(OFFSCREEN)
  singleView(d, tab)?.setBounds(OFFSCREEN)
}

/**
 * Focus tab content, or the active browser page, after a popup closes. Otherwise focus remains trapped
 * in the hidden view and shortcuts stop working until a click. Return whether a view was focused.
 */
export function focusViewInMain(convId: string, tab: FloatTab): boolean {
  const d = drawers.get(convId)
  if (!d) return false
  if (tab === 'browser' && !d.remoteBrowserView) {
    const active = d.browserTabs.find((t) => t.id === d.activeBrowserId) ?? d.browserTabs[0]
    if (!active?.view) return false
    active.view.webContents.focus()
    return true
  }
  const v = singleView(d, tab)
  if (!v) return false
  v.webContents.focus()
  return true
}
