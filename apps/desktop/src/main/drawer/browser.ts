import { BrowserWindow, WebContentsView, session, type NativeImage, type Rectangle, type WebContents } from 'electron'
import * as windowIpc from '../window-ipc'
import { attachToView, setBrowserCdpActivity } from '../browser-control'
import {
  acquireAgentActivity,
  registerThrottleTarget,
  resourceNeedsFullSpeed,
  touchAgentActivity,
  unregisterThrottleTarget,
} from '../performance/resource-governor'
import { registerPerformanceWebContents, unregisterPerformanceWebContents } from '../performance/metrics'
import { registerReclaimable, scheduleMemoryReclaim, unregisterReclaimable } from '../performance/memory-reclaimer'
import { BROWSER_TAB_COLD_TTL_MS, MEMORY_RECLAIM_RETRY_MS } from '../performance/policy'
import { getConvUiPrefs, patchConvUiPrefs } from '../store'
import { attachHotkeyCapture } from '../hotkeys'
import { attachBrowserHotkeyCapture } from '../browser-hotkeys'
import { isPopupDisposition, oauthChildWindowOptions } from '../oauth-popup'
import { attachMacMouseNavigation } from '../mouse-navigation'
import { conversationBrowserArea, presentedBrowserSize } from '../conversation-screen'
import { isHeadlessInstance, isServerMode } from '../remote-host/server/config'
import { centerInArea, clampToArea, insideWindowFrame, popupArea } from '../fleet/instance/window-bounds'
import { refocusScreen, setScreenFocusOwner, showWindow } from '../screen-focus'
import {
  OFFSCREEN,
  activeConvId,
  convHasPopup,
  drawers,
  fkey,
  floatWinByKey,
  getDrawer,
  getPlacement,
  isBrowserStreamed,
  isTabFloating,
  isTabOutOfSlot,
  omniboxOverlays,
  placedSlot,
  streamWinByConv,
  suppressed,
  visibleKind,
  win,
  type BrowserState,
  type BrowserTab,
  type ConvDrawer,
} from './state'
import { applyLayout } from './layout'
import { layoutFloatingTab } from './float'
import { layoutStreamBrowser } from './stream-window'
import { focusViewInMain } from './popup'
import { setDrawerPlacementPerformance } from './performance'
import { refreshUnthrottledBrowserRendering } from './browser-rendering'
import {
  browserHistoryIconFor,
  clearBrowserHistory,
  noteBrowserHistoryFavicon,
  queryBrowserHistory,
  recordBrowserVisit,
  updateBrowserHistoryTitle,
} from './browser-history'
import { requestSearchSuggestions } from './search-suggest'
import {
  browserHistoryKey,
  normalizeBrowserInput as normalizeUrl,
  type OmniboxQueryResult,
} from '../../shared/browser-omnibox'

type WindowOpenHandler = Parameters<WebContents['setWindowOpenHandler']>[0]

// Injected popup-manager hook avoids import cycles and relayouts an existing browser popup when its active
// subtab changes to another WebContentsView.
let popupBrowserRelayout: ((convId: string) => void) | null = null
const oauthOwnerScopeByWindow = new Map<BrowserWindow, string>()
const browserCaptureTails = new WeakMap<WebContents, Promise<void>>()
const browserDialogReady = new WeakMap<WebContents, Promise<void>>()

/** Bot pages load only once their nonblocking dialog policy is installed. Native dialogs are disabled from creation. */
function loadBrowserUrl(wc: WebContents, url: string): void {
  const load = () => {
    if (!wc.isDestroyed()) void wc.loadURL(url).catch(() => {})
  }
  const ready = browserDialogReady.get(wc)
  if (ready) void ready.then(load)
  else load()
}

/**
 * Resolves once a browser view can be driven. In a bot or on a workspaces host a new view first loads an empty page to
 * install its dialog policy; a navigation sent before that page is in place would be replaced by it.
 */
export function browserControlReady(wc: WebContents): Promise<void> {
  return browserDialogReady.get(wc) ?? Promise.resolve()
}

function enqueueBrowserCapture<T>(wc: WebContents, operation: () => Promise<T>): Promise<T> {
  const previous = browserCaptureTails.get(wc) ?? Promise.resolve()
  const result = previous.catch(() => {}).then(operation)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  browserCaptureTails.set(wc, tail)
  void tail.finally(() => {
    if (browserCaptureTails.get(wc) === tail) browserCaptureTails.delete(wc)
  })
  return result
}

function capturePresentedFrame(wc: WebContents, signal: AbortSignal): Promise<NativeImage> {
  return new Promise((resolve, reject) => {
    const maxCaptureAttempts = 3
    let settled = false
    let subscribed = false
    let captureAttempts = 0
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (subscribed) {
        try {
          wc.endFrameSubscription()
        } catch {
          /* WebContents may have been destroyed while capture was in flight. */
        }
      }
      complete()
    }
    const onAbort = () => finish(() => reject(new Error('browser surface capture canceled')))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    try {
      subscribed = true
      wc.beginFrameSubscription(false, (image) => {
        if (image.isEmpty()) return
        finish(() => resolve(image))
      })
      wc.invalidate()
      // capturePage keeps the hidden compositor active; invalidation alone may never present a frame.
      // macOS may transiently reject a hidden frame with UnknownVizError while WindowServer wakes it.
      const requestFrame = () => {
        if (settled || signal.aborted) return
        captureAttempts += 1
        void wc.capturePage(undefined, { stayHidden: true, stayAwake: true }).then(
          (image) => {
            if (!image.isEmpty()) finish(() => resolve(image))
          },
          (error) => {
            if (
              /UnknownVizError/i.test(String((error as Error)?.message ?? error)) &&
              captureAttempts < maxCaptureAttempts
            ) {
              wc.invalidate()
              setTimeout(requestFrame, 75)
              return
            }
            finish(() => reject(error))
          }
        )
      }
      requestFrame()
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

// The first callback runs while the renderer builds the frame that paints the current document state. The second
// runs only after that frame was produced, because Blink may begin the next main frame before submitting the last.
const RENDERED_FRAMES_SCRIPT =
  'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'

/**
 * Chromium keeps serving the surface it last received until the renderer submits a new frame. After a scroll, or
 * after a hidden parked tab is shown by the capture host, an immediate capture can therefore return stale pixels.
 * WebFrameMain is used because WebContents.executeJavaScript waits for loading to stop. A disposed or crashed frame
 * has no newer paint to wait for, so evaluation failures fall through to the capture itself.
 */
function waitForRendererPaint(wc: WebContents, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      complete()
    }
    const onAbort = () => finish(() => reject(new Error('browser surface capture canceled')))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    let painted: Promise<unknown>
    try {
      painted = wc.mainFrame.executeJavaScript(RENDERED_FRAMES_SCRIPT)
    } catch {
      finish(() => resolve())
      return
    }
    void painted.then(
      () => finish(() => resolve()),
      () => finish(() => resolve())
    )
  })
}

