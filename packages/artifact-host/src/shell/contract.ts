// Shared by the host (Node) and the viewer shell (browser): no DOM and no Node APIs.
//
// The page and the shell talk through `postMessage`. The page reports what the reader does in it and asks the shell to
// save or read the response of the person viewing it; the shell sends in only the page's own text and places in it,
// and that person's own response. Never anyone's name, a comment, or another person's response.

export const ARTIFACT_HEADER = 'x-maestrly-artifact'
export const SESSION_COOKIE = 'maestrly_artifact_session'
/** A random secret that ties an access request, and access-code attempts, to one browser. */
export const VISITOR_COOKIE = 'maestrly_artifact_visitor'
export const MAX_BRIDGE_MESSAGE_CHARS = 300
/** Never includes `allow-same-origin` or `allow-top-navigation`: content keeps an opaque origin. */
export const CONTENT_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox'

/** Invited and approved people were confirmed by the owner; a guest's name is whatever they typed. */
export type ViewerIdentity =
  | { kind: 'owner' }
  | { kind: 'invited' | 'approved'; name: string }
  | { kind: 'guest'; name: string | null }

export interface ViewerVersion {
  number: number
  createdAt: number
  summary: string
}

export type ViewerVisibility = 'private' | 'people' | 'link'
/** A page is the files of its versions; a whiteboard is one board that people and agents edit in place. */
export type ArtifactKind = 'page' | 'whiteboard'

/** Who can open the page, for the owner only: read here, changed only in Maestrly. */
export interface ViewerSharing {
  visibility: ViewerVisibility
  /** The page's address on the public address when there is one, otherwise on this computer. */
  link: string
  /** True when no public address is set, so the link only works on the owner's computer. */
  local: boolean
  linkExpiresAt: number | null
  /** The first people the page is shared with; `peopleCount` counts them all. */
  people: { name: string; kind: 'invited' | 'approved' | 'guest'; devices: number }[]
  peopleCount: number
  requests: number
}

export interface ViewerState {
  artifact: { id: string; kind: ArtifactKind; title: string; currentVersion: number; versions: ViewerVersion[] }
  identity: ViewerIdentity
  /** The owner's display name, or an empty string when they did not set one. */
  ownerName: string
  /** `respond`: the page may save the response of the person viewing it. `edit`: they may draw on the whiteboard. */
  /** `history`: whether earlier versions stay open to this viewer, or a new one replaces what is on screen. */
  can: { comment: boolean; resolve: boolean; respond: boolean; edit: boolean; history: boolean }
  /** Present for the owner only. */
  sharing?: ViewerSharing
}

/** What a visitor without access gets instead of the state: what they may do, and nothing about the artifact. */
export interface ViewerGate {
  gate: {
    request: boolean
    guest: boolean
    code: boolean
    /** This browser's access request, when it has one the owner has not approved yet. */
    pending: 'pending' | 'denied' | null
  }
  ownerName: string
}

export type AccessRequestStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface FrameResponse {
  url: string
  expiresAt: number
}

export const MAX_QUOTE_CHARS = 500
export const MAX_QUOTE_CONTEXT_CHARS = 64
export const MAX_SELECTOR_CHARS = 300
/** Anchors the shell sends the page at once, and positions the page reports back. */
export const MAX_ANCHORS = 200
/** The anchor of the comment being written, which has no ID yet. */
export const DRAFT_ANCHOR_ID = 'draft'

export const DESIGN_MANIFEST_PATH = 'maestrly-design.json'
export const DESIGN_SCHEMA = 'maestrly-prototype/v1'
export const MAX_DESIGN_TOKENS = 200
export const MAX_DESIGN_TOKEN_FILES = 8
export const MAX_DESIGN_SCREENS = 50
export const MAX_DESIGN_TITLE_CHARS = 120
export const MAX_DESIGN_SCREEN_NAME_CHARS = 80
export const MAX_DESIGN_SCREEN_PATH_CHARS = 300
export const MAX_TOKEN_VALUE_CHARS = 200
export const MAX_THEME_SELECTOR_CHARS = 120
export const MAX_DS_PROPS = 32
export const MAX_DS_PROPS_RAW_CHARS = 200
export const MAX_DS_PROP_VALUE_CHARS = 120
export const MAX_COMPUTED_STYLE_CHARS = 120
export const MAX_INSPECTED_TOKENS = 64
export const MAX_INVENTORY_COMPONENTS = 200
export const MAX_INVENTORY_COUNT = 10_000
export const MIN_VIEWPORT_DIMENSION = 320
export const MAX_VIEWPORT_DIMENSION = 2560

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

