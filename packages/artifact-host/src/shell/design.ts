// Stateful headless controller for Design mode v2: manifest/token loading, screen iframe pool, Inspect state,
// live token previews, saving tokens as a new version, and token suggestions on comments.
import { type ArtifactApi, bodyOf } from './api.js'
import {
  CONTENT_SANDBOX,
  isValidComponentName,
  isValidThemeSelector,
  isValidTokenName,
  isValidTokenValue,
  MAX_SELECTOR_CHARS,
  type BridgeMessage,
  type DesignResponse,
  type FrameResponse,
  type InspectHover,
  type InspectTarget,
  type PublicComment,
  type SelectionRect,
  type ShellMessage,
  type TokenChange,
  type TokenSuggestionChange,
  type ViewerDesign,
  type ViewerState,
  type ViewerVersion,
} from './contract.js'
import {
  canApplySuggestion,
  canSaveTokens,
  canSuggestTokens,
  diffTokens,
  formatTokenSummary,
  lookupDesignTokenValue,
  MAX_CONCURRENT_FRAME_LOADS,
  MAX_LIVE_SCREEN_FRAMES,
  mergeInspectedTokens,
  resolveScreenViewport,
  screenFrameUrl,
  selectLiveScreens,
  THUMBNAIL_MAX_HEIGHT,
  THUMBNAIL_MAX_WIDTH,
  tokenDraftKey,
} from './design-model.js'

export type DesignView = 'page' | 'screens'

export type ScreenUsageStatus = 'queued' | 'measuring' | 'done' | 'failed'

export interface ScreenUsage {
  screenId: string
  screenName: string
  status: ScreenUsageStatus
  count: number | null
}

export interface ScreenFrameState {
  screenId: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  errorMessage: string | null
}

export interface DesignSnapshot {
  version: number
  loading: boolean
  /** True when `GET design` failed with an HTTP or network error (distinct from `{ design: null }`). */
  loadError: boolean
  /** Non-null when `version` has a valid `maestrly-design.json`. */
  design: ViewerDesign | null
  view: DesignView
  /** Path currently loaded in the main stage frame (for example `'index.html#/dashboard'` or `'components.html'`). */
  stagePath: string | null
  /** Origin screen ID when viewing `manifest.components` via `openMainComponent`, otherwise `null`. */
  backScreenId: string | null
  inspecting: boolean
  tokensOpen: boolean
  hovered: InspectHover | null
  inspected: InspectTarget | null
  /** Live box of `inspected` updated on frame scroll/resize, or null. */
  inspectedRect: SelectionRect | null
  /** Bounding boxes of highlighted component instances from `showComponentUses`, updated on scroll/resize. */
  matchRects: readonly SelectionRect[]
  /** Active theme edited in the Tokens panel (`null` = `:root`). */
  activeTheme: string | null
  /** Pending uncommitted token edits (`key` = `${theme ?? ''}\n${name}`). */
  draftChanges: readonly TokenChange[]
  /** Keys (`tokenDraftKey(name, theme)`) of preserved drafts whose base value changed when rebasing versions. */
  staleDraftKeys: ReadonlySet<string>
  /** Comment ID when the active preview comes from previewing a thread's suggestion, otherwise null. */
  previewingCommentId: string | null
  focusedScreenId: string | null
  screensState: ReadonlyMap<string, ScreenFrameState>
  /** Pictures of the screens drawn so far in this version, as data URLs; null when a screen could not be drawn. */
  screenThumbnails: ReadonlyMap<string, string | null>
  /** Component name -> per-screen instance counts collected so far. */
  componentUsage: (component: string) => ScreenUsage[]
  /** Distinct normalized `data-ds-props` variant strings seen for `component` in `components.html`. */
  componentVariants: (component: string) => readonly string[]
}

export type DesignWriteError =
  | 'forbidden'
  | 'comments_disabled'
  | 'name_required'
  | 'version_conflict'
  | 'version_replaced'
  | 'version_limit'
  | 'quota_exceeded'
  | 'no_design_contract'
  | 'already_applied'
  | 'suggestion_conflict'
  | 'invalid_tokens'
  | 'no_changes'
  | 'rate_limited'
  | 'failed'

export type SaveTokensResult =
  | { ok: true; version: ViewerVersion; design: ViewerDesign }
  | { ok: false; error: DesignWriteError; currentVersion?: number }

export type SuggestTokensResult = { ok: true; comment: PublicComment } | { ok: false; error: DesignWriteError }

export type ApplySuggestionResult =
  | { ok: true; version: ViewerVersion; design: ViewerDesign; comment: PublicComment }
  | {
      ok: false
      error: DesignWriteError
      currentVersion?: number
      staleTokens?: readonly string[]
    }

export interface SetDesignVersionOptions {
  preserveDrafts?: boolean
}

export interface DesignControllerOptions {
  api: ArtifactApi
  state: ViewerState
  stageFrame: HTMLIFrameElement
  version: number
  preview: boolean
  /** Called whenever `snapshot()` changes so UI panels re-render. */
  onChange(): void
  /** Mutual exclusion: called before enabling Inspect so Comment mode turns off. */
  onDisableCommenting(): void
  /** Called when `saveTokens` or `applySuggestion` creates a new current version. */
  onVersionCreated(version: ViewerVersion, design: ViewerDesign): void
  /** Called when `rebaseTokensToVersion` or `editSuggestionInTokens` moves the viewer onto an existing version. */
  onVersionSynced?(version: number, currentVersion: number): void
  /** Called when a write fails with `version_replaced` for a viewer without history access. */
  onReplaced(): void
  /** Called when the guest sets their name during `suggestTokens`. */
  onIdentityChanged(): void
}

export interface DesignController {
  snapshot(): DesignSnapshot
  /** Records the latest `/c/<cap>/<entry>` returned by `POST frame` for `version` and loads `GET design`. */
  setVersion(version: number, frameUrl?: string, expiresAt?: number, options?: SetDesignVersionOptions): Promise<void>
  /** Retries `GET design` for the current version after `loadError`. */
  reloadDesign(): Promise<void>
  /** Routes `window` `message` events: returns `'stage'`, `'screen'`, or `null` if from an unknown window. */
  routeMessage(source: MessageEventSource | null, message: BridgeMessage): 'stage' | 'screen' | null

  // View & Screens (`shell/screens.ts`)
  setView(view: DesignView): void
  /**
   * Updates visible/focused screens in `screens` view and reconciles the `<= 6` live iframe pool. `detailIds` are the
   * visible screens shown larger than their picture, which stay live once drawn.
   */
  setVisibleScreens(visibleIds: readonly string[], focusedId: string | null, detailIds?: readonly string[]): void
  /** Returns the live `<iframe>` for `screenId` when pooled, or `null` when evicted/unmounted. */
  screenFrame(screenId: string): HTMLIFrameElement | null
  /**
   * Sets where each screen's live `<iframe>` lives (`null`: a hidden parking host). Frames are created in their host
   * and moved only when it changes, since moving an iframe reloads it where `moveBefore` is unavailable.
   */
  setScreenHost(resolve: ((screenId: string) => HTMLElement | null) | null): void
  /** Retries loading a screen frame that failed or timed out. */
  retryScreen(screenId: string): void
  /** Focuses a screen in `screens` view without leaving it. */
  focusScreen(screenId: string | null): void
  /** Switches to `'page'` view and navigates `stageFrame` to `screen.path`. */
  openScreen(screenId: string): Promise<void>

