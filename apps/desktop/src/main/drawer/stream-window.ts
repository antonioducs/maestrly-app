import { BrowserWindow, type WebContentsView } from 'electron'
import { conversationBrowserArea, conversationScreen, presentedBrowserSize } from '../conversation-screen'
import { clampPresentedSize, type PresentedSize } from '../fleet/instance/window-bounds'
import { refreshUnthrottledBrowserRendering } from './browser-rendering'
import { setPlacement } from './layout'
import { setDrawerPlacementPerformance } from './performance'
import { OFFSCREEN, drawers, getPlacement, streamWinByConv, win } from './state'

/**
 * The window that presents a conversation's browser while another computer watches it (see drawer/browser-stream).
 * A workspaces host's own window is hidden and its views sit offscreen, where Chromium paints nothing a screencast
 * could send; this window is shown, unfocusable and ignoring the mouse, on the host's display, so the active page
 * paints at the size of the viewer's surface. Every browser view of the conversation moves into it ("stream"
 * placement) and moves back when the stream window is released.
 *
 * A conversation that holds a tile of the environment display (its Browser tab streams it as video) has its window at
 * the tile's top left, kept above other windows, where the tile's encoder captures it. While its computer runs, its
 * browser is the computer's window instead, and no stream window is made.
 */

// Windows of several watched conversations are offset from each other on the host's display.
const CASCADE_STEP = 32
const CASCADE_SLOTS = 16
const cascadeSlotByConv = new Map<string, number>()
const closedListeners = new Set<(convId: string) => void>()

/** Observes stream windows that were closed or released; returns the function that stops observing. */
export function onStreamWindowClosed(listener: (convId: string) => void): () => void {
  closedListeners.add(listener)
  return () => {
    closedListeners.delete(listener)
  }
}

function notifyClosed(convId: string): void {
  for (const listener of [...closedListeners]) {
    try {
      listener(convId)
    } catch (error) {
      console.error('A stream window listener failed:', error instanceof Error ? error.message : String(error))
    }
  }
}

function cascadeSlot(convId: string): number {
  const own = cascadeSlotByConv.get(convId)
  if (own !== undefined) return own
  const used = new Set(cascadeSlotByConv.values())
  let slot = 0
  while (used.has(slot) && slot < CASCADE_SLOTS - 1) slot++
  cascadeSlotByConv.set(convId, slot)
  return slot
}

function moveView(view: WebContentsView, from: BrowserWindow | null | undefined, to: BrowserWindow): void {
  try {
    if (from && !from.isDestroyed()) from.contentView.removeChildView(view)
  } catch {
    /* The view was not a child of that window. */
  }
  to.contentView.addChildView(view)
  view.setBounds(OFFSCREEN)
  const wc = view.webContents
  if (wc.isDestroyed()) return
  // A reparented page may keep its last surface until something invalidates it (Linux Electron 44 in particular).
  wc.invalidate()
  refreshUnthrottledBrowserRendering(wc)
}

/** Where the conversation's stream window goes: its tile, kept above other windows, or its place in the cascade. */
function streamWindowPlace(convId: string): { x: number; y: number; above: boolean } {
  const area = conversationBrowserArea(convId)
  if (area) {
    cascadeSlotByConv.delete(convId)
    return { x: area.x, y: area.y, above: true }
  }
  const slot = cascadeSlot(convId)
  return { x: slot * CASCADE_STEP, y: slot * CASCADE_STEP, above: false }
}

function createStreamWindow(convId: string, size: PresentedSize): BrowserWindow {
  const place = streamWindowPlace(convId)
  const host = new BrowserWindow({
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    enableLargerThanScreen: true,
    useContentSize: true,
    x: place.x,
    y: place.y,
    width: size.width,
    height: size.height,
    backgroundColor: '#0A0A0B',
    title: 'Maestrly browser stream',
    // macOS (development hosts only): a shown, fully transparent window still makes WindowServer supply frames.
    ...(process.platform === 'darwin' ? { opacity: 0 } : {}),
    webPreferences: { backgroundThrottling: false },
  })
  host.setIgnoreMouseEvents(true)
  if (place.above) host.setAlwaysOnTop(true)
  host.once('closed', () => {
    if (streamWinByConv.get(convId) !== host) return
    // Closed by something other than release: its views go back to the main window before anything reaches them.
    streamWinByConv.delete(convId)
    cascadeSlotByConv.delete(convId)
    for (const tab of drawers.get(convId)?.browserTabs ?? []) {
      if (tab.view && win && !win.isDestroyed()) moveView(tab.view, null, win)
    }
    if (getPlacement(convId, 'browser') === 'stream') setPlacement(convId, 'browser', 'slot')
    notifyClosed(convId)
  })
  host.showInactive()
  return host
}