export interface DesignManifest {
  schema: typeof DESIGN_SCHEMA
  title?: string
  tokens: string[]
  components?: string
  screens: DesignScreen[]
  componentTokens?: Record<string, string[]>
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

export interface DesignResponse {
  design: ViewerDesign | null
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

export const TOKEN_NAME_PATTERN = /^--[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}$/
export const COMPONENT_NAME_PATTERN = /^[A-Z][A-Za-z0-9]{0,47}$/
export const DS_PROP_KEY_PATTERN = /^[a-z][a-zA-Z0-9-]{0,31}$/
export const SCREEN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
const THEME_SELECTOR_PATTERN =
  /^(?:(?::root|html)?\[data-theme=(?:"[a-zA-Z0-9_-]{1,32}"|'[a-zA-Z0-9_-]{1,32}')\]|(?::root|html)?\.(?:dark|light|theme-[a-zA-Z0-9_-]{1,32})|@media \((?:prefers-color-scheme: (?:dark|light))\))$/
const FORBIDDEN_RAW_TOKEN_VALUE = /[<\\]|\/\*|\*\//
const FORBIDDEN_UNQUOTED_TOKEN_VALUE =
  /[;{}]|!\s*important\b|@import\b|(?:url|-webkit-image-set|image-set|src|expression)\s*\(/i
const CONTROL_CHAR = /\p{Cc}/u

export function isValidTokenName(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_NAME_PATTERN.test(value)
}

export function isValidTokenValue(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length > MAX_TOKEN_VALUE_CHARS || CONTROL_CHAR.test(value)) return false
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_TOKEN_VALUE_CHARS) return false
  if (FORBIDDEN_RAW_TOKEN_VALUE.test(value)) return false
  const unquoted = value.replace(/"[^"]*"|'[^']*'/g, '""')
  return !FORBIDDEN_UNQUOTED_TOKEN_VALUE.test(unquoted)
}

export function isValidThemeSelector(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_THEME_SELECTOR_CHARS && THEME_SELECTOR_PATTERN.test(value)
}

export function isValidComponentName(value: unknown): value is string {
  return typeof value === 'string' && COMPONENT_NAME_PATTERN.test(value)
}

export type CommentAuthorKind = 'owner' | 'agent' | 'invited' | 'approved' | 'guest'

export interface TextQuote {
  exact: string
  prefix: string
  suffix: string
}

/** A spot on the page: an element, and where in its box (0 to 1 across and down). */
export interface PagePoint {
  selector: string
  rx: number
  ry: number
}

/**
 * Where a comment points: a passage or a spot on the page, or neither for a comment about the whole page. The quote
 * is the selected text with a little of what surrounds it, which finds the passage again even after the page changes
 * around it. The hint is only where to look first.
 */
export interface CommentAnchor {
  quote?: TextQuote
  point?: PagePoint
  hint?: { selector: string }
}

/** A comment as one viewer sees it: what is theirs is decided by the host, and no internal ID of a person leaves it. */
export interface PublicComment {
  id: string
  version: number
  parentId: string | null
  author: { kind: CommentAuthorKind; name: string; verified: boolean; self: boolean }
  body: string
  anchor: CommentAnchor | null
  suggestion: TokenSuggestion | null
  status: 'open' | 'resolved'
  createdAt: number
  canDelete: boolean
}

export interface CommentPage {
  comments: PublicComment[]
  nextCursor: string | null
}

/** A response's size as UTF-8 JSON, and how deep its values may nest. */
export const MAX_RESPONSE_BYTES = 32 * 1024
/** The elements one canvas sends at a time, as JSON: under the 1 MiB a gateway proxy accepts in one request. */
export const MAX_BOARD_PUSH_BYTES = 900 * 1024
export const MAX_RESPONSE_DEPTH = 16

export type ResponseValue = string | number | boolean | null | ResponseValue[] | { [key: string]: ResponseValue }
/** What a page saves as one person's response: a JSON object. */
export type ResponseData = { [key: string]: ResponseValue }

/** What the page gets back about the response of the person viewing it, and nothing about anyone else's. */
export interface ResponseSnapshot {
  data: ResponseData
  version: number
  updatedAt: number
}

/** Why a response could not be read or saved, as the page learns it. */
export const RESPONSE_ERRORS = [
  'closed',
  'unavailable',
  'cancelled',
  'invalid',
  'too_large',
  'full',
  'rate_limited',
  'failed',
] as const
export type ResponseError = (typeof RESPONSE_ERRORS)[number]

/** Why a whiteboard could not be read or a canvas's change saved, as the canvas learns it. */
export const BOARD_ERRORS = [
  'read_only',
  'invalid',
  'too_large',
  'full',
  'rate_limited',
  'unavailable',
  'failed',
] as const
export type BoardError = (typeof BOARD_ERRORS)[number]
/** The elements a canvas sends at once; the host checks each one again. */
export const MAX_BOARD_PUSH_ELEMENTS = 1000

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A response as a page may save it: a JSON object of strings, finite numbers, booleans, null, arrays and objects, at
 * most MAX_RESPONSE_DEPTH levels deep and MAX_RESPONSE_BYTES as UTF-8 JSON. The walk is iterative and stops after as
 * many values as the size allows, so neither depth nor breadth can exhaust the caller.
 */
export function isResponseData(value: unknown): value is ResponseData {
  if (!isRecord(value)) return false
  const stack: [unknown, number][] = [[value, 1]]
  let seen = 0
  while (stack.length) {
    const [item, depth] = stack.pop()!
    if (++seen > MAX_RESPONSE_BYTES) return false
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return false
      continue
    }
    if (depth > MAX_RESPONSE_DEPTH) return false
    const children = Array.isArray(item) ? item : isRecord(item) ? Object.values(item) : null
    if (!children) return false
    for (const child of children) stack.push([child, depth + 1])
  }
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_RESPONSE_BYTES
}

export interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

/** Where an anchor is in the frame's viewport; null when the page does not have it. */
export type PinPosition = { x: number; y: number } | null

/** What a comment may be anchored to when the reader places it on the page. */
export type PickedAnchor = { quote: TextQuote } | { point: PagePoint }

export const FORWARDED_KEYS = ['Escape', 'c', 'f', 'i'] as const
export type ForwardedKey = (typeof FORWARDED_KEYS)[number]

export type BridgeMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  /** What the reader selected in the page, and where it is in the frame; both null when nothing is selected. */
  | { type: 'selection'; quote: TextQuote | null; rect: SelectionRect | null }
  /** Where each anchor the shell sent is, and the frame's size. */
  | {
      type: 'layout'
      pins: Record<string, PinPosition>
      width: number
      height: number
      inspectRect?: SelectionRect | null
    }
  /** In comment mode, the passage or spot the reader chose. */
  | { type: 'pick'; anchor: PickedAnchor }
  /** In inspect mode, the component or element under the pointer. */
  | { type: 'inspect-hover'; target: InspectHover | null }
  /** In inspect mode (or after reveal-component), the selected component or element. */
  | { type: 'inspect-pick'; target: InspectTarget | null }
  /** Component instance counts and main definitions currently present in the frame's DOM. */
  | { type: 'inventory'; requestId: string | null; instances: Record<string, number>; mains: string[] }
  /** The reader pressed inside the page. */
  | { type: 'pointer' }
  /** A viewer shortcut pressed while the page had the focus. */
  | { type: 'key'; key: ForwardedKey }
  /** The page asks for the response of the person viewing it. */
  | { type: 'response-get'; requestId: string }
  /** The page saves the response of the person viewing it; `data` is null when it is not a valid response. */
  | { type: 'response-submit'; requestId: string; data: ResponseData | null }
  /** A whiteboard's canvas asks for its board. */
  | { type: 'board-load'; requestId: string }
  /** A whiteboard's canvas sends what the person changed; the host validates every element. */
  | { type: 'board-push'; requestId: string; elements: unknown[] }