  // Inspect & Components (`shell/inspect.ts`)
  setInspecting(on: boolean): void
  /** Selects a specific element in `stageFrame` by CSS selector (for example an ancestor breadcrumb). */
  selectElement(selector: string): void
  clearSelection(): void
  /** Distinct normalized `data-ds-props` variant strings seen for `component`. */
  componentVariants(component: string): readonly string[]
  /** Navigates `stageFrame` to `manifest.components` when `[data-ds="<name>"][data-ds-main]` exists, else returns `false`. */
  openMainComponent(component: string): Promise<boolean>
  /** Returns from `manifest.components` back to the origin screen and re-selects the origin element if known. */
  returnFromMainComponent(): Promise<void>
  /** Opens `screenId` in `'page'` view and highlights all instances of `component` on that screen. */
  showComponentUses(component: string, screenId: string): Promise<void>
  /** Schedules background/live inventory collection for screens whose counts are still unknown. */
  requestInventory(): void

  // Tokens & Suggestions (`shell/tokens.ts`, `shell/thread.ts`)
  setTokensOpen(open: boolean): void
  setActiveTheme(theme: string | null): void
  /** Sets or updates one token override and broadcasts `token-preview` to `stageFrame` and all live screen frames. */
  setTokenValue(name: string, value: string, theme?: string | null): boolean
  resetToken(name: string, theme?: string | null): void
  discardTokens(): void
  /** Previews a comment's suggested changes across all live frames (`null` clears). */
  previewSuggestion(commentId: string | null, changes?: readonly TokenSuggestionChange[]): void
  /** Rebases pending token drafts onto `version` (marking drafts whose origin value changed in `staleDraftKeys`). */
  rebaseTokensToVersion(version: number): Promise<void>
  /** Loads a suggestion's token changes as editable drafts on the latest version and opens the Tokens panel. */
  editSuggestionInTokens(changes: readonly TokenSuggestionChange[]): Promise<void>
  saveTokens(): Promise<SaveTokensResult>
  suggestTokens(body: string, guestName?: string | null): Promise<SuggestTokensResult>
  applySuggestion(commentId: string): Promise<ApplySuggestionResult>

  /** Handles `Escape`: exits Inspect, closes selection, or closes Tokens panel as appropriate. */
  escape(): boolean
  destroy(): void
}

const CAPABILITY_REFRESH_BUFFER_MS = 60_000
const FRAME_LOAD_FALLBACK_MS = 5_000
/** A page that does not send its picture by then is treated as one that cannot be drawn. */
const CAPTURE_TIMEOUT_MS = 15_000

interface PooledFrame {
  screenId: string
  el: HTMLIFrameElement
  status: 'loading' | 'ready' | 'error'
  errorMessage: string | null
  loadTimer: ReturnType<typeof setTimeout> | null
}

type MovingParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }

/** Puts `frame` first in `host`, keeping its document alive with `moveBefore` where the browser has it. */
function placeFrame(host: HTMLElement, frame: HTMLIFrameElement): void {
  if (frame.parentElement === host) return
  const parent = host as MovingParent
  const before = host.firstChild
  if (typeof parent.moveBefore === 'function' && frame.isConnected && host.isConnected) {
    try {
      parent.moveBefore(frame, before)
      return
    } catch {
      // Different documents or a disconnected node: fall back to a plain insert, which reloads the frame.
    }
  }
  host.insertBefore(frame, before)
}

function postToFrame(frame: HTMLIFrameElement, message: ShellMessage): void {
  frame.contentWindow?.postMessage({ source: 'maestrly-shell', ...message }, '*')
}

function pathFromCapabilityUrl(url: string | undefined): string | null {
  if (!url) return null
  const match = /^\/c\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/(.+)$/.exec(url)
  return match ? match[1]! : null
}

function mapWriteError(status: number, code: unknown): DesignWriteError {
  if (status === 429) return 'rate_limited'
  if (status === 413) return code === 'quota_exceeded' ? 'quota_exceeded' : 'failed'
  if (status === 403) {
    if (code === 'comments_disabled') return 'comments_disabled'
    if (code === 'name_required') return 'name_required'
    return 'forbidden'
  }
  if (status === 400) {
    if (code === 'no_changes') return 'no_changes'
    return 'invalid_tokens'
  }
  if (status === 409) {
    if (code === 'version_conflict') return 'version_conflict'
    if (code === 'version_replaced') return 'version_replaced'
    if (code === 'version_limit') return 'version_limit'
    if (code === 'quota_exceeded') return 'quota_exceeded'
    if (code === 'no_design_contract') return 'no_design_contract'
    if (code === 'already_applied') return 'already_applied'
    if (code === 'suggestion_conflict') return 'suggestion_conflict'
    if (code === 'name_required') return 'name_required'
  }
  return 'failed'
}

