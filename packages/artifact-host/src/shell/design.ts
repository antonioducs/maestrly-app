// Stateful headless controller for Design mode v2: manifest/token loading, screen iframe pool, Inspect state,
// live token previews, saving tokens as a new version, and token suggestions on comments.
import { type ArtifactApi, bodyOf } from './api.js'
import {
  CONTENT_SANDBOX,
  isValidComponentName,
  isValidThemeSelector,
  isValidTokenName,
  isValidTokenValue,
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
  tokenDraftKey,
} from './design-model.js'

export type DesignView = 'page' | 'screens'

export interface ScreenUsage {
  screenId: string
  screenName: string
  count: number | null
  measuring: boolean
}

export interface ScreenFrameState {
  screenId: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  errorMessage: string | null
}

export interface DesignSnapshot {
  version: number
  loading: boolean
  /** Non-null when `version` has a valid `maestrly-design.json`. */
  design: ViewerDesign | null
  view: DesignView
  /** Path currently loaded in the main stage frame (for example `'index.html#/dashboard'` or `'components.html'`). */
  stagePath: string | null
  inspecting: boolean
  tokensOpen: boolean
  hovered: InspectHover | null
  inspected: InspectTarget | null
  /** Live box of `inspected` updated on frame scroll/resize, or null. */
  inspectedRect: SelectionRect | null
  /** Active theme edited in the Tokens panel (`null` = `:root`). */
  activeTheme: string | null
  /** Pending uncommitted token edits (`key` = `${theme ?? ''}\n${name}`). */
  draftChanges: readonly TokenChange[]
  /** Comment ID when the active preview comes from previewing a thread's suggestion, otherwise null. */
  previewingCommentId: string | null
  focusedScreenId: string | null
  screensState: ReadonlyMap<string, ScreenFrameState>
  /** Component name -> per-screen instance counts collected so far. */
  componentUsage: (component: string) => ScreenUsage[]
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
  | { ok: false; error: DesignWriteError; currentVersion?: number }

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
  /** Called when a write fails with `version_replaced` for a viewer without history access. */
  onReplaced(): void
  /** Called when the guest sets their name during `suggestTokens`. */
  onIdentityChanged(): void
}

export interface DesignController {
  snapshot(): DesignSnapshot
  /** Records the latest `/c/<cap>/<entry>` returned by `POST frame` for `version` and loads `GET design`. */
  setVersion(version: number, frameUrl?: string, expiresAt?: number): Promise<void>
  /** Routes `window` `message` events: returns `'stage'`, `'screen'`, or `null` if from an unknown window. */
  routeMessage(source: MessageEventSource | null, message: BridgeMessage): 'stage' | 'screen' | null

  // View & Screens (`shell/screens.ts`)
  setView(view: DesignView): void
  /** Updates visible/focused screens in `screens` view and reconciles the `<= 6` live iframe pool. */
  setVisibleScreens(visibleIds: readonly string[], focusedId: string | null): void
  /** Returns the live `<iframe>` for `screenId` when pooled, or `null` when evicted/unmounted. */
  screenFrame(screenId: string): HTMLIFrameElement | null
  /** Focuses a screen in `screens` view without leaving it. */
  focusScreen(screenId: string | null): void
  /** Switches to `'page'` view and navigates `stageFrame` to `screen.path`. */
  openScreen(screenId: string): Promise<void>

  // Inspect & Components (`shell/inspect.ts`)
  setInspecting(on: boolean): void
  clearSelection(): void
  /** Navigates `stageFrame` to `manifest.components`, reveals `[data-ds="<name>"][data-ds-main]`, and gathers counts. */
  openMainComponent(component: string): Promise<boolean>
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
  saveTokens(): Promise<SaveTokensResult>
  suggestTokens(body: string, guestName?: string | null): Promise<SuggestTokensResult>
  applySuggestion(commentId: string): Promise<ApplySuggestionResult>

  /** Handles `Escape`: exits Inspect, closes selection, or closes Tokens panel as appropriate. */
  escape(): boolean
  destroy(): void
}

const CAPABILITY_REFRESH_BUFFER_MS = 60_000
const FRAME_LOAD_FALLBACK_MS = 5_000

interface PooledFrame {
  screenId: string
  el: HTMLIFrameElement
  status: 'loading' | 'ready' | 'error'
  errorMessage: string | null
  loadTimer: ReturnType<typeof setTimeout> | null
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
  let loadSeq = 0
  let design: ViewerDesign | null = null
  let capabilityUrl: string | null = null
  let capabilityExpiresAt = 0
  let stagePath: string | null = null
  let stageReady = false
  let pendingRevealComponent: string | null = null

  let view: DesignView = 'page'
  let inspecting = false
  let tokensOpen = false
  let rawHovered: InspectHover | null = null
  let rawInspected: InspectTarget | null = null
  let inspectedRect: SelectionRect | null = null
  let activeTheme: string | null = null

  const drafts = new Map<string, TokenChange>()
  let previewingCommentId: string | null = null
  let suggestionPreviewChanges: TokenChange[] = []

