import type { WebContentsView } from 'electron'
import { unregisterPanelTarget } from '../window-ipc'
import {
  drawers,
  fkey,
  floatWinByKey,
  placementByConv,
  setActiveConvId,
  win,
  type ConvDrawer,
} from './state'
import { applyLayout } from './layout'
import { disposeBrowserTabEviction, persistTimers, scheduleColdBrowserEviction } from './browser'
import { disposePanelEviction, scheduleColdPanelEviction } from './panels'
import { closeChatGptWebView, disposeChatGptWebViews } from '../chat/chatgpt-web/companion-window'
import { closeVSCodeView } from './vscode'
import { disposeConversationResources, disposeResourceGovernor } from '../performance/resource-governor'

// ---------------- ciclo de vida ----------------

function closeView(v: WebContentsView | null | undefined): void {
  if (!v) return
  try {
    unregisterPanelTarget(v.webContents)
    win?.contentView.removeChildView(v) // no-op for a floating view already closed by its manager
    v.webContents.close()
  } catch {
    /* noop */
  }
}

function destroyDrawer(convId: string, d: ConvDrawer): void {
  for (const t of d.browserTabs) closeView(t.view)
  d.browserTabs.length = 0
  d.activeBrowserId = null
  // The companion owns its popup registry and persisted URL cache. Close through that lifecycle
  // before the generic view cleanup so a conversation cannot leave OAuth children behind.
  if (d.chatgptView) closeChatGptWebView(convId)
  closeView(d.chatgptView)
  d.chatgptView = null
  closeVSCodeView(convId)
  closeView(d.vscodeView)
  d.vscodeView = null
  for (const v of d.panelViews.values()) closeView(v)
  d.panelViews.clear()
  d.panelInactiveSince.clear()
  closeView(d.browserChromeView)
  d.browserChromeView = null
  // Close conversation-owned OAuth windows during archive/delete/quit so none become orphaned (#560).
  for (const w of d.oauthWindows) {
    try {
      if (!w.isDestroyed()) w.destroy()
    } catch {
      /* noop */
    }
  }
  d.oauthWindows.clear()
}

/** Dispose of all conversation views, for example on archive. */
export function disposeConversation(convId: string): void {
  const d = drawers.get(convId)
  if (!d) return
  const t = persistTimers.get(convId)
  if (t) {
    clearTimeout(t)
    persistTimers.delete(convId)
  }
  destroyDrawer(convId, d)
  drawers.delete(convId)
  disposeConversationResources(convId)
  for (const tab of placementByConv.get(convId)?.keys() ?? []) floatWinByKey.delete(fkey(convId, tab))
  placementByConv.delete(convId)
  scheduleColdBrowserEviction()
  scheduleColdPanelEviction()
  applyLayout()
}

export function disposeDrawer(): void {
  disposeBrowserTabEviction()
  disposePanelEviction()
  disposeChatGptWebViews()
  for (const [convId, d] of drawers) destroyDrawer(convId, d)
  drawers.clear()
  placementByConv.clear()
  floatWinByKey.clear()
  setActiveConvId(null)
  disposeResourceGovernor()
}
