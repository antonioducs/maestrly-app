import {
  WebContentsView,
  session,
  type BrowserWindow,
  type Session,
  type WebContents,
  type WebContentsViewConstructorOptions,
} from 'electron'
import { attachHotkeyCapture } from '../../hotkeys'
import { isPopupDisposition, oauthChildWindowOptions } from '../../oauth-popup'
import {
  OFFSCREEN,
  drawers,
  fkey,
  floatWinByKey,
  getDrawer,
  win,
} from '../../drawer/state'
import {
  registerThrottleTarget,
  resourceHasVisibleSurface,
  resourceNeedsFullSpeed,
  unregisterThrottleTarget,
} from '../../performance/resource-governor'
import { registerPerformanceWebContents, unregisterPerformanceWebContents } from '../../performance/metrics'
import { registerReclaimable, scheduleMemoryReclaim, unregisterReclaimable } from '../../performance/memory-reclaimer'
import { CHATGPT_VIEW_COLD_TTL_MS, MAX_HIDDEN_HOT_CHATGPT_VIEWS } from '../../performance/policy'
import { getMainLocale, tMain } from '../../i18n'

export const CHATGPT_WEB_URL = 'https://chatgpt.com/'
// Preserve the existing isolated partition so users keep the ChatGPT login they already completed.
export const CHATGPT_WEB_PARTITION = 'persist:chatgpt-web'

export interface ChatGptWebCompanionViewOptions {
  /** Test seam; production uses the main window registered by drawer/state. */
  getMainWindow?: () => BrowserWindow | null
  /** Test seam; production constructs the real Electron WebContentsView. */
  createView?: (options: WebContentsViewConstructorOptions, conversationId: string) => WebContentsView
  session?: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'clearStorageData'>
  /** Per-Maestrly-conversation persistence; the manager uses ui_prefs and tests inject a map. */
  loadConversationUrl?: (conversationId: string) => string | null | undefined
  saveConversationUrl?: (conversationId: string, url: string) => void
  clearConversationUrls?: () => void
}

/**
 * Accept only a conversation route on the official origin. Query/hash are unnecessary for resumption
 * and may contain transient state, so never persist them.
 */
export function resumableChatGptConversationUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port || url.username || url.password) {
      return null
    }
    const segments = url.pathname.split('/').filter(Boolean)
    const conversationMarker = segments.findIndex((segment, index) => segment === 'c' && !!segments[index + 1])
    if (conversationMarker < 0) return null
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function viewOptions(): WebContentsViewConstructorOptions {
  return {
    webPreferences: {
      partition: CHATGPT_WEB_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // No preload: remote content never receives the Maestrly API.
    },
  }
}

function defaultPartition(): Session {
  return session.fromPartition(CHATGPT_WEB_PARTITION)
}

function hardenPartition(isolated: ChatGptWebCompanionViewOptions['session']): void {
  if (!isolated) return
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler?.(() => false)
}

export const CHATGPT_DRAFT_PROBE_SCRIPT = `(() => {
  try {
    const nodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'));
    return nodes.some((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const text = el instanceof HTMLTextAreaElement ? el.value : (el.innerText || el.textContent || '');
      return String(text).trim().length > 0;
    });
  } catch {
    return true;
  }
})()`

function chatgptReclaimKey(conversationId: string): string {
  return `chatgpt:${conversationId}`
}

function chatgptSurfaceIsShown(conversationId: string): boolean {
  return resourceHasVisibleSurface('chatgpt', conversationId)
}

