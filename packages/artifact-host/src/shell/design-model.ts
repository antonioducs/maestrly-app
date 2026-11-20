// Pure design-viewer state helpers shared by the viewer shell and unit tests: no DOM and no Node APIs.
import {
  isValidThemeSelector,
  isValidTokenName,
  isValidTokenValue,
  type DesignScreen,
  type DesignToken,
  type ScreenViewport,
  type ScreenViewportPreset,
  type TokenChange,
  type TokenGroup,
  type TokenSuggestionChange,
  type TokenValueKind,
  type UsedToken,
  type ViewerDesign,
  type ViewerState,
} from './contract.js'

export const MAX_LIVE_SCREEN_FRAMES = 6
export const MAX_CONCURRENT_FRAME_LOADS = 2

export const VIEWPORT_PRESETS: Readonly<Record<ScreenViewportPreset, { width: number; height: number }>> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
}

const KNOWN_GROUPS = new Set<TokenGroup>(['color', 'font', 'text', 'space', 'radius', 'shadow', 'duration', 'ease'])

const EXPRESSION_PREFIX = /^(?:var|calc|clamp|min|max)\s*\(/i
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const COLOR_FN_PREFIX = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/i
const LENGTH_VALUE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|dvh|dvw|svh|svw|ch|ex|lh|rlh)$/i
const NUMBER_VALUE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/

const NAMED_COLORS = new Set([
  'transparent',
  'currentcolor',
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
])

/** True when `raw` is a single function call whose outer parentheses close at the very end of `raw`. */
function isSingleFunctionCall(raw: string): boolean {
  const open = raw.indexOf('(')
  if (open < 0 || !raw.endsWith(')')) return false
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < raw.length; i++) {
    const ch = raw[i]!
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i === raw.length - 1
      if (depth < 0) return false
    }
  }
  return false
}

export function groupOfToken(name: string): TokenGroup {
  if (!name.startsWith('--')) return 'other'
  const rest = name.slice(2)
  const sep = rest.search(/[-_]/)
  if (sep <= 0) return 'other'
  const prefix = rest.slice(0, sep).toLowerCase() as TokenGroup
  return KNOWN_GROUPS.has(prefix) ? prefix : 'other'
}

export function classifyTokenValue(name: string, value: string): TokenValueKind {
  const trimmed = value.trim()
  if (!trimmed || EXPRESSION_PREFIX.test(trimmed)) return 'text'
  const group = groupOfToken(name)
  if (HEX_COLOR.test(trimmed)) return 'color'
  if (COLOR_FN_PREFIX.test(trimmed) && isSingleFunctionCall(trimmed)) return 'color'
  if (group === 'color' && NAMED_COLORS.has(trimmed.toLowerCase())) return 'color'
  if (LENGTH_VALUE.test(trimmed)) return 'length'
  if ((trimmed === '0' || trimmed === '+0' || trimmed === '-0') && (group === 'space' || group === 'radius'))
    return 'length'
  if (NUMBER_VALUE.test(trimmed) && Number.isFinite(Number(trimmed))) return 'number'
  return 'text'
}

const GROUP_ORDER: readonly TokenGroup[] = [
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

export function groupTokens(tokens: readonly DesignToken[]): ReadonlyMap<TokenGroup, DesignToken[]> {
  const buckets = new Map<TokenGroup, DesignToken[]>()
  for (const group of GROUP_ORDER) buckets.set(group, [])
  for (const token of tokens) {
    const bucket = buckets.get(token.group) ?? buckets.get('other')!
    bucket.push(token)
  }
  for (const group of GROUP_ORDER) {
    if (buckets.get(group)?.length === 0) buckets.delete(group)
  }
  return buckets
}

export function resolveScreenViewport(viewport: ScreenViewport): { width: number; height: number } {
  if (typeof viewport === 'string') return { ...VIEWPORT_PRESETS[viewport] }
  return { width: viewport.width, height: viewport.height }
}

/**
 * Resolves a manifest relative path (with optional `?query` and `#fragment`) against a `/c/<capability>/...` frame URL
 * without leaving `/c/<capability>/`.
 */
export function screenFrameUrl(capabilityUrl: string, screenPath: string): string | null {
  const capMatch = /^\/c\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\//.exec(capabilityUrl)
  if (!capMatch || !screenPath || screenPath.length > 300) return null
  const capPrefix = `/c/${capMatch[1]}/`
  const hashIdx = screenPath.indexOf('#')
  const beforeHash = hashIdx >= 0 ? screenPath.slice(0, hashIdx) : screenPath
  const fragment = hashIdx >= 0 ? screenPath.slice(hashIdx) : ''
  const queryIdx = beforeHash.indexOf('?')
  const rawFile = queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash
  const query = queryIdx >= 0 ? beforeHash.slice(queryIdx) : ''
  if (!rawFile || rawFile.startsWith('/') || rawFile.includes('\\') || rawFile.includes('\0')) return null
  const segments = rawFile.split('/')
  const encoded: string[] = []
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return null
    let decoded: string
    try {
      decoded = decodeURIComponent(seg)
    } catch {
      return null
    }
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return null
    encoded.push(encodeURIComponent(decoded))
  }
  return `${capPrefix}${encoded.join('/')}${query}${fragment}`
}