/** The conversation's stream window, when its browser is presented in one. */
export function streamWindowOf(convId: string): BrowserWindow | null {
  const host = streamWinByConv.get(convId)
  return host && !host.isDestroyed() ? host : null
}

/** Positions the conversation's tabs in its stream window: the active one fills it, the others wait offscreen. */
export function layoutStreamBrowser(convId: string): void {
  const host = streamWindowOf(convId)
  const drawer = drawers.get(convId)
  if (!host || !drawer) return
  const [width, height] = host.getContentSize()
  for (const tab of drawer.browserTabs) {
    if (!tab.view) continue
    tab.view.setBounds(tab.id === drawer.activeBrowserId ? { x: 0, y: 0, width, height } : OFFSCREEN)
  }
  setDrawerPlacementPerformance(convId, 'browser', 'stream', true)
}

/**
 * Presents the conversation's browser in its stream window at `size` (the viewer's surface, in CSS pixels, within the
 * presented browser limits) and returns the size it took. The first call creates the window and moves every
 * materialized tab into it; later calls resize it.
 */
export function presentBrowserForStream(convId: string, size: PresentedSize): PresentedSize {
  const placement = getPlacement(convId, 'browser')
  // The computer of a workspaces conversation presents its browser: the stream shows that window at its size.
  if (placement === 'floating' && conversationScreen(convId) !== null)
    return presentedBrowserSize(convId) ?? clampPresentedSize(size)
  if (placement !== 'slot' && placement !== 'stream') throw new Error('The browser is presented elsewhere.')
  const clamped = clampPresentedSize(size)
  let host = streamWindowOf(convId)
  if (!host) {
    host = createStreamWindow(convId, clamped)
    streamWinByConv.set(convId, host)
    for (const tab of drawers.get(convId)?.browserTabs ?? []) if (tab.view) moveView(tab.view, win, host)
    setPlacement(convId, 'browser', 'stream')
  } else {
    const [width, height] = host.getContentSize()
    if (width !== clamped.width || height !== clamped.height) host.setContentSize(clamped.width, clamped.height)
    // The conversation may have taken or given back a tile since the window opened.
    const place = streamWindowPlace(convId)
    const [x, y] = host.getPosition()
    if (x !== place.x || y !== place.y) host.setPosition(place.x, place.y)
    if (host.isAlwaysOnTop() !== place.above) host.setAlwaysOnTop(place.above)
  }
  layoutStreamBrowser(convId)
  return clamped
}

/** Moves the conversation's browser back to the main window and closes its stream window. */
export function releaseBrowserStream(convId: string): void {
  const host = streamWinByConv.get(convId)
  if (!host) return
  streamWinByConv.delete(convId)
  cascadeSlotByConv.delete(convId)
  setDrawerPlacementPerformance(convId, 'browser', 'stream', false)
  for (const tab of drawers.get(convId)?.browserTabs ?? []) {
    if (tab.view && win && !win.isDestroyed()) moveView(tab.view, host, win)
  }
  if (getPlacement(convId, 'browser') === 'stream') setPlacement(convId, 'browser', 'slot')
  if (!host.isDestroyed()) host.destroy()
  notifyClosed(convId)
}

/**
 * Moves the conversation's browser back to the main window and closes its stream window, without ending its stream:
 * another window (its computer's) presents the browser from now on.
 */
export function handOverStreamWindow(convId: string): void {
  const host = streamWinByConv.get(convId)
  if (!host) return
  streamWinByConv.delete(convId)
  cascadeSlotByConv.delete(convId)
  setDrawerPlacementPerformance(convId, 'browser', 'stream', false)
  for (const tab of drawers.get(convId)?.browserTabs ?? []) {
    if (tab.view && win && !win.isDestroyed()) moveView(tab.view, host, win)
  }
  if (getPlacement(convId, 'browser') === 'stream') setPlacement(convId, 'browser', 'slot')
  if (!host.isDestroyed()) host.destroy()
}

/** Closes the stream window of a conversation being disposed, whose views are closed by the caller. */
export function disposeStreamWindow(convId: string): void {
  const host = streamWinByConv.get(convId)
  if (!host) return
  streamWinByConv.delete(convId)
  cascadeSlotByConv.delete(convId)
  for (const tab of drawers.get(convId)?.browserTabs ?? []) {
    if (!tab.view) continue
    try {
      if (!host.isDestroyed()) host.contentView.removeChildView(tab.view)
    } catch {
      /* Already detached. */
    }
  }
  if (!host.isDestroyed()) host.destroy()
  notifyClosed(convId)
}
