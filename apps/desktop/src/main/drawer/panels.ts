import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebContentsView } from 'electron'
import { preparePanelMemoryEviction, registerPanelTarget, sendToPanel, unregisterPanelTarget } from '../window-ipc'
import { resolvePreload } from '../resolve-preload'
import { attachHotkeyCapture } from '../hotkeys'
import { attachTerminalHotkeyCapture } from '../terminal-hotkeys'
import {
  activeConvId,
  convHasPopup,
  drawers,
  getDrawer,
  getPlacement,
  OFFSCREEN,
  visibleKind,
  win,
  type ConvDrawer,
  type PanelTab,
} from './state'
import { applyLayout } from './layout'
import {
  registerThrottleTarget,
  resourceNeedsFullSpeed,
  unregisterThrottleTarget,
} from '../performance/resource-governor'
import { registerReclaimable, scheduleMemoryReclaim, unregisterReclaimable } from '../performance/memory-reclaimer'
import { MEMORY_RECLAIM_RETRY_MS, PANEL_COLD_TTL_MS } from '../performance/policy'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Cold eviction is deliberately conservative: safe panel renderers get ten minutes of warm state. */
export { PANEL_COLD_TTL_MS }
export const PANEL_COLD_RETRY_MS = MEMORY_RECLAIM_RETRY_MS
const RECLAIMABLE_PANEL_TABS: readonly PanelTab[] = ['terminal', 'review', 'notes', 'plan']

function panelReclaimKey(convId: string, tab: PanelTab): string {
  return `panel:${convId}:${tab}`
}