  let visibleScreenIds: string[] = []
  let focusedScreenId: string | null = null
  const lruScreenIds: string[] = []
  const pooledFrames = new Map<string, PooledFrame>()
  const screenStates = new Map<string, ScreenFrameState>()
  const pendingScreenLoads: string[] = []

  const inventoryByScreen = new Map<string, Record<string, number>>()
  const measuringScreenIds = new Set<string>()
  const inventoryQueue: string[] = []
  let inventoryReqSeq = 0

  let parkingHost: HTMLElement | null = null

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

  function activePreviewTokens(): TokenChange[] {
    if (previewingCommentId !== null) return suggestionPreviewChanges
    return [...drafts.values()]
  }

  function broadcastTokenPreview(): void {
    const tokens = activePreviewTokens()
    const msg: ShellMessage = tokens.length ? { type: 'token-preview', tokens } : { type: 'token-preview-clear' }
    postToFrame(stageFrame, msg)
    for (const entry of pooledFrames.values()) {
      if (entry.status === 'ready') postToFrame(entry.el, msg)
    }
  }

  function clearFrameTimer(entry: PooledFrame): void {
    if (entry.loadTimer !== null) {
      clearTimeout(entry.loadTimer)
      entry.loadTimer = null
    }
  }

  function evictScreenFrame(screenId: string): void {
    const entry = pooledFrames.get(screenId)
    if (!entry) return
    clearFrameTimer(entry)
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
      ensureParkingHost()?.appendChild(iframe)

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

    // Remove queued loads that are no longer desired.
    for (let i = pendingScreenLoads.length - 1; i >= 0; i--) {
      if (!desired.has(pendingScreenLoads[i]!)) pendingScreenLoads.splice(i, 1)
    }

    // Queue desired frames that aren't pooled or queued yet.
    for (const id of desired) {
      if (!pooledFrames.has(id) && !pendingScreenLoads.includes(id)) {
        pendingScreenLoads.push(id)
      }
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

  function resetVersionState(nextVersion: number): void {
    version = nextVersion
    design = null
    rawHovered = null
    rawInspected = null
    inspectedRect = null
    activeTheme = null
    drafts.clear()
    previewingCommentId = null
    suggestionPreviewChanges = []
    inventoryByScreen.clear()
    measuringScreenIds.clear()
    inventoryQueue.length = 0
    screenStates.clear()
    evictAllScreenFrames()
  }

  function decoratedInspected(): InspectTarget | null {
    if (!rawInspected) return null
    const mergedTokens = mergeInspectedTokens(
      rawInspected.tokens,
      rawInspected.component,
      design,
      activePreviewTokens(),
      activeTheme
    )
    return { ...rawInspected, tokens: mergedTokens }
  }

  const controller: DesignController = {
    snapshot(): DesignSnapshot {
      return {
        version,
        loading,
        design,
        view,
        stagePath,
        inspecting,
        tokensOpen,
        hovered: rawHovered,
        inspected: decoratedInspected(),
        inspectedRect,
        activeTheme,
        draftChanges: [...drafts.values()],
        previewingCommentId,
        focusedScreenId,
        screensState: new Map(screenStates),
        componentUsage(component: string): ScreenUsage[] {
          if (!design) return []
          return design.screens.map((screen) => {
            const counts = inventoryByScreen.get(screen.id)
            if (counts !== undefined) {
              return {
                screenId: screen.id,
                screenName: screen.name,
                count: Object.hasOwn(counts, component) ? counts[component]! : 0,
                measuring: false,
              }
            }
            return {
              screenId: screen.id,
              screenName: screen.name,
              count: null,
              measuring: measuringScreenIds.has(screen.id),
            }
          })
        },
      }
    },

    async setVersion(nextVersion: number, frameUrl?: string, expiresAt?: number): Promise<void> {
      const seq = ++loadSeq
      if (nextVersion !== version) resetVersionState(nextVersion)
      else {
        inventoryByScreen.clear()
        measuringScreenIds.clear()
        inventoryQueue.length = 0
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
          options.onChange()
          return
        }
        const payload = (await res.json()) as Partial<DesignResponse>
        if (seq !== loadSeq || destroyed) return
        design = payload.design ?? null
        screenStates.clear()
        if (design) {
          for (const screen of design.screens) {
            screenStates.set(screen.id, { screenId: screen.id, status: 'idle', errorMessage: null })
          }
          if (activeTheme !== null && !design.themes.includes(activeTheme)) activeTheme = null
        } else {
          view = 'page'
          inspecting = false
          tokensOpen = false
        }
        loading = false
        reconcilePool()
        options.onChange()
      } catch {
        if (seq !== loadSeq || destroyed) return
        design = null
        loading = false
        options.onChange()
      }
    },

    routeMessage(source: MessageEventSource | null, message: BridgeMessage): 'stage' | 'screen' | null {
      if (!source) return null
      if (stageFrame.contentWindow && source === stageFrame.contentWindow) {
        if (message.type === 'ready') {
          stageReady = true
          sendInspectModeToStage()
          const active = activePreviewTokens()
          if (active.length) postToFrame(stageFrame, { type: 'token-preview', tokens: active })
          if (pendingRevealComponent) {
            const comp = pendingRevealComponent
            pendingRevealComponent = null
            postToFrame(stageFrame, { type: 'reveal-component', component: comp })
          }
        } else if (message.type === 'inspect-hover') {
          rawHovered = inspecting ? message.target : null
          options.onChange()
        } else if (message.type === 'inspect-pick') {
          rawInspected = message.target
          inspectedRect = message.target?.rect ?? null
          options.onChange()
        } else if (message.type === 'layout' && message.inspectRect !== undefined) {
          inspectedRect = message.inspectRect
          if (message.inspectRect === null) rawInspected = null
          options.onChange()
        } else if (message.type === 'inventory' && design && stagePath) {
          const matching = design.screens.find((s) => s.path === stagePath)
          if (matching) {
            inventoryByScreen.set(matching.id, message.instances)
            measuringScreenIds.delete(matching.id)
            reconcilePool()
            options.onChange()
          }
        }
        return 'stage'
      }

      for (const [screenId, entry] of pooledFrames) {
        if (entry.el.isConnected && entry.el.contentWindow === source) {
          if (message.type === 'ready') {
            clearFrameTimer(entry)
            entry.status = 'ready'
            entry.errorMessage = null
            screenStates.set(screenId, { screenId, status: 'ready', errorMessage: null })
            touchLru(screenId)
            const active = activePreviewTokens()
            if (active.length) postToFrame(entry.el, { type: 'token-preview', tokens: active })
            if (!inventoryByScreen.has(screenId)) {
              sendInventoryRequest(entry.el)
            }
            void pumpScreenLoads()
            options.onChange()
          } else if (message.type === 'inventory') {
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

    setVisibleScreens(visibleIds: readonly string[], focusedId: string | null): void {
      visibleScreenIds = [...visibleIds]
      focusedScreenId = focusedId
      if (focusedId) touchLru(focusedId)
      reconcilePool()
      options.onChange()
    },

    screenFrame(screenId: string): HTMLIFrameElement | null {
      return pooledFrames.get(screenId)?.el ?? null
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
      stagePath = screen.path
      stageReady = false
      rawHovered = null
      rawInspected = null
      inspectedRect = null
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
      }
      sendInspectModeToStage()
      reconcilePool()
      options.onChange()
    },

    clearSelection(): void {
      if (!rawInspected && !inspectedRect) return
      rawInspected = null
      inspectedRect = null
      postToFrame(stageFrame, { type: 'inspect-clear' })
      options.onChange()
    },

    async openMainComponent(component: string): Promise<boolean> {
      if (!design?.componentsPath || !isValidComponentName(component)) return false
      const cap = await ensureCapabilityUrl()
      if (!cap || destroyed) return false
      const url = screenFrameUrl(cap, design.componentsPath)
      if (!url) return false
      if (view === 'screens') view = 'page'
      if (!inspecting) {
        options.onDisableCommenting()
        inspecting = true
      }
      controller.requestInventory()
      if (stagePath === design.componentsPath && stageReady) {
        postToFrame(stageFrame, { type: 'reveal-component', component })
      } else {
        pendingRevealComponent = component
        stagePath = design.componentsPath
        stageReady = false
        stageFrame.src = url
      }
      reconcilePool()
      options.onChange()
      return true
    },

    requestInventory(): void {
      if (!design || preview) return
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
      if (open && !design) return
      tokensOpen = open
      options.onChange()
    },

    setActiveTheme(theme: string | null): void {
      if (theme !== null && !design?.themes.includes(theme)) return
      if (theme === activeTheme) return
      activeTheme = theme
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
      const trimmed = value.trim()
      if (trimmed === baseValue) drafts.delete(key)
      else drafts.set(key, { name, value: trimmed, ...(normalizedTheme ? { theme: normalizedTheme } : {}) })
      broadcastTokenPreview()
      options.onChange()
      return true
    },

    resetToken(name: string, theme: string | null = activeTheme): void {
      const key = tokenDraftKey(name, theme ?? null)
      if (!drafts.delete(key)) return
      broadcastTokenPreview()
      options.onChange()
    },

    discardTokens(): void {
      if (drafts.size === 0 && previewingCommentId === null) return
      drafts.clear()
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
          return { ok: false, error, ...(currentVersion !== undefined ? { currentVersion } : {}) }
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
      if (rawInspected) {
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
        controller.setView('page')
        return true
      }
      return false
    },

    destroy(): void {
      destroyed = true
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
    capabilityUrl = null
    capabilityExpiresAt = 0
    drafts.clear()
    previewingCommentId = null
    suggestionPreviewChanges = []
    inventoryByScreen.clear()
    measuringScreenIds.clear()
    inventoryQueue.length = 0
    evictAllScreenFrames()
    screenStates.clear()
    for (const screen of nextDesign.screens) {
      screenStates.set(screen.id, { screenId: screen.id, status: 'idle', errorMessage: null })
    }
    broadcastTokenPreview()
    options.onVersionCreated(nextVer, nextDesign)
    options.onChange()
  }

  return controller
}
