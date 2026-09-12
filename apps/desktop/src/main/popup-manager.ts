import type { BrowserWindow } from 'electron'
import { broadcast } from './window-ipc'
import {
  ensureViewFor,
  placeViewInMain,
  hideViewOffscreen,
  focusViewInMain,
  setPlacement,
  getPlacement,
  setPopupBrowserRelayout,
  isTabDialogSuppressionOwner,
  type Bounds,
} from './drawer-manager'
import type { FloatTab } from '../shared/tool-tabs'
import { setDrawerPlacementPerformance } from './drawer/performance'

/**
 * Owns centered tool popups (#328), reusing drawer WebContentsViews within mainWindow to preserve
 * state without reparenting between windows. Each conversation has a stack; the last entry is topmost
 * and closes on Escape/backdrop/X. Reopening a tool raises it instead of duplicating it. Main computes
 * fixed-percent bounds with a slight cascade in DIPs and emits CSS-pixel bounds for PopupOverlay to
 * align DOM chrome.
 */

// Popup DOM title strip contains close, name, and Escape hint. Native content starts below it because
// WebContentsView paints above DOM.
const POPUP_CHROME_H = 40
// Browser popup tabs/toolbar live in PopupOverlay DOM, above page content, at the same height as floating
// chrome.
const POPUP_BROWSER_CHROME_H = 78
// Per-stack-level offset creates a slight cascade so lower popups remain visible.
const CASCADE = 26
// Popup size as a fraction of the window; VS Code gets more room for the IDE.
const SIZE: Record<'default' | 'vscode', { w: number; h: number }> = {
  default: { w: 0.8, h: 0.82 },
  vscode: { w: 0.86, h: 0.88 },
}

/** Popup stack entry in renderer CSS pixels for PopupOverlay chrome. */
export interface PopupSlot {
  tab: FloatTab
  /** Complete popup bounds in CSS pixels: title, optional browser chrome, and content. */
  frame: Bounds
  /** Top space in CSS pixels for DOM title/browser toolbar; the view starts below it. */
  chromeTop: number
  /** Browser-toolbar height in CSS pixels, zero for other tools. */
  browserChromeH: number
}

export interface PopupState {
  convId: string | null
  stack: PopupSlot[]
  suppressed: boolean
}

let win: BrowserWindow | null = null
const stacks = new Map<string, FloatTab[]>()
// Visible conversation from drawer:visible-conversation, shared with floating windows. null means
// Project panels, Settings, onboarding, or no conversation: hide all popups and ignore open shortcuts.
let visibleConvId: string | null = null
// Independent dialog and overlay suppression flags are combined with OR to avoid races. Dialogs report
// through drawer:suppress-views; global App overlays use popup:set-suppressed.
let suppressedByDialog = false
let dialogSuppressionOwnerIds: ReadonlySet<number> = new Set()
let suppressedByOverlay = false
// Injected hook loads a cold VS Code popup through its server.
let vscodeLoader: ((convId: string) => void) | null = null

/**
 * Whether a modal/overlay suppresses native views. Escape belongs to the modal and shortcuts must not
 * open beneath it.
 */
export function isSuppressed(): boolean {
  return suppressedByDialog || suppressedByOverlay
}
const stackOf = (convId: string): FloatTab[] => stacks.get(convId) ?? []

function syncPopupPerformance(convId: string): void {
  const stack = stackOf(convId)
  const top = stack.at(-1)
  for (const tab of stack) {
    setDrawerPlacementPerformance(
      convId,
      tab,
      'popup',
      convId === visibleConvId && popupCanRemainVisible(convId, tab) && tab === top
    )
  }
}

function popupCanRemainVisible(convId: string, tab: FloatTab | undefined): boolean {
  if (!tab || suppressedByOverlay) return false
  return !suppressedByDialog || isTabDialogSuppressionOwner(convId, tab)
}

