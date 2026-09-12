import type { FloatTab } from '../store'
import {
  PANEL_TABS,
  OFFSCREEN,
  activeConvId,
  convHasPopup,
  drawers,
  isTabOutOfSlot,
  isViewAllowedDuringDialogSuppression,
  placedSlot,
  placementByConv,
  round,
  setActiveConvId,
  setDialogSuppressionOwnerIds,
  setSlot,
  setSuppressed,
  setVisibleKind,
  slot,
  dialogSuppressionOwnerIds,
  suppressed,
  visibleKind,
  win,
  type Bounds,
  type Placement,
} from './state'
import { emitBrowserState, noteBrowserSurfaceVisibility } from './browser'
import { noteVSCodeSurfaceVisibility } from './vscode'
import { syncDrawerResourcePerformance } from './performance'
import { scheduleColdPanelEviction } from './panels'

/**
 * Position all conversation views: only the active docked tab of the active conversation occupies the
 * slot; others move offscreen. Chromium manages native DevTools docking/resizing within the browser
 * view.
 */
export function applyLayout(): void {
  // Track browser/VS Code hiding so warm TTL begins then; ChatGPT uses effective governor visibility
  // synchronized below.
  for (const convId of drawers.keys()) {
    noteBrowserSurfaceVisibility(convId)
    noteVSCodeSurfaceVisibility(convId)
  }
  if (win) {
    const placed = placedSlot()
    for (const [convId, d] of drawers) {
      // While a conversation has a popup, hide its drawer slot so native content cannot cover the DOM
      // backdrop. Popup-placement views are managed separately (#328).
      const slotLive = !!placed && !convHasPopup(convId)
      const isActiveConv = convId === activeConvId && slotLive
      const browserOutOfSlot = isTabOutOfSlot(convId, 'browser')
      const showBrowser = isActiveConv && visibleKind === 'browser' && !browserOutOfSlot

      for (const tab of d.browserTabs) {
        if (browserOutOfSlot || !tab.view) continue // cold or out-of-slot tab has no view to position here
        const target =
          showBrowser && tab.id === d.activeBrowserId && isViewAllowedDuringDialogSuppression(tab.view)
            ? placed!
            : OFFSCREEN
        tab.view.setBounds(round(target))
      }
      if (d.vscodeView && !isTabOutOfSlot(convId, 'vscode')) {
        const showVscode =
          isActiveConv && visibleKind === 'vscode' && isViewAllowedDuringDialogSuppression(d.vscodeView)
        d.vscodeView.setBounds(round(showVscode ? placed! : OFFSCREEN))
      }
      if (d.chatgptView && !isTabOutOfSlot(convId, 'chatgpt')) {
        const showChatGpt =
          isActiveConv && visibleKind === 'chatgpt' && isViewAllowedDuringDialogSuppression(d.chatgptView)
        d.chatgptView.setBounds(round(showChatGpt ? placed! : OFFSCREEN))
      }
      // Plan/review/notes/terminal panels share the same drawer slot.
      for (const t of PANEL_TABS) {
        const v = d.panelViews.get(t)
        if (!v || isTabOutOfSlot(convId, t)) continue
        const show = isActiveConv && visibleKind === t && isViewAllowedDuringDialogSuppression(v)
        v.setBounds(round(show ? placed! : OFFSCREEN))
      }
    }
  }
  syncDrawerResourcePerformance()
  scheduleColdPanelEviction()
}

/** Set active conversation and displayed tool, hiding other conversation views. */
export function setLayout(opts: { convId: string | null; visibleKind: FloatTab | null; bounds?: Bounds }): void {
  setActiveConvId(opts.convId)
  setVisibleKind(opts.visibleKind)
  setSlot(opts.bounds ?? slot)
  applyLayout()
  if (activeConvId) emitBrowserState(activeConvId)
}

/** Move native views offscreen while an HTML modal must appear above them. */
export function setViewsSuppressed(s: boolean): void {
  if (suppressed === s && (!s || dialogSuppressionOwnerIds.size === 0)) return
  setSuppressed(s)
  applyLayout()
}

/** Update Dialog leases while preserving the native panel hosting each modal. */
export function setDialogSuppressionOwners(ownerWebContentsIds: ReadonlySet<number>): void {
  const next = new Set(ownerWebContentsIds)
  setDialogSuppressionOwnerIds(next)
  applyLayout()
}

/**
 * Set tab placement, removing explicit state for slot. Callers own reparenting/positioning; then
 * reapply slot layout so remaining views and popup suppression update.
 */
export function setPlacement(convId: string, tab: FloatTab, p: Placement): void {
  const m = placementByConv.get(convId)
  if (p === 'slot') {
    if (m) {
      m.delete(tab)
      if (m.size === 0) placementByConv.delete(convId)
    }
  } else {
    if (m) m.set(tab, p)
    else placementByConv.set(convId, new Map([[tab, p]]))
  }
  applyLayout()
}
