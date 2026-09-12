import type { BrowserWindow, WebContentsView } from 'electron'
import type { FloatTab } from '../store'

/**
 * Single owner of conversation-isolated drawer state: views, active conversation, placement, and
 * suppression. Restored browser tabs begin as cold descriptors; materialize the active tab and retain
 * agent-active resources. Idle tabs can become cold after TTL. React measures an empty DOM slot;
 * native views are positioned over it. Hide by moving offscreen, never setVisible(false), to avoid
 * flicker. User actions target activeConvId; MCP actions target their conversation regardless of
 * visibility. Other drawer modules share this state rather than duplicating it.
 */

export type ViewKind = 'browser' | 'vscode'
/** Tabs rendered by panel.html as docked or floating WebContentsViews. */
export type PanelTab = 'terminal' | 'plan' | 'review' | 'notes'
export const PANEL_TABS: PanelTab[] = ['terminal', 'plan', 'review', 'notes']
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export const OFFSCREEN: Bounds = { x: -100000, y: 0, width: 1000, height: 800 }
// Fixed DIP height for floating browser tabs/URL chrome; reparented page content fills the rest.
export const BROWSER_CHROME_H = 78

export interface BrowserTab {
  id: string
  /** Persisted descriptors may stay cold until selected/materialized. */
  view: WebContentsView | null
  url: string
  title: string
  /** Runtime-only LRU timestamp; never persisted in ui_prefs. */
  lastUsedAt?: number
  /** Runtime-only Maestro delegation owner; never persisted in ui_prefs. */
  ownerScopeId?: string
}

export interface ConvDrawer {
  browserTabs: BrowserTab[]
  activeBrowserId: string | null
  /** Per-conversation ChatGPT Companion view, created only when a manual session starts. */
  chatgptView: WebContentsView | null
  vscodeView: WebContentsView | null
  vscodeRequestedUrl: string
  /**
   * Actual editor URL awaited behind the custom loading page (#318). Prevent duplicate waits/navigation
   * and clear when the editor loads.
   */
  vscodePendingUrl: string | null
  tabSeq: number
  /** On-demand React tab WebContentsViews, docked or floating. */
  panelViews: Map<PanelTab, WebContentsView>
  /** Runtime-only start times for cold-safe panels that are inactive; never persisted. */
  panelInactiveSince: Map<PanelTab, number>
  /** Browser panel chrome exists only while the browser is floating. */
  browserChromeView: WebContentsView | null
  /**
   * OAuth windows opened by this conversation's embedded browser. ChatGPT Companion owns its popups
   * separately so resetting one session cannot close another tab's login. Close these windows on
   * conversation disposal; each unregisters on closed. They are native windows outside slot layout.
   */
  oauthWindows: Set<BrowserWindow>
}

export interface BrowserState {
  convId: string
  tabs: Array<{ id: string; title: string; url: string; loading: boolean }>
  activeId: string | null
  canGoBack: boolean
  canGoForward: boolean
  devtoolsOpen: boolean
}

export let win: BrowserWindow | null = null
export const drawers = new Map<string, ConvDrawer>()
export let activeConvId: string | null = null

// React-supplied active conversation/tab layout. Only the selected view that remains docked occupies the
// slot.
export let visibleKind: FloatTab | null = null
export let slot: Bounds | null = null
/**
 * Tab placement is slot, floating BrowserWindow, or centered mainWindow popup. applyLayout controls
 * slot views; floating/popup managers position the others.
 */
export type Placement = 'slot' | 'floating' | 'popup'
// Per-conversation tab placement defaults to slot. Public placement APIs replace private floating-state
// reuse so popup-manager has explicit ownership.
export const placementByConv = new Map<string, Map<FloatTab, Exclude<Placement, 'slot'>>>()
// Current floating window per conversation/tab lets drawer code reposition views without importing
// floating-manager.
export const floatWinByKey = new Map<string, BrowserWindow>()
export const fkey = (convId: string, tab: FloatTab): string => `${convId}:${tab}`
// Move non-owner native views offscreen while HTML modals are visible because WebContentsViews paint above
// every DOM z-index.
export let suppressed = false
/** Native renderers hosting their own Dialog remain visible during the suppression they create. */
export let dialogSuppressionOwnerIds: ReadonlySet<number> = new Set()

// Shared-state setters: ESM let exports are live bindings readable by other drawer modules, but assignments
// must occur in the owning module.
export function setActiveConvId(id: string | null): void {
  activeConvId = id
}
export function setVisibleKind(k: FloatTab | null): void {
  visibleKind = k
}
export function setSlot(b: Bounds | null): void {
  slot = b
}
export function setSuppressed(s: boolean): void {
  suppressed = s
  // Boolean callers without explicit owners request global suppression.
  dialogSuppressionOwnerIds = new Set()
}
export function setDialogSuppressionOwnerIds(ids: Iterable<number>): void {
  dialogSuppressionOwnerIds = new Set(ids)
  suppressed = dialogSuppressionOwnerIds.size > 0
}

