// Temporary Phase A stub of the Core <-> UI contract from Section 8 of
// docs/superpowers/specs/2026-11-20-design-mode-v2-design.md (commit d5bd7a1e).
// Deleted in Phase B once `shell/contract.ts`, `shell/design-model.ts`, and `shell/design.ts` are merged.
import type { ArtifactApi } from './api.js'
import type { BridgeMessage, PublicComment, SelectionRect, ViewerState, ViewerVersion } from './contract.js'

// --- contract.ts additions ---

export const MAX_DESIGN_TOKENS = 200
export const MAX_DESIGN_SCREENS = 50
export const MAX_DESIGN_COMPONENTS = 200
export const MAX_TOKEN_VALUE_CHARS = 200
export const MAX_INSPECT_TOKENS = 64
export const MAX_INSPECT_PROPS = 32

export type TokenGroup = 'color' | 'font' | 'text' | 'space' | 'radius' | 'shadow' | 'duration' | 'ease' | 'other'

export type TokenValueKind = 'color' | 'length' | 'number' | 'text'

export type ScreenViewportPreset = 'desktop' | 'tablet' | 'mobile'
export type ScreenViewport = ScreenViewportPreset | { width: number; height: number }

export interface DesignScreen {
  id: string
  name: string
  path: string
  viewport: ScreenViewport
}

export interface DesignToken {
  name: string
  group: TokenGroup
  kind: TokenValueKind
  /** Base `:root` value. */
  value: string
  /** Optional theme selector -> override value (for example `'[data-theme="dark"]': '#0f172a'`). */
  themes: Record<string, string>
}

export interface ViewerDesign {
  title: string | null
  tokenFile: string
  allTokenFiles: string[]
  componentsPath: string | null
  screens: DesignScreen[]
  componentTokens: Record<string, string[]>
  tokens: DesignToken[]
  /** Ordered list of distinct theme selectors found in `tokenFile`. */
  themes: string[]
}

export interface TokenChange {
  name: string
  value: string
  /** Null or omitted for `:root`; a validated theme selector for a theme override. */
  theme?: string | null
}

export interface TokenSuggestionChange {
  name: string
  from: string
  to: string
  theme?: string
}

export interface TokenSuggestion {
  file: string
  changes: TokenSuggestionChange[]
  appliedVersion: number | null
}

/** Temporary Phase A intersection until `PublicComment` in `contract.ts` gains `suggestion`. */
export type CommentWithSuggestion = PublicComment & { suggestion?: TokenSuggestion | null }

export interface ComputedStyleSubset {
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  color: string
  backgroundColor: string
  borderRadius: string
  padding: string
}

export interface UsedToken {
  name: string
  value: string
}

export interface InspectHover {
  selector: string
  rect: SelectionRect
  tag: string
  component: string | null
  main: boolean
}

export interface InspectTarget extends InspectHover {
  props: Record<string, string>
  styles: ComputedStyleSubset
  tokens: UsedToken[]
}

