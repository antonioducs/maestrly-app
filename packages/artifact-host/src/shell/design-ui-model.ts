// Pure UI model functions for Inspect, Screens, Tokens, and token suggestions: no DOM dependencies, directly testable.
import type { SelectionRect } from './contract.js'
import {
  classifyTokenValue,
  type DesignScreen,
  type InspectHover,
  type InspectTarget,
  resolveScreenViewport,
  type ScreenViewport,
  type TokenChange,
  type TokenGroup,
  type TokenSuggestionChange,
  type TokenValueKind,
  type ViewerDesign,
} from './design-ui-stub.js'
import type { ShellKey, Translate } from './i18n.js'

// --- Screens layout & camera math ---

export const SCREENS_GAP_X = 160
export const SCREENS_GAP_Y = 240
/** Candidate row widths; whichever maximizes the fit zoom wins so narrow viewports get fewer screens per row. */
export const SCREENS_ROW_WIDTHS = [4800, 3200, 1600] as const
/** Minimum screen-pixel gap kept between rows for counter-scaled screen labels. */
export const SCREENS_LABEL_ROOM = 32
export const SCREENS_MIN_ZOOM = 0.04
export const SCREENS_MAX_ZOOM = 2

export interface SizeBox {
  width: number
  height: number
}

export interface ScreenCamera {
  x: number
  y: number
  z: number
}

export interface PlacedScreen {
  screen: DesignScreen
  x: number
  y: number
  width: number
  height: number
  row: number
}

export interface ScreensLayout {
  placed: PlacedScreen[]
  width: number
  height: number
  rowMax: number
  zoom: number
}

export function screensPadding(box: SizeBox): { x: number; top: number; bottom: number } {
  return box.width <= 720 ? { x: 16, top: 76, bottom: 68 } : { x: 56, top: 76, bottom: 76 }
}

/** Places screens in left-to-right rows wrapping at `rowMax`. */
export function wrapScreens(
  screens: readonly DesignScreen[],
  rowMax: number,
  gapY: number
): { placed: PlacedScreen[]; width: number; height: number } {
  const placed: PlacedScreen[] = []
  let x = 0
  let y = 0
  let rowHeight = 0
  let row = 0
  for (const screen of screens) {
    const { width, height } = resolveScreenViewport(screen.viewport)
    if (x > 0 && x + width > rowMax) {
      x = 0
      y += rowHeight + gapY
      rowHeight = 0
      row += 1
    }
    placed.push({ screen, x, y, width, height, row })
    x += width + SCREENS_GAP_X
    rowHeight = Math.max(rowHeight, height)
  }
  if (!placed.length) return { placed, width: 0, height: 0 }
  return {
    placed,
    width: Math.max(...placed.map((item) => item.x + item.width)),
    height: Math.max(...placed.map((item) => item.y + item.height)),
  }
}

/** Chooses the row wrapping and vertical gap that shows every screen largest while keeping room for labels. */
export function arrangeScreens(screens: readonly DesignScreen[], box: SizeBox): ScreensLayout {
  if (!screens.length) return { placed: [], width: 0, height: 0, rowMax: SCREENS_ROW_WIDTHS[0], zoom: 1 }
  const pad = screensPadding(box)
  const availW = Math.max(1, box.width - pad.x * 2)
  const availH = Math.max(1, box.height - pad.top - pad.bottom)
  const fit = (layout: { width: number; height: number }) =>
    Math.min(availW / Math.max(1, layout.width), availH / Math.max(1, layout.height), 1)
  let best: ScreensLayout | null = null
  for (const rowMax of SCREENS_ROW_WIDTHS) {
    let layout = wrapScreens(screens, rowMax, SCREENS_GAP_Y)
    for (let pass = 0; pass < 4 && SCREENS_GAP_Y * fit(layout) < SCREENS_LABEL_ROOM; pass++) {
      const z = Math.max(SCREENS_MIN_ZOOM, fit(layout))
      layout = wrapScreens(screens, rowMax, Math.max(SCREENS_GAP_Y, Math.ceil(SCREENS_LABEL_ROOM / z)))
    }
    const zoom = fit(layout)
    // A narrower wrap must win clearly so minor resizes do not flip layouts.
    if (!best || zoom > best.zoom * 1.05) best = { ...layout, rowMax, zoom }
  }
  return best!
}

export function fitAllCamera(bounds: SizeBox, box: SizeBox): ScreenCamera {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0, z: 1 }
  const pad = screensPadding(box)
  const z = Math.max(
    SCREENS_MIN_ZOOM,
    Math.min((box.width - pad.x * 2) / bounds.width, (box.height - pad.top - pad.bottom) / bounds.height, 1)
  )
  return {
    z,
    x: (box.width - bounds.width * z) / 2,
    y: pad.top + (box.height - pad.top - pad.bottom - bounds.height * z) / 2,
  }
}

