// How the viewer arranges comments and places their pins. No DOM here, so the rules are tested directly.
import {
  type CommentAuthorKind,
  DRAFT_ANCHOR_ID,
  type PickedAnchor,
  type PinPosition,
  type PublicComment,
  type ShellAnchor,
} from './contract.js'
import type { ShellKey } from './i18n.js'

export interface Thread {
  comment: PublicComment
  replies: PublicComment[]
}

export type ListFilter = 'open' | 'resolved'

const byDate = (a: PublicComment, b: PublicComment): number => a.createdAt - b.createdAt

/** Every thread with its replies, both in the order they were written. Replies without a thread are left out. */
export function buildThreads(comments: readonly PublicComment[]): Thread[] {
  const threads = new Map<string, Thread>()
  for (const comment of comments) if (comment.parentId === null) threads.set(comment.id, { comment, replies: [] })
  for (const comment of comments) if (comment.parentId !== null) threads.get(comment.parentId)?.replies.push(comment)
  const ordered = [...threads.values()].sort((a, b) => byDate(a.comment, b.comment))
  for (const thread of ordered) thread.replies.sort(byDate)
  return ordered
}

const statusOf = (thread: Thread): ListFilter => (thread.comment.status === 'resolved' ? 'resolved' : 'open')

/** What the list shows: this version's threads with the chosen status, then the other versions' with the same one. */
export function listThreads(
  threads: readonly Thread[],
  version: number,
  filter: ListFilter
): { here: Thread[]; elsewhere: Thread[] } {
  const matching = threads.filter((thread) => statusOf(thread) === filter)
  return {
    here: matching.filter((thread) => thread.comment.version === version),
    elsewhere: matching.filter((thread) => thread.comment.version !== version),
  }
}

/** A thread about a passage or a spot has a pin; one about the whole page does not. */
export const hasPin = (thread: Thread): boolean => Boolean(thread.comment.anchor?.quote || thread.comment.anchor?.point)

/**
 * Threads drawn as pins on the version on screen: the open ones, the resolved ones while the list shows them, and the
 * one that is open in the card whatever its status.
 */
export function pinnedThreads(
  threads: readonly Thread[],
  version: number,
  options: { showResolved: boolean; activeId: string | null }
): Thread[] {
  return threads.filter(
    (thread) =>
      thread.comment.version === version &&
      hasPin(thread) &&
      (statusOf(thread) === 'open' || options.showResolved || thread.comment.id === options.activeId)
  )
}

/** The threads the reader steps through with ‹ ›: the open ones of the version on screen, and the active one. */
export function steppable(threads: readonly Thread[], version: number, activeId: string | null): Thread[] {
  return threads.filter(
    (thread) => thread.comment.version === version && (statusOf(thread) === 'open' || thread.comment.id === activeId)
  )
}

/** What the page is told to find: only its own text or places in it, never a name or what a comment says. */
export function anchorsFor(pinned: readonly Thread[], draft: PickedAnchor | null): ShellAnchor[] {
  const anchors: ShellAnchor[] = []
  for (const { comment } of pinned) {
    const { quote, point } = comment.anchor ?? {}
    if (quote)
      anchors.push({ id: comment.id, quote: { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix } })
    else if (point) anchors.push({ id: comment.id, point: { selector: point.selector, rx: point.rx, ry: point.ry } })
  }
  if (draft) anchors.push({ id: DRAFT_ANCHOR_ID, ...draft })
  return anchors
}

/** Open threads per version, for the version list and the counter. */
export function openCounts(threads: readonly Thread[]): Map<number, number> {
  const counts = new Map<number, number>()
  for (const thread of threads)
    if (statusOf(thread) === 'open') counts.set(thread.comment.version, (counts.get(thread.comment.version) ?? 0) + 1)
  return counts
}

// --- Unread: kept per browser, in the host's own times so a wrong clock on the reader's device does not matter.

export interface SeenState {
  /** Comments up to this time were already there the first time this browser opened the page. */
  baseline: number
  /** For each thread the reader opened, the time of the newest message they saw. */
  threads: Record<string, number>
}

const newest = (thread: Thread, fromOthers: boolean): number =>
  [thread.comment, ...thread.replies]
    .filter((comment) => !fromOthers || !comment.author.self)
    .reduce((latest, comment) => Math.max(latest, comment.createdAt), 0)

/** On a first visit everything already there counts as seen; what arrives later is new. */
export function firstSeen(comments: readonly PublicComment[]): SeenState {
  return { baseline: comments.reduce((latest, comment) => Math.max(latest, comment.createdAt), 0), threads: {} }
}