export function initPopupManager(window: BrowserWindow): void {
  win = window
  // Recenter the visible conversation's popups after window resize.
  window.on('resize', () => layoutPopups(visibleConvId))
  // popup-manager owns browser popup layout; reapply it when the active browser subtab changes.
  setPopupBrowserRelayout((convId) => {
    if (convId === visibleConvId) layoutPopups(convId)
  })
}

/** Inject the VS Code loader from index.ts to resolve conversation cwd, serve-web, and URL. */
export function setPopupVscodeLoader(fn: (convId: string) => void): void {
  vscodeLoader = fn
}

const chromeTopFor = (tab: FloatTab): number =>
  tab === 'browser' ? POPUP_CHROME_H + POPUP_BROWSER_CHROME_H : POPUP_CHROME_H

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max)

/** Popup frame in DIPs at index i of n: centered percentage sizing with a centered cascade. */
function frameAt(tab: FloatTab, i: number, n: number, W: number, H: number): Bounds {
  const size = tab === 'vscode' ? SIZE.vscode : SIZE.default
  const w = Math.round(W * size.w)
  const h = Math.round(H * size.h)
  // Center the whole stack with offsets from -(n-1)/2 to +(n-1)/2 levels.
  const shift = Math.round(i * CASCADE - ((n - 1) * CASCADE) / 2)
  const x = clamp(Math.round((W - w) / 2) + shift, 0, Math.max(0, W - w))
  const y = clamp(Math.round((H - h) / 2) + shift, 0, Math.max(0, H - h))
  return { x, y, width: w, height: h }
}

/**
 * Compute all stack geometry: view bounds in DIPs for placeViewInMain and PopupSlot in CSS pixels for
 * the renderer. Divide by zoom for DIP-to-CSS conversion, including the unusual non-unit zoom case.
 */
function computeSlots(
  stack: FloatTab[],
  W: number,
  H: number,
  zoom: number
): { slot: PopupSlot; viewBounds: Bounds }[] {
  const n = stack.length
  return stack.map((tab, i) => {
    const frame = frameAt(tab, i, n, W, H)
    const chromeTop = chromeTopFor(tab)
    const viewBounds: Bounds = {
      x: frame.x,
      y: frame.y + chromeTop,
      width: frame.width,
      height: Math.max(0, frame.height - chromeTop),
    }
    const slot: PopupSlot = {
      tab,
      frame: { x: frame.x / zoom, y: frame.y / zoom, width: frame.width / zoom, height: frame.height / zoom },
      chromeTop: chromeTop / zoom,
      browserChromeH: (tab === 'browser' ? POPUP_BROWSER_CHROME_H : 0) / zoom,
    }
    return { slot, viewBounds }
  })
}

function emit(convId: string | null, slots: PopupSlot[]): void {
  broadcast('popup:state', { convId, stack: slots, suppressed: isSuppressed() } satisfies PopupState)
}

/**
 * Position the top view when visible and unsuppressed, and emit renderer state. Keep lower views
 * offscreen but alive: native views would cover the upper popup's DOM title/toolbar. If the stack
 * cannot be shown, hide all views and emit an empty stack.
 */
function layoutPopups(convId: string | null): void {
  if (!win || convId === null) {
    if (convId === visibleConvId) emit(visibleConvId, [])
    if (convId) syncPopupPerformance(convId)
    return
  }
  const stack = stackOf(convId)
  const topTab = stack.at(-1)
  if (convId !== visibleConvId || !popupCanRemainVisible(convId, topTab)) {
    for (const tab of stack) hideViewOffscreen(convId, tab)
    if (convId === visibleConvId) emit(convId, []) // renderer esconde a chrome DOM
    syncPopupPerformance(convId)
    return
  }
  const [W, H] = win.getContentSize()
  const zoom = win.webContents.getZoomFactor() || 1
  const computed = computeSlots(stack, W, H, zoom)
  const topIndex = computed.length - 1
  for (let i = 0; i < topIndex; i++) hideViewOffscreen(convId, computed[i].slot.tab)
  const top = computed[topIndex]
  if (top) placeViewInMain(convId, top.slot.tab, top.viewBounds)
  syncPopupPerformance(convId)
  emit(
    convId,
    computed.map((c) => c.slot)
  )
}