const TOKEN_NAME_RE = /^--[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/
const BAD_TOKEN_VALUE_RE = /[;{}<\\\r\n]|\/\*|\*\/|!important|\b(?:url|image-set|-webkit-image-set|src)\s*\(/i
const THEME_ATTR_RE = /^(?::root|html)?\[data-theme=(['"])([a-z0-9-]{1,32})\1\]$/
const THEME_CLASS_RE = /^(?::root|html)?\.theme-([a-z0-9-]{1,32})$/
const THEME_MEDIA_RE = /^@media\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/

export function isValidTokenName(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_NAME_RE.test(value)
}

export function isValidTokenValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_TOKEN_VALUE_CHARS &&
    !BAD_TOKEN_VALUE_RE.test(value)
  )
}

export function isValidThemeSelector(value: unknown): value is string {
  return (
    typeof value === 'string' && (THEME_ATTR_RE.test(value) || THEME_CLASS_RE.test(value) || THEME_MEDIA_RE.test(value))
  )
}

// --- design-model.ts pure helpers ---

export const MAX_LIVE_SCREEN_FRAMES = 6
export const MAX_CONCURRENT_FRAME_LOADS = 2

const GROUP_PREFIXES: readonly [string, TokenGroup][] = [
  ['--color-', 'color'],
  ['--font-', 'font'],
  ['--text-', 'text'],
  ['--space-', 'space'],
  ['--radius-', 'radius'],
  ['--shadow-', 'shadow'],
  ['--duration-', 'duration'],
  ['--ease-', 'ease'],
]

export function groupOfToken(name: string): TokenGroup {
  for (const [prefix, group] of GROUP_PREFIXES) {
    if (name.startsWith(prefix)) return group
  }
  return 'other'
}

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNC_COLOR_RE = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i
const LENGTH_RE = /^-?\d*\.?\d+(?:px|rem|em|%|vw|vh|vmin|vmax|ch|ex|dvw|dvh|svw|svh|lvw|lvh|cqw|cqh|pt)$/i
const NUMBER_RE = /^-?\d*\.?\d+$/

export function classifyTokenValue(name: string, value: string): TokenValueKind {
  const trimmed = value.trim()
  if (HEX_COLOR_RE.test(trimmed) || FUNC_COLOR_RE.test(trimmed) || trimmed === 'transparent') return 'color'
  if (name.startsWith('--color-') && /^[a-z]+$/i.test(trimmed)) return 'color'
  if (LENGTH_RE.test(trimmed)) return 'length'
  if (NUMBER_RE.test(trimmed)) return 'number'
  return 'text'
}

export function groupTokens(tokens: readonly DesignToken[]): ReadonlyMap<TokenGroup, DesignToken[]> {
  const result = new Map<TokenGroup, DesignToken[]>()
  for (const token of tokens) {
    const bucket = result.get(token.group)
    if (bucket) bucket.push(token)
    else result.set(token.group, [token])
  }
  return result
}

const VIEWPORT_PRESETS: Record<ScreenViewportPreset, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
}

export function resolveScreenViewport(viewport: ScreenViewport): { width: number; height: number } {
  if (typeof viewport === 'string') return VIEWPORT_PRESETS[viewport]
  return { width: viewport.width, height: viewport.height }
}

export function canSaveTokens(state: ViewerState, version: number, design: ViewerDesign | null): boolean {
  return state.identity.kind === 'owner' && version === state.artifact.currentVersion && design !== null
}

export function canSuggestTokens(state: ViewerState, design: ViewerDesign | null): boolean {
  return state.identity.kind !== 'owner' && state.can.comment && design !== null
}

export function canApplySuggestion(state: ViewerState, design: ViewerDesign | null): boolean {
  return state.identity.kind === 'owner' && design !== null
}

// --- design.ts controller types ---

export type DesignView = 'page' | 'screens'

export interface ScreenUsage {
  screenId: string
  screenName: string
  count: number
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

// --- Sample data & fake controller for Phase A standalone rendering/testing ---

const DARK_THEME = "[data-theme='dark']"

function token(name: string, value: string, dark?: string): DesignToken {
  return {
    name,
    group: groupOfToken(name),
    kind: classifyTokenValue(name, value),
    value,
    themes: dark === undefined ? {} : { [DARK_THEME]: dark },
  }
}

/** Crumb orders sample design matching `prototypes/artifact-design-viewer/sample/`. */
export const SAMPLE_VIEWER_DESIGN: ViewerDesign = {
  title: 'Crumb orders',
  tokenFile: 'tokens.css',
  allTokenFiles: ['tokens.css'],
  componentsPath: 'components.html',
  screens: [
    { id: 'dashboard', name: 'Today', path: 'index.html#/dashboard', viewport: 'desktop' },
    { id: 'orders', name: 'Orders', path: 'index.html#/orders', viewport: 'desktop' },
    { id: 'order-detail', name: 'Order detail', path: 'index.html#/orders/1042', viewport: 'desktop' },
    { id: 'orders-empty', name: 'Orders · empty', path: 'index.html#/orders?state=empty', viewport: 'desktop' },
    { id: 'order-mobile', name: 'Order · mobile', path: 'index.html#/m/orders/1042', viewport: 'mobile' },
    { id: 'sync-error', name: 'Orders · offline', path: 'index.html#/m/orders?state=error', viewport: 'mobile' },
  ],
  componentTokens: {
    Button: ['--color-accent', '--color-on-accent', '--radius-md', '--text-sm', '--space-4'],
    Badge: ['--radius-full', '--text-xs', '--space-2'],
  },
  themes: [DARK_THEME],
  tokens: [
    token('--color-bg', '#f6f2ec', '#171411'),
    token('--color-surface', '#ffffff', '#221e1a'),
    token('--color-surface-muted', '#f0ebe3', '#2b2621'),
    token('--color-border', '#e4ddd2', '#3a332c'),
    token('--color-text', '#1f1a15', '#f3ede5'),
    token('--color-text-muted', '#71685d', '#ada295'),
    token('--color-accent', '#b4532a', '#e07a4b'),
    token('--color-accent-hover', '#9c4521', '#ec8c5f'),
    token('--color-accent-soft', '#f7e6dc', '#3d2619'),
    token('--color-on-accent', '#ffffff', '#1a0f09'),
    token('--color-success', '#2e7a4d', '#6cc490'),
    token('--color-success-soft', '#e2f1e7', '#1d3324'),
    token('--color-warning', '#9a640f', '#e3aa4b'),
    token('--color-warning-soft', '#f8edd6', '#3a2d14'),
    token('--color-danger', '#b3261e', '#f08a80'),
    token('--color-danger-soft', '#fbe5e2', '#3d1d1a'),
    token('--font-sans', "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"),
    token('--font-mono', "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"),
    token('--font-weight-medium', '500'),
    token('--font-weight-bold', '650'),
    token('--text-xs', '12px'),
    token('--text-sm', '13px'),
    token('--text-md', '15px'),
    token('--text-lg', '18px'),
    token('--text-xl', '24px'),
    token('--text-2xl', '30px'),
    token('--text-leading-tight', '1.2'),
    token('--text-leading-normal', '1.5'),
    token('--space-1', '4px'),
    token('--space-2', '8px'),
    token('--space-3', '12px'),
    token('--space-4', '16px'),
    token('--space-5', '24px'),
    token('--space-6', '32px'),
    token('--space-7', '48px'),
    token('--radius-sm', '6px'),
    token('--radius-md', '10px'),
    token('--radius-lg', '16px'),
    token('--radius-full', '999px'),
    token('--shadow-sm', '0 1px 2px rgba(31, 26, 21, 0.06)', '0 1px 2px rgba(0, 0, 0, 0.4)'),
    token('--shadow-md', '0 10px 30px rgba(31, 26, 21, 0.1)', '0 10px 30px rgba(0, 0, 0, 0.45)'),
    token('--duration-fast', '120ms'),
    token('--duration-base', '200ms'),
    token('--ease-standard', 'cubic-bezier(0.2, 0, 0, 1)'),
    token('--layout-sidebar', '232px'),
    token('--layout-content', '1120px'),
  ],
}

export interface StubDesignControllerOptions {
  version?: number
  design?: ViewerDesign | null
  onChange?: () => void
  onDisableCommenting?: () => void
}

/** In-memory stub controller for Phase A UI rendering and tests. */
export function createStubDesignController(options: StubDesignControllerOptions = {}): DesignController {
  let version = options.version ?? 3
  let design: ViewerDesign | null = options.design === undefined ? SAMPLE_VIEWER_DESIGN : options.design
  let view: DesignView = 'page'
  let stagePath: string | null = design?.screens[0]?.path ?? null
  let inspecting = false
  let tokensOpen = false
  let hovered: InspectHover | null = null
  let inspected: InspectTarget | null = null
  let inspectedRect: SelectionRect | null = null
  let activeTheme: string | null = null
  let previewingCommentId: string | null = null
  let focusedScreenId: string | null = null
  const drafts = new Map<string, TokenChange>()
  const screensState = new Map<string, ScreenFrameState>()
  const frames = new Map<string, HTMLIFrameElement>()
  const notify = () => options.onChange?.()

  const draftKey = (name: string, theme?: string | null) => `${theme ?? ''}\n${name}`

  const controller: DesignController = {
    snapshot() {
      return {
        version,
        loading: false,
        design,
        view,
        stagePath,
        inspecting,
        tokensOpen,
        hovered,
        inspected,
        inspectedRect,
        activeTheme,
        draftChanges: [...drafts.values()],
        previewingCommentId,
        focusedScreenId,
        screensState: new Map(screensState),
        componentUsage: () =>
          (design?.screens ?? []).map((screen) => ({ screenId: screen.id, screenName: screen.name, count: 0 })),
      }
    },

    async setVersion(next) {
      version = next
      notify()
    },

    routeMessage() {
      return null
    },

    setView(next) {
      if (next === 'screens' && !design) return
      view = next
      if (next === 'screens') {
        inspecting = false
        hovered = null
      }
      notify()
    },

    setVisibleScreens(visibleIds, focusedId) {
      focusedScreenId = focusedId
      const allowed = new Set(visibleIds.slice(0, MAX_LIVE_SCREEN_FRAMES))
      for (const screen of design?.screens ?? []) {
        screensState.set(screen.id, {
          screenId: screen.id,
          status: allowed.has(screen.id) ? 'ready' : 'idle',
          errorMessage: null,
        })
      }
      notify()
    },

    screenFrame(screenId) {
      return frames.get(screenId) ?? null
    },

    focusScreen(screenId) {
      focusedScreenId = screenId
      notify()
    },

    async openScreen(screenId) {
      const screen = design?.screens.find((item) => item.id === screenId)
      if (!screen) return
      view = 'page'
      focusedScreenId = null
      stagePath = screen.path
      notify()
    },

    setInspecting(on) {
      if (on) options.onDisableCommenting?.()
      inspecting = on
      if (!on) hovered = null
      notify()
    },

    clearSelection() {
      inspected = null
      inspectedRect = null
      notify()
    },

    async openMainComponent() {
      if (!design?.componentsPath) return false
      stagePath = design.componentsPath
      notify()
      return true
    },

    requestInventory() {
      notify()
    },

    setTokensOpen(open) {
      if (open && !design) return
      tokensOpen = open
      notify()
    },

    setActiveTheme(theme) {
      activeTheme = theme
      notify()
    },

    setTokenValue(name, value, theme = null) {
      if (!isValidTokenName(name) || !isValidTokenValue(value)) return false
      if (theme !== null && theme !== undefined && !isValidThemeSelector(theme)) return false
      const key = draftKey(name, theme)
      const base = design?.tokens.find((item) => item.name === name)
      const original = theme ? base?.themes[theme] : base?.value
      if (original !== undefined && value.trim() === original) drafts.delete(key)
      else drafts.set(key, { name, value: value.trim(), theme: theme ?? null })
      notify()
      return true
    },

    resetToken(name, theme = null) {
      drafts.delete(draftKey(name, theme))
      notify()
    },

    discardTokens() {
      drafts.clear()
      notify()
    },

    previewSuggestion(commentId) {
      previewingCommentId = commentId
      notify()
    },

    async saveTokens() {
      if (!design || drafts.size === 0) return { ok: false, error: 'no_changes' }
      const nextDesign: ViewerDesign = {
        ...design,
        tokens: design.tokens.map((item) => {
          const rootEdit = drafts.get(draftKey(item.name, null))
          const nextThemes = { ...item.themes }
          for (const theme of design?.themes ?? []) {
            const themeEdit = drafts.get(draftKey(item.name, theme))
            if (themeEdit) nextThemes[theme] = themeEdit.value
          }
          return { ...item, value: rootEdit ? rootEdit.value : item.value, themes: nextThemes }
        }),
      }
      design = nextDesign
      version += 1
      drafts.clear()
      notify()
      return {
        ok: true,
        version: { number: version, createdAt: Date.now(), summary: 'Tokens updated' },
        design: nextDesign,
      }
    },

    async suggestTokens(body) {
      if (!design || drafts.size === 0) return { ok: false, error: 'no_changes' }
      const changes: TokenSuggestionChange[] = [...drafts.values()].map((entry) => {
        const base = design?.tokens.find((item) => item.name === entry.name)
        const from = (entry.theme ? base?.themes[entry.theme] : base?.value) ?? ''
        return { name: entry.name, from, to: entry.value, ...(entry.theme ? { theme: entry.theme } : {}) }
      })
      drafts.clear()
      notify()
      const comment: CommentWithSuggestion = {
        id: `stub-${Date.now()}`,
        version,
        parentId: null,
        author: { kind: 'invited', name: 'Guest', verified: true, self: true },
        body,
        anchor: null,
        status: 'open',
        createdAt: Date.now(),
        canDelete: true,
        suggestion: { file: design.tokenFile, changes, appliedVersion: null },
      }
      return { ok: true, comment }
    },

    async applySuggestion() {
      return { ok: false, error: 'failed' }
    },

    escape() {
      if (inspected) {
        inspected = null
        inspectedRect = null
        notify()
        return true
      }
      if (inspecting) {
        inspecting = false
        hovered = null
        notify()
        return true
      }
      if (tokensOpen) {
        tokensOpen = false
        notify()
        return true
      }
      if (view === 'screens' && focusedScreenId) {
        focusedScreenId = null
        notify()
        return true
      }
      return false
    },

    destroy() {
      frames.clear()
      screensState.clear()
    },
  }

  return controller
}