export function tokenDraftKey(name: string, theme?: string | null): string {
  return `${theme ?? ''}\n${name}`
}

export function lookupDesignTokenValue(design: ViewerDesign | null, name: string, theme: string | null): string | null {
  if (!design) return null
  const token = design.tokens.find((item) => item.name === name)
  if (!token) return null
  if (theme === null) return token.value
  return Object.hasOwn(token.themes, theme) ? token.themes[theme]! : null
}

export function mergeInspectedTokens(
  reported: readonly UsedToken[],
  component: string | null,
  design: ViewerDesign | null,
  draftChanges: readonly TokenChange[],
  activeTheme: string | null
): UsedToken[] {
  const byName = new Map<string, { value: string; property?: string }>()
  for (const item of reported) {
    if (isValidTokenName(item.name) && !byName.has(item.name)) {
      byName.set(item.name, { value: item.value, ...(item.property ? { property: item.property } : {}) })
    }
  }

  const drafts = new Map<string, string>()
  for (const change of draftChanges) {
    drafts.set(tokenDraftKey(change.name, change.theme ?? null), change.value)
  }

  const resolveDraft = (name: string): string | null => {
    if (activeTheme) {
      const themedDraft = drafts.get(tokenDraftKey(name, activeTheme))
      if (themedDraft !== undefined) return themedDraft
    }
    const rootDraft = drafts.get(tokenDraftKey(name, null))
    return rootDraft !== undefined ? rootDraft : null
  }

  const resolveEffective = (name: string): string | null => {
    const drafted = resolveDraft(name)
    if (drafted !== null) return drafted
    if (activeTheme) {
      const themedVal = lookupDesignTokenValue(design, name, activeTheme)
      if (themedVal !== null) return themedVal
    }
    return lookupDesignTokenValue(design, name, null)
  }

  if (component && design && Object.hasOwn(design.componentTokens, component)) {
    for (const hintName of design.componentTokens[component]!) {
      if (!isValidTokenName(hintName)) continue
      if (!byName.has(hintName)) {
        const fallback = resolveEffective(hintName)
        if (fallback !== null) byName.set(hintName, { value: fallback })
      }
    }
  }

  const out: UsedToken[] = []
  for (const [name, entry] of byName) {
    out.push({
      name,
      value: resolveDraft(name) ?? (entry.value || resolveEffective(name) || ''),
      ...(entry.property ? { property: entry.property } : {}),
    })
  }
  return out
}

export function diffTokens(
  design: ViewerDesign | null,
  drafts: ReadonlyMap<string, TokenChange>
): { name: string; from: string; to: string; theme: string | null }[] {
  if (!design || drafts.size === 0) return []
  const tokenOrder = new Map<string, number>()
  design.tokens.forEach((token, idx) => tokenOrder.set(token.name, idx))
  const themeOrder = new Map<string, number>()
  design.themes.forEach((theme, idx) => themeOrder.set(theme, idx))

  const diffs: { name: string; from: string; to: string; theme: string | null; order: number; themeIdx: number }[] = []
  for (const change of drafts.values()) {
    const theme = change.theme ?? null
    if (!isValidTokenName(change.name) || !isValidTokenValue(change.value)) continue
    if (theme !== null && !isValidThemeSelector(theme)) continue
    const from = lookupDesignTokenValue(design, change.name, theme)
    if (from === null || from === change.value) continue
    diffs.push({
      name: change.name,
      from,
      to: change.value,
      theme,
      order: tokenOrder.get(change.name) ?? Number.MAX_SAFE_INTEGER,
      themeIdx: theme === null ? -1 : (themeOrder.get(theme) ?? Number.MAX_SAFE_INTEGER),
    })
  }
  diffs.sort((a, b) => a.themeIdx - b.themeIdx || a.order - b.order || a.name.localeCompare(b.name))
  return diffs.map(({ name, from, to, theme }) => ({ name, from, to, theme }))
}