export function createDesignController(options: DesignControllerOptions): DesignController {
  const { api, state, stageFrame, preview } = options
  let destroyed = false
  let version = options.version
  let loading = false
  let loadError = false
  let loadSeq = 0
  let design: ViewerDesign | null = null
  let capabilityUrl: string | null = null
  let capabilityExpiresAt = 0
  let stagePath: string | null = null
  let stageReady = false
  let pendingRevealComponent: string | null = null
  let pendingSelectSelector: string | null = null
  let pendingHighlightComponent: string | null = null
  let backOrigin: { screenId: string; selector: string | null } | null = null

  let view: DesignView = 'page'
  let inspecting = false
  let tokensOpen = false
  let rawHovered: InspectHover | null = null
  let rawInspected: InspectTarget | null = null
  let inspectedRect: SelectionRect | null = null
  let matchRects: SelectionRect[] = []
  let activeTheme: string | null = null

  const drafts = new Map<string, TokenChange>()
  const staleDraftKeys = new Set<string>()
  let previewingCommentId: string | null = null
  let suggestionPreviewChanges: TokenChange[] = []

  let visibleScreenIds: string[] = []
  let focusedScreenId: string | null = null
  const lruScreenIds: string[] = []
  const pooledFrames = new Map<string, PooledFrame>()
  const screenStates = new Map<string, ScreenFrameState>()
  const pendingScreenLoads: string[] = []
  let detailScreenIds: string[] = []
  const thumbnails = new Map<string, string | null>()
  const captures = new Map<string, { screenId: string; timer: ReturnType<typeof setTimeout> }>()
  let captureSeq = 0

  const inventoryByScreen = new Map<string, Record<string, number>>()
  const variantsByComponent = new Map<string, string[]>()
  let componentMains: Set<string> | null = null
  let componentsProbe: {
    el: HTMLIFrameElement
    resolve: (ok: boolean) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  let stageInventoryWaiter: ((ok: boolean) => void) | null = null
  const measuringScreenIds = new Set<string>()
  const inventoryQueue: string[] = []
  let inventoryRequested = false
  let inventoryReqSeq = 0

  let parkingHost: HTMLElement | null = null
  let screenHost: ((screenId: string) => HTMLElement | null) | null = null

  function hostFor(screenId: string): HTMLElement | null {
    return screenHost?.(screenId) ?? ensureParkingHost()
  }

  function ensureParkingHost(): HTMLElement | null {
    if (parkingHost) return parkingHost
    const doc = stageFrame.ownerDocument ?? (typeof document !== 'undefined' ? document : null)
    const parent = stageFrame.parentElement ?? doc?.body ?? null
    if (!doc || !parent) return null
    const el = doc.createElement('div')
    el.hidden = true
    el.setAttribute('aria-hidden', 'true')
    el.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none'
    parent.appendChild(el)
    parkingHost = el
    return el
  }

  function touchLru(screenId: string): void {
    const idx = lruScreenIds.indexOf(screenId)
    if (idx >= 0) lruScreenIds.splice(idx, 1)
    lruScreenIds.unshift(screenId)
    if (lruScreenIds.length > 50) lruScreenIds.length = 50
  }

  function rawPreviewChanges(): TokenChange[] {
    if (previewingCommentId !== null) return suggestionPreviewChanges
    return [...drafts.values()]
  }

  function effectivePreviewTokens(): TokenChange[] {
    const raw = rawPreviewChanges()
    if (activeTheme === null || !design) return raw

    const byKey = new Map<string, string>()
    for (const item of raw) {
      byKey.set(tokenDraftKey(item.name, item.theme ?? null), item.value)
    }

    const projected: TokenChange[] = []
    for (const token of design.tokens) {
      const themedOverride = byKey.get(tokenDraftKey(token.name, activeTheme))
      const rootOverride = byKey.get(tokenDraftKey(token.name, null))
      let effective: string
      if (themedOverride !== undefined) effective = themedOverride
      else if (Object.hasOwn(token.themes, activeTheme)) effective = token.themes[activeTheme]!
      else if (rootOverride !== undefined) effective = rootOverride
      else effective = token.value
      projected.push({ name: token.name, value: effective })
    }
    return projected
  }

  function broadcastTokenPreview(): void {
    const tokens = effectivePreviewTokens()
    const msg: ShellMessage = tokens.length ? { type: 'token-preview', tokens } : { type: 'token-preview-clear' }
    postToFrame(stageFrame, msg)
    for (const entry of pooledFrames.values()) {
      if (entry.status === 'ready') postToFrame(entry.el, msg)
    }
  }

  function mergeVariants(component: string, incoming: readonly string[] | undefined): void {
    if (!incoming?.length || !isValidComponentName(component)) return
    let list = variantsByComponent.get(component)
    if (!list) {
      list = []
      variantsByComponent.set(component, list)
    }
    for (const item of incoming) {
      if (list.length >= 32) break
      if (!list.includes(item)) list.push(item)
    }
  }

  function mergeInventoryVariants(variantsMap: Record<string, string[]> | undefined): void {
    if (!variantsMap) return
    for (const [comp, list] of Object.entries(variantsMap)) {
      mergeVariants(comp, list)
    }
  }

  function disposeComponentsProbe(result: boolean): void {
    if (!componentsProbe) return
    const current = componentsProbe
    componentsProbe = null
    clearTimeout(current.timer)
    try {
      current.el.src = 'about:blank'
      current.el.remove()
    } catch {
      // Frame already detached.
    }
    current.resolve(result)
  }

  function probeComponentsPage(url: string): Promise<boolean> {
    if (componentsProbe) disposeComponentsProbe(false)
    const doc = stageFrame.ownerDocument ?? (typeof document !== 'undefined' ? document : null)
    const host = ensureParkingHost()
    if (!doc || !host) return Promise.resolve(false)
    return new Promise((resolve) => {
      const iframe = doc.createElement('iframe')
      iframe.setAttribute('sandbox', CONTENT_SANDBOX)
      iframe.setAttribute('referrerpolicy', 'no-referrer')
      iframe.style.width = '1024px'
      iframe.style.height = '768px'
      host.appendChild(iframe)
      const timer = setTimeout(() => disposeComponentsProbe(false), FRAME_LOAD_FALLBACK_MS)
      componentsProbe = { el: iframe, resolve, timer }
      iframe.src = url
    })
  }

  function clearFrameTimer(entry: PooledFrame): void {
    if (entry.loadTimer !== null) {
      clearTimeout(entry.loadTimer)
      entry.loadTimer = null
    }
  }

  function captureInFlight(screenId: string): boolean {
    for (const request of captures.values()) if (request.screenId === screenId) return true
    return false
  }

  function dropCaptures(screenId?: string): void {
    for (const [requestId, request] of captures) {
      if (screenId !== undefined && request.screenId !== screenId) continue
      clearTimeout(request.timer)
      captures.delete(requestId)
    }
  }

  function requestCapture(screenId: string, frame: HTMLIFrameElement): void {
    if (thumbnails.has(screenId) || captureInFlight(screenId)) return
    const requestId = `cap${++captureSeq}`
    const timer = setTimeout(() => {
      if (!captures.delete(requestId)) return
      if (!thumbnails.has(screenId)) thumbnails.set(screenId, null)
      reconcilePool()
      options.onChange()
    }, CAPTURE_TIMEOUT_MS)
    captures.set(requestId, { screenId, timer })
    postToFrame(frame, {
      type: 'capture-request',
      requestId,
      maxWidth: THUMBNAIL_MAX_WIDTH,
      maxHeight: THUMBNAIL_MAX_HEIGHT,
    })
  }

  function evictScreenFrame(screenId: string): void {
    const entry = pooledFrames.get(screenId)
    if (!entry) return
    clearFrameTimer(entry)
    dropCaptures(screenId)
    pooledFrames.delete(screenId)
    try {
      entry.el.src = 'about:blank'
      entry.el.remove()
    } catch {
      // Frame already detached.
    }
    if (!inventoryByScreen.has(screenId) && !inventoryQueue.includes(screenId)) {
      measuringScreenIds.delete(screenId)
    }
    const curState = screenStates.get(screenId)
    if (curState && curState.status !== 'error') {
      screenStates.set(screenId, { screenId, status: 'idle', errorMessage: null })
    }
  }

  function evictAllScreenFrames(): void {
    for (const id of [...pooledFrames.keys()]) evictScreenFrame(id)
    pendingScreenLoads.length = 0
  }

  async function ensureCapabilityUrl(): Promise<string | null> {
    if (capabilityUrl && Date.now() + CAPABILITY_REFRESH_BUFFER_MS < capabilityExpiresAt) {
      return capabilityUrl
    }
    try {
      const res = await api.write('frame', 'POST', { version })
      if (res.status === 409 && (await bodyOf(res)).error === 'version_replaced') {
        options.onReplaced()
        return null
      }
      if (!res.ok) return null
      const body = (await res.json()) as Partial<FrameResponse>
      if (typeof body.url !== 'string' || !body.url.startsWith('/c/')) return null
      capabilityUrl = body.url
      capabilityExpiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : Date.now() + 3_600_000
      return capabilityUrl
    } catch {
      return null
    }
  }

  function countLoadingFrames(): number {
    let count = 0
    for (const entry of pooledFrames.values()) {
      if (entry.status === 'loading') count++
    }
    return count
  }

  async function pumpScreenLoads(): Promise<void> {
    if (destroyed || !design || countLoadingFrames() >= MAX_CONCURRENT_FRAME_LOADS) return
    if (pendingScreenLoads.length === 0) return
    const cap = await ensureCapabilityUrl()
    if (destroyed || !design || !cap) return

    while (pendingScreenLoads.length > 0 && countLoadingFrames() < MAX_CONCURRENT_FRAME_LOADS) {
      const screenId = pendingScreenLoads.shift()!
      if (pooledFrames.has(screenId)) continue
      const screen = design.screens.find((s) => s.id === screenId)
      if (!screen) continue
      const url = screenFrameUrl(cap, screen.path)
      if (!url) continue
      const doc = stageFrame.ownerDocument ?? (typeof document !== 'undefined' ? document : null)
      if (!doc) continue
      const iframe = doc.createElement('iframe')
      iframe.setAttribute('sandbox', CONTENT_SANDBOX)
      iframe.setAttribute('referrerpolicy', 'no-referrer')
      iframe.title = screen.name
      const dims = resolveScreenViewport(screen.viewport)
      iframe.style.width = `${dims.width}px`
      iframe.style.height = `${dims.height}px`
      iframe.tabIndex = -1
      iframe.setAttribute('aria-hidden', 'true')
      const host = hostFor(screenId)
      if (host === parkingHost) host?.appendChild(iframe)
      else host?.insertBefore(iframe, host.firstChild)

      const entry: PooledFrame = {
        screenId,
        el: iframe,
        status: 'loading',
        errorMessage: null,
        loadTimer: setTimeout(() => {
          if (entry.status === 'loading') {
            entry.status = 'error'
            entry.errorMessage = 'Timed out loading screen'
            entry.loadTimer = null
            screenStates.set(screenId, { screenId, status: 'error', errorMessage: entry.errorMessage })
            if (!thumbnails.has(screenId)) thumbnails.set(screenId, null)
            measuringScreenIds.delete(screenId)
            reconcilePool()
            options.onChange()
          }
        }, FRAME_LOAD_FALLBACK_MS),
      }
      pooledFrames.set(screenId, entry)
      screenStates.set(screenId, { screenId, status: 'loading', errorMessage: null })
      touchLru(screenId)
      iframe.src = url
    }
  }

  function reconcilePool(): void {
    if (destroyed || !design || preview) {
      evictAllScreenFrames()
      return
    }
    // Prune already-measured screens from the background queue.
    for (let i = inventoryQueue.length - 1; i >= 0; i--) {
      if (inventoryByScreen.has(inventoryQueue[i]!)) inventoryQueue.splice(i, 1)
    }

    const desired = new Set<string>()
    if (view === 'screens') {
      const reserveForInventory = inventoryQueue.some((id) => !visibleScreenIds.includes(id) && id !== focusedScreenId)
        ? 1
        : 0
      const chosen = selectLiveScreens({
        screens: design.screens,
        visibleIds: visibleScreenIds,
        focusedId: focusedScreenId,
        lruIds: lruScreenIds,
        limit: MAX_LIVE_SCREEN_FRAMES - reserveForInventory,
        thumbnails,
        detailIds: detailScreenIds,
      })
      for (const id of chosen) desired.add(id)
    }

    for (const id of inventoryQueue) {
      if (desired.size >= MAX_LIVE_SCREEN_FRAMES) break
      desired.add(id)
    }

    // Evict frames no longer desired.
    for (const id of [...pooledFrames.keys()]) {
      if (!desired.has(id)) evictScreenFrame(id)
    }

    // The screen the person is looking at closely loads before background work, interrupting it when needed.
    if (view === 'screens') {
      const urgent = new Set([focusedScreenId, ...detailScreenIds].filter((id): id is string => id !== null))
      for (const id of urgent) {
        if (!desired.has(id) || pooledFrames.has(id) || countLoadingFrames() < MAX_CONCURRENT_FRAME_LOADS) continue
        const background = [...pooledFrames.values()].find(
          (entry) => entry.status === 'loading' && !urgent.has(entry.screenId)
        )
        if (background) evictScreenFrame(background.screenId)
      }
    }

    // Queue desired frames that aren't pooled, in priority order.
    pendingScreenLoads.length = 0
    for (const id of desired) {
      if (!pooledFrames.has(id)) pendingScreenLoads.push(id)
    }

    void pumpScreenLoads()
  }

  function sendInspectModeToStage(): void {
    postToFrame(stageFrame, {
      type: 'inspect-mode',
      inspecting,
      ...(inspecting && design ? { componentTokens: design.componentTokens } : {}),
    })
  }

  function sendInventoryRequest(frame: HTMLIFrameElement): void {
    postToFrame(frame, { type: 'inventory-request', requestId: `inv${++inventoryReqSeq}` })
  }

  function resetVersionState(nextVersion: number, preserveDrafts = false): void {
    version = nextVersion
    design = null
    loadError = false
    rawHovered = null
    rawInspected = null
    inspectedRect = null
    matchRects = []
    pendingRevealComponent = null
    pendingSelectSelector = null
    pendingHighlightComponent = null
    backOrigin = null
    if (!preserveDrafts) {
      activeTheme = null
      drafts.clear()
      staleDraftKeys.clear()
    }
    previewingCommentId = null
    suggestionPreviewChanges = []
    inventoryByScreen.clear()
    variantsByComponent.clear()
    componentMains = null
    disposeComponentsProbe(false)
    if (stageInventoryWaiter) {
      const waiter = stageInventoryWaiter
      stageInventoryWaiter = null
      waiter(false)
    }
    measuringScreenIds.clear()
    inventoryQueue.length = 0
    inventoryRequested = false
    screenStates.clear()
    evictAllScreenFrames()
    thumbnails.clear()
    dropCaptures()
  }

  function rebaseDraftsOntoDesign(previousDesign: ViewerDesign | null, currentDesign: ViewerDesign): void {
    for (const [key, change] of [...drafts.entries()]) {
      const nextBase = lookupDesignTokenValue(currentDesign, change.name, change.theme ?? null)
      if (nextBase === null || nextBase === change.value) {
        drafts.delete(key)
        staleDraftKeys.delete(key)
        continue
      }
      if (previousDesign && previousDesign !== currentDesign) {
        const prevBase = lookupDesignTokenValue(previousDesign, change.name, change.theme ?? null)
        if (prevBase !== null && prevBase !== nextBase) {
          staleDraftKeys.add(key)
        }
      }
    }
  }

  function decoratedInspected(): InspectTarget | null {
    if (!rawInspected) return null
    const mergedTokens = mergeInspectedTokens(
      rawInspected.tokens,
      rawInspected.component,
      design,
      rawPreviewChanges(),
      activeTheme
    )
    const knownVariants =
      rawInspected.main && rawInspected.component ? variantsByComponent.get(rawInspected.component) : undefined
    const tokensFromManifest =
      rawInspected.tokensFromManifest === true || (rawInspected.tokens.length === 0 && mergedTokens.length > 0)
    return {
      ...rawInspected,
      tokens: mergedTokens,
      ...(knownVariants && (!rawInspected.variants || knownVariants.length > rawInspected.variants.length)
        ? { variants: [...knownVariants] }
        : {}),
      ...(tokensFromManifest ? { tokensFromManifest: true } : {}),
    }
  }

  function readComponentVariants(component: string): readonly string[] {
    const list = variantsByComponent.get(component)
    return list ? [...list] : []
  }

  const controller: DesignController = {
    snapshot(): DesignSnapshot {
      return {
        version,
        loading,
        loadError,
        design,
        view,
        stagePath,
        backScreenId:
          design?.componentsPath && stagePath === design.componentsPath && backOrigin ? backOrigin.screenId : null,
        inspecting,
        tokensOpen,
        hovered: rawHovered,
        inspected: decoratedInspected(),
        inspectedRect,
        matchRects: [...matchRects],
        activeTheme,
        draftChanges: [...drafts.values()],
        staleDraftKeys: new Set(staleDraftKeys),
        previewingCommentId,
        focusedScreenId,
        screensState: new Map(screenStates),
        screenThumbnails: new Map(thumbnails),
        componentUsage(component: string): ScreenUsage[] {
          if (!design) return []
          return design.screens.map((screen) => {
            const counts = inventoryByScreen.get(screen.id)
            if (counts !== undefined) {
              return {
                screenId: screen.id,
                screenName: screen.name,
                status: 'done',
                count: Object.hasOwn(counts, component) ? counts[component]! : 0,
              }
            }
            const frameState = screenStates.get(screen.id)
            if (frameState?.status === 'error') {
              return {
                screenId: screen.id,
                screenName: screen.name,
                status: 'failed',
                count: null,
              }
            }
            const isMeasuringNow =
              pooledFrames.has(screen.id) ||
              (stagePath === screen.path && stageReady && measuringScreenIds.has(screen.id))
            return {
              screenId: screen.id,
              screenName: screen.name,
              status: isMeasuringNow ? 'measuring' : 'queued',
              count: null,
            }
          })
        },
        componentVariants: readComponentVariants,
      }
    },

    async setVersion(
      nextVersion: number,
      frameUrl?: string,
      expiresAt?: number,
      setOptions?: SetDesignVersionOptions
    ): Promise<void> {
      const seq = ++loadSeq
      const preserveDrafts = setOptions?.preserveDrafts === true
      const previousDesign = design
      if (nextVersion !== version) resetVersionState(nextVersion, preserveDrafts)
      else {
        loadError = false
        inventoryByScreen.clear()
        variantsByComponent.clear()
        componentMains = null
        disposeComponentsProbe(false)
        measuringScreenIds.clear()
        inventoryQueue.length = 0
        inventoryRequested = false
        if (!preserveDrafts) {
          matchRects = []
          backOrigin = null
        }
      }
      if (frameUrl) {
        capabilityUrl = frameUrl
        capabilityExpiresAt = typeof expiresAt === 'number' ? expiresAt : Date.now() + 3_600_000
        stagePath = pathFromCapabilityUrl(frameUrl)
        stageReady = false
      }
      if (state.artifact.kind === 'whiteboard') {
        design = null
        loading = false
        loadError = false
        options.onChange()
        return
      }
      loading = true
      options.onChange()
      try {
        const res = await api.read(`design?version=${nextVersion}`)
        if (seq !== loadSeq || destroyed) return
        if (res.status === 409 && (await bodyOf(res)).error === 'version_replaced') {
          loading = false
          options.onReplaced()
          return
        }
        if (!res.ok) {
          design = null
          loading = false
          loadError = true
          options.onChange()
          return
        }
        const payload = (await res.json()) as Partial<DesignResponse>
        if (seq !== loadSeq || destroyed) return
        design = payload.design ?? null
        loadError = false
        screenStates.clear()
        if (design) {
          for (const screen of design.screens) {
            screenStates.set(screen.id, { screenId: screen.id, status: 'idle', errorMessage: null })
          }
          if (activeTheme !== null && !design.themes.includes(activeTheme)) activeTheme = null
          if (preserveDrafts) rebaseDraftsOntoDesign(previousDesign, design)
        } else {
          view = 'page'
          inspecting = false
          tokensOpen = false
          drafts.clear()
          staleDraftKeys.clear()
        }
        loading = false
        broadcastTokenPreview()
        reconcilePool()
        options.onChange()
      } catch {
        if (seq !== loadSeq || destroyed) return
        design = null
        loading = false
        loadError = true
        options.onChange()
      }
    },

    async reloadDesign(): Promise<void> {
      await controller.setVersion(version, capabilityUrl ?? undefined, capabilityExpiresAt || undefined, {
        preserveDrafts: true,
      })
    },

    routeMessage(source: MessageEventSource | null, message: BridgeMessage): 'stage' | 'screen' | null {
      if (!source) return null
      if (stageFrame.contentWindow && source === stageFrame.contentWindow) {
        if (message.type === 'ready') {
          stageReady = true
          sendInspectModeToStage()
          const active = effectivePreviewTokens()
          if (active.length) postToFrame(stageFrame, { type: 'token-preview', tokens: active })
          if (design?.componentsPath && stagePath === design.componentsPath) {
            sendInventoryRequest(stageFrame)
          } else if (design && stagePath && measuringScreenIds.size > 0) {
            const matching = design.screens.find((s) => s.path === stagePath)
            if (matching && !inventoryByScreen.has(matching.id)) sendInventoryRequest(stageFrame)
          }
          if (pendingRevealComponent) {
            const comp = pendingRevealComponent
            pendingRevealComponent = null
            postToFrame(stageFrame, { type: 'reveal-component', component: comp })
          } else if (pendingSelectSelector) {
            const sel = pendingSelectSelector
            pendingSelectSelector = null
            postToFrame(stageFrame, { type: 'inspect-select', selector: sel })
          } else if (pendingHighlightComponent) {
            const comp = pendingHighlightComponent
            pendingHighlightComponent = null
            postToFrame(stageFrame, { type: 'highlight-component', component: comp })
          }
        } else if (message.type === 'inspect-hover') {
          rawHovered = inspecting ? message.target : null
          options.onChange()
        } else if (message.type === 'inspect-pick') {
          rawInspected = message.target
          inspectedRect = message.target?.rect ?? null
          if (message.target) {
            matchRects = []
            if (message.target.component && message.target.variants) {
              mergeVariants(message.target.component, message.target.variants)
            }
          }
          options.onChange()
        } else if (message.type === 'matches') {
          matchRects = [...message.rects]
          options.onChange()
        } else if (message.type === 'layout') {
          let changed = false
          if (message.inspectRect !== undefined) {
            inspectedRect = message.inspectRect
            if (message.inspectRect === null) rawInspected = null
            changed = true
          }
          if (message.matchRects !== undefined) {
            matchRects = [...message.matchRects]
            changed = true
          }
          if (changed) options.onChange()
        } else if (message.type === 'inventory') {
          if (design?.componentsPath && stagePath === design.componentsPath) {
            mergeInventoryVariants(message.variants)
            componentMains = new Set(message.mains)
            if (stageInventoryWaiter) {
              const waiter = stageInventoryWaiter
              stageInventoryWaiter = null
              waiter(true)
            }
            options.onChange()
          } else if (design && stagePath) {
            if (!design.componentsPath) mergeInventoryVariants(message.variants)
            const matching = design.screens.find((s) => s.path === stagePath)
            if (matching) {
              inventoryByScreen.set(matching.id, message.instances)
              measuringScreenIds.delete(matching.id)
              reconcilePool()
              options.onChange()
            }
          }
        }
        return 'stage'
      }

      if (componentsProbe?.el.isConnected && componentsProbe.el.contentWindow === source) {
        if (message.type === 'ready') {
          sendInventoryRequest(componentsProbe.el)
        } else if (message.type === 'inventory') {
          componentMains = new Set(message.mains)
          mergeInventoryVariants(message.variants)
          disposeComponentsProbe(true)
          options.onChange()
        } else if (message.type === 'error') {
          disposeComponentsProbe(false)
        }
        return 'screen'
      }

      for (const [screenId, entry] of pooledFrames) {
        if (entry.el.isConnected && entry.el.contentWindow === source) {
          if (message.type === 'ready') {
            clearFrameTimer(entry)
            entry.status = 'ready'
            entry.errorMessage = null
            screenStates.set(screenId, { screenId, status: 'ready', errorMessage: null })
            touchLru(screenId)
            const active = effectivePreviewTokens()
            if (active.length) postToFrame(entry.el, { type: 'token-preview', tokens: active })
            if (!inventoryByScreen.has(screenId)) {
              sendInventoryRequest(entry.el)
            }
            requestCapture(screenId, entry.el)
            void pumpScreenLoads()
            options.onChange()
          } else if (message.type === 'capture') {
            const request = captures.get(message.requestId)
            if (request?.screenId !== screenId) return 'screen'
            clearTimeout(request.timer)
            captures.delete(message.requestId)
            thumbnails.set(screenId, message.image)
            reconcilePool()
            options.onChange()
          } else if (message.type === 'inventory') {
            if (!design?.componentsPath) mergeInventoryVariants(message.variants)
            inventoryByScreen.set(screenId, message.instances)
            measuringScreenIds.delete(screenId)
            reconcilePool()
            options.onChange()
          } else if (message.type === 'error') {
            clearFrameTimer(entry)
            entry.status = 'error'
            entry.errorMessage = message.message
            screenStates.set(screenId, { screenId, status: 'error', errorMessage: message.message })
            measuringScreenIds.delete(screenId)
            reconcilePool()
            options.onChange()
          }
          return 'screen'
        }
      }
      return null
    },

    setView(nextView: DesignView): void {
      if (nextView === view) return
      if (nextView === 'screens' && !design) return
      view = nextView
      if (view === 'screens' && inspectActive()) {
        controller.setInspecting(false)
      }
      reconcilePool()
      options.onChange()
    },

    setVisibleScreens(
      visibleIds: readonly string[],
      focusedId: string | null,
      detailIds: readonly string[] = []
    ): void {
      visibleScreenIds = [...visibleIds]
      detailScreenIds = [...detailIds]
      focusedScreenId = focusedId
      if (focusedId) touchLru(focusedId)
      reconcilePool()
      options.onChange()
    },

    screenFrame(screenId: string): HTMLIFrameElement | null {
      return pooledFrames.get(screenId)?.el ?? null
    },

    setScreenHost(resolve: ((screenId: string) => HTMLElement | null) | null): void {
      screenHost = resolve
      for (const [screenId, entry] of pooledFrames) {
        const host = hostFor(screenId)
        if (host) placeFrame(host, entry.el)
      }
    },

    retryScreen(screenId: string): void {
      if (!design?.screens.some((s) => s.id === screenId)) return
      evictScreenFrame(screenId)
      screenStates.set(screenId, { screenId, status: 'idle', errorMessage: null })
      if (thumbnails.get(screenId) === null) thumbnails.delete(screenId)
      if (!inventoryByScreen.has(screenId) && (inventoryRequested || view === 'page')) {
        measuringScreenIds.add(screenId)
        if (!inventoryQueue.includes(screenId)) inventoryQueue.push(screenId)
      }
      touchLru(screenId)
      reconcilePool()
      options.onChange()
    },

    focusScreen(screenId: string | null): void {
      if (screenId !== null && !design?.screens.some((s) => s.id === screenId)) return
      focusedScreenId = screenId
      if (screenId) touchLru(screenId)
      reconcilePool()
      options.onChange()
    },

    async openScreen(screenId: string): Promise<void> {
      const screen = design?.screens.find((s) => s.id === screenId)
      if (!screen) return
      const cap = await ensureCapabilityUrl()
      if (!cap || destroyed) return
      const url = screenFrameUrl(cap, screen.path)
      if (!url) return
      focusedScreenId = screenId
      view = 'page'
      backOrigin = null
      pendingRevealComponent = null
      pendingSelectSelector = null
      pendingHighlightComponent = null
      stagePath = screen.path
      stageReady = false
      rawHovered = null
      rawInspected = null
      inspectedRect = null
      matchRects = []
      stageFrame.src = url
      reconcilePool()
      options.onChange()
    },

    setInspecting(on: boolean): void {
      if (on === inspecting) return
      if (on) {
        if (state.artifact.kind === 'whiteboard' || preview) return
        options.onDisableCommenting()
        if (view === 'screens') view = 'page'
      }
      inspecting = on
      rawHovered = null
      if (!on) {
        rawInspected = null
        inspectedRect = null
        matchRects = []
        pendingHighlightComponent = null
      }
      sendInspectModeToStage()
      reconcilePool()
      options.onChange()
    },

    selectElement(selector: string): void {
      if (typeof selector !== 'string' || !selector || selector.length > MAX_SELECTOR_CHARS || /\p{Cc}/u.test(selector))
        return
      matchRects = []
      pendingHighlightComponent = null
      if (!inspecting) {
        controller.setInspecting(true)
        if (!inspecting) return
      }
      if (stageReady) {
        postToFrame(stageFrame, { type: 'inspect-select', selector })
      } else {
        pendingSelectSelector = selector
      }
      options.onChange()
    },

    clearSelection(): void {
      if (!rawInspected && !inspectedRect && matchRects.length === 0) return
      rawInspected = null
      inspectedRect = null
      matchRects = []
      pendingHighlightComponent = null
      postToFrame(stageFrame, { type: 'inspect-clear' })
      options.onChange()
    },

    componentVariants(component: string): readonly string[] {
      return readComponentVariants(component)
    },

    async openMainComponent(component: string): Promise<boolean> {
      if (!design?.componentsPath || !isValidComponentName(component)) return false
      const cap = await ensureCapabilityUrl()
      if (!cap || destroyed) return false
      const url = screenFrameUrl(cap, design.componentsPath)
      if (!url) return false

      const currentDesign = design
      const wasOnScreen = stagePath !== currentDesign.componentsPath
      const originScreen = wasOnScreen
        ? (currentDesign.screens.find((s) => s.path === stagePath) ??
          (focusedScreenId ? currentDesign.screens.find((s) => s.id === focusedScreenId) : currentDesign.screens[0]) ??
          null)
        : null
      const candidateOrigin = originScreen
        ? { screenId: originScreen.id, selector: rawInspected?.selector ?? null }
        : null

      if (componentMains === null) {
        if (stagePath === currentDesign.componentsPath && stageReady) {
          await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              if (stageInventoryWaiter === done) stageInventoryWaiter = null
              resolve(false)
            }, FRAME_LOAD_FALLBACK_MS)
            const done = (ok: boolean) => {
              clearTimeout(timer)
              resolve(ok)
            }
            stageInventoryWaiter = done
            sendInventoryRequest(stageFrame)
          })
        } else {
          const ok = await probeComponentsPage(url)
          if (!ok || destroyed || design !== currentDesign) return false
        }
      }

      if (!componentMains?.has(component)) return false

      if (candidateOrigin) backOrigin = candidateOrigin
      if (view === 'screens') view = 'page'
      if (!inspecting) {
        options.onDisableCommenting()
        inspecting = true
      }
      rawHovered = null
      matchRects = []
      pendingHighlightComponent = null
      pendingSelectSelector = null
      controller.requestInventory()
      if (stagePath === currentDesign.componentsPath && stageReady) {
        sendInspectModeToStage()
        postToFrame(stageFrame, { type: 'reveal-component', component })
      } else {
        pendingRevealComponent = component
        stagePath = currentDesign.componentsPath
        stageReady = false
        stageFrame.src = url
      }
      reconcilePool()
      options.onChange()
      return true
    },

    async returnFromMainComponent(): Promise<void> {
      if (!backOrigin || !design) return
      const { screenId, selector } = backOrigin
      const screen = design.screens.find((s) => s.id === screenId)
      if (!screen) {
        backOrigin = null
        options.onChange()
        return
      }
      const cap = await ensureCapabilityUrl()
      if (!cap || destroyed) return
      const url = screenFrameUrl(cap, screen.path)
      if (!url) return
      backOrigin = null
      focusedScreenId = screenId
      view = 'page'
      if (!inspecting) {
        options.onDisableCommenting()
        inspecting = true
      }
      pendingRevealComponent = null
      pendingHighlightComponent = null
      pendingSelectSelector = selector
      stagePath = screen.path
      stageReady = false
      rawHovered = null
      rawInspected = null
      inspectedRect = null
      matchRects = []
      stageFrame.src = url
      reconcilePool()
      options.onChange()
    },

    async showComponentUses(component: string, screenId: string): Promise<void> {
      if (!design || !isValidComponentName(component)) return
      const screen = design.screens.find((s) => s.id === screenId)
      if (!screen) return
      const cap = await ensureCapabilityUrl()
      if (!cap || destroyed) return
      const url = screenFrameUrl(cap, screen.path)
      if (!url) return
      focusedScreenId = screenId
      view = 'page'
      backOrigin = null
      if (!inspecting) {
        options.onDisableCommenting()
        inspecting = true
      }
      rawHovered = null
      inspectedRect = null
      pendingRevealComponent = null
      pendingSelectSelector = null
      if (stagePath === screen.path && stageReady) {
        pendingHighlightComponent = null
        sendInspectModeToStage()
        postToFrame(stageFrame, { type: 'highlight-component', component })
      } else {
        pendingHighlightComponent = component
        matchRects = []
        stagePath = screen.path
        stageReady = false
        stageFrame.src = url
      }
      reconcilePool()
      options.onChange()
    },

    requestInventory(): void {
      if (!design || preview) return
      inventoryRequested = true
      let changed = false
      for (const screen of design.screens) {
        if (inventoryByScreen.has(screen.id)) continue
        if (!measuringScreenIds.has(screen.id)) {
          measuringScreenIds.add(screen.id)
          changed = true
        }
        const pooled = pooledFrames.get(screen.id)
        if (pooled?.status === 'ready') {
          sendInventoryRequest(pooled.el)
        } else if (stagePath === screen.path && stageReady) {
          sendInventoryRequest(stageFrame)
        } else if (!inventoryQueue.includes(screen.id)) {
          inventoryQueue.push(screen.id)
        }
      }
      reconcilePool()
      if (changed) options.onChange()
    },

    setTokensOpen(open: boolean): void {
      if (open === tokensOpen) return
      if (open && !design && !loading && !loadError) return
      tokensOpen = open
      options.onChange()
    },

    setActiveTheme(theme: string | null): void {
      if (theme !== null && !design?.themes.includes(theme)) return
      if (theme === activeTheme) return
      activeTheme = theme
      broadcastTokenPreview()
      options.onChange()
    },

    setTokenValue(name: string, value: string, theme: string | null = activeTheme): boolean {
      if (!design || !isValidTokenName(name) || !isValidTokenValue(value)) return false
      const normalizedTheme = theme ?? null
      if (normalizedTheme !== null && !isValidThemeSelector(normalizedTheme)) return false
      const baseValue = lookupDesignTokenValue(design, name, normalizedTheme)
      if (baseValue === null) return false
      previewingCommentId = null
      suggestionPreviewChanges = []
      const key = tokenDraftKey(name, normalizedTheme)
      staleDraftKeys.delete(key)
      const trimmed = value.trim()
      if (trimmed === baseValue) drafts.delete(key)
      else drafts.set(key, { name, value: trimmed, ...(normalizedTheme ? { theme: normalizedTheme } : {}) })
      broadcastTokenPreview()
      options.onChange()
      return true
    },

    resetToken(name: string, theme: string | null = activeTheme): void {
      const key = tokenDraftKey(name, theme ?? null)
      staleDraftKeys.delete(key)
      if (!drafts.delete(key)) return
      broadcastTokenPreview()
      options.onChange()
    },

    discardTokens(): void {
      if (drafts.size === 0 && staleDraftKeys.size === 0 && previewingCommentId === null) return
      drafts.clear()
      staleDraftKeys.clear()
      previewingCommentId = null
      suggestionPreviewChanges = []
      broadcastTokenPreview()
      options.onChange()
    },

    previewSuggestion(commentId: string | null, changes?: readonly TokenSuggestionChange[]): void {
      if (commentId === null || !changes?.length) {
        if (previewingCommentId === null) return
        previewingCommentId = null
        suggestionPreviewChanges = []
        broadcastTokenPreview()
        options.onChange()
        return
      }
      previewingCommentId = commentId
      suggestionPreviewChanges = changes
        .filter(
          (c) => isValidTokenName(c.name) && isValidTokenValue(c.to) && (!c.theme || isValidThemeSelector(c.theme))
        )
        .map((c) => ({ name: c.name, value: c.to, ...(c.theme ? { theme: c.theme } : {}) }))
      broadcastTokenPreview()
      options.onChange()
    },

    async rebaseTokensToVersion(nextVersion: number): Promise<void> {
      if (
        nextVersion > state.artifact.currentVersion ||
        !state.artifact.versions.some((v) => v.number === nextVersion)
      ) {
        const latest = await api.state()
        if (latest && 'artifact' in latest) {
          state.artifact.currentVersion = latest.artifact.currentVersion
          state.artifact.versions = latest.artifact.versions
        }
      }
      let frameUrl: string | undefined
      let expiresAt: number | undefined
      const frameRes = await api.write('frame', 'POST', { version: nextVersion }).catch(() => null)
      if (frameRes) {
        if (frameRes.status === 409 && (await bodyOf(frameRes)).error === 'version_replaced') {
          options.onReplaced()
          return
        }
        if (frameRes.ok) {
          const frameBody = (await frameRes.json()) as Partial<FrameResponse>
          if (typeof frameBody.url === 'string' && frameBody.url.startsWith('/c/')) {
            frameUrl = frameBody.url
            expiresAt = frameBody.expiresAt
            stageFrame.src = frameUrl
          }
        }
      }
      await controller.setVersion(nextVersion, frameUrl, expiresAt, { preserveDrafts: true })
      options.onVersionSynced?.(nextVersion, state.artifact.currentVersion)
    },

    async editSuggestionInTokens(changes: readonly TokenSuggestionChange[]): Promise<void> {
      previewingCommentId = null
      suggestionPreviewChanges = []
      const latest = await api.state()
      if (latest && 'artifact' in latest) {
        state.artifact.currentVersion = latest.artifact.currentVersion
        state.artifact.versions = latest.artifact.versions
      }
      const targetVersion = state.artifact.currentVersion
      if (version !== targetVersion || !design) {
        await controller.rebaseTokensToVersion(targetVersion)
        if (!design) return
      }
      drafts.clear()
      staleDraftKeys.clear()
      let firstTheme: string | null = null
      for (const item of changes) {
        if (!isValidTokenName(item.name) || !isValidTokenValue(item.to)) continue
        const normalizedTheme = item.theme ?? null
        if (
          normalizedTheme !== null &&
          (!isValidThemeSelector(normalizedTheme) || !design.themes.includes(normalizedTheme))
        )
          continue
        const base = lookupDesignTokenValue(design, item.name, normalizedTheme)
        if (base === null) continue
        const trimmed = item.to.trim()
        if (trimmed === base) continue
        drafts.set(tokenDraftKey(item.name, normalizedTheme), {
          name: item.name,
          value: trimmed,
          ...(normalizedTheme ? { theme: normalizedTheme } : {}),
        })
        if (normalizedTheme && firstTheme === null) firstTheme = normalizedTheme
      }
      if (firstTheme !== null && activeTheme === null) activeTheme = firstTheme
      tokensOpen = true
      broadcastTokenPreview()
      options.onChange()
    },

    async saveTokens(): Promise<SaveTokensResult> {
      if (!design) return { ok: false, error: 'no_design_contract' }
      if (state.identity.kind !== 'owner') return { ok: false, error: 'forbidden' }
      if (version !== state.artifact.currentVersion) {
        return { ok: false, error: 'version_conflict', currentVersion: state.artifact.currentVersion }
      }
      if (!canSaveTokens(state, version, design)) return { ok: false, error: 'forbidden' }
      const diffs = diffTokens(design, drafts)
      if (diffs.length === 0) return { ok: false, error: 'no_changes' }
      const changes: TokenChange[] = diffs.map((d) => ({
        name: d.name,
        value: d.to,
        ...(d.theme ? { theme: d.theme } : {}),
      }))
      try {
        const res = await api.write('tokens', 'POST', { baseVersion: version, changes })
        if (!res.ok) {
          const body = await bodyOf(res)
          const error = mapWriteError(res.status, body.error)
          const currentVersion = typeof body.currentVersion === 'number' ? body.currentVersion : undefined
          if (currentVersion !== undefined && currentVersion > state.artifact.currentVersion) {
            state.artifact.currentVersion = currentVersion
          }
          return { ok: false, error, ...(currentVersion !== undefined ? { currentVersion } : {}) }
        }
        const payload = (await res.json()) as { version: ViewerVersion; design: ViewerDesign }
        applyNewVersion(payload.version, payload.design)
        return { ok: true, version: payload.version, design: payload.design }
      } catch {
        return { ok: false, error: 'failed' }
      }
    },

    async suggestTokens(body: string, guestName?: string | null): Promise<SuggestTokensResult> {
      if (!design) return { ok: false, error: 'no_design_contract' }
      if (!canSuggestTokens(state, design)) return { ok: false, error: 'comments_disabled' }
      const diffs = diffTokens(design, drafts)
      if (diffs.length === 0) return { ok: false, error: 'no_changes' }

      if (state.identity.kind === 'guest' && !state.identity.name) {
        const trimmedName = (guestName ?? '').trim()
        if (!trimmedName) return { ok: false, error: 'name_required' }
        const nameRes = await api.write('session/name', 'PUT', { name: trimmedName }).catch(() => null)
        if (!nameRes) return { ok: false, error: 'failed' }
        if (nameRes.status !== 204) {
          const errBody = await bodyOf(nameRes)
          return { ok: false, error: mapWriteError(nameRes.status, errBody.error) }
        }
        state.identity = { kind: 'guest', name: trimmedName }
        options.onIdentityChanged()
      }

      const summaryChanges: TokenSuggestionChange[] = diffs.map((d) => ({
        name: d.name,
        from: d.from,
        to: d.to,
        ...(d.theme ? { theme: d.theme } : {}),
      }))
      const finalBody = body.trim() || formatTokenSummary(summaryChanges)
      const changes: TokenChange[] = diffs.map((d) => ({
        name: d.name,
        value: d.to,
        ...(d.theme ? { theme: d.theme } : {}),
      }))

      try {
        const res = await api.write('comments', 'POST', {
          version,
          body: finalBody,
          suggestion: { changes },
        })
        if (!res.ok) {
          const errBody = await bodyOf(res)
          const error = mapWriteError(res.status, errBody.error)
          if (error === 'version_replaced') options.onReplaced()
          return { ok: false, error }
        }
        const comment = (await res.json()) as PublicComment
        drafts.clear()
        staleDraftKeys.clear()
        broadcastTokenPreview()
        options.onChange()
        return { ok: true, comment }
      } catch {
        return { ok: false, error: 'failed' }
      }
    },

    async applySuggestion(commentId: string): Promise<ApplySuggestionResult> {
      if (!design) return { ok: false, error: 'no_design_contract' }
      if (!canApplySuggestion(state, design)) return { ok: false, error: 'forbidden' }
      try {
        const res = await api.write(`comments/${encodeURIComponent(commentId)}/apply`, 'POST', {
          baseVersion: state.artifact.currentVersion,
        })
        if (!res.ok) {
          const errBody = await bodyOf(res)
          const error = mapWriteError(res.status, errBody.error)
          const currentVersion = typeof errBody.currentVersion === 'number' ? errBody.currentVersion : undefined
          if (currentVersion !== undefined && currentVersion > state.artifact.currentVersion) {
            state.artifact.currentVersion = currentVersion
          }
          const staleTokens = Array.isArray(errBody.staleTokens)
            ? errBody.staleTokens.filter((t): t is string => typeof t === 'string')
            : undefined
          return {
            ok: false,
            error,
            ...(currentVersion !== undefined ? { currentVersion } : {}),
            ...(staleTokens !== undefined ? { staleTokens } : {}),
          }
        }
        const payload = (await res.json()) as {
          version: ViewerVersion
          design: ViewerDesign
          comment: PublicComment
        }
        if (previewingCommentId === commentId) {
          previewingCommentId = null
          suggestionPreviewChanges = []
        }
        applyNewVersion(payload.version, payload.design)
        return { ok: true, version: payload.version, design: payload.design, comment: payload.comment }
      } catch {
        return { ok: false, error: 'failed' }
      }
    },

    escape(): boolean {
      if (rawInspected || matchRects.length > 0) {
        controller.clearSelection()
        return true
      }
      if (inspecting) {
        controller.setInspecting(false)
        return true
      }
      if (previewingCommentId !== null) {
        controller.previewSuggestion(null)
        return true
      }
      if (tokensOpen) {
        controller.setTokensOpen(false)
        return true
      }
      if (view === 'screens') {
        if (focusedScreenId !== null) {
          controller.focusScreen(null)
          return true
        }
        controller.setView('page')
        return true
      }
      return false
    },

    destroy(): void {
      destroyed = true
      screenHost = null
      dropCaptures()
      disposeComponentsProbe(false)
      evictAllScreenFrames()
      parkingHost?.remove()
      parkingHost = null
    },
  }

  function inspectActive(): boolean {
    return inspecting
  }

  function applyNewVersion(nextVer: ViewerVersion, nextDesign: ViewerDesign): void {
    state.artifact.currentVersion = nextVer.number
    if (!state.artifact.versions.some((v) => v.number === nextVer.number)) {
      state.artifact.versions.unshift(nextVer)
    }
    version = nextVer.number
    design = nextDesign
    loadError = false
    capabilityUrl = null
    capabilityExpiresAt = 0
    drafts.clear()
    staleDraftKeys.clear()
    previewingCommentId = null
    suggestionPreviewChanges = []
    inventoryByScreen.clear()
    variantsByComponent.clear()
    componentMains = null
    disposeComponentsProbe(false)
    measuringScreenIds.clear()
    inventoryQueue.length = 0
    inventoryRequested = false
    evictAllScreenFrames()
    thumbnails.clear()
    dropCaptures()
    screenStates.clear()
    for (const screen of nextDesign.screens) {
      screenStates.set(screen.id, { screenId: screen.id, status: 'idle', errorMessage: null })
    }
    if (activeTheme !== null && !nextDesign.themes.includes(activeTheme)) activeTheme = null
    broadcastTokenPreview()
    options.onVersionCreated(nextVer, nextDesign)
    options.onChange()
  }

  return controller
}