function viewIsPresented(owner: BrowserWindow | null, bounds: Rectangle): boolean {
  if (!owner || owner.isDestroyed() || !owner.isVisible()) return false
  const host = owner.getContentBounds()
  return (
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x < host.width &&
    bounds.y < host.height &&
    bounds.x + bounds.width > 0 &&
    bounds.y + bounds.height > 0
  )
}

async function captureBrowserView(
  convId: string,
  tab: BrowserTab,
  view: WebContentsView,
  signal: AbortSignal
): Promise<NativeImage> {
  const wc = view.webContents
  return enqueueBrowserCapture(wc, async () => {
    if (signal.aborted) throw new Error('browser surface preparation canceled')
    const currentDrawer = drawers.get(convId)
    if (!currentDrawer || currentDrawer.browserTabs.find((candidate) => candidate.id === tab.id)?.view !== view) {
      throw new Error('surface preparation failed: the browser tab was replaced')
    }

    const originalOwner = browserViewOwner(convId)
    const originalBounds = view.getBounds()
    if (viewIsPresented(originalOwner, originalBounds)) {
      return capturePresentedFrame(wc, signal)
    }

    const width = Math.max(1, originalBounds.width)
    const height = Math.max(1, originalBounds.height)
    const originalIndex = originalOwner?.contentView.children.indexOf(view) ?? -1
    const wasFocused = wc.isFocused()
    const wasThrottled = wc.getBackgroundThrottling()
    const captureHost = new BrowserWindow({
      show: false,
      frame: false,
      focusable: false,
      ...(process.platform === 'darwin' ? { opacity: 0 } : {}),
      skipTaskbar: true,
      useContentSize: true,
      width,
      height,
      backgroundColor: '#000000',
      webPreferences: { backgroundThrottling: false },
    })
    let restoreError: unknown
    let captureError: unknown
    let captured: NativeImage | undefined
    try {
      try {
        originalOwner?.contentView.removeChildView(view)
        captureHost.contentView.addChildView(view)
        view.setBounds({ x: 0, y: 0, width, height })
        wc.setBackgroundThrottling(false)
        if (process.platform === 'darwin') {
          // macOS can suspend an entirely hidden native host despite capturePage.
          // Present a transparent, noninteractive host so WindowServer supplies frames.
          captureHost.setIgnoreMouseEvents(true)
          captureHost.showInactive()
        }
        wc.invalidate()
      } catch (error) {
        throw new Error(`screenshot surface preparation failed: ${String((error as Error)?.message ?? error)}`)
      }
      await waitForRendererPaint(wc, signal)
      captured = await capturePresentedFrame(wc, signal)
    } catch (error) {
      captureError = error
    } finally {
      try {
        if (!captureHost.isDestroyed()) captureHost.contentView.removeChildView(view)
        const desiredOwner = browserViewOwner(convId)
        const restoreOwner = desiredOwner && !desiredOwner.isDestroyed() ? desiredOwner : originalOwner
        if (!restoreOwner || restoreOwner.isDestroyed()) {
          restoreError = new Error('the window hosting the tab is no longer available')
        } else {
          const restoreIndex = restoreOwner === originalOwner && originalIndex >= 0 ? originalIndex : undefined
          restoreOwner.contentView.addChildView(view, restoreIndex)
          if (restoreOwner === originalOwner) view.setBounds(originalBounds)
          wc.setBackgroundThrottling(wasThrottled)
          afterBrowserMutation(convId)
          if (wasFocused && browserSurfaceIsShown(convId)) wc.focus()
        }
      } catch (error) {
        restoreError = error
      } finally {
        if (!captureHost.isDestroyed()) captureHost.destroy()
      }
    }
    if (restoreError) {
      throw new Error(
        `surface restoration after screenshot failed: ${String((restoreError as Error)?.message ?? restoreError)}`
      )
    }
    if (captureError) throw captureError
    if (!captured) throw new Error('surface capture finished without producing a frame')
    return captured
  })
}

export function setPopupBrowserRelayout(fn: (convId: string) => void): void {
  popupBrowserRelayout = fn
}

/**
 * After browser mutations, apply docked slot layout, reposition floating chrome/active page, or ask
 * popup-manager to relayout. applyLayout ignores out-of-slot browsers.
 */
function afterBrowserMutation(convId: string): void {
  applyLayout()
  if (isBrowserStreamed(convId)) {
    layoutStreamBrowser(convId)
    return
  }
  if (isTabFloating(convId, 'browser')) {
    const fw = floatWinByKey.get(fkey(convId, 'browser'))
    setDrawerPlacementPerformance(convId, 'browser', 'floating', !!fw && !fw.isDestroyed() && fw.isVisible())
    if (fw && !fw.isDestroyed()) layoutFloatingTab(convId, 'browser', fw)
    return
  }
  if (getPlacement(convId, 'browser') === 'popup') popupBrowserRelayout?.(convId)
}

/**
 * Whether this conversation's browser is actually visible in the drawer slot. Restore focus after
 * OAuth only under this condition, avoiding focus theft after switching tools/conversations or
 * changing placement.
 */
function isBrowserVisibleInSlot(convId: string): boolean {
  const slotLive = !!placedSlot() && !suppressed && !convHasPopup(convId)
  return convId === activeConvId && slotLive && visibleKind === 'browser' && !isTabOutOfSlot(convId, 'browser')
}

// Per-conversation browser tabs.

// Use a dedicated browser session so the app's defaultSession production CSP cannot block legitimate site
// scripts or cross-origin connections. Each website controls its own CSP; browser cookies are isolated from
// the app.
export const BROWSER_PARTITION = 'persist:drawer-browser'

/** Cold eviction is deliberately conservative: an inactive page gets ten minutes of warm state. */
export { BROWSER_TAB_COLD_TTL_MS }
export const BROWSER_TAB_COLD_RETRY_MS = MEMORY_RECLAIM_RETRY_MS

function browserReclaimKey(convId: string, tabId: string): string {
  return `browser:${convId}:${tabId}`
}

function browserViewOwner(convId: string): BrowserWindow | null {
  if (isBrowserStreamed(convId)) {
    const streamWin = streamWinByConv.get(convId)
    if (streamWin && !streamWin.isDestroyed()) return streamWin
  }
  const floatingWin = isTabFloating(convId, 'browser') ? floatWinByKey.get(fkey(convId, 'browser')) : undefined
  return floatingWin && !floatingWin.isDestroyed() ? floatingWin : win
}

function syncBrowserTabMetadata(tab: BrowserTab): void {
  const wc = tab.view?.webContents
  if (!wc || wc.isDestroyed()) return
  const currentUrl = wc.getURL()
  if (currentUrl) tab.url = currentUrl
  const currentTitle = wc.getTitle()
  if (currentTitle) tab.title = currentTitle
}

/** Releases every owner/registry before closing a materialized page. The descriptor remains in place. */
function closeMaterializedBrowserTab(convId: string, tab: BrowserTab): void {
  unregisterReclaimable(browserReclaimKey(convId, tab.id))
  const view = tab.view
  if (!view) {
    unregisterThrottleTarget('browser', convId, tab.id)
    return
  }
  const wc = view.webContents
  syncBrowserTabMetadata(tab)
  const owner = browserViewOwner(convId)
  try {
    owner?.contentView.removeChildView(view)
  } catch {
    /* the floating owner may already be closing */
  }
  unregisterThrottleTarget('browser', convId, tab.id)
  unregisterPerformanceWebContents(wc)
  try {
    if (!wc.isDestroyed()) wc.close()
  } catch {
    /* already closed */
  }
  if (tab.view === view) tab.view = null
}