export function fitScreenCamera(screen: PlacedScreen, box: SizeBox): ScreenCamera {
  const pad = screensPadding(box)
  const top = pad.top + 16
  const z = Math.max(
    SCREENS_MIN_ZOOM,
    Math.min((box.width - pad.x * 2) / screen.width, (box.height - top - pad.bottom) / screen.height, 1)
  )
  return {
    z,
    x: box.width / 2 - (screen.x + screen.width / 2) * z,
    y: top + (box.height - top - pad.bottom - screen.height * z) / 2 - screen.y * z,
  }
}

export function zoomAtCamera(cam: ScreenCamera, px: number, py: number, factor: number): ScreenCamera {
  const z = Math.min(SCREENS_MAX_ZOOM, Math.max(SCREENS_MIN_ZOOM, cam.z * factor))
  return {
    z,
    x: px - (px - cam.x) * (z / cam.z),
    y: py - (py - cam.y) * (z / cam.z),
  }
}

/** Screens intersecting the viewport plus a 25% margin, ordered nearest to the stage center first. */
export function rankVisibleScreens(placed: readonly PlacedScreen[], cam: ScreenCamera, box: SizeBox): string[] {
  const marginX = box.width * 0.25
  const marginY = box.height * 0.25
  const viewLeft = -marginX
  const viewTop = -marginY
  const viewRight = box.width + marginX
  const viewBottom = box.height + marginY
  return placed
    .map((entry) => {
      const left = cam.x + entry.x * cam.z
      const top = cam.y + entry.y * cam.z
      const right = left + entry.width * cam.z
      const bottom = top + entry.height * cam.z
      const visible = right > viewLeft && left < viewRight && bottom > viewTop && top < viewBottom
      const distance = Math.hypot((left + right - box.width) / 2, (top + bottom - box.height) / 2)
      return { id: entry.screen.id, visible, distance }
    })
    .filter((item) => item.visible)
    .sort((a, b) => a.distance - b.distance)
    .map((item) => item.id)
}

/**
 * Pre-approved label overflow policy: when a screen label does not fit the scaled screen width, hide the
 * dimension suffix (`390 × 844`) completely before truncating the screen name with an ellipsis.
 */
export function shouldHideScreenSize(availablePx: number, namePx: number, sizePx: number, gapPx = 8): boolean {
  return availablePx < namePx + gapPx + sizePx
}

/** Maps a screen's viewport preset or custom dimensions to the viewer's device icon / width preset. */
export function viewportKindOf(viewport: ScreenViewport): 'desktop' | 'tablet' | 'phone' {
  if (viewport === 'mobile') return 'phone'
  if (viewport === 'tablet' || viewport === 'desktop') return viewport
  return viewport.width <= 500 ? 'phone' : viewport.width <= 1024 ? 'tablet' : 'desktop'
}

// --- Themes & Tokens helpers ---

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  'color',
  'font',
  'text',
  'space',
  'radius',
  'shadow',
  'duration',
  'ease',
  'other',
]

export const TOKEN_GROUP_KEY: Record<TokenGroup, ShellKey> = {
  color: 'groupColor',
  font: 'groupFont',
  text: 'groupText',
  space: 'groupSpace',
  radius: 'groupRadius',
  shadow: 'groupShadow',
  duration: 'groupDuration',
  ease: 'groupEase',
  other: 'groupOther',
}

export interface ThemeMeta {
  selector: string | null
  name: string
  system: boolean
}