export function selectLiveScreens(options: {
  screens: readonly DesignScreen[]
  visibleIds: readonly string[]
  focusedId: string | null
  lruIds: readonly string[]
  limit?: number
}): string[] {
  const max = Math.max(0, Math.min(options.limit ?? MAX_LIVE_SCREEN_FRAMES, MAX_LIVE_SCREEN_FRAMES))
  if (max === 0 || options.screens.length === 0) return []
  const valid = new Set(options.screens.map((s) => s.id))
  const chosen: string[] = []
  const seen = new Set<string>()
  const add = (id: string | null | undefined) => {
    if (!id || seen.has(id) || !valid.has(id) || chosen.length >= max) return
    seen.add(id)
    chosen.push(id)
  }
  add(options.focusedId)
  for (const id of options.visibleIds) add(id)
  for (const id of options.lruIds) add(id)
  return chosen
}

export function canSaveTokens(state: ViewerState, version: number, design: ViewerDesign | null): boolean {
  return (
    design !== null &&
    state.artifact.kind === 'page' &&
    state.identity.kind === 'owner' &&
    version === state.artifact.currentVersion
  )
}

export function canSuggestTokens(state: ViewerState, design: ViewerDesign | null): boolean {
  return design !== null && state.artifact.kind === 'page' && state.can.comment
}

export function canApplySuggestion(state: ViewerState, design: ViewerDesign | null): boolean {
  return design !== null && state.artifact.kind === 'page' && state.identity.kind === 'owner'
}

const MAX_SUMMARY_CHARS = 500

export function formatTokenSummary(changes: readonly TokenSuggestionChange[], prefix = 'Tokens'): string {
  if (changes.length === 0) return prefix
  const parts = changes.map((c) => {
    const scope = c.theme ? ` (${c.theme})` : ''
    return `${c.name}${scope} ${c.from} → ${c.to}`
  })
  const full = `${prefix}: ${parts.join(', ')}`
  if (full.length <= MAX_SUMMARY_CHARS) return full
  let acc = `${prefix}: `
  let shown = 0
  for (const part of parts) {
    const sep = shown === 0 ? '' : ', '
    const restCount = parts.length - (shown + 1)
    const tail = restCount > 0 ? `, +${restCount} more` : ''
    if (acc.length + sep.length + part.length + tail.length > MAX_SUMMARY_CHARS) break
    acc += sep + part
    shown++
  }
  if (shown === 0) return `${prefix}: ${parts.length} changes`.slice(0, MAX_SUMMARY_CHARS)
  const remaining = parts.length - shown
  return remaining > 0 ? `${acc}, +${remaining} more` : acc
}

/**
 * Formats a version summary when applying a third-party token suggestion: includes only validated token names
 * (never the commenter's name or suggested values, which are untrusted external input).
 */
export function formatAppliedSuggestionSummary(names: readonly string[]): string {
  const prefix = 'Applied a token suggestion'
  const unique: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    if (isValidTokenName(name) && !seen.has(name)) {
      seen.add(name)
      unique.push(name)
    }
  }
  if (unique.length === 0) return prefix
  const full = `${prefix}: ${unique.join(', ')}`
  if (full.length <= MAX_SUMMARY_CHARS) return full
  let acc = `${prefix}: `
  let shown = 0
  for (const name of unique) {
    const sep = shown === 0 ? '' : ', '
    const restCount = unique.length - (shown + 1)
    const tail = restCount > 0 ? `, +${restCount} more` : ''
    if (acc.length + sep.length + name.length + tail.length > MAX_SUMMARY_CHARS) break
    acc += sep + name
    shown++
  }
  if (shown === 0) return prefix
  const remaining = unique.length - shown
  return remaining > 0 ? `${acc}, +${remaining} more` : acc
}