function touchBrowserTab(tab: BrowserTab): void {
  tab.lastUsedAt = Date.now()
  scheduleMemoryReclaim()
}

function browserSurfaceIsShown(convId: string): boolean {
  return (
    isBrowserVisibleInSlot(convId) ||
    isTabFloating(convId, 'browser') ||
    isBrowserStreamed(convId) ||
    getPlacement(convId, 'browser') === 'popup' ||
    convHasPopup(convId)
  )
}

// Track surface visibility transitions. Visible tabs are protected, but lastUsedAt changes only on
// activity; reset on hiding so a long-visible tab is not immediately evicted due to an old timestamp.
const browserSurfaceShownByConv = new Map<string, boolean>()

/**
 * On browser visible-to-hidden transitions across slot/floating/popup, reset the active tab's
 * lastUsedAt so warm TTL measures actual inactivity. Hard reclamation ignores TTL but still honors
 * protection.
 */
export function noteBrowserSurfaceVisibility(convId: string): void {
  const shown = browserSurfaceIsShown(convId)
  const wasShown = browserSurfaceShownByConv.get(convId) ?? false
  browserSurfaceShownByConv.set(convId, shown)
  if (!wasShown || shown) return
  const d = drawers.get(convId)
  const tab = d ? d.browserTabs.find((candidate) => candidate.id === d.activeBrowserId) : null
  if (tab) touchBrowserTab(tab)
}

function browserTabProtectionReasons(convId: string, tab: BrowserTab): string[] {
  const d = drawers.get(convId)
  const reasons: string[] = []
  if (!d || !tab.view) reasons.push('not-materialized')
  const wc = tab.view?.webContents
  try {
    if (wc && !wc.isDestroyed() && wc.isDevToolsOpened()) reasons.push('devtools')
  } catch {
    reasons.push('unknown')
  }
  if (d && tab.id === d.activeBrowserId && browserSurfaceIsShown(convId)) reasons.push('visible')
  if (resourceNeedsFullSpeed('browser', convId, tab.id)) reasons.push('full-speed')
  if (d && d.oauthWindows.size > 0 && tab.id === d.activeBrowserId) reasons.push('oauth')
  return reasons
}

function registerBrowserTabReclaimable(convId: string, tab: BrowserTab): void {
  registerReclaimable({
    key: browserReclaimKey(convId, tab.id),
    kind: 'browser',
    lastActiveAt: () => tab.lastUsedAt ?? Date.now(),
    coldTtlMs: BROWSER_TAB_COLD_TTL_MS,
    priority: 20,
    protection: () => {
      const reasons = browserTabProtectionReasons(convId, tab)
      return { protected: reasons.length > 0, reasons }
    },
    prepare: async () => {
      if (!tab.view) return { ok: false, reason: 'not-materialized' }
      syncBrowserTabMetadata(tab)
      if (tab.ownerScopeId === undefined) writeBrowserPrefs(convId)
      return { ok: true }
    },
    evict: () => {
      closeMaterializedBrowserTab(convId, tab)
    },
  })
}

function touchActiveBrowserTab(d: ConvDrawer): BrowserTab | null {
  const tab = d.browserTabs.find((candidate) => candidate.id === d.activeBrowserId) ?? null
  if (tab) touchBrowserTab(tab)
  return tab
}

/** Start the warm TTL when an active tab becomes inactive, before changing the active id. */
function touchOutgoingBrowserTab(d: ConvDrawer, nextId: string): void {
  if (d.activeBrowserId === nextId) return
  const outgoing = d.browserTabs.find((candidate) => candidate.id === d.activeBrowserId)
  if (outgoing) touchBrowserTab(outgoing)
}

export function scheduleColdBrowserEviction(): void {
  scheduleMemoryReclaim()
}

/** Called during app teardown; the shared reclaimer owns the agenda. */
export function disposeBrowserTabEviction(): void {
  for (const [convId, d] of drawers) {
    for (const tab of d.browserTabs) unregisterReclaimable(browserReclaimKey(convId, tab.id))
  }
}

/**
 * Deny sensitive site permissions by default in the shared embedded-browser/OAuth session (#560).
 * Electron otherwise grants them silently without a handler, and the app has no site-permission
 * prompt. Configure once at boot after defaultSession permissions; narrowly allow integrations only
 * when explicitly supported.
 */
export function hardenBrowserSession(): void {
  session.fromPartition(BROWSER_PARTITION).setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
}

/** Where a conversation's popups stay: inside its presented browser, or its whole screen area; none without one. */
function popupWindowArea(convId: string) {
  const area = conversationBrowserArea(convId)
  return area ? popupArea(area, presentedBrowserSize(convId)) : undefined
}