/** An anchor as the page receives it: the page's own text or a place in it, never names or comment text. */
export type ShellAnchor = { id: string } & Pick<CommentAnchor, 'quote' | 'point'>

/**
 * What the shell sends into the page, as `{ source: 'maestrly-shell', ...message }`. None of it carries a name, a
 * comment's text, or anyone's response but the one of the person viewing the page.
 */
export type ShellMessage =
  | { type: 'anchors'; anchors: ShellAnchor[]; active: string | null }
  | { type: 'mode'; commenting: boolean }
  | { type: 'inspect-mode'; inspecting: boolean; componentTokens?: Record<string, string[]> }
  | { type: 'inspect-clear' }
  | { type: 'reveal-component'; component: string }
  | { type: 'inventory-request'; requestId: string }
  | { type: 'token-preview'; tokens: TokenChange[] }
  | { type: 'token-preview-clear' }
  | { type: 'reveal'; id: string }
  | { type: 'measure' }
  | { type: 'clear-selection' }
  | { type: 'response-result'; requestId: string; ok: true; response: ResponseSnapshot | null }
  | { type: 'response-result'; requestId: string; ok: false; error: ResponseError }
  | { type: 'board-loaded'; requestId: string; ok: true; revision: number; elements: unknown[]; canEdit: boolean }
  | { type: 'board-loaded'; requestId: string; ok: false; error: BoardError }
  | { type: 'board-pushed'; requestId: string; ok: true; revision: number; kept: unknown[] }
  | { type: 'board-pushed'; requestId: string; ok: false; error: BoardError }
  /** What others changed on the board: elements as they are now, deleted ones as tombstones. */
  | { type: 'board-changes'; revision: number; elements: unknown[] }

const ANCHOR_ID = /^[A-Za-z0-9_-]{22}$/
/** Chosen by the page to match the shell's answer to its request. */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,32}$/
const isRequestId = (value: unknown): value is string => typeof value === 'string' && REQUEST_ID.test(value)
const isAnchorId = (id: string): boolean => ANCHOR_ID.test(id) || id === DRAFT_ANCHOR_ID

const capped = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const unit = (value: number): number => Math.min(1, Math.max(0, value))

function parseQuote(value: unknown): TextQuote | null {
  if (typeof value !== 'object' || value === null) return null
  const quote = value as { exact?: unknown; prefix?: unknown; suffix?: unknown }
  const exact = capped(quote.exact, MAX_QUOTE_CHARS)
  if (!exact) return null
  return {
    exact,
    prefix: capped(quote.prefix, MAX_QUOTE_CONTEXT_CHARS),
    suffix: capped(quote.suffix, MAX_QUOTE_CONTEXT_CHARS),
  }
}

function parsePoint(value: unknown): PagePoint | null {
  if (typeof value !== 'object' || value === null) return null
  const point = value as { selector?: unknown; rx?: unknown; ry?: unknown }
  if (typeof point.selector !== 'string' || !point.selector || point.selector.length > MAX_SELECTOR_CHARS) return null
  if (!finite(point.rx) || !finite(point.ry)) return null
  return { selector: point.selector, rx: unit(point.rx), ry: unit(point.ry) }
}

function parseRect(value: unknown): SelectionRect | null {
  if (typeof value !== 'object' || value === null) return null
  const rect = value as Record<string, unknown>
  const sides = [rect.x, rect.y, rect.width, rect.height]
  if (!sides.every(finite)) return null
  const [x, y, width, height] = sides as [number, number, number, number]
  return { x, y, width, height }
}