/** Development URL or production file for panel.html with panel/conversation query parameters. */
function loadPanel(view: WebContentsView, tab: string, convId: string): void {
  const search = `?panel=${tab}&conv=${encodeURIComponent(convId)}`
  if (process.env.ELECTRON_RENDERER_URL) {
    void view.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}/panel.html${search}`)
  } else {
    void view.webContents.loadFile(path.join(__dirname, '../renderer/panel.html'), { search })
  }
}

function sendTerminalPanelActivity(convId: string, fullSpeed: boolean): void {
  sendToPanel(convId, 'terminal', 'drawer:terminal-activity', { convId, fullSpeed })
}

function panelIsVisible(convId: string, tab: PanelTab): boolean {
  return activeConvId === convId && visibleKind === tab && getPlacement(convId, tab) === 'slot'
}

/** A cold-safe panel is evictable only while its own surface is in the drawer slot and inactive. */
function panelIsProtected(convId: string, tab: PanelTab): boolean {
  return (
    getPlacement(convId, tab) !== 'slot' ||
    panelIsVisible(convId, tab) ||
    convHasPopup(convId) ||
    resourceNeedsFullSpeed('panel', convId, tab)
  )
}

/** Releases every owner/registry before closing a panel renderer. */
function closePanelView(convId: string, d: ConvDrawer, tab: PanelTab, view: WebContentsView): void {
  unregisterReclaimable(panelReclaimKey(convId, tab))
  const wc = view.webContents
  unregisterPanelTarget(wc)
  unregisterThrottleTarget('panel', convId, tab)
  try {
    win?.contentView.removeChildView(view)
  } catch {
    /* the owner may already be closing */
  }
  try {
    if (!wc.isDestroyed()) wc.close()
  } catch {
    /* already closed */
  }
  if (d.panelViews.get(tab) === view) d.panelViews.delete(tab)
  d.panelInactiveSince.delete(tab)
}

function panelProtectionReasons(convId: string, tab: PanelTab): string[] {
  const reasons: string[] = []
  if (getPlacement(convId, tab) !== 'slot') reasons.push('out-of-slot')
  if (panelIsVisible(convId, tab)) reasons.push('visible')
  if (convHasPopup(convId)) reasons.push('popup')
  if (resourceNeedsFullSpeed('panel', convId, tab)) reasons.push('full-speed')
  return reasons
}

function registerPanelReclaimable(convId: string, tab: PanelTab, view: WebContentsView): void {
  const d = getDrawer(convId)
  if (!d.panelInactiveSince.has(tab)) d.panelInactiveSince.set(tab, Date.now())
  registerReclaimable({
    key: panelReclaimKey(convId, tab),
    kind: 'panel',
    lastActiveAt: () => {
      if (panelIsProtected(convId, tab)) {
        d.panelInactiveSince.delete(tab)
        return Date.now()
      }
      return d.panelInactiveSince.get(tab) ?? Date.now()
    },
    coldTtlMs: PANEL_COLD_TTL_MS,
    priority: 30,
    protection: () => {
      const reasons = panelProtectionReasons(convId, tab)
      return { protected: reasons.length > 0, reasons }
    },
    prepare: async () => {
      if (d.panelViews.get(tab) !== view) return { ok: false, reason: 'stale-owner' }
      if (tab === 'terminal' || tab === 'review') return { ok: true }
      return preparePanelMemoryEviction(convId, tab)
    },
    evict: () => {
      if (d.panelViews.get(tab) !== view) return
      closePanelView(convId, d, tab, view)
    },
  })
}

export function scheduleColdPanelEviction(): void {
  for (const [convId, d] of drawers) {
    for (const tab of RECLAIMABLE_PANEL_TABS) {
      if (panelIsProtected(convId, tab)) d.panelInactiveSince.delete(tab)
      else if (d.panelViews.get(tab) && !d.panelInactiveSince.has(tab)) d.panelInactiveSince.set(tab, Date.now())
    }
  }
  scheduleMemoryReclaim()
}

/** Called during app teardown; the shared reclaimer owns the agenda. */
export function disposePanelEviction(): void {
  for (const [convId, d] of drawers) {
    for (const tab of d.panelViews.keys()) unregisterReclaimable(panelReclaimKey(convId, tab))
  }
}

/**
 * Idempotently create/register a React panel WebContentsView offscreen. Layout/float positioning
 * reuses it without remounting, preserving state.
 */
export function ensurePanelView(d: ConvDrawer, convId: string, tab: PanelTab): WebContentsView {
  const existing = d.panelViews.get(tab)
  if (existing && !existing.webContents.isDestroyed()) {
    scheduleColdPanelEviction()
    return existing
  }
  if (existing) {
    closePanelView(convId, d, tab, existing)
  }
  const v = new WebContentsView({
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  v.setBackgroundColor('#0A0A0B')
  v.setBounds(OFFSCREEN)
  win!.contentView.addChildView(v)
  d.panelViews.set(tab, v)
  registerPanelTarget(v.webContents, { convId, panel: tab, resourceId: tab })
  if (RECLAIMABLE_PANEL_TABS.includes(tab)) registerPanelReclaimable(convId, tab, v)
  const wc = v.webContents
  registerThrottleTarget('panel', convId, tab, {
    setBackgroundThrottling: (throttled) => wc.setBackgroundThrottling(throttled),
    isDestroyed: () => wc.isDestroyed(),
    once: (event, listener) => wc.once(event, listener),
    onFullSpeedChange: (fullSpeed: boolean) => {
      if (tab === 'terminal') sendTerminalPanelActivity(convId, fullSpeed)
      scheduleColdPanelEviction()
    },
  })
  if (tab === 'terminal') {
    // The governor can apply the initial decision before the document has a listener. Re-send the
    // authoritative state after every load; the preload also caches it for React's async bootstrap.
    wc.on('did-finish-load', () => {
      sendTerminalPanelActivity(convId, resourceNeedsFullSpeed('panel', convId, tab))
    })
  }
  attachHotkeyCapture(v.webContents) // #328: capture shortcuts while panel content has focus
  if (tab === 'terminal') attachTerminalHotkeyCapture(v.webContents, convId)
  loadPanel(v, tab, convId)
  scheduleColdPanelEviction()
  return v
}

/**
 * Idempotently create floating browser chrome using panel.html?panel=browser. It starts in mainWindow
 * and is reparented by floatView above browser content; docked chrome stays in drawer DOM.
 */
export function ensureBrowserChrome(d: ConvDrawer, convId: string): WebContentsView {
  if (d.browserChromeView && !d.browserChromeView.webContents.isDestroyed()) return d.browserChromeView
  if (d.browserChromeView) {
    unregisterPanelTarget(d.browserChromeView.webContents)
    unregisterThrottleTarget('panel', convId, 'browser-chrome')
    d.browserChromeView = null
  }
  const v = new WebContentsView({
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  v.setBackgroundColor('#0A0A0B')
  v.setBounds(OFFSCREEN)
  win!.contentView.addChildView(v)
  d.browserChromeView = v
  registerPanelTarget(v.webContents, { convId, panel: 'browser', resourceId: 'browser-chrome' })
  registerThrottleTarget('panel', convId, 'browser-chrome', v.webContents)
  attachHotkeyCapture(v.webContents) // #328
  loadPanel(v, 'browser', convId)
  return v
}

/** Ensure a docked React panel view when its tab opens. */
export function ensurePanelTab(convId: string, tab: PanelTab): void {
  ensurePanelView(getDrawer(convId), convId, tab)
  applyLayout()
}