/**
 * Current conversation popup stack for mount-time hydration; PopupOverlay may mount after the
 * broadcast.
 */
export function stateFor(convId: string): PopupState {
  if (!win || convId !== visibleConvId || !popupCanRemainVisible(convId, stackOf(convId).at(-1))) {
    return { convId, stack: [], suppressed: isSuppressed() }
  }
  const [W, H] = win.getContentSize()
  const zoom = win.webContents.getZoomFactor() || 1
  return { convId, stack: computeSlots(stackOf(convId), W, H, zoom).map((c) => c.slot), suppressed: isSuppressed() }
}

/** Open or raise a tool popup. Reopening the same tool reorders it without duplication. */
export function openPopup(convId: string, tab: FloatTab): void {
  if (isSuppressed()) return // do not open beneath a modal
  // A floating view belongs to another BrowserWindow/manager. Reparenting here would corrupt that
  // ownership, so ignore the popup shortcut and retain the floating window.
  if (getPlacement(convId, tab) === 'floating') return
  const stack = stacks.get(convId) ?? []
  const idx = stack.indexOf(tab)
  if (idx >= 0) {
    stack.splice(idx, 1)
    stack.push(tab) // raise to top
    stacks.set(convId, stack)
    layoutPopups(convId)
    focusPopupTab(convId, tab) // reopening raises and focuses for immediate interaction
    return
  }
  // ChatGPT Web is materialized only by the explicit companion session start. Other tools retain their
  // historical lazy creation; mocked/legacy callers returning undefined are treated as success.
  if (ensureViewFor(convId, tab) === false) return
  setPlacement(convId, tab, 'popup') // release layout ownership and suppress the conversation slot
  stack.push(tab)
  stacks.set(convId, stack)
  if (tab === 'vscode') vscodeLoader?.(convId) // cold-load the editor (server + URL) — conflict #3
  layoutPopups(convId)
  focusPopupTab(convId, tab) // focus new content so typing works without a click
}

/**
 * Focus an opened/raised popup only in the visible conversation with no modal above it. Focusing a
 * still-loading VS Code view has no effect.
 */
function focusPopupTab(convId: string, tab: FloatTab): void {
  if (!win || convId !== visibleConvId || isSuppressed()) return
  focusViewInMain(convId, tab)
}

/**
 * Close the top popup through shortcut/backdrop. Return whether one existed so the close shortcut can
 * decide whether to preventDefault or let the key reach a modal.
 */
export function closeTopPopup(convId: string): boolean {
  const stack = stacks.get(convId)
  if (stack && stack.length > 0) {
    closePopup(convId, stack[stack.length - 1])
    return true
  }
  return false
}

function releasePopup(convId: string, tab: FloatTab): boolean {
  const stack = stacks.get(convId)
  if (!stack) return false
  const idx = stack.indexOf(tab)
  if (idx < 0) return false
  stack.splice(idx, 1)
  if (stack.length === 0) stacks.delete(convId)
  else stacks.set(convId, stack)
  setPlacement(convId, tab, 'slot')
  layoutPopups(convId) // recenter and cascade remaining popups before reparenting
  return true
}

/**
 * Remove the tool from the stack and release placement before floating-manager reparents the same
 * view.
 */
export function releasePopupForFloating(convId: string, tab: FloatTab): boolean {
  return releasePopup(convId, tab)
}

/** Close a specific popup with its corner button and return the view to the drawer slot. */
export function closePopup(convId: string, tab: FloatTab): void {
  if (!releasePopup(convId, tab)) return
  restoreFocusAfterClose(convId) // move focus out of the closed offscreen view
}

/** Close all conversation popups without destroying their views; return them to the slot. */
export function closeAll(convId: string): void {
  const stack = stacks.get(convId)
  if (!stack) return
  for (const tab of [...stack]) setPlacement(convId, tab, 'slot')
  stacks.delete(convId)
  layoutPopups(convId)
  restoreFocusAfterClose(convId) // empty stack returns focus to Chat so shortcuts remain usable
}