function createBrowserView(d: ConvDrawer, convId: string, tab: BrowserTab): WebContentsView {
  const resourceId = tab.id
  const v = new WebContentsView({
    webPreferences: { partition: BROWSER_PARTITION, ...(isHeadlessInstance() ? { disableDialogs: true } : {}) },
  })
  // Electron uses this as the page's base canvas colour, not just the slot behind it: pages that leave the body
  // background unset expect a browser's white default, and a dark one hides their dark text.
  v.setBackgroundColor('#FFFFFF')
  v.setBounds(OFFSCREEN)
  // A browser subtab created after detachment (or while streamed) must be parented into that window. Bounds alone
  // cannot move it between windows and would paint it over mainWindow at incorrect coordinates.
  const owner = browserViewOwner(convId)
  owner!.contentView.addChildView(v)

  const wc = v.webContents
  registerThrottleTarget('browser', convId, resourceId, {
    setBackgroundThrottling: (throttled) => wc.setBackgroundThrottling(throttled),
    isDestroyed: () => wc.isDestroyed(),
    once: (event, listener) => wc.once(event, listener),
    onFullSpeedChange: (fullSpeed) => {
      void setBrowserCdpActivity(wc, fullSpeed).catch(() => {})
    },
  })
  registerPerformanceWebContents(wc, { kind: 'browser', convId, resourceId })
  wc.once('destroyed', () => {
    if (tab.view === v) tab.view = null
    unregisterPerformanceWebContents(wc)
  })
  // Attach CDP early; Page/DevTools coexist while Runtime/Log/Network capture follows activity leases and
  // tool demand.
  // In a bot or on a workspaces host nobody can answer a native dialog: the page's dialog policy answers instead.
  const dialogs = attachToView(wc, { nativeDialogsDisabled: isHeadlessInstance() })
  if (isHeadlessInstance()) {
    // Runtime.evaluate needs a renderer before it can install the current-document override. Bootstrap only an empty
    // document; waiting for CDP before creating that renderer would deadlock the first real navigation.
    const blank = wc.loadURL('about:blank')
    browserDialogReady.set(
      wc,
      Promise.all([blank, dialogs])
        .then(() => attachToView(wc, { nativeDialogsDisabled: true }))
        .catch(() => undefined)
    )
  }
  attachHotkeyCapture(wc) // #328: capture shortcuts while browser content has focus
  // Delegated worker tabs are never shown, so the tab shortcuts stay with user-facing pages.
  attachBrowserHotkeyCapture(wc, () => (tab.ownerScopeId === undefined ? convId : null))
  attachMacMouseNavigation(wc, (direction) => {
    if (direction === 'back') browserBack(convId)
    else browserForward(convId)
  })
  // #560: Preserve real popup window.opener for OAuth using native top-level windows; ordinary
  // _blank/middle-click links become tabs. Avoid parented windows because macOS fullscreen Spaces can break
  // compositing. did-create-window handles presentation.
  const buildWindowOpenHandler = (): WindowOpenHandler => (details) => {
    if (isPopupDisposition(details)) {
      const popupOptions = oauthChildWindowOptions(BROWSER_PARTITION)
      return {
        action: 'allow',
        outlivesOpener: false, // close login windows when their opener tab closes
        // Hidden until did-create-window places and shows it: a window shown while it is constructed would take the
        // focus before anything could decide whether it may (another bot's screen may be under control).
        overrideBrowserWindowOptions: {
          ...popupOptions,
          show: false,
          webPreferences: {
            ...popupOptions.webPreferences,
            // Electron's native dialogs are separate GTK windows and bypass the popup's disabled input. They must
            // never block another bot's controlled screen. Native confirmations in bot popups are canceled.
            ...(isHeadlessInstance() ? { disableDialogs: true } : {}),
          },
        },
      }
    }
    if (tab.ownerScopeId) {
      createBrowserTab(convId, details.url, { ownerScopeId: tab.ownerScopeId, activate: false })
    } else {
      createBrowserTab(convId, details.url)
    }
    return { action: 'deny' }
  }
  const registerOAuthWindow = (child: BrowserWindow): void => {
    setScreenFocusOwner(child, { kind: 'conversation', conversationId: convId })
    d.oauthWindows.add(child)
    if (tab.ownerScopeId) oauthOwnerScopeByWindow.set(child, tab.ownerScopeId)
    // Show top-level OAuth windows above the app, including macOS fullscreen Spaces through
    // visibleOnFullScreen; otherwise login may open invisibly behind the app.
    if (process.platform === 'darwin') {
      try {
        child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      } catch {
        /* noop — API best-effort */
      }
    }
    try {
      // A conversation with its own screen area keeps its popups there, window manager frame included: they keep the
      // frame for its close button. Others center on their display.
      const area = popupWindowArea(convId)
      if (area) child.setBounds(centerInArea(child.getBounds(), insideWindowFrame(area)))
      else child.center()
      // A workspaces conversation's browser window in its tile stays above other windows: so do its popups, which its
      // tile's screen shows too.
      if (area && isServerMode()) child.setAlwaysOnTop(true)
      showWindow(child)
    } catch {
      /* The window may already be closed. */
    }
    emitBrowserPopupsChange(convId)
    // A page may move or resize its popup (window.moveTo, window.resizeTo); inside a screen area it stays there.
    child.webContents.on('content-bounds-updated', (event, bounds) => {
      const area = popupWindowArea(convId)
      if (!area) return
      event.preventDefault()
      if (!child.isDestroyed()) child.setBounds(clampToArea(bounds, insideWindowFrame(area)))
    })
    // Apply the same hardened options, shared partition, and conversation ownership recursively to popups
    // opened from OAuth windows.
    child.webContents.setWindowOpenHandler(buildWindowOpenHandler())
    child.webContents.on('did-create-window', registerOAuthWindow)
    child.on('closed', () => {
      d.oauthWindows.delete(child)
      oauthOwnerScopeByWindow.delete(child)
      emitBrowserPopupsChange(convId)
      if (isBrowserVisibleInSlot(convId)) focusViewInMain(convId, 'browser')
      // While someone controls this conversation's screen, its next popup or its browser gets the keyboard back.
      else refocusScreen({ kind: 'conversation', conversationId: convId })
    })
  }
  wc.setWindowOpenHandler(buildWindowOpenHandler())
  // Keep OAuth as native windows to preserve opener. Register them for conversation lifecycle cleanup and
  // restore browser focus on close only if it remains visible.
  wc.on('did-create-window', registerOAuthWindow)
  const syncTabMetadata = (): void => {
    const currentUrl = wc.getURL()
    if (currentUrl) tab.url = currentUrl
    const currentTitle = wc.getTitle()
    if (currentTitle) tab.title = currentTitle
  }
  const emit = () => {
    syncTabMetadata()
    emitBrowserState(convId)
  }
  // Actual URL changes update UI and persisted tabs for restart restoration.
  const navPersist = () => {
    emit()
    if (tab.ownerScopeId === undefined) persistBrowserTabs(convId)
  }
  wc.on('did-navigate', navPersist)
  wc.on('did-navigate-in-page', navPersist)
  wc.on('dom-ready', () => refreshUnthrottledBrowserRendering(wc))
  wc.on('did-start-loading', emit)
  wc.on('did-stop-loading', emit)
  wc.on('page-title-updated', emit)
  attachBrowserHistoryRecording(wc, tab)
  return v
}

/** Loads a favicon through the browser session, so it sees the same cookies and cache as the page. */
function loadBrowserFavicon(url: string, signal: AbortSignal): Promise<Response> {
  return session.fromPartition(BROWSER_PARTITION).fetch(url, { signal })
}

/**
 * Feeds the global history from a user-facing tab: committed main-frame visits (error pages excluded), their
 * titles, and their favicons. Delegated worker tabs record nothing.
 */
function attachBrowserHistoryRecording(wc: WebContents, tab: BrowserTab): void {
  if (tab.ownerScopeId !== undefined) return
  let lastKey: string | null = null
  const record = (url: string, inPage: boolean) => {
    const key = browserHistoryKey(url)
    // Fragment-only changes keep the same key; counting each one would inflate the visit count.
    if (!key || (inPage && key === lastKey)) return
    lastKey = key
    const typed = tab.typedNavigation === true
    tab.typedNavigation = false
    recordBrowserVisit(url, { typed })
  }
  wc.on('did-navigate', (_event, url, httpResponseCode) => {
    if (httpResponseCode > 0) record(url, false)
    else tab.typedNavigation = false
  })
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) record(url, true)
  })
  wc.on('page-title-updated', (_event, title) => {
    updateBrowserHistoryTitle(wc.getURL(), title)
  })
  wc.on('page-favicon-updated', (_event, favicons) => {
    const favicon = favicons.find((candidate) => typeof candidate === 'string' && candidate.length > 0)
    if (favicon) noteBrowserHistoryFavicon(wc.getURL(), favicon, loadBrowserFavicon)
  })
}

/**
 * Focuses the newest visible popup of a conversation's browser, such as a sign-in window, which lies above its
 * browser; false when it has none.
 */
export function focusBrowserPopup(convId: string): boolean {
  const popups = [...(drawers.get(convId)?.oauthWindows ?? [])].reverse()
  const popup = popups.find((child) => !child.isDestroyed() && child.isVisible())
  if (!popup) return false
  popup.focus()
  return true
}

