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

export interface ViewerState {
  artifact: { id: string; title: string; currentVersion: number; versions: ViewerVersion[] }
  identity: ViewerIdentity
  /** The owner's display name, or an empty string when they did not set one. */
  ownerName: string
  can: { comment: boolean; resolve: boolean }
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
/** Quotes the shell asks the page to highlight at once, and IDs the page reports back. */
export const MAX_HIGHLIGHTS = 200

export type CommentAuthorKind = 'owner' | 'agent' | 'invited' | 'approved' | 'guest'

export interface TextQuote {
  exact: string
  prefix: string
  suffix: string
}

/**
 * Where a comment points. The quote is the selected text with a little of what surrounds it, which finds the passage
 * again even after the page changes around it; the selector is only a hint of where to look first.
 */
export interface CommentAnchor {
  quote?: TextQuote
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

export type BridgeMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  /** What the reader selected in the page, and where it is in the frame; both null when nothing is selected. */
  | { type: 'selection'; quote: TextQuote | null; rect: SelectionRect | null }
  /** Which of the quotes the shell asked to highlight the page found. */
  | { type: 'anchors'; found: string[]; missing: string[] }

/** The only message the shell sends into the page. It carries quotes, which are the page's own text, and nothing else. */
export interface ShellMessage {
  source: 'maestrly-shell'
  type: 'highlight'
  quotes: ({ id: string } & TextQuote)[]
  active: string | null
}

const COMMENT_ID = /^[A-Za-z0-9_-]{22}$/

const capped = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

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

function parseRect(value: unknown): SelectionRect | null {
  if (typeof value !== 'object' || value === null) return null
  const rect = value as Record<string, unknown>
  const sides = [rect.x, rect.y, rect.width, rect.height]
  if (!sides.every((side) => typeof side === 'number' && Number.isFinite(side))) return null
  const [x, y, width, height] = sides as [number, number, number, number]
  return { x, y, width, height }
}

function parseIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_HIGHLIGHTS) return null
  return value.every((id) => typeof id === 'string' && COMMENT_ID.test(id)) ? (value as string[]) : null
}

/**
 * Messages come from untrusted page code: accept only known shapes and cap every string. What they say is a hint for
 * the interface, never an instruction: the shell shows a selection as text and decides by itself what to do with it.
 */
export function parseBridgeMessage(value: unknown): BridgeMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { source?: unknown; type?: unknown; message?: unknown } & Record<string, unknown>
  if (v.source !== 'maestrly-bridge') return null
  if (v.type === 'ready') return { type: 'ready' }
  if (v.type === 'error') return { type: 'error', message: String(v.message ?? '').slice(0, MAX_BRIDGE_MESSAGE_CHARS) }
  if (v.type === 'selection') {
    const quote = parseQuote(v.quote)
    if (!quote) return { type: 'selection', quote: null, rect: null }
    const rect = parseRect(v.rect)
    return rect ? { type: 'selection', quote, rect } : null
  }
  if (v.type === 'anchors') {
    const found = parseIds(v.found)
    const missing = parseIds(v.missing)
    return found && missing ? { type: 'anchors', found, missing } : null
  }
  return null
}