function parsePins(value: unknown): Record<string, PinPosition> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_ANCHORS + 1) return null
  const pins: Record<string, PinPosition> = {}
  for (const [id, at] of entries) {
    if (!isAnchorId(id)) return null
    if (at === null) pins[id] = null
    else if (typeof at === 'object' && finite((at as { x?: unknown }).x) && finite((at as { y?: unknown }).y))
      pins[id] = { x: (at as { x: number }).x, y: (at as { y: number }).y }
    else return null
  }
  return pins
}

function parsePicked(value: unknown): PickedAnchor | null {
  if (typeof value !== 'object' || value === null) return null
  const anchor = value as { quote?: unknown; point?: unknown }
  if (anchor.quote !== undefined) {
    const quote = parseQuote(anchor.quote)
    return quote ? { quote } : null
  }
  const point = parsePoint(anchor.point)
  return point ? { point } : null
}

/** A batch a canvas may send: few enough elements, and small enough to cross a gateway proxy in one request. */
function isBoardBatch(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length > MAX_BOARD_PUSH_ELEMENTS) return false
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BOARD_PUSH_BYTES
  } catch {
    return false
  }
}

const TAG_PATTERN = /^[a-zA-Z][a-zA-Z0-9:-]{0,63}$/
const COMPUTED_STYLE_KEYS: readonly (keyof ComputedStyleSubset)[] = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'backgroundColor',
  'borderRadius',
  'padding',
]

function setSafeProp<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

function parseInspectHover(value: unknown): InspectHover | null {
  if (!isRecord(value)) return null
  if (typeof value.selector !== 'string' || !value.selector || value.selector.length > MAX_SELECTOR_CHARS) return null
  if (typeof value.tag !== 'string' || !TAG_PATTERN.test(value.tag)) return null
  const rect = parseRect(value.rect)
  if (!rect) return null
  let component: string | null = null
  if (value.component !== null && value.component !== undefined) {
    if (!isValidComponentName(value.component)) return null
    component = value.component
  }
  if (typeof value.main !== 'boolean') return null
  return {
    selector: value.selector,
    rect,
    tag: value.tag.toLowerCase(),
    component,
    main: component !== null && value.main,
  }
}

function parseInspectTarget(value: unknown): InspectTarget | null {
  const hover = parseInspectHover(value)
  if (!hover || !isRecord(value)) return null
  if (!isRecord(value.props)) return null
  const propEntries = Object.entries(value.props)
  if (propEntries.length > MAX_DS_PROPS) return null
  const props: Record<string, string> = {}
  for (const [key, rawVal] of propEntries) {
    if (key === 'constructor' || key === 'prototype' || !DS_PROP_KEY_PATTERN.test(key)) return null
    if (
      typeof rawVal !== 'string' ||
      !rawVal ||
      rawVal.length > MAX_DS_PROP_VALUE_CHARS ||
      /\s/.test(rawVal) ||
      CONTROL_CHAR.test(rawVal)
    )
      return null
    setSafeProp(props, key, rawVal)
  }

  if (!isRecord(value.styles)) return null
  const styles = {} as ComputedStyleSubset
  for (const key of COMPUTED_STYLE_KEYS) {
    const rawStyle = value.styles[key]
    if (typeof rawStyle !== 'string' || CONTROL_CHAR.test(rawStyle)) return null
    styles[key] = rawStyle.slice(0, MAX_COMPUTED_STYLE_CHARS)
  }

  if (!Array.isArray(value.tokens) || value.tokens.length > MAX_INSPECTED_TOKENS) return null
  const tokens: UsedToken[] = []
  const seenTokens = new Set<string>()
  for (const item of value.tokens) {
    if (!isRecord(item) || !isValidTokenName(item.name) || typeof item.value !== 'string') return null
    if (CONTROL_CHAR.test(item.value)) return null
    if (seenTokens.has(item.name)) continue
    seenTokens.add(item.name)
    tokens.push({ name: item.name, value: item.value.slice(0, MAX_TOKEN_VALUE_CHARS) })
  }

  return { ...hover, props, styles, tokens }
}