/**
 * The views of a conversation's browser that its bot's desktop presents: its tab strip and address bar, its active
 * page, and its visible popups, newest first.
 */
export function presentedBrowserViews(convId: string): {
  chrome: WebContentsView | null
  page: WebContentsView | null
  popups: BrowserWindow[]
} {
  const d = drawers.get(convId)
  if (!d) return { chrome: null, page: null, popups: [] }
  const page = d.browserTabs.find((tab) => tab.id === d.activeBrowserId)?.view ?? null
  const popups = [...d.oauthWindows].reverse().filter((child) => !child.isDestroyed() && child.isVisible())
  return { chrome: d.browserChromeView, page, popups }
}

const browserStateListeners = new Set<(convId: string) => void>()
/** Observes changes of a browser's tabs, titles and addresses; returns the function that stops observing. */
export function onBrowserStateChange(listener: (convId: string) => void): () => void {
  browserStateListeners.add(listener)
  return () => {
    browserStateListeners.delete(listener)
  }
}

const browserPopupListeners = new Set<(convId: string) => void>()
/** Observes sign-in windows of a conversation's browser opening and closing; returns the function that stops. */
export function onBrowserPopupsChange(listener: (convId: string) => void): () => void {
  browserPopupListeners.add(listener)
  return () => {
    browserPopupListeners.delete(listener)
  }
}

function emitBrowserPopupsChange(convId: string): void {
  for (const listener of [...browserPopupListeners]) {
    try {
      listener(convId)
    } catch (error) {
      console.error('A browser popup listener failed:', error instanceof Error ? error.message : String(error))
    }
  }
}

// Debounce per-conversation tab URL/order/active-state persistence rather than writing on every navigation.
export const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Immediately persist ordered warm/cold descriptors and active tab. */
function writeBrowserPrefs(convId: string): void {
  const d = drawers.get(convId)
  if (!d) return // the conversation may have been deleted during debounce
  const persistentTabs = d.browserTabs.filter((tab) => tab.ownerScopeId === undefined)
  const browserTabs = persistentTabs.map((tab) => {
    const wc = tab.view?.webContents
    const url = wc?.getURL() || tab.url
    const title = wc?.getTitle() || tab.title
    return {
      url,
      ...(title ? { title } : {}),
    }
  })
  let browserActive = persistentTabs.findIndex((t) => t.id === d.activeBrowserId)
  if (browserActive < 0) browserActive = 0
  patchConvUiPrefs(convId, { browserTabs, browserActive })
}

function persistBrowserTabs(convId: string): void {
  const prev = persistTimers.get(convId)
  if (prev) clearTimeout(prev)
  persistTimers.set(
    convId,
    setTimeout(() => {
      persistTimers.delete(convId)
      writeBrowserPrefs(convId)
    }, 800)
  )
}

/**
 * Synchronously flush pending writes before exit so recent navigation/reorder is not lost to an unrun
 * debounce timer. Store remains open at window-all-closed.
 */
export function flushPendingBrowserPersists(): void {
  const ids = [...persistTimers.keys()]
  for (const t of persistTimers.values()) clearTimeout(t)
  persistTimers.clear()
  for (const convId of ids) writeBrowserPrefs(convId)
}

/** Move a browser tab between indices, reusing layout/state/persistence updates. */
export function reorderBrowserTab(convId: string, from: number, to: number): void {
  const d = getDrawer(convId)
  // Renderer indices address only public tabs. Scoped worker tabs keep their exact slots/order and can never
  // be moved indirectly by a drag operation over the filtered BrowserState.
  const publicTabs = d.browserTabs.filter((tab) => tab.ownerScopeId === undefined)
  const n = publicTabs.length
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return
  const [tab] = publicTabs.splice(from, 1)
  publicTabs.splice(to, 0, tab)
  let publicIndex = 0
  d.browserTabs = d.browserTabs.map((current) =>
    current.ownerScopeId === undefined ? publicTabs[publicIndex++]! : current
  )
  afterBrowserMutation(convId)
  emitBrowserState(convId)
  if (tab.ownerScopeId === undefined) persistBrowserTabs(convId)
  scheduleColdBrowserEviction()
}

function activeBrowserWc(d: ConvDrawer): WebContents | null {
  return d.browserTabs.find((t) => t.id === d.activeBrowserId)?.view?.webContents ?? null
}

/** Navigate the active tab only when it owns focus. */
export function navigateFocusedBrowser(convId: string, direction: 'back' | 'forward'): boolean {
  const d = drawers.get(convId)
  if (!d || !activeBrowserWc(d)?.isFocused()) return false
  if (direction === 'back') browserBack(convId)
  else browserForward(convId)
  return true
}

function materializeBrowserTab(convId: string, tab: BrowserTab): WebContentsView {
  const d = getDrawer(convId)
  if (tab.view && !tab.view.webContents.isDestroyed()) {
    touchBrowserTab(tab)
    scheduleColdBrowserEviction()
    return tab.view
  }
  tab.view = createBrowserView(d, convId, tab)
  tab.url = normalizeUrl(tab.url || 'https://www.google.com')
  touchBrowserTab(tab)
  registerBrowserTabReclaimable(convId, tab)
  loadBrowserUrl(tab.view.webContents, tab.url)
  scheduleColdBrowserEviction()
  return tab.view
}

export interface CreateBrowserTabOptions {
  /** Runtime-only Maestro delegation owner. */
  ownerScopeId?: string
  /** Defaults to true for the existing UI/unscoped behavior. */
  activate?: boolean
}

export function createBrowserTab(convId: string, url?: string, options: CreateBrowserTabOptions = {}): string {
  const d = getDrawer(convId)
  const tab: BrowserTab = {
    id: `${convId}:b${++d.tabSeq}`,
    view: null,
    url: normalizeUrl(url || 'https://www.google.com'),
    title: '',
    ...(options.ownerScopeId ? { ownerScopeId: options.ownerScopeId } : {}),
  }
  const activate = options.activate ?? true
  if (activate) touchOutgoingBrowserTab(d, tab.id)
  d.browserTabs.push(tab)
  if (activate) d.activeBrowserId = tab.id
  materializeBrowserTab(convId, tab)
  afterBrowserMutation(convId)
  emitBrowserState(convId)
  if (tab.ownerScopeId === undefined) persistBrowserTabs(convId)
  scheduleColdBrowserEviction()
  return tab.id
}

/** Runtime ownership helpers for host-side scoped tools. Ownership is never added to BrowserState. */
export function getBrowserTabOwnerScopeId(convId: string, tabId: string): string | undefined {
  return drawers.get(convId)?.browserTabs.find((tab) => tab.id === tabId)?.ownerScopeId
}

export function listBrowserTabIdsOwnedByScope(convId: string, ownerScopeId: string): string[] {
  return (drawers.get(convId)?.browserTabs ?? [])
    .filter((tab) => tab.ownerScopeId === ownerScopeId)
    .map((tab) => tab.id)
}