const THEME_ATTR_RE = /^(?::root|html)?\[data-theme=(['"])([a-z0-9-]{1,32})\1\]$/
const THEME_CLASS_RE = /^(?::root|html)?\.theme-([a-z0-9-]{1,32})$/
const THEME_MEDIA_RE = /^@media\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/

const capitalize = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '')

export function parseThemeSelector(selector: string | null | undefined): ThemeMeta {
  if (!selector) return { selector: null, name: '', system: false }
  const attr = THEME_ATTR_RE.exec(selector)
  if (attr) return { selector, name: attr[2], system: false }
  const cls = THEME_CLASS_RE.exec(selector)
  if (cls) return { selector, name: cls[1], system: false }
  const media = THEME_MEDIA_RE.exec(selector)
  if (media) return { selector, name: media[1], system: true }
  return { selector, name: selector, system: false }
}

export function themeDisplayName(t: Translate, selector: string | null | undefined): string {
  const meta = parseThemeSelector(selector)
  if (!meta.selector) return t('themeDefault')
  const label = capitalize(meta.name)
  return meta.system ? t('themeSystem', { name: label }) : label
}

/** Canonical draft map key matching Section 8 (`${theme ?? ''}\n${name}`). */
export function tokenKey(name: string, theme?: string | null): string {
  return `${theme ?? ''}\n${name}`
}

/** Label used in change lists, dialogs, and summaries (`--color-accent` or `--color-accent (Dark)`). */
export function formatChangeName(t: Translate, name: string, theme?: string | null): string {
  return theme ? `${name} (${themeDisplayName(t, theme)})` : name
}

export function tokenBaseValue(design: ViewerDesign | null, name: string, theme?: string | null): string {
  const found = design?.tokens.find((item) => item.name === name)
  if (!found) return ''
  return theme ? (found.themes[theme] ?? '') : found.value
}

export interface ThemeTokenEntry {
  key: string
  name: string
  theme: string | null
  group: TokenGroup
  kind: TokenValueKind
  baseValue: string
}

/** Lists tokens declared in the given theme (`null` = `:root`), preserving declaration order. */
export function tokensForTheme(design: ViewerDesign, theme: string | null): ThemeTokenEntry[] {
  const list: ThemeTokenEntry[] = []
  for (const item of design.tokens) {
    if (theme === null) {
      list.push({
        key: tokenKey(item.name, null),
        name: item.name,
        theme: null,
        group: item.group,
        kind: item.kind,
        baseValue: item.value,
      })
    } else if (Object.hasOwn(item.themes, theme)) {
      const value = item.themes[theme]
      list.push({
        key: tokenKey(item.name, theme),
        name: item.name,
        theme,
        group: item.group,
        kind: classifyTokenValue(item.name, value),
        baseValue: value,
      })
    }
  }
  return list
}

export function inheritedTokenCount(design: ViewerDesign, theme: string | null): number {
  if (!theme) return 0
  let declared = 0
  for (const item of design.tokens) {
    if (Object.hasOwn(item.themes, theme)) declared += 1
  }
  return Math.max(0, design.tokens.length - declared)
}

export interface DescribedTokenChange {
  key: string
  name: string
  theme: string | null
  from: string
  to: string
  kind: TokenValueKind
}

export interface DescribedSuggestionChange extends DescribedTokenChange {
  now: string
  stale: boolean
}

/** Normalizes `#rgb` / `#rrggbb` / `rgb(r, g, b)` to uppercase `#RRGGBB`, or returns `null` when not opaque/simple. */
export function normalizeColorHex(value: string): string | null {
  const trimmed = value.trim()
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed)
  if (short) {
    const [r, g, b] = short[1]
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase()
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toUpperCase()
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(trimmed)
  if (rgb) {
    const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    if (channels.every((c) => c >= 0 && c <= 255)) {
      return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
    }
  }
  return null
}

/** Compares two token values, treating equivalent hex/rgb colors as identical. */
export function tokenValuesEqual(kind: TokenValueKind, a: string, b: string): boolean {
  const left = a.trim()
  const right = b.trim()
  if (kind === 'color') {
    const hexA = normalizeColorHex(left)
    const hexB = normalizeColorHex(right)
    if (hexA && hexB) return hexA === hexB
  }
  return left === right
}

export function formatDisplayTokenValue(value: string, kind: TokenValueKind): string {
  if (kind !== 'color') return value
  return normalizeColorHex(value) ?? value
}

export function describeDraftChanges(
  design: ViewerDesign | null,
  drafts: readonly TokenChange[]
): DescribedTokenChange[] {
  return drafts.map((draft) => {
    const theme = draft.theme ?? null
    const found = design?.tokens.find((item) => item.name === draft.name)
    const from = found ? (theme ? (found.themes[theme] ?? '') : found.value) : ''
    const kind = found?.kind ?? classifyTokenValue(draft.name, draft.value)
    return {
      key: tokenKey(draft.name, theme),
      name: draft.name,
      theme,
      from,
      to: draft.value,
      kind,
    }
  })
}

export function describeSuggestionChanges(
  design: ViewerDesign | null,
  changes: readonly TokenSuggestionChange[]
): DescribedSuggestionChange[] {
  return changes.map((change) => {
    const theme = change.theme ?? null
    const found = design?.tokens.find((item) => item.name === change.name)
    const now = found ? (theme ? (found.themes[theme] ?? '') : found.value) : change.from
    const kind = found?.kind ?? classifyTokenValue(change.name, change.to)
    return {
      key: tokenKey(change.name, theme),
      name: change.name,
      theme,
      from: change.from,
      to: change.to,
      kind,
      now,
      stale: Boolean(now) && !tokenValuesEqual(kind, now, change.from),
    }
  })
}

/** Steps numeric/length token values on ArrowUp/ArrowDown (Shift for 10x, 50 for unitless numbers >= 100). */
export function stepNumericToken(value: string, direction: 1 | -1, shift: boolean): string | null {
  const match = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(value.trim())
  if (!match) return null
  const num = Number(match[1])
  if (!Number.isFinite(num)) return null
  const decimals = (match[1].split('.')[1] ?? '').length
  const unit = decimals ? 10 ** -decimals : num >= 100 && !match[2] ? 50 : 1
  const step = unit * (shift ? 10 : 1) * direction
  return `${(num + step).toFixed(decimals)}${match[2]}`
}

export function formatTokenSummary(
  t: Translate,
  changes: readonly Pick<DescribedTokenChange, 'name' | 'theme'>[],
  authorName?: string
): string {
  const names = changes.map((change) => formatChangeName(t, change.name, change.theme)).join(', ')
  return authorName ? t('summaryApplied', { author: authorName, names }) : t('summaryTokens', { names })
}

export function formatAutoSuggestionBody(t: Translate, changes: readonly DescribedTokenChange[]): string {
  const names = changes
    .map(
      (change) =>
        `${formatChangeName(t, change.name, change.theme)} ${formatDisplayTokenValue(change.from, change.kind)} → ${formatDisplayTokenValue(change.to, change.kind)}`
    )
    .join(', ')
  return t('summaryTokens', { names })
}

/** Splits summary prose into plain segments and non-wrapping `--token-name` segments. */
export function splitTokenSummaryParts(text: string): { text: string; nowrap: boolean }[] {
  return text
    .split(/(--[a-zA-Z0-9_-]+)/)
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, nowrap: part.startsWith('--') }))
}

