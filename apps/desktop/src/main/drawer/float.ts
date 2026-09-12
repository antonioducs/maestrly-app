import type { BrowserWindow, WebContentsView } from 'electron'
import { safeWindowSend } from '../window-ipc'
import type { FloatTab } from '../store'
import {
  BROWSER_CHROME_H,
  OFFSCREEN,
  drawers,
  fkey,
  floatWinByKey,
  getDrawer,
  isTabFloating,
  win,
  type ConvDrawer,
  type PanelTab,
} from './state'
import { applyLayout, setPlacement } from './layout'
import { emitBrowserState, ensureBrowser } from './browser'
import { ensureBrowserChrome, ensurePanelView } from './panels'

// Identity/pin strip height in DIPs for every floating window. Container content paints it; reparented
// views begin below it.
export const FLOAT_CHROME_H = 32

// Injected floating-window focuser avoids cycles and supports VS Code debug/open-file bridges.
let floatFocuser: ((convId: string, tab: FloatTab) => boolean) | null = null
export function setFloatFocuser(fn: (convId: string, tab: FloatTab) => boolean): void {
  floatFocuser = fn
}

/**
 * Ask renderer to open/focus this conversation's Code drawer so VS Code and its extension load before
 * debug commands. If floating, raise its window instead of redocking.
 */
export function requestVSCodeForDebug(convId: string): void {
  if (isTabFloating(convId, 'vscode') && floatFocuser?.(convId, 'vscode')) return
  safeWindowSend(win, 'debug:ensure-vscode', convId)
}

// ---------------- desatachar / re-atachar (re-parent de WebContentsView entre janelas) ----------------

/** WebContentsViews forming a tab, reparented together on detach. */
function tabViews(d: ConvDrawer, tab: FloatTab): WebContentsView[] {
  if (tab === 'vscode') return d.vscodeView ? [d.vscodeView] : []
  if (tab === 'chatgpt') return d.chatgptView ? [d.chatgptView] : []
  if (tab === 'browser') {
    const pages = d.browserTabs.flatMap((t) => (t.view ? [t.view] : []))
    return d.browserChromeView ? [d.browserChromeView, ...pages] : pages
  }
  const v = d.panelViews.get(tab as PanelTab)
  return v ? [v] : []
}

/**
 * Detach by removing views from mainWindow and adding to floatWin, preserving browser
 * DOM/scroll/login/CDP, editor sessions, terminals, and plan/note edits. Position them there;
 * applyLayout no longer owns them.
 */
export function floatView(convId: string, tab: FloatTab, floatWin: BrowserWindow): boolean {
  if (!win) return false
  const d = getDrawer(convId)
  if (tab === 'browser') {
    ensureBrowser(convId)
    ensureBrowserChrome(d, convId)
  } else if (tab === 'chatgpt') {
    // A ChatGPT view is materialized only by an active companion session.
    // A direct detach request must not create a remote view by itself.
    if (!d.chatgptView) return false
  } else if (tab !== 'vscode') ensurePanelView(d, convId, tab as PanelTab)
  const views = tabViews(d, tab)
  if (views.length === 0) return false
  for (const v of views) {
    try {
      win.contentView.removeChildView(v)
    } catch {
      /* The view was not a child of mainWindow. */
    }
    floatWin.contentView.addChildView(v)
  }
  floatWinByKey.set(fkey(convId, tab), floatWin)
  setPlacement(convId, tab, 'floating') // mark placement and skip the reparented view in slot layout
  layoutFloatingTab(convId, tab, floatWin)
  applyLayout()
  // Focus tool content instead of the container strip. Because floatWin is initially hidden,
  // floating-manager must refocus after show so keyboard input and close shortcuts work immediately.
  focusFloatingContent(convId, tab)
  if (tab === 'browser') emitBrowserState(convId)
  return true
}

/** Focus floating tab content: active browser page, VS Code, or panel, not its identity strip. */
export function focusFloatingContent(convId: string, tab: FloatTab): void {
  const d = drawers.get(convId)
  if (!d) return
  const primary =
    tab === 'browser'
      ? d.browserTabs.find((t) => t.id === d.activeBrowserId)?.view
      : tab === 'vscode'
        ? d.vscodeView
        : tab === 'chatgpt'
          ? d.chatgptView
          : d.panelViews.get(tab as PanelTab)
  primary?.webContents.focus()
}

/** Reattach views to mainWindow and discard ephemeral floating browser chrome. */
export function unfloatView(convId: string, tab: FloatTab, floatWin: BrowserWindow): void {
  if (!win) return
  const d = drawers.get(convId)
  if (d) {
    for (const v of tabViews(d, tab)) {
      try {
        floatWin.contentView.removeChildView(v)
      } catch {
        /* Already detached from this parent. */
      }
      if (tab === 'browser' && v === d.browserChromeView) {
        try {
          v.webContents.close() // chrome exists only while floating
        } catch {
          /* noop */
        }
      } else {
        win.contentView.addChildView(v)
        v.setBounds(OFFSCREEN)
      }
    }
    if (tab === 'browser') d.browserChromeView = null
  }
  floatWinByKey.delete(fkey(convId, tab))
  setPlacement(convId, tab, 'slot') // return to slot ownership and reapply layout
  applyLayout()
  if (tab === 'browser') emitBrowserState(convId)
}

/** Lay out floating tab views on resize below FLOAT_CHROME_H at unit zoom. */
export function layoutFloatingTab(convId: string, tab: FloatTab, floatWin: BrowserWindow): void {
  if (floatWin.isDestroyed()) return
  const d = drawers.get(convId)
  if (!d) return
  const [w, h] = floatWin.getContentSize()
  const top = Math.min(FLOAT_CHROME_H, h)
  if (tab === 'browser') {
    const chromeH = d.browserChromeView ? Math.min(BROWSER_CHROME_H, Math.max(0, h - top)) : 0
    if (d.browserChromeView) d.browserChromeView.setBounds({ x: 0, y: top, width: w, height: chromeH })
    for (const t of d.browserTabs) {
      if (!t.view) continue
      const on = t.id === d.activeBrowserId
      t.view.setBounds(on ? { x: 0, y: top + chromeH, width: w, height: Math.max(0, h - top - chromeH) } : OFFSCREEN)
    }
    return
  }
  for (const v of tabViews(d, tab)) v.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) })
}