export function initDrawer(window: BrowserWindow): void {
  win = window
}

export function getDrawer(convId: string): ConvDrawer {
  let d = drawers.get(convId)
  if (!d) {
    d = {
      browserTabs: [],
      activeBrowserId: null,
      chatgptView: null,
      vscodeView: null,
      vscodeRequestedUrl: '',
      vscodePendingUrl: null,
      tabSeq: 0,
      panelViews: new Map(),
      panelInactiveSince: new Map(),
      browserChromeView: null,
      oauthWindows: new Set(),
    }
    drawers.set(convId, d)
  }
  return d
}

export function round(b: Bounds): Bounds {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  }
}

// React slot bounds use CSS pixels; WebContentsView bounds use DIPs. Multiply by main WebContents
// zoomFactor to align them. At normal unit zoom this has no effect.
export function placedSlot(): Bounds | null {
  if (!slot || !win) return slot
  return placedBounds(slot)
}

/** Convert a renderer-measured CSS rectangle to Electron DIPs. */
export function placedBounds(bounds: Bounds): Bounds {
  if (!win) return bounds
  const zoom = win.webContents.getZoomFactor()
  if (zoom === 1) return bounds
  return {
    x: bounds.x * zoom,
    y: bounds.y * zoom,
    width: bounds.width * zoom,
    height: bounds.height * zoom,
  }
}

/** Conversation visible to the user, used as selection-routing fallback when cwd does not match. */
export function getActiveConvId(): string | null {
  return activeConvId
}

/** A modal can hide other native views but never the view containing that modal. */
export function isViewAllowedDuringDialogSuppression(view: WebContentsView | null | undefined): boolean {
  if (!suppressed) return true
  const id = view?.webContents?.id
  return typeof id === 'number' && dialogSuppressionOwnerIds.has(id)
}

function viewForTab(drawer: ConvDrawer, tab: FloatTab): WebContentsView | null | undefined {
  if (tab === 'browser') return drawer.browserTabs.find((item) => item.id === drawer.activeBrowserId)?.view
  if (tab === 'vscode') return drawer.vscodeView
  if (tab === 'chatgpt') return drawer.chatgptView
  return drawer.panelViews.get(tab as PanelTab)
}

export function isTabAllowedDuringDialogSuppression(convId: string, tab: FloatTab): boolean {
  const drawer = drawers.get(convId)
  return !suppressed || (!!drawer && isViewAllowedDuringDialogSuppression(viewForTab(drawer, tab)))
}

export function isTabDialogSuppressionOwner(convId: string, tab: FloatTab): boolean {
  if (!suppressed) return false
  const drawer = drawers.get(convId)
  return !!drawer && isViewAllowedDuringDialogSuppression(viewForTab(drawer, tab))
}

/** Current tab placement, default slot. */
export function getPlacement(convId: string, tab: FloatTab): Placement {
  return placementByConv.get(convId)?.get(tab) ?? 'slot'
}

/** Whether a tab is currently painting in the native drawer slot. */
export function isTabVisibleInSlot(convId: string, tab: FloatTab): boolean {
  const drawer = drawers.get(convId)
  return (
    !!drawer &&
    activeConvId === convId &&
    visibleKind === tab &&
    !!slot &&
    isTabAllowedDuringDialogSuppression(convId, tab) &&
    !convHasPopup(convId) &&
    getPlacement(convId, tab) === 'slot' &&
    (tab !== 'chatgpt' || drawer.chatgptView !== null)
  )
}

/** Whether the tab is reparented into its own floating BrowserWindow. */
export function isTabFloating(convId: string, tab: FloatTab): boolean {
  return getPlacement(convId, tab) === 'floating'
}

/** Whether the tab is outside the drawer slot (floating or popup), so applyLayout leaves it alone. */
export function isTabOutOfSlot(convId: string, tab: FloatTab): boolean {
  return getPlacement(convId, tab) !== 'slot'
}

/** Floating tabs for the drawer reattach chips; excludes popups. */
export function floatingTabsOf(convId: string): FloatTab[] {
  const m = placementByConv.get(convId)
  if (!m) return []
  return [...m].filter(([, p]) => p === 'floating').map(([t]) => t)
}

/** Whether the conversation has any popup, requiring its drawer slot to be suppressed. */
export function convHasPopup(convId: string): boolean {
  const m = placementByConv.get(convId)
  if (!m) return false
  for (const p of m.values()) if (p === 'popup') return true
  return false
}
