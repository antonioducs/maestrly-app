import { BrowserWindow, screen } from 'electron'
import { convAccentColor } from '../shared/conv-color'
import { resolvePreload } from './resolve-preload'
import { broadcast, registerPanelTarget } from './window-ipc'
import {
  getConversation,
  getConvUiPrefs,
  getWorkspace,
  patchConvUiPrefs,
  type FloatTab,
  type FloatingBounds,
} from './store'
import {
  FLOAT_CHROME_H,
  floatView,
  unfloatView,
  layoutFloatingTab,
  floatingTabsOf,
  focusFloatingContent,
  navigateFocusedBrowser,
  navigateFocusedVSCode,
} from './drawer-manager'
import { attachHotkeyCapture } from './hotkeys'
import { tMain } from './i18n'
import { floatingStripHtml } from './floating-strip-html'
import { restoreFocusAfterFloatingClose } from './popup-manager'
import { attachWindowNavigation } from './mouse-navigation'
import { setDrawerPlacementPerformance } from './drawer/performance'

function tabTitle(tab: FloatTab): string {
  return tMain('main')(`floating.${tab}`)
}

/**
 * `Project · Conversation — Tool` identifies the window outside the app, including Mission Control,
 * app switching, and the taskbar.
 */
function windowTitle(convId: string, tab: FloatTab): string {
  const conv = getConversation(convId)
  const ws = conv ? getWorkspace(conv.workspaceId) : undefined
  const ctx = [ws?.name, conv?.name].filter(Boolean).join(' · ')
  return ctx ? `${ctx} — ${tabTitle(tab)}` : tabTitle(tab)
}

/**
 * Identity/pin strip at the top of the floating window (FLOAT_CHROME_H). Its container loads minimal
 * HTML through a data URL using localized text, names, and a deterministic conversation color.
 * Reparented WebContentsViews paint above it and start below the strip. The HTML title mirrors
 * windowTitle because page navigation replaces the native title. Preload handles pin clicks to respect
 * the production script-src CSP.
 */
function stripHtml(convId: string, tab: FloatTab, pinned: boolean): string {
  const t = tMain('main')
  const conv = getConversation(convId)
  const ws = conv ? getWorkspace(conv.workspaceId) : undefined
  return floatingStripHtml({
    chromeHeight: FLOAT_CHROME_H,
    color: convAccentColor(convId),
    convId,
    conversationName: conv?.name,
    pinTitle: t('floating.pin'),
    pinned,
    projectName: ws?.name,
    tab,
    tabTitle: tabTitle(tab),
    title: windowTitle(convId, tab),
    unpinTitle: t('floating.unpin'),
  })
}