export function closeBrowserWindowsOwnedByScope(convId: string, ownerScopeId: string): void {
  const drawer = drawers.get(convId)
  if (!drawer) return
  for (const child of [...drawer.oauthWindows]) {
    if (oauthOwnerScopeByWindow.get(child) !== ownerScopeId) continue
    oauthOwnerScopeByWindow.delete(child)
    try {
      if (!child.isDestroyed()) child.close()
    } catch {
      // The popup may race its normal window lifecycle; ownership cleanup remains best-effort.
    }
  }
}

/**
 * Idempotently ensure a public tab, avoiding StrictMode duplicates. On first UI opening restore saved
 * order/active tab; private worker tabs do not count. Create a default tab when no saved state exists.
 */
export function ensureBrowser(convId: string): void {
  const d = getDrawer(convId)
  const uiTabs = d.browserTabs.filter((tab) => tab.ownerScopeId === undefined)
  if (uiTabs.length > 0) {
    const active = uiTabs.find((tab) => tab.id === d.activeBrowserId) ?? uiTabs[0]
    if (active) {
      d.activeBrowserId = active.id
      materializeBrowserTab(convId, active)
      afterBrowserMutation(convId)
    }
    emitBrowserState(convId)
    scheduleColdBrowserEviction()
    return
  }
  const prefs = getConvUiPrefs(convId)
  const saved = (prefs.browserTabs ?? []).filter((t) => t.url)
  if (saved.length === 0) {
    createBrowserTab(convId)
    return
  }
  const restored: BrowserTab[] = []
  for (const t of saved) {
    const tab: BrowserTab = {
      id: `${convId}:b${++d.tabSeq}`,
      view: null,
      url: normalizeUrl(t.url),
      title: t.title ?? '',
    }
    d.browserTabs.push(tab)
    restored.push(tab)
  }
  const activeIdx = Math.min(Math.max(prefs.browserActive ?? 0, 0), restored.length - 1)
  const activeTab = restored[Math.max(0, activeIdx)]
  if (activeTab) {
    d.activeBrowserId = activeTab.id
    materializeBrowserTab(convId, activeTab)
    afterBrowserMutation(convId)
    emitBrowserState(convId)
    scheduleColdBrowserEviction()
  }
}

export function closeBrowserTab(convId: string, id: string): void {
  const d = getDrawer(convId)
  const idx = d.browserTabs.findIndex((t) => t.id === id)
  if (idx === -1) return
  const closing = d.browserTabs[idx]
  const publicTabsBefore = d.browserTabs.filter((tab) => tab.ownerScopeId === undefined)
  const publicIndex = publicTabsBefore.findIndex((tab) => tab.id === id)
  const [tab] = d.browserTabs.splice(idx, 1)
  closeMaterializedBrowserTab(convId, tab)
  if (d.activeBrowserId === id) {
    const remainingPublic = d.browserTabs.filter((candidate) => candidate.ownerScopeId === undefined)
    const next =
      closing.ownerScopeId === undefined
        ? (remainingPublic[publicIndex] ?? remainingPublic[publicIndex - 1] ?? null)
        : (remainingPublic[0] ?? null)
    d.activeBrowserId = next?.id ?? null
    if (next) materializeBrowserTab(convId, next)
  }
  afterBrowserMutation(convId)
  emitBrowserState(convId)
  if (tab.ownerScopeId === undefined) persistBrowserTabs(convId)
  scheduleColdBrowserEviction()
}

export function switchBrowserTab(convId: string, id: string): void {
  const d = getDrawer(convId)
  const tab = d.browserTabs.find((t) => t.id === id)
  if (tab) {
    touchOutgoingBrowserTab(d, id)
    d.activeBrowserId = id
    materializeBrowserTab(convId, tab)
    afterBrowserMutation(convId)
    emitBrowserState(convId)
    if (tab.ownerScopeId === undefined) persistBrowserTabs(convId)
    scheduleColdBrowserEviction()
  }
}

export interface NavigateBrowserOptions {
  /** Typed or picked in the address bar: counts as a typed visit and moves keyboard focus to the page. */
  typed?: boolean
}

export function navigateBrowser(convId: string, input: string, options: NavigateBrowserOptions = {}): void {
  const d = getDrawer(convId)
  const active = d.browserTabs.find((tab) => tab.id === d.activeBrowserId)
  if (!active) {
    const id = createBrowserTab(convId, input)
    const created = d.browserTabs.find((tab) => tab.id === id)
    if (created && options.typed) {
      created.typedNavigation = true
      focusTypedNavigation(convId, created)
    }
    return
  }
  if (options.typed) active.typedNavigation = true
  if (!active.view || active.view.webContents.isDestroyed()) {
    active.url = normalizeUrl(input)
    materializeBrowserTab(convId, active)
    afterBrowserMutation(convId)
    emitBrowserState(convId)
    if (active.ownerScopeId === undefined) persistBrowserTabs(convId)
    if (options.typed) focusTypedNavigation(convId, active)
    return
  }
  touchBrowserTab(active)
  scheduleColdBrowserEviction()
  const wc = active.view.webContents
  loadBrowserUrl(wc, normalizeUrl(input))
  if (options.typed) focusTypedNavigation(convId, active)
}

/**
 * As in a regular browser, Enter in the address bar hands the keyboard to the page being opened. A streamed browser
 * gets its keyboard from the computer watching it; focusing its page here would also focus this host's stream window.
 */
function focusTypedNavigation(convId: string, tab: BrowserTab): void {
  const wc = tab.view?.webContents
  if (wc && !wc.isDestroyed() && browserSurfaceIsShown(convId) && !isBrowserStreamed(convId)) wc.focus()
}

/**
 * The address bar of the conversation's browser gets keyboard focus: the window hosting its chrome is focused,
 * then that chrome focuses and selects its input.
 */
export function focusBrowserAddressBar(convId: string): void {
  const placement = getPlacement(convId, 'browser')
  const chrome = drawers.get(convId)?.browserChromeView?.webContents
  try {
    if (placement === 'floating') {
      if (chrome && !chrome.isDestroyed()) chrome.focus()
    } else if (win && !win.isDestroyed()) win.webContents.focus()
  } catch {
    /* the host may be closing */
  }
  const payload = { convId, placement }
  if (typeof windowIpc.sendToConversation === 'function') {
    windowIpc.sendToConversation(convId, 'drawer:browser-focus-url', payload, { panel: 'browser' })
  } else {
    windowIpc.broadcast('drawer:browser-focus-url', payload)
  }
}

/** Cmd/Ctrl+T: a new tab whose address bar is ready for typing. */
export function openBrowserTabFromShortcut(convId: string): void {
  createBrowserTab(convId)
  focusBrowserAddressBar(convId)
}

/**
 * Cmd/Ctrl+W: closes the active user-facing tab. The next tab's page keeps the keyboard when the closed page had
 * it; after the last tab the empty browser's address bar takes it, so typing opens a new tab.
 */