// --- Inspect helpers ---

/** Formats a non-component element label like `h2.section-title`, `div#app`, or `button`. */
export function formatElementLabel(hover: Pick<InspectHover, 'tag' | 'selector'>): string {
  const tag = hover.tag.toLowerCase()
  const tail = hover.selector.split(/\s*>\s*|\s+/).pop() ?? ''
  if (tail.toLowerCase().startsWith(tag)) {
    // Drop `:nth-of-type(...)` / pseudo parts so the label stays readable like `h2.section-title`.
    const clean = tail.replace(/:[a-z-]+(?:\([^)]*\))?/gi, '')
    if (clean.length > 0) return clean
  }
  return tag
}

/** Places `.inspect-tag` 24 px above the box, below when there is no room, inside as last resort, clamped to frame. */
export function clampInspectTag(at: SelectionRect, tagWidth: number, bounds: SizeBox): { x: number; y: number } {
  const x = Math.min(Math.max(at.x, 4), Math.max(4, bounds.width - tagWidth - 4))
  let y = at.y - 24
  if (y < 4) y = at.y + at.height + 4
  if (y > bounds.height - 24) y = Math.max(4, at.y + 4)
  return { x, y }
}

export interface InspectStyleRow {
  label: string
  value: string
  swatch: boolean
}

export function formatInspectStyles(target: Pick<InspectTarget, 'styles' | 'rect'>, t: Translate): InspectStyleRow[] {
  const { styles, rect } = target
  const primaryFont =
    styles.fontFamily
      .split(',')[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, '') || styles.fontFamily
  return [
    { label: t('styleFont'), value: `${primaryFont} · ${styles.fontWeight}`, swatch: false },
    { label: t('styleSize'), value: `${styles.fontSize} / ${styles.lineHeight}`, swatch: false },
    { label: t('styleColor'), value: formatDisplayTokenValue(styles.color, 'color'), swatch: true },
    { label: t('styleBackground'), value: formatDisplayTokenValue(styles.backgroundColor, 'color'), swatch: true },
    { label: t('styleRadius'), value: styles.borderRadius, swatch: false },
    { label: t('stylePadding'), value: styles.padding, swatch: false },
    { label: t('styleBox'), value: `${Math.round(rect.width)} × ${Math.round(rect.height)}`, swatch: false },
  ]
}

export function formatUsageSummary(
  t: Translate,
  totalInstances: number,
  screensWithUses: number,
  doneScreens: number,
  totalScreens: number
): string {
  if (doneScreens < totalScreens) {
    return t('inspectUsesCounting', { n: totalInstances, done: doneScreens, total: totalScreens })
  }
  if (totalInstances === 0) return t('inspectUsesNone')
  if (totalInstances === 1) return t('inspectUsesOne')
  if (screensWithUses === 1) return t('inspectUsesOneScreen', { n: totalInstances })
  return t('inspectUsesMany', { n: totalInstances, screens: screensWithUses })
}