function parseInventory(
  value: Record<string, unknown>
): { type: 'inventory'; requestId: string | null; instances: Record<string, number>; mains: string[] } | null {
  let requestId: string | null
  if (value.requestId === null) requestId = null
  else if (isRequestId(value.requestId)) requestId = value.requestId
  else return null

  if (!isRecord(value.instances)) return null
  const entries = Object.entries(value.instances)
  if (entries.length > MAX_INVENTORY_COMPONENTS) return null
  const instances: Record<string, number> = {}
  for (const [name, count] of entries) {
    if (!isValidComponentName(name)) return null
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > MAX_INVENTORY_COUNT) return null
    setSafeProp(instances, name, count)
  }

  if (!Array.isArray(value.mains) || value.mains.length > MAX_INVENTORY_COMPONENTS) return null
  const mains: string[] = []
  const seenMains = new Set<string>()
  for (const item of value.mains) {
    if (!isValidComponentName(item)) return null
    if (!seenMains.has(item)) {
      seenMains.add(item)
      mains.push(item)
    }
  }
  return { type: 'inventory', requestId, instances, mains }
}

/**
 * Messages come from untrusted page code: accept only known shapes and cap every string. What they say is a hint for
 * the interface, never an instruction: the shell shows a selection as text and decides by itself what to do with it.
 */
export function parseBridgeMessage(value: unknown): BridgeMessage | null {
  if (!isRecord(value)) return null
  const v = value as { source?: unknown; type?: unknown; message?: unknown } & Record<string, unknown>
  if (v.source !== 'maestrly-bridge') return null
  switch (v.type) {
    case 'ready':
      return { type: 'ready' }
    case 'error':
      return { type: 'error', message: String(v.message ?? '').slice(0, MAX_BRIDGE_MESSAGE_CHARS) }
    case 'selection': {
      const quote = parseQuote(v.quote)
      if (!quote) return { type: 'selection', quote: null, rect: null }
      const rect = parseRect(v.rect)
      return rect ? { type: 'selection', quote, rect } : null
    }
    case 'layout': {
      const pins = parsePins(v.pins)
      if (!pins || !finite(v.width) || !finite(v.height)) return null
      if (v.inspectRect === undefined) {
        return { type: 'layout', pins, width: Math.max(0, v.width), height: Math.max(0, v.height) }
      }
      if (v.inspectRect === null) {
        return { type: 'layout', pins, width: Math.max(0, v.width), height: Math.max(0, v.height), inspectRect: null }
      }
      const inspectRect = parseRect(v.inspectRect)
      if (!inspectRect) return null
      return { type: 'layout', pins, width: Math.max(0, v.width), height: Math.max(0, v.height), inspectRect }
    }
    case 'pick': {
      const anchor = parsePicked(v.anchor)
      return anchor ? { type: 'pick', anchor } : null
    }
    case 'inspect-hover': {
      if (v.target === null) return { type: 'inspect-hover', target: null }
      const target = parseInspectHover(v.target)
      return target ? { type: 'inspect-hover', target } : null
    }
    case 'inspect-pick': {
      if (v.target === null) return { type: 'inspect-pick', target: null }
      const target = parseInspectTarget(v.target)
      return target ? { type: 'inspect-pick', target } : null
    }
    case 'inventory':
      return parseInventory(v)
    case 'pointer':
      return { type: 'pointer' }
    case 'key':
      return (FORWARDED_KEYS as readonly unknown[]).includes(v.key) ? { type: 'key', key: v.key as ForwardedKey } : null
    case 'response-get':
      return isRequestId(v.requestId) ? { type: 'response-get', requestId: v.requestId } : null
    case 'response-submit':
      // An invalid response is kept as null, so the shell answers it instead of leaving the page waiting.
      if (!isRequestId(v.requestId)) return null
      return { type: 'response-submit', requestId: v.requestId, data: isResponseData(v.data) ? v.data : null }
    case 'board-load':
      return isRequestId(v.requestId) ? { type: 'board-load', requestId: v.requestId } : null
    case 'board-push':
      return isRequestId(v.requestId) && isBoardBatch(v.elements)
        ? { type: 'board-push', requestId: v.requestId, elements: v.elements }
        : null
    default:
      return null
  }
}