export function closeActiveBrowserTabFromShortcut(convId: string): void {
  const d = drawers.get(convId)
  const active = d?.browserTabs.find((tab) => tab.id === d.activeBrowserId && tab.ownerScopeId === undefined)
  if (!d || !active) return
  const activeWc = active.view?.webContents
  const pageHadFocus = !!activeWc && !activeWc.isDestroyed() && activeWc.isFocused()
  closeBrowserTab(convId, active.id)
  const next = d.browserTabs.find((tab) => tab.id === d.activeBrowserId && tab.ownerScopeId === undefined)
  if (!next) {
    focusBrowserAddressBar(convId)
    return
  }
  const nextWc = next.view?.webContents
  if (pageHadFocus && nextWc && !nextWc.isDestroyed()) nextWc.focus()
}
export function browserBack(convId: string): void {
  const d = getDrawer(convId)
  const wc = activeBrowserWc(d)
  if (wc) {
    touchActiveBrowserTab(d)
    scheduleColdBrowserEviction()
  }
  if (wc?.canGoBack()) wc.goBack()
}
export function browserForward(convId: string): void {
  const d = getDrawer(convId)
  const wc = activeBrowserWc(d)
  if (wc) {
    touchActiveBrowserTab(d)
    scheduleColdBrowserEviction()
  }
  if (wc?.canGoForward()) wc.goForward()
}
export function browserReload(convId: string): void {
  const d = getDrawer(convId)
  const wc = activeBrowserWc(d)
  if (wc) {
    touchActiveBrowserTab(d)
    scheduleColdBrowserEviction()
    wc.reload()
  }
}

/**
 * Clear all shared embedded-browser history, HTTP cache, storage, and cookies globally across conversations
 * (#314), signing out sites. Reload the current conversation's live tabs so in-memory storage state
 * reflects removal. Rejects when the history file cannot be deleted, so the UI never confirms a partial clear.
 */
export async function browserClearCache(convId?: string): Promise<void> {
  const ses = session.fromPartition(BROWSER_PARTITION)
  await ses.clearCache()
  // No options clears every supported storage type, including cookies and service workers.
  await ses.clearStorageData()
  clearBrowserHistory()
  if (convId) for (const tab of drawers.get(convId)?.browserTabs ?? []) tab.view?.webContents.reload()
}

/** Active conversation browser WebContents for MCP control. */
function resolveBrowserForControl(convId: string): { wc: WebContents; tab: BrowserTab; resourceId: string } {
  const d = getDrawer(convId)
  let tab = d.browserTabs.find((candidate) => candidate.id === d.activeBrowserId)
  if (!tab) {
    createBrowserTab(convId, 'about:blank')
    tab = d.browserTabs.find((candidate) => candidate.id === d.activeBrowserId)
  }
  if (!tab) throw new Error('Browser tab could not be created.')
  const wc = materializeBrowserTab(convId, tab).webContents
  return { wc, tab, resourceId: tab.id }
}

export interface AcquiredBrowserForControl {
  readonly webContents: WebContents
  captureFrame(signal: AbortSignal): Promise<NativeImage>
  release(): void
}

/** Returns the active browser and owns its governor lease until the caller finishes awaiting its tool. */
export function acquireBrowserForControl(convId: string): AcquiredBrowserForControl {
  const { wc, tab, resourceId } = resolveBrowserForControl(convId)
  const view = tab.view
  if (!view) throw new Error('Browser tab was not materialized.')
  return {
    webContents: wc,
    captureFrame: (signal) => captureBrowserView(convId, tab, view, signal),
    release: acquireAgentActivity('browser', convId, resourceId),
  }
}

export interface AcquiredBrowserTab {
  readonly tabId: string
  readonly webContents: WebContents
  captureFrame(signal: AbortSignal): Promise<NativeImage>
  isCurrent(): boolean
  getBounds(): { width: number; height: number }
  show(): boolean
  release(): void
}

/**
 * Acquires one exact drawer tab without changing the active tab. The returned identity check turns
 * renderer replacement, cold rematerialization, and user tab closure into a hard boundary for callers.
 */
export function acquireBrowserTabForControl(convId: string, tabId: string): AcquiredBrowserTab {
  const d = drawers.get(convId)
  const tab = d?.browserTabs.find((candidate) => candidate.id === tabId)
  if (!d || !tab) throw new Error('Drawer browser tab is no longer available.')
  const view = materializeBrowserTab(convId, tab)
  const wc = view.webContents
  const releaseActivity = acquireAgentActivity('browser', convId, tabId)
  let released = false
  const isCurrent = () => {
    const currentDrawer = drawers.get(convId)
    const currentTab = currentDrawer?.browserTabs.find((candidate) => candidate.id === tabId)
    return currentTab === tab && currentTab.view === view && !wc.isDestroyed()
  }
  return {
    tabId,
    webContents: wc,
    captureFrame: (signal) => captureBrowserView(convId, tab, view, signal),
    isCurrent,
    getBounds: () => {
      if (!isCurrent()) throw new Error('Drawer browser tab is no longer available.')
      const bounds = view.getBounds()
      return { width: bounds.width, height: bounds.height }
    },
    show: () => {
      if (!isCurrent()) return false
      const placement = getPlacement(convId, 'browser')
      if (placement === 'slot' && !isBrowserVisibleInSlot(convId)) return false
      switchBrowserTab(convId, tabId)
      if (!isCurrent()) return false
      // A streamed browser is shown on the viewer's computer: making the tab active is all it takes.
      if (placement === 'stream') return true
      if (placement === 'floating') {
        const floatingWindow = floatWinByKey.get(fkey(convId, 'browser'))
        if (!floatingWindow || floatingWindow.isDestroyed()) return false
        floatingWindow.show()
        floatingWindow.focus()
      } else {
        if (!win || win.isDestroyed()) return false
        win.show()
        win.focus()
      }
      wc.focus()
      return true
    },
    release: () => {
      if (released) return
      released = true
      releaseActivity()
    },
  }
}

/** Renew active-tab grace without materializing a browser for a conversation that has none. */
export function touchActiveBrowserActivity(convId: string): void {
  const drawer = drawers.get(convId)
  if (!drawer?.activeBrowserId) return
  const tab = drawer.browserTabs.find((candidate) => candidate.id === drawer.activeBrowserId)
  if (!tab) return
  touchBrowserTab(tab)
  scheduleColdBrowserEviction()
  try {
    touchAgentActivity('browser', convId, tab.id)
  } catch {
    // Conversation cleanup may already be destroying this tab.
  }
}

export function browserForControl(convId: string): WebContents {
  const { wc, resourceId } = resolveBrowserForControl(convId)
  try {
    // This lease deliberately outlives the current MCP tool so model think time between calls stays
    // full-speed. Long awaited operations use acquireBrowserForControl instead.
    if (resourceId) touchAgentActivity('browser', convId, resourceId)
  } catch {
    // A destroyed page may race the governor during shutdown; return the WebContents and let the
    // actual browser operation report its normal error.
  }
  return wc
}

function projectBrowserState(
  convId: string,
  d: ConvDrawer,
  sourceTabs: readonly BrowserTab[],
  activeId: string | null
): BrowserState {
  const tabs = sourceTabs.map((t) => ({
    id: t.id,
    title: t.view?.webContents.getTitle() || t.title || 'New tab',
    url: t.view?.webContents.getURL() || t.url,
    loading: t.view?.webContents.isLoading() ?? false,
  }))
  const wc = activeId ? d.browserTabs.find((tab) => tab.id === activeId)?.view?.webContents : null
  return {
    convId,
    tabs,
    activeId,
    canGoBack: wc?.canGoBack() ?? false,
    canGoForward: wc?.canGoForward() ?? false,
    devtoolsOpen: wc?.isDevToolsOpened() ?? false,
  }
}