function loadStrip(win: BrowserWindow, convId: string, tab: FloatTab, pinned: boolean): void {
  void win.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(stripHtml(convId, tab, pinned))}`)
}

/**
 * Owns BrowserWindows hosting detached drawer tabs. Each container loads only the identity/pin strip
 * and reparents existing views below FLOAT_CHROME_H, preserving their state. showFor shows the visible
 * conversation and pinned windows from any conversation; others remain alive but hidden. Per-tab
 * bounds persist in ConvUiPrefs.floating and are clamped on load. The native close button reattaches;
 * disposing the conversation closes permanently.
 */

interface FloatEntry {
  win: BrowserWindow
  /**
   * Distinguishes programmatic close (reattach/dispose) from the user's native close button, which
   * reattaches.
   */
  reattaching: boolean
  /**
   * A pinned window stays visible across conversations and project panels/Settings. Runtime-only state resets on
   * reattach/dispose; floating windows are not restored after restart.
   */
  pinned: boolean
}

const DEFAULT_W = 940
const DEFAULT_H = 720
const MIN_W = 380
const MIN_H = 280

let mainWindow: BrowserWindow | null = null
const floats = new Map<string, Map<FloatTab, FloatEntry>>()
// Visible conversation reported through drawer:visible-conversation. null means a project panel or no
// conversation; only pinned floating windows remain visible.
let visibleConvId: string | null = null
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function initFloatingManager(window: BrowserWindow): void {
  mainWindow = window
}

const keyOf = (convId: string, tab: FloatTab): string => `${convId}:${tab}`

/**
 * Focus tool content after the OS activates the floating window. Synchronous focus after show/focus is
 * overwritten by activation focusing the strip. setImmediate lets activation settle first.
 */
function focusContentSoon(win: BrowserWindow, convId: string, tab: FloatTab): void {
  const doIt = (): void => {
    if (!win.isDestroyed()) focusFloatingContent(convId, tab)
  }
  if (win.isFocused()) setImmediate(doIt)
  else win.once('focus', () => setImmediate(doIt))
}
function entry(convId: string, tab: FloatTab): FloatEntry | undefined {
  return floats.get(convId)?.get(tab)
}

function syncFloatingPerformance(convId: string, tab: FloatTab): void {
  const en = entry(convId, tab)
  const active = !!en && !en.win.isDestroyed() && en.win.isVisible()
  setDrawerPlacementPerformance(convId, tab, 'floating', active)
}
function emitFloatingState(convId: string): void {
  broadcast('drawer:floating-state', {
    convId,
    floating: floatingTabsOf(convId),
    // Use BrowserWindow.isVisible() to distinguish a detached tab from a visible surface without inferring
    // remote DOM focus.
    visible: visibleFloatingTabsOf(convId),
  })
}

/** Clamp saved bounds to a display workArea; fall back to the primary display center. */
function clampBounds(saved?: FloatingBounds): FloatingBounds {
  const primary = screen.getPrimaryDisplay().workArea
  const width = Math.min(Math.max(MIN_W, Math.round(saved?.width ?? DEFAULT_W)), primary.width)
  const height = Math.min(Math.max(MIN_H, Math.round(saved?.height ?? DEFAULT_H)), primary.height)
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const rect = { x: Math.round(saved.x), y: Math.round(saved.y), width, height }
    const display = screen.getAllDisplays().find((d) => {
      const a = d.workArea
      return (
        rect.x < a.x + a.width && rect.x + rect.width > a.x && rect.y < a.y + a.height && rect.y + rect.height > a.y
      )
    })
    if (display) {
      const a = display.workArea
      return {
        x: Math.min(Math.max(rect.x, a.x), a.x + Math.max(0, a.width - rect.width)),
        y: Math.min(Math.max(rect.y, a.y), a.y + Math.max(0, a.height - rect.height)),
        width: rect.width,
        height: rect.height,
      }
    }
  }
  return {
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + (primary.height - height) / 2),
    width,
    height,
  }
}

function makeWindow(convId: string, tab: FloatTab): BrowserWindow {
  const win = new BrowserWindow({
    ...clampBounds(getConvUiPrefs(convId).floating?.[tab]),
    minWidth: MIN_W,
    minHeight: MIN_H,
    show: false,
    title: windowTitle(convId, tab),
    backgroundColor: '#0A0A0B',
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.setMenuBarVisibility(false)
  // Register the strip preload as a trusted sender so guardOn accepts float:set-pinned (#264); registration
  // is removed on destroy. The container receives global events, while reparented content retains its panel
  // metadata.
  registerPanelTarget(win.webContents, { global: true, panel: 'floating-strip' })
  attachHotkeyCapture(win.webContents) // capture strip-focused shortcuts; content views capture their own
  attachWindowNavigation(win, (direction) => {
    if (tab === 'vscode') return navigateFocusedVSCode(convId, direction)
    if (tab === 'browser') return navigateFocusedBrowser(convId, direction)
    return false
  })
  // The container identity/pin strip paints behind the reparented views, which begin FLOAT_CHROME_H below
  // the top.
  loadStrip(win, convId, tab, false)
  // Strip loading finishes after detach focus and Chromium focuses the newly loaded container. Restore
  // content focus after every strip load, including title refreshes, but only while the window is focused
  // so background windows cannot steal the keyboard.
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed() && win.isFocused()) focusFloatingContent(convId, tab)
  })

  win.on('resize', () => {
    layoutFloatingTab(convId, tab, win)
    schedulePersist(convId, tab)
  })
  win.on('moved', () => schedulePersist(convId, tab))
  // The native close button reattaches unless reattaching marks a programmatic close. Use setImmediate to
  // reparent and destroy outside the close handler.
  win.on('close', (e) => {
    const en = entry(convId, tab)
    if (en && !en.reattaching) {
      e.preventDefault()
      setImmediate(() => reattach(convId, tab))
    }
  })
  return win
}

/** Detach a tab into its own window, or focus an existing one. drawer-manager reparents the view. */
export function detach(convId: string, tab: FloatTab): void {
  if (!mainWindow) return
  const existing = entry(convId, tab)
  if (existing) {
    if (!existing.win.isDestroyed()) {
      existing.win.show()
      existing.win.focus()
      focusContentSoon(existing.win, convId, tab) // send keyboard focus to tool content
    }
    syncFloatingPerformance(convId, tab)
    return
  }
  const win = makeWindow(convId, tab)
  let byTab = floats.get(convId)
  if (!byTab) floats.set(convId, (byTab = new Map()))
  byTab.set(tab, { win, reattaching: false, pinned: false })
  if (!floatView(convId, tab, win)) {
    // The tool, especially ChatGPT Companion, may close between detach and container creation. Do not
    // register an empty window.
    byTab.delete(tab)
    if (byTab.size === 0) floats.delete(convId)
    if (!win.isDestroyed()) win.destroy()
    return
  }
  // reparent drawer views into this window
  if (convId === visibleConvId) {
    win.show()
    win.focus()
    // Refocus content after showing the window; floatView ran while hidden and OS activation would
    // otherwise focus the strip.
    focusContentSoon(win, convId, tab)
  }
  syncFloatingPerformance(convId, tab)
  emitFloatingState(convId)
}

/** Reattach the tab to the drawer and close its window; idempotent. */
export function reattach(convId: string, tab: FloatTab): void {
  const byTab = floats.get(convId)
  const en = byTab?.get(tab)
  if (!en) return
  if (!en.win.isDestroyed()) {
    persistNow(convId, tab, en.win) // persist final bounds before closing
    unfloatView(convId, tab, en.win) // return the view before destroying its window
    en.reattaching = true // the close handler must not reattach again
    en.win.destroy()
  }
  byTab!.delete(tab)
  if (byTab!.size === 0) floats.delete(convId)
  const k = keyOf(convId, tab)
  const t = persistTimers.get(k)
  if (t) {
    clearTimeout(t)
    persistTimers.delete(k)
  }
  emitFloatingState(convId)
  restoreFocusAfterFloatingClose(convId)
}

/** Programmatically set clamped floating bounds; the resize debounce persists them. */
export function setFloatBounds(convId: string, tab: FloatTab, bounds: FloatingBounds): void {
  const en = entry(convId, tab)
  if (en && !en.win.isDestroyed()) en.win.setBounds(clampBounds(bounds))
}

/**
 * Show the visible conversation's floating windows and pinned windows from any conversation. Hide
 * others without closing them. Pins remain visible on project panels/Settings (convId=null).
 */
export function showFor(convId: string | null): void {
  visibleConvId = convId
  const effective = convId
  for (const [cid, byTab] of floats) {
    for (const [tab, en] of byTab) {
      if (en.win.isDestroyed()) continue
      const show = cid === effective || en.pinned
      if (show) {
        if (!en.win.isVisible()) en.win.showInactive()
        layoutFloatingTab(cid, tab, en.win) // restore layout when showing the view to avoid repaint defects
      } else if (en.win.isVisible()) {
        en.win.hide()
      }
      syncFloatingPerformance(cid, tab)
    }
  }
  // Drawer resets local floating state when conversations change. Reemit the newly visible conversation's
  // set to restore its placeholders and chips.
  if (effective) emitFloatingState(effective)
}

/**
 * Set the strip pin and immediately reapply visibility. Unpinning a window belonging to a background
 * conversation hides it.
 */
export function setPinned(convId: string, tab: FloatTab, pinned: boolean): void {
  const en = entry(convId, tab)
  if (!en || en.win.isDestroyed()) return
  en.pinned = pinned
  showFor(visibleConvId)
}

/**
 * Focus a tab's floating window, showing it if hidden. Return whether it exists; used by VS Code
 * debug/open-file flows.
 */
export function focusFloatIfAny(convId: string, tab: FloatTab): boolean {
  const en = entry(convId, tab)
  if (!en || en.win.isDestroyed()) return false
  if (!en.win.isVisible()) en.win.showInactive()
  syncFloatingPerformance(convId, tab)
  en.win.focus()
  focusContentSoon(en.win, convId, tab) // send keyboard focus to tool content
  return true
}

/**
 * Resolve a floating BrowserWindow to (convId, tab), or null if it is not ours. The close shortcut
 * uses this to reattach the focused window.
 */
export function findByWin(target: BrowserWindow): { convId: string; tab: FloatTab } | null {
  for (const [convId, byTab] of floats) {
    for (const [tab, en] of byTab) {
      if (en.win === target) return { convId, tab }
    }
  }
  return null
}

export function listFloating(convId: string): FloatTab[] {
  return [...(floats.get(convId)?.keys() ?? [])]
}

/** Detached tabs whose native windows are currently visible. */
export function visibleFloatingTabsOf(convId: string): FloatTab[] {
  const byTab = floats.get(convId)
  if (!byTab) return []
  return [...byTab.entries()]
    .filter(([, entry]) => !entry.win.isDestroyed() && entry.win.isVisible())
    .map(([tab]) => tab)
}

/** ChatGPT visible in a native window, including a pinned background conversation. */
export function isChatGptVisible(convId: string): boolean {
  return visibleFloatingTabsOf(convId).includes('chatgpt')
}

export function getFloatWin(convId: string, tab: FloatTab): BrowserWindow | null {
  const en = entry(convId, tab)
  return en && !en.win.isDestroyed() ? en.win : null
}

/** Reload all floating titles and identity strips after locale or conversation-name changes. */
export function refreshFloatingTitles(): void {
  for (const [convId, byTab] of floats) {
    for (const [tab, en] of byTab) {
      if (en.win.isDestroyed()) continue
      en.win.setTitle(windowTitle(convId, tab))
      loadStrip(en.win, convId, tab, en.pinned) // refresh localized strip names and document title
    }
  }
}

/**
 * Close every floating window for an archived/deleted conversation. drawer-manager.disposeConversation
 * closes views; this only destroys containers with reattaching set to prevent reattachment.
 */
export function disposeConversation(convId: string): void {
  const byTab = floats.get(convId)
  if (!byTab) return
  for (const [tab, en] of byTab) {
    const k = keyOf(convId, tab)
    const t = persistTimers.get(k)
    if (t) {
      clearTimeout(t)
      persistTimers.delete(k)
    }
    en.reattaching = true
    if (!en.win.isDestroyed()) en.win.destroy()
  }
  floats.delete(convId)
}

/** Close every floating window on quit, matching disposeDrawer. */
export function disposeAll(): void {
  for (const byTab of floats.values()) {
    for (const en of byTab.values()) {
      en.reattaching = true
      if (!en.win.isDestroyed()) en.win.destroy()
    }
  }
  floats.clear()
  for (const t of persistTimers.values()) clearTimeout(t)
  persistTimers.clear()
  visibleConvId = null
}

// Debounced bounds persistence.

function persistNow(convId: string, tab: FloatTab, win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const b = win.getBounds()
  const cur = getConvUiPrefs(convId).floating ?? {}
  patchConvUiPrefs(convId, { floating: { ...cur, [tab]: { x: b.x, y: b.y, width: b.width, height: b.height } } })
}

function schedulePersist(convId: string, tab: FloatTab): void {
  const k = keyOf(convId, tab)
  const prev = persistTimers.get(k)
  if (prev) clearTimeout(prev)
  persistTimers.set(
    k,
    setTimeout(() => {
      persistTimers.delete(k)
      const en = entry(convId, tab)
      if (en) persistNow(convId, tab, en.win)
    }, 600)
  )
}

/** Synchronously persist pending bounds before app exit, matching flushPendingBrowserPersists. */
export function flushPendingFloatPersists(): void {
  for (const timer of persistTimers.values()) clearTimeout(timer)
  persistTimers.clear()
  for (const [convId, byTab] of floats) {
    for (const [tab, en] of byTab) persistNow(convId, tab, en.win)
  }
}
