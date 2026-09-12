import type { FloatTab } from '../store'
import { noteChatGptSurfaceVisibility } from '../chat/chatgpt-web/companion-window'
import { setResourcePlacementActive, setResourceVisible } from '../performance/resource-governor'
import {
  activeConvId,
  convHasPopup,
  drawers,
  getPlacement,
  isTabAllowedDuringDialogSuppression,
  placedSlot,
  visibleKind,
  type ConvDrawer,
} from './state'
import { PANEL_TABS } from './state'

type PlacementReason = 'floating' | 'popup'

/**
 * A tab may consist of more than one renderer (the browser has one renderer per page and a
 * floating browser also has a panel chrome). Keep the mapping in one place so every lifecycle
 * applies the same governor decision.
 */
function setPlacementReason(
  convId: string,
  drawer: ConvDrawer,
  tab: FloatTab,
  reason: PlacementReason,
  active: boolean
): void {
  if (tab === 'browser') {
    for (const page of drawer.browserTabs) {
      if (!page.view) continue
      setResourcePlacementActive('browser', convId, page.id, reason, active && page.id === drawer.activeBrowserId)
    }
    // The browser chrome is a panel renderer and is present only while the browser is floating.
    if (drawer.browserChromeView) {
      setResourcePlacementActive('panel', convId, 'browser-chrome', reason, active)
    }
    return
  }
  if (tab === 'chatgpt') {
    if (drawer.chatgptView) {
      setResourcePlacementActive('chatgpt', convId, undefined, reason, active)
      noteChatGptSurfaceVisibility(convId)
    }
    return
  }
  if (tab === 'vscode') {
    if (drawer.vscodeView) setResourcePlacementActive('vscode', convId, undefined, reason, active)
    return
  }
  if (PANEL_TABS.includes(tab as (typeof PANEL_TABS)[number])) {
    if (drawer.panelViews.get(tab as (typeof PANEL_TABS)[number])) {
      setResourcePlacementActive('panel', convId, tab, reason, active)
    }
  }
}

function setSlotVisible(convId: string, drawer: ConvDrawer, tab: FloatTab, visible: boolean): void {
  if (tab === 'browser') {
    for (const page of drawer.browserTabs) {
      if (!page.view) continue
      setResourceVisible('browser', convId, page.id, visible && page.id === drawer.activeBrowserId)
    }
    if (drawer.browserChromeView) setResourceVisible('panel', convId, 'browser-chrome', false)
    return
  }
  if (tab === 'chatgpt') {
    if (drawer.chatgptView) {
      setResourceVisible('chatgpt', convId, undefined, visible)
      noteChatGptSurfaceVisibility(convId)
    }
    return
  }
  if (tab === 'vscode') {
    if (drawer.vscodeView) setResourceVisible('vscode', convId, undefined, visible)
    return
  }
  if (drawer.panelViews.get(tab as (typeof PANEL_TABS)[number])) {
    setResourceVisible('panel', convId, tab, visible)
  }
}

/**
 * Synchronizes the slot reason for every materialized drawer renderer. Placement managers own the
 * floating/popup reasons; when a tab returns to the slot we explicitly clear both, which also makes
 * reattach/close deterministic during a window-destroy race.
 */
export function syncDrawerResourcePerformance(): void {
  const slotLive = !!placedSlot()
  for (const [convId, drawer] of drawers) {
    const popupOpen = convHasPopup(convId)
    const visibleConversation = convId === activeConvId && slotLive && !popupOpen
    const tabs: FloatTab[] = ['browser', 'vscode', 'chatgpt', ...PANEL_TABS]
    for (const tab of tabs) {
      const placement = getPlacement(convId, tab)
      const visible =
        visibleConversation &&
        visibleKind === tab &&
        placement === 'slot' &&
        isTabAllowedDuringDialogSuppression(convId, tab)
      setSlotVisible(convId, drawer, tab, visible)
      if (placement === 'slot') {
        setPlacementReason(convId, drawer, tab, 'floating', false)
        setPlacementReason(convId, drawer, tab, 'popup', false)
      }
    }
    // Browser chrome never belongs to the drawer slot. It is woken by the floating manager only.
    if (drawer.browserChromeView && getPlacement(convId, 'browser') !== 'floating') {
      setResourceVisible('panel', convId, 'browser-chrome', false)
      setResourcePlacementActive('panel', convId, 'browser-chrome', 'floating', false)
    }
  }
}

/** Called by a placement owner after it knows whether its native window is actually shown. */
export function setDrawerPlacementPerformance(
  convId: string,
  tab: FloatTab,
  reason: PlacementReason,
  active: boolean
): void {
  const drawer = drawers.get(convId)
  if (!drawer) return
  setPlacementReason(convId, drawer, tab, reason, active)
}