/**
 * After closing a popup, keyboard focus may remain trapped in its offscreen native view. Focus the new
 * stack top or main Chat renderer so shortcuts work without a click. Only act for the visible
 * conversation without a modal; Radix/overlays own focus while suppressed.
 */
function restoreFocusAfterClose(convId: string): void {
  if (!win || convId !== visibleConvId || isSuppressed()) return
  const stack = stackOf(convId)
  if (stack.length > 0 && focusViewInMain(convId, stack[stack.length - 1])) return
  win.webContents.focus() // empty stack or missing view returns focus to Chat
}

/** After closing a floating window, avoid leaving focus in the reattached offscreen view. */
export function restoreFocusAfterFloatingClose(convId: string): void {
  restoreFocusAfterClose(convId)
}

/**
 * On conversation changes, hide the previous popups and restore the newly visible conversation's
 * stack.
 */
export function showFor(convId: string | null): void {
  const prev = visibleConvId
  visibleConvId = convId
  if (prev && prev !== convId) {
    for (const tab of stackOf(prev)) hideViewOffscreen(prev, tab)
    syncPopupPerformance(prev)
  }
  layoutPopups(convId)
  if (convId) syncPopupPerformance(convId)
}

/** Radix Dialog opened/closed through drawer:suppress-views. */
export function setSuppressedByDialog(on: boolean): void {
  setDialogSuppressionOwners(on ? new Set([-1]) : new Set())
}

/** Per-renderer leases preserve only the popup hosting the active Dialog. */
export function setDialogSuppressionOwners(ownerIds: ReadonlySet<number>): void {
  const next = new Set(ownerIds)
  const changed =
    next.size !== dialogSuppressionOwnerIds.size || [...next].some((id) => !dialogSuppressionOwnerIds.has(id))
  if (!changed) return
  dialogSuppressionOwnerIds = next
  suppressedByDialog = next.size > 0
  layoutPopups(visibleConvId)
}
/** Global App DOM overlay suppression through popup:set-suppressed. */
export function setSuppressedByOverlay(on: boolean): void {
  applySuppress(() => {
    suppressedByOverlay = on
  })
}
function applySuppress(mutate: () => void): void {
  const before = isSuppressed()
  mutate()
  if (before !== isSuppressed()) layoutPopups(visibleConvId) // hide on suppression or restore on release
}

/** Raise a tab only if already in a popup; do not open it. Used by terminal_focus through MCP. */
export function bringTabToTopIfPopup(convId: string, tab: FloatTab): void {
  if ((stacks.get(convId)?.indexOf(tab) ?? -1) >= 0) openPopup(convId, tab)
}

// --- consultas p/ o handler de hotkeys (index.ts injeta) ---
export function hasPopup(convId: string): boolean {
  return (stacks.get(convId)?.length ?? 0) > 0
}

/** ChatGPT counts as visible only when it is the top of the displayed stack. */
export function isChatGptVisible(convId: string): boolean {
  if (!win || convId !== visibleConvId || isSuppressed()) return false
  const stack = stacks.get(convId)
  return stack?.[stack.length - 1] === 'chatgpt'
}

export function getVisibleConvId(): string | null {
  return visibleConvId
}

// Lifecycle mirrors floating-manager and runs before drawer-manager.disposeConversation.
/** Clear an archived/deleted conversation's stack; drawer-manager destroys its views. */
export function disposeConversation(convId: string): void {
  if (!stacks.has(convId)) return
  syncPopupPerformance(convId)
  stacks.delete(convId)
  if (convId === visibleConvId) emit(convId, [])
}

/** Clear all state on quit. */
export function disposeAll(): void {
  for (const convId of stacks.keys()) syncPopupPerformance(convId)
  stacks.clear()
  visibleConvId = null
  suppressedByDialog = false
  dialogSuppressionOwnerIds = new Set()
  suppressedByOverlay = false
}