function chatgptRestoringDataUrl(): string {
  const t = tMain('main')
  const title = t('drawerLoading.chatgptRestoringTitle')
  const sub = t('drawerLoading.chatgptRestoringSub')
  const html = `<!doctype html><html lang="${getMainLocale()}"><head><meta charset="utf-8">
<style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{display:flex;align-items:center;justify-content:center;background:#0A0A0B;
    font-family:'SF Pro Text',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    color:rgba(237,239,245,.96);-webkit-font-smoothing:antialiased;user-select:none;cursor:default}
  .box{display:flex;flex-direction:column;align-items:center;text-align:center;gap:18px;max-width:420px;padding:32px}
  .ring{width:34px;height:34px;border-radius:50%;border:2.5px solid rgba(255,255,255,.10);
    border-top-color:#EDEAE3;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:15px;font-weight:600;letter-spacing:.2px}
  p{font-size:13px;line-height:1.5;color:rgba(178,182,196,.72)}
</style></head>
<body><div class="box"><div class="ring"></div><h1>${title}</h1><p>${sub}</p></div></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function removeFromKnownParent(view: WebContentsView, conversationId: string, owner: BrowserWindow | null): void {
  const floating = floatWinByKey.get(fkey(conversationId, 'chatgpt'))
  try {
    floating?.contentView.removeChildView(view)
  } catch {
    /* a floating window may already be destroyed */
  }
  try {
    owner?.contentView.removeChildView(view)
  } catch {
    /* already removed or owned by another window */
  }
  try {
    if (owner !== win) win?.contentView.removeChildView(view)
  } catch {
    /* already removed or owned by another window */
  }
}

function registerCompanionPopup(
  child: BrowserWindow,
  oauthWindows: Set<BrowserWindow>,
  install: (wc: WebContents, childWindow?: BrowserWindow) => void
): void {
  // Companion popups belong to this companion instance, not to the drawer-wide OAuth registry. The
  // latter is also used by the embedded browser, so sharing it would let closing one companion destroy
  // a login popup opened by another tab/conversation.
  oauthWindows.add(child)
  // A top-level child must remain visible over the native fullscreen Space on macOS, just like the
  // browser drawer's OAuth windows. This is best-effort because the API is platform-specific.
  if (process.platform === 'darwin') {
    try {
      child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    } catch {
      /* noop */
    }
  }
  try {
    child.center()
    child.show()
    child.focus()
  } catch {
    /* the provider may have closed the child during creation */
  }
  install(child.webContents, child)
  child.on('closed', () => oauthWindows.delete(child))
}

function installPopupHardening(
  conversationId: string,
  wc: WebContents,
  oauthWindows: Set<BrowserWindow>,
  childWindow?: BrowserWindow
): void {
  const guardNavigation = (event: { preventDefault(): void }, url: string) => {
    if (!/^https:\/\//i.test(url)) event.preventDefault()
  }
  wc.on('will-navigate', guardNavigation)
  wc.on('will-redirect', guardNavigation)
  wc.setWindowOpenHandler((details) => {
    if (!isPopupDisposition(details) || !/^https:\/\//i.test(details.url)) return { action: 'deny' }
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        ...oauthChildWindowOptions(CHATGPT_WEB_PARTITION),
      },
    }
  })
  wc.on('did-create-window', (child) =>
    registerCompanionPopup(child, oauthWindows, (next, childWin) => {
      installPopupHardening(conversationId, next, oauthWindows, childWin)
    })
  )
  // Keep the argument meaningful for recursive calls and make it explicit that a child is not the
  // companion view itself. The opener is retained by Electron; ownership stays in this companion's set.
  void childWindow
}

/**
 * Creates the ChatGPT web renderer lazily and keeps exactly one view per Maestrly conversation.
 *
 * The old implementation opened a BrowserWindow here. The returned manager deliberately only owns the
 * remote WebContentsView; slot/popup/floating managers decide where that same view is painted.
 */
export function createChatGptWebCompanionWindows(options: ChatGptWebCompanionViewOptions = {}) {
  let partition: NonNullable<ChatGptWebCompanionViewOptions['session']> | null = options.session ?? null
  let partitionHardened = false
  const ownerByView = new WeakMap<WebContentsView, BrowserWindow>()
  const loadByView = new WeakMap<WebContentsView, Promise<void>>()
  const oauthWindowsByConversation = new Map<string, Set<BrowserWindow>>()
  const conversationUrls = new Map<string, string>()
  const lastActiveAt = new Map<string, number>()
  const surfaceShownByConversation = new Map<string, boolean>()
  const viewGeneration = new Map<string, number>()
  const loadingConversations = new Set<string>()

  const loadConversationUrl = (conversationId: string): string => {
    const cached = conversationUrls.get(conversationId)
    if (cached) return cached
    try {
      const saved = resumableChatGptConversationUrl(options.loadConversationUrl?.(conversationId))
      if (saved) {
        conversationUrls.set(conversationId, saved)
        return saved
      }
    } catch {
      /* missing/corrupt preferences never prevent opening ChatGPT */
    }
    return CHATGPT_WEB_URL
  }

  const rememberConversationUrl = (conversationId: string, candidate: unknown): void => {
    const url = resumableChatGptConversationUrl(candidate)
    if (!url || conversationUrls.get(conversationId) === url) return
    conversationUrls.set(conversationId, url)
    try {
      options.saveConversationUrl?.(conversationId, url)
    } catch {
      /* the Maestrly conversation may have been removed during navigation */
    }
  }

  const getPartition = (): NonNullable<ChatGptWebCompanionViewOptions['session']> => {
    partition ??= defaultPartition()
    return partition
  }

  const mainWindow = (): BrowserWindow => {
    const current = options.getMainWindow?.() ?? win
    if (!current || current.isDestroyed()) throw new Error('window-unavailable')
    return current
  }

  const touch = (conversationId: string): void => {
    lastActiveAt.set(conversationId, Date.now())
    scheduleMemoryReclaim()
  }

  /** Starts the warm TTL when a ChatGPT surface becomes hidden, regardless of its placement. */
  const noteSurfaceVisibility = (conversationId: string): void => {
    const shown = chatgptSurfaceIsShown(conversationId)
    const wasShown = surfaceShownByConversation.get(conversationId) ?? false
    surfaceShownByConversation.set(conversationId, shown)
    if (!wasShown || shown) return
    touch(conversationId)
  }

  const hiddenHotViews = (): string[] =>
    [...viewGeneration.keys()]
      .filter((conversationId) => drawers.get(conversationId)?.chatgptView && !chatgptSurfaceIsShown(conversationId))
      .sort((a, b) => (lastActiveAt.get(a) ?? 0) - (lastActiveAt.get(b) ?? 0))

  async function probeUnsentDraft(wc: WebContents): Promise<boolean> {
    try {
      const result = await wc.executeJavaScript(CHATGPT_DRAFT_PROBE_SCRIPT, true)
      return result === true
    } catch {
      return true
    }
  }

  function registerCompanionReclaimable(conversationId: string, generation: number): void {
    registerReclaimable({
      key: chatgptReclaimKey(conversationId),
      kind: 'chatgpt',
      lastActiveAt: () => {
        const hidden = hiddenHotViews()
        const warmReserve = hidden.slice(-MAX_HIDDEN_HOT_CHATGPT_VIEWS)
        if (
          hidden.length > MAX_HIDDEN_HOT_CHATGPT_VIEWS &&
          hidden.includes(conversationId) &&
          !warmReserve.includes(conversationId)
        ) {
          return 0
        }
        return lastActiveAt.get(conversationId) ?? Date.now()
      },
      coldTtlMs: CHATGPT_VIEW_COLD_TTL_MS,
      priority: 10,
      protection: async () => {
        const drawer = drawers.get(conversationId)
        const view = drawer?.chatgptView
        const reasons: string[] = []
        if (viewGeneration.get(conversationId) !== generation) reasons.push('stale-owner')
        if (!view) reasons.push('not-materialized')
        const visible = chatgptSurfaceIsShown(conversationId)
        if (visible) reasons.push('visible')
        if (!visible && resourceNeedsFullSpeed('chatgpt', conversationId)) reasons.push('lease')
        const oauth = oauthWindowsByConversation.get(conversationId)
        if (oauth && [...oauth].some((child) => !child.isDestroyed())) reasons.push('oauth')
        if (loadingConversations.has(conversationId)) reasons.push('loading')
        try {
          if (view && !view.webContents.isDestroyed() && view.webContents.isLoading()) reasons.push('loading')
        } catch {
          reasons.push('unknown')
        }
        // Cheap reasons that already block eviction need not execute JavaScript in ChatGPT. The probe is
        // needed only for a current, hidden, eligible view, including under hard pressure.
        if (reasons.length > 0) return { protected: true, reasons }
        if (view && !view.webContents.isDestroyed() && (await probeUnsentDraft(view.webContents))) {
          reasons.push('draft')
        }
        return { protected: reasons.length > 0, reasons }
      },
      prepare: async () => {
        if (viewGeneration.get(conversationId) !== generation) return { ok: false, reason: 'stale-owner' }
        const view = drawers.get(conversationId)?.chatgptView
        if (!view) return { ok: false, reason: 'not-materialized' }
        try {
          rememberConversationUrl(conversationId, view.webContents.getURL())
        } catch {
          return { ok: false, reason: 'url-unavailable' }
        }
        return { ok: true }
      },
      evict: () => {
        if (viewGeneration.get(conversationId) !== generation) return
        close(conversationId)
      },
    })
  }

  function ensure(conversationId: string): WebContentsView {
    const drawer = getDrawer(conversationId)
    const current = drawer.chatgptView
    if (current && !current.webContents.isDestroyed()) {
      touch(conversationId)
      return current
    }
    if (current) {
      unregisterThrottleTarget('chatgpt', conversationId)
      unregisterPerformanceWebContents(current.webContents)
      unregisterReclaimable(chatgptReclaimKey(conversationId))
    }

    if (!partitionHardened) {
      hardenPartition(getPartition())
      partitionHardened = true
    }

    const owner = mainWindow()
    const view = options.createView
      ? options.createView(viewOptions(), conversationId)
      : new WebContentsView(viewOptions())
    view.setBackgroundColor('#0A0A0B')
    view.setBounds(OFFSCREEN)
    owner.contentView.addChildView(view)
    ownerByView.set(view, owner)
    drawer.chatgptView = view
    const generation = (viewGeneration.get(conversationId) ?? 0) + 1
    viewGeneration.set(conversationId, generation)
    touch(conversationId)
    const wc = view.webContents
    registerThrottleTarget('chatgpt', conversationId, undefined, wc)
    registerPerformanceWebContents(wc, { kind: 'chatgpt', convId: conversationId })
    registerCompanionReclaimable(conversationId, generation)
    wc.once('destroyed', () => {
      unregisterPerformanceWebContents(wc)
      if (viewGeneration.get(conversationId) === generation) {
        unregisterReclaimable(chatgptReclaimKey(conversationId))
        surfaceShownByConversation.delete(conversationId)
      }
    })
    const markActive = (): void => {
      if (drawer.chatgptView === view) touch(conversationId)
    }
    wc.on('focus', markActive)
    wc.on('dom-ready', markActive)
    wc.on('before-input-event', markActive)

    const oauthWindows = new Set<BrowserWindow>()
    oauthWindowsByConversation.set(conversationId, oauthWindows)
    attachHotkeyCapture(view.webContents)
    installPopupHardening(conversationId, view.webContents, oauthWindows)
    view.webContents.on('did-navigate', (_event, url) => {
      rememberConversationUrl(conversationId, url)
      touch(conversationId)
    })
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      rememberConversationUrl(conversationId, url)
      touch(conversationId)
    })
    view.webContents.once('destroyed', () => {
      if (drawer.chatgptView === view) drawer.chatgptView = null
      if (viewGeneration.get(conversationId) === generation) loadingConversations.delete(conversationId)
      for (const child of oauthWindows) {
        try {
          if (!child.isDestroyed()) child.destroy()
        } catch {
          /* a provider popup may already be closing */
        }
      }
      oauthWindows.clear()
      if (oauthWindowsByConversation.get(conversationId) === oauthWindows) {
        oauthWindowsByConversation.delete(conversationId)
      }
    })
    // Keep the rejection observable by `open`, while also attaching a rejection handler immediately so a
    // caller using the synchronous `ensure` seam can never create an unhandled rejection. A failed load
    // tears down the invalid view; the next `open` therefore creates a clean renderer and can retry.
    loadingConversations.add(conversationId)
    const targetUrl = loadConversationUrl(conversationId)
    // Start the local restoring page in the same turn that materializes the view. Popup/floating shortcuts
    // can place this cold view immediately; deferring the first navigation by a microtask briefly exposed an
    // unpainted native surface and caused a visible flash before the loading UI appeared.
    const load = view.webContents
      .loadURL(chatgptRestoringDataUrl())
      .then(() => view.webContents.loadURL(targetUrl))
      .then(
        () => {
          if (viewGeneration.get(conversationId) === generation) loadingConversations.delete(conversationId)
        },
        (error) => {
          if (viewGeneration.get(conversationId) === generation) {
            loadingConversations.delete(conversationId)
            surfaceShownByConversation.delete(conversationId)
          }
          if (drawer.chatgptView === view) drawer.chatgptView = null
          removeFromKnownParent(view, conversationId, ownerByView.get(view) ?? null)
          try {
            if (!view.webContents.isDestroyed()) view.webContents.close()
          } catch {
            /* a failed renderer may already be gone */
          }
          throw error
        }
      )
    loadByView.set(view, load)
    void load.catch(() => undefined)
    return view
  }

  async function open(conversationId: string): Promise<void> {
    const view = ensure(conversationId)
    await (loadByView.get(view) ?? Promise.resolve())
    if (view.webContents.isDestroyed()) throw new Error('companion-view-destroyed')
    touch(conversationId)
  }

  function close(conversationId: string): void {
    unregisterReclaimable(chatgptReclaimKey(conversationId))
    loadingConversations.delete(conversationId)
    surfaceShownByConversation.delete(conversationId)
    const drawer = drawers.get(conversationId)
    const view = drawer?.chatgptView
    const oauthWindows = oauthWindowsByConversation.get(conversationId)
    for (const child of oauthWindows ?? []) {
      try {
        if (!child.isDestroyed()) child.destroy()
      } catch {
        /* a provider popup may already be closing */
      }
    }
    oauthWindows?.clear()
    oauthWindowsByConversation.delete(conversationId)
    if (!view) return
    if (drawer) drawer.chatgptView = null
    try {
      rememberConversationUrl(conversationId, view.webContents.getURL())
    } catch {
      /* renderer already destroyed */
    }
    removeFromKnownParent(view, conversationId, ownerByView.get(view) ?? null)
    try {
      view.webContents.close()
    } catch {
      /* already destroyed */
    }
  }

  async function clearStorage(): Promise<void> {
    const conversationIds = new Set([...drawers.keys(), ...oauthWindowsByConversation.keys()])
    for (const conversationId of conversationIds) close(conversationId)
    conversationUrls.clear()
    options.clearConversationUrls?.()
    await getPartition().clearStorageData()
  }

  function dispose(): void {
    const conversationIds = new Set([...drawers.keys(), ...oauthWindowsByConversation.keys()])
    for (const conversationId of conversationIds) close(conversationId)
  }

  return { open, ensure, close, clearStorage, dispose, noteSurfaceVisibility }
}

const companionViews = createChatGptWebCompanionWindows()

/** Shared view factory used by session start and by popup/floating placement. */
export function ensureChatGptWebView(conversationId: string): WebContentsView {
  return companionViews.ensure(conversationId)
}

export async function openChatGptWebView(conversationId: string): Promise<void> {
  return companionViews.open(conversationId)
}

/** Shared visibility-transition hook used by drawer layout. */
export function noteChatGptSurfaceVisibility(conversationId: string): void {
  companionViews.noteSurfaceVisibility(conversationId)
}

export function closeChatGptWebView(conversationId: string): void {
  companionViews.close(conversationId)
}

export async function clearChatGptWebStorage(): Promise<void> {
  return companionViews.clearStorage()
}

export function disposeChatGptWebViews(): void {
  companionViews.dispose()
}