export function isUnread(thread: Thread, seen: SeenState): boolean {
  const latest = newest(thread, true)
  return latest > (seen.threads[thread.comment.id] ?? seen.baseline)
}

export function markSeen(seen: SeenState, thread: Thread): SeenState {
  return { baseline: seen.baseline, threads: { ...seen.threads, [thread.comment.id]: newest(thread, false) } }
}

/** Forgets threads that no longer exist, so the stored state does not grow forever. */
export function pruneSeen(seen: SeenState, threads: readonly Thread[]): SeenState {
  const ids = new Set(threads.map((thread) => thread.comment.id))
  return {
    baseline: seen.baseline,
    threads: Object.fromEntries(Object.entries(seen.threads).filter(([id]) => ids.has(id))),
  }
}

export function parseSeen(raw: string | null): SeenState | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as { baseline?: unknown; threads?: unknown }
    if (typeof value.baseline !== 'number' || typeof value.threads !== 'object' || value.threads === null) return null
    const threads: Record<string, number> = {}
    for (const [id, at] of Object.entries(value.threads)) if (typeof at === 'number') threads[id] = at
    return { baseline: value.baseline, threads }
  } catch {
    return null
  }
}

// --- Names and faces.

type Translate = (key: ShellKey, vars?: Record<string, string | number>) => string

/** How an author is named next to a comment. A guest's name is marked: nobody confirmed it. */
export function authorLabel(t: Translate, author: PublicComment['author']): string {
  if (author.self) return t('you')
  if (author.kind === 'owner') return author.name ? t('commentOwner', { name: author.name }) : t('commentOwnerUnnamed')
  if (author.kind === 'agent') return author.name ? t('commentAgent', { name: author.name }) : t('commentAgentUnnamed')
  if (author.kind === 'guest') return t('unverified', { name: author.name })
  return author.name
}

/** Up to two initials; an empty name has none, and the avatar shows a person instead. */
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]!.toLocaleUpperCase())
    .join('')
}

export const AVATAR_TONES = 8

/** A stable color for a person, from their name and how they got in. */
export function avatarTone(kind: CommentAuthorKind, name: string): number {
  let hash = 0
  for (const char of `${kind}:${name}`) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return hash % AVATAR_TONES
}

export function snippet(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** "now", "5 min ago", "3 h ago", "2 days ago", in the reader's language. */
export function relativeTime(locale: string, at: number, now: number, nowLabel: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' })
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return nowLabel
  if (minutes < 60) return format.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return format.format(-hours, 'hour')
  const days = Math.floor(hours / 24)
  return days < 7 ? format.format(-days, 'day') : format.format(-Math.floor(days / 7), 'week')
}

// --- Placement.

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Pins near the right edge unfold their preview to the left. */
export const PREVIEW_WIDTH = 290
export const flipsLeft = (x: number, frameWidth: number): boolean => x > frameWidth - PREVIEW_WIDTH

/**
 * Where the conversation card goes: beside its pin, on the other side near the edge, and in the top right corner when
 * it has no pin. `pin` and the result are in the stage's coordinates.
 */
export function placeCard(
  pin: Box | null,
  card: { width: number; height: number },
  stage: { width: number; height: number },
  margin = 12,
  gap = 10
): { left: number; top: number; originX: 'left' | 'right'; originY: number } {
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))
  if (!pin) return { left: stage.width - card.width - 16, top: 16, originX: 'right', originY: 0 }
  let left = pin.left + pin.width + gap
  if (left + card.width > stage.width - margin) left = pin.left - card.width - gap
  if (left < margin) left = clamp(pin.left + pin.width / 2 - card.width / 2, margin, stage.width - card.width - margin)
  const top = clamp(pin.top - 6, margin, stage.height - card.height - margin)
  return {
    left,
    top,
    originX: left > pin.left ? 'left' : 'right',
    originY: clamp(pin.top + pin.height / 2 - top, 0, card.height),
  }
}

/** Open threads whose pins are scrolled out of sight, nearest first, for the "comments above/below" chips. */
export function offscreen(
  ids: readonly string[],
  pins: Readonly<Record<string, PinPosition>>,
  frameHeight: number,
  margin = 24
): { above: string[]; below: string[] } {
  const placed = ids
    .map((id) => ({ id, at: pins[id] }))
    .filter((item): item is { id: string; at: { x: number; y: number } } => Boolean(item.at))
  return {
    above: placed
      .filter((item) => item.at.y < 0)
      .sort((a, b) => b.at.y - a.at.y)
      .map((item) => item.id),
    below: placed
      .filter((item) => item.at.y > frameHeight + margin)
      .sort((a, b) => a.at.y - b.at.y)
      .map((item) => item.id),
  }
}
