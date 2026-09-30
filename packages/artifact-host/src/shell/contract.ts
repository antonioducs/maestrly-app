// Shared by the host (Node) and the viewer shell (browser): no DOM and no Node APIs.

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
  artifact: { id: string; title: string; currentVersion: number; versions: ViewerVersion[] }
  identity: ViewerIdentity
  /** The owner's display name, or an empty string when they did not set one. */
  ownerName: string
  can: { comment: boolean; resolve: boolean }
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
  status: 'open' | 'resolved'
  createdAt: number
  canDelete: boolean
}

export interface CommentPage {
  comments: PublicComment[]
  nextCursor: string | null
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

export const FORWARDED_KEYS = ['Escape', 'c', 'f'] as const
export type ForwardedKey = (typeof FORWARDED_KEYS)[number]

export type BridgeMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  /** What the reader selected in the page, and where it is in the frame; both null when nothing is selected. */
  | { type: 'selection'; quote: TextQuote | null; rect: SelectionRect | null }
  /** Where each anchor the shell sent is, and the frame's size. */
  | { type: 'layout'; pins: Record<string, PinPosition>; width: number; height: number }
  /** In comment mode, the passage or spot the reader chose. */
  | { type: 'pick'; anchor: PickedAnchor }
  /** The reader pressed inside the page. */
  | { type: 'pointer' }
  /** A viewer shortcut pressed while the page had the focus. */
  | { type: 'key'; key: ForwardedKey }

/** An anchor as the page receives it: the page's own text or a place in it, never names or comment text. */
export type ShellAnchor = { id: string } & Pick<CommentAnchor, 'quote' | 'point'>

/**
 * What the shell sends into the page, as `{ source: 'maestrly-shell', ...message }`. None of it carries a name or a
 * comment's text.
 */
export type ShellMessage =
  | { type: 'anchors'; anchors: ShellAnchor[]; active: string | null }
  | { type: 'mode'; commenting: boolean }
  | { type: 'reveal'; id: string }
  | { type: 'measure' }
  | { type: 'clear-selection' }

const ANCHOR_ID = /^[A-Za-z0-9_-]{22}$/
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

/**
 * Messages come from untrusted page code: accept only known shapes and cap every string. What they say is a hint for
 * the interface, never an instruction: the shell shows a selection as text and decides by itself what to do with it.
 */
export function parseBridgeMessage(value: unknown): BridgeMessage | null {
  if (typeof value !== 'object' || value === null) return null
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
      return { type: 'layout', pins, width: Math.max(0, v.width), height: Math.max(0, v.height) }
    }
    case 'pick': {
      const anchor = parsePicked(v.anchor)
      return anchor ? { type: 'pick', anchor } : null
    }
    case 'pointer':
      return { type: 'pointer' }
    case 'key':
      return (FORWARDED_KEYS as readonly unknown[]).includes(v.key) ? { type: 'key', key: v.key as ForwardedKey } : null
    default:
      return null
  }
}