/** Public/UI state never exposes delegated tabs or their runtime ownership. */
export function getBrowserState(convId: string): BrowserState {
  const d = getDrawer(convId)
  const tabs = d.browserTabs.filter((tab) => tab.ownerScopeId === undefined)
  const activeId = tabs.some((tab) => tab.id === d.activeBrowserId) ? d.activeBrowserId : null
  if (activeId) touchActiveBrowserTab(d)
  scheduleColdBrowserEviction()
  return projectBrowserState(convId, d, tabs, activeId)
}

/** Host-only projection for one exact Maestro delegation. Never sent through renderer IPC. */
export function getBrowserStateForScope(convId: string, ownerScopeId: string): BrowserState {
  const d = getDrawer(convId)
  const tabs = d.browserTabs.filter((tab) => tab.ownerScopeId === ownerScopeId)
  scheduleColdBrowserEviction()
  return projectBrowserState(convId, d, tabs, tabs[0]?.id ?? null)
}

/** Asks the renderer to open this conversation's drawer on its Browser tab, as terminal focus does. */
export function focusBrowserDrawer(convId: string): void {
  if (typeof windowIpc.sendToConversation === 'function') {
    windowIpc.sendToConversation(convId, 'drawer:browser-focus', { convId }, { panel: 'browser' })
  } else {
    windowIpc.broadcast('drawer:browser-focus', { convId })
  }
}

export function emitBrowserState(convId: string): void {
  if (!drawers.has(convId)) return
  for (const listener of [...browserStateListeners]) {
    try {
      listener(convId)
    } catch (error) {
      console.error('A browser state listener failed:', error instanceof Error ? error.message : String(error))
    }
  }
  // Broadcast chrome updates filtered by convId, including floating browsers in background conversations
  // controlled through MCP.
  const state = getBrowserState(convId)
  if (typeof windowIpc.sendToConversation === 'function') {
    windowIpc.sendToConversation(convId, 'drawer:browser-state', state, { panel: 'browser' })
  } else {
    windowIpc.broadcast('drawer:browser-state', state)
  }
}

// ---------------- DevTools natively docked inside the view ----------------

/**
 * Toggle native docked DevTools for the active page. Chromium handles page shrinking, dock side, and
 * resizing; early CDP attachment coexists with it.
 */
export function toggleBrowserDevTools(convId: string): void {
  const d = getDrawer(convId)
  const wc = activeBrowserWc(d)
  if (!wc) return
  touchActiveBrowserTab(d)
  scheduleColdBrowserEviction()
  if (wc.isDevToolsOpened()) wc.closeDevTools()
  else wc.openDevTools({ mode: 'bottom' })
  emitBrowserState(convId)
}

// ---------------- Address bar ----------------

const OMNIBOX_INPUT_MAX = 2048

/**
 * History candidates and open tabs for address-bar text, plus Google suggestions when `search` is set. `requestKey`
 * identifies the asking address bar so its newer request cancels the previous suggestion fetch.
 */
export async function queryOmnibox(
  convId: string,
  text: string,
  options: { search?: boolean; locale?: string },
  requestKey: number
): Promise<OmniboxQueryResult> {
  const input = text.slice(0, OMNIBOX_INPUT_MAX)
  const d = drawers.get(convId)
  const tabs = (d?.browserTabs ?? [])
    .filter((tab) => tab.ownerScopeId === undefined)
    .map((tab) => {
      const wc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null
      const url = wc?.getURL() || tab.url
      const icon = browserHistoryIconFor(url)
      return { id: tab.id, url, title: wc?.getTitle() || tab.title, ...(icon ? { icon } : {}) }
    })
  const history = queryBrowserHistory(input)
  const searchSuggestions = options.search ? await requestSearchSuggestions(requestKey, input, options.locale) : []
  return { history, tabs, searchSuggestions }
}

export type OmniboxOverlayMode = 'prepare' | 'open' | 'close'

const omniboxOverlayGeneration = new Map<string, number>()
const omniboxOverlayOwners = new WeakMap<WebContents, Set<string>>()

function releaseOmniboxOverlay(convId: string): void {
  omniboxOverlayGeneration.set(convId, (omniboxOverlayGeneration.get(convId) ?? 0) + 1)
  if (omniboxOverlays.delete(convId) && drawers.has(convId)) afterBrowserMutation(convId)
}

/** A renderer that crashes, reloads, or closes while its suggestions are open must not leave the page hidden. */
function trackOmniboxOverlayOwner(owner: WebContents, convId: string): void {
  let convs = omniboxOverlayOwners.get(owner)
  if (!convs) {
    const owned = new Set<string>()
    convs = owned
    omniboxOverlayOwners.set(owner, owned)
    const release = () => {
      for (const id of [...owned]) releaseOmniboxOverlay(id)
      owned.clear()
    }
    owner.once('destroyed', release)
    owner.on('render-process-gone', release)
    owner.on('did-navigate', release)
  }
  convs.add(convId)
}

/** Frozen frame of the active page while it is on screen, as a data URL. */
async function captureActiveBrowserPage(convId: string): Promise<string | null> {
  const d = drawers.get(convId)
  const view = d?.browserTabs.find((tab) => tab.id === d.activeBrowserId)?.view
  if (!view || view.webContents.isDestroyed()) return null
  if (!viewIsPresented(browserViewOwner(convId), view.getBounds())) return null
  try {
    const image = await view.webContents.capturePage()
    return image.isEmpty() ? null : image.toDataURL()
  } catch {
    return null
  }
}

/**
 * Address-bar suggestions over the native page, which paints above any DOM. `prepare` captures the page (the
 * renderer paints that frame under the page) and, when floating, extends the chrome view over the page area;
 * `open` then moves the page offscreen; `close` restores the page and the chrome. A `close` issued while a
 * `prepare` is capturing wins.
 */
export async function setOmniboxOverlay(
  convId: string,
  mode: OmniboxOverlayMode,
  owner?: WebContents
): Promise<string | null> {
  if (mode === 'close') {
    releaseOmniboxOverlay(convId)
    return null
  }
  if (!drawers.has(convId)) return null
  if (mode === 'open') {
    if (omniboxOverlays.get(convId) !== 'prepared') return null
    omniboxOverlays.set(convId, 'open')
    afterBrowserMutation(convId)
    return null
  }
  const generation = (omniboxOverlayGeneration.get(convId) ?? 0) + 1
  omniboxOverlayGeneration.set(convId, generation)
  const snapshot = await captureActiveBrowserPage(convId)
  if (omniboxOverlayGeneration.get(convId) !== generation || !drawers.has(convId)) return null
  if (owner) trackOmniboxOverlayOwner(owner, convId)
  if (!omniboxOverlays.has(convId)) {
    omniboxOverlays.set(convId, 'prepared')
    afterBrowserMutation(convId)
  }
  return snapshot
}
