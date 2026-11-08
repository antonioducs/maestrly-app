import type { ConversationStatus } from '../../../shared/conversation'
import type { FleetServerId } from '../../../shared/fleet-servers'

/** How long a read item stays listed. */
export const INBOX_READ_TTL_MS = 24 * 60 * 60 * 1000
/** An entry no source lists anymore (a host away, a conversation deleted) is forgotten after this long. */
const FORGET_UNLISTED_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 500
/**
 * How much later a time must be to be another event: a conversation's time reaches this window first from its status
 * and later, a little apart, from its host's listing.
 */
const NEWER_SLACK_MS = 2_000

/**
 * What an item is about: something that waits for the owner, or a turn that ended. `activity` is a bot with something
 * new that says nothing more: a turn answering another bot, or a mark kept from before the app restarted.
 */
export type { InboxKind } from '../../../shared/inbox-kind'
import type { InboxKind } from '../../../shared/inbox-kind'
export type InboxGroup = 'waiting' | 'new' | 'read'
export type InboxSource = 'workspace' | 'chat' | 'bot'
/** Where in a bot it happened: its own conversation, a routine run, or a conversation with another bot. */
export type InboxLane = 'main' | 'routine' | 'thread'

const WAITING_KINDS: ReadonlySet<InboxKind> = new Set<InboxKind>(['question', 'approval', 'plan', 'help'])
/** Kinds that hold the agent until the owner acts: they stay listed, read or not, until that happens. */
export const isWaitingKind = (kind: InboxKind): boolean => WAITING_KINDS.has(kind)

export type InboxTarget =
  | { kind: 'conversation'; conversationId: string }
  /** `requestId` is the request of a bot's that waits for the owner, which the list can answer. */
  | { kind: 'bot'; serverId: FleetServerId; botId: string; runId?: string; threadId?: string; requestId?: string }

/** The machine or environment an item belongs to, which the place filter offers. */
export interface InboxPlace {
  key: string
  label: string
}

/** What a row shows of an item, and what opening it shows. */
export interface InboxView {
  source: InboxSource
  title: string
  /** The project of a workspace's conversation. */
  project?: string
  bot?: { name: string; tint: string | null; lane: InboxLane }
  /** What the bot said, or what waits for the owner; none for a conversation. */
  summary: string | null
  place: InboxPlace
  target: InboxTarget
}

/** What a source tells of one item now. */
export interface InboxObservation {
  key: string
  view: InboxView
  /** What it needs from or told the owner now; null when nothing (read, answered, or never notified). */
  active: { kind: InboxKind; unread: boolean } | null
  /** When what it shows happened, when the source knows. */
  at: number | null
  /**
   * False when the source does not know why it is active, or what its view would say: a bot mark read back after a
   * restart, or a bot without a mark. What the ledger kept of it is shown instead.
   */
  known?: boolean
  /** Its unread state is this center's own: a bot's request, which no mark tracks. */
  ownRead?: boolean
  /** Listed only while active: a request that is gone once answered. */
  transient?: boolean
  /** The conversation's status now, for its icon. */
  status?: ConversationStatus
}

/** What this computer remembers of an item: its last event, and whether the owner read or dismissed it. */
export interface InboxEntry {
  kind: InboxKind
  at: number
  readAt: number | null
  /** Hidden from the list until something newer happens. */
  dismissedAt: number | null
  view: InboxView
  transient?: boolean
}

export type InboxLedger = Readonly<Record<string, InboxEntry>>

export interface InboxItem extends InboxView {
  key: string
  kind: InboxKind
  group: InboxGroup
  unread: boolean
  /** Read in this center's own ledger, not by clearing a mark: a bot's request. */
  ownRead?: boolean
  at: number
  /** When a read item leaves the list. */
  expiresAt: number | null
  status?: ConversationStatus
}

function sameView(a: InboxView, b: InboxView): boolean {
  return (
    a.source === b.source &&
    a.title === b.title &&
    a.project === b.project &&
    a.summary === b.summary &&
    a.place.key === b.place.key &&
    a.place.label === b.place.label &&
    a.bot?.name === b.bot?.name &&
    a.bot?.tint === b.bot?.tint &&
    a.bot?.lane === b.bot?.lane &&
    JSON.stringify(a.target) === JSON.stringify(b.target)
  )
}

/**
 * The ledger after what the sources tell now: a new event (a new kind, a newer time, or unread again after being
 * read) replaces an item's entry; an item that no longer needs or tells anything is read from now on. Entries read more
 * than a day ago, requests no longer listed and entries no source listed for a month are forgotten. The same ledger
 * when nothing changed.
 */
export function reconcileInbox(
  ledger: InboxLedger,
  observations: readonly InboxObservation[],
  now: number
): InboxLedger {
  let next: Record<string, InboxEntry> | null = null
  const write = (key: string, entry: InboxEntry): void => {
    next ??= { ...ledger }
    next[key] = entry
  }
  const listed = new Map<string, InboxObservation>()
  for (const observation of observations) {
    listed.set(observation.key, observation)
    const entry = ledger[observation.key]
    const known = observation.known !== false
    if (observation.active) {
      const { kind, unread } = observation.active
      const newKind = known && entry !== undefined && entry.kind !== kind
      const newer = observation.at !== null && entry !== undefined && observation.at > entry.at + NEWER_SLACK_MS
      // Marked after the owner read it. A mark without a time may be the one being cleared: the mark decides whether
      // the row is unread, and only a time says it is another event.
      const unreadAgain =
        !observation.ownRead &&
        unread &&
        entry !== undefined &&
        entry.readAt !== null &&
        observation.at !== null &&
        observation.at > entry.readAt
      if (!entry || newKind || newer || unreadAgain) {
        const at =
          observation.at !== null && (!entry || observation.at > entry.at)
            ? observation.at
            : Math.max(now, entry?.at ?? 0)
        write(observation.key, {
          kind: known || !entry ? kind : entry.kind,
          at,
          readAt: observation.ownRead || unread ? null : (entry?.readAt ?? now),
          dismissedAt: null,
          view: known || !entry ? observation.view : entry.view,
          ...(observation.transient ? { transient: true } : {}),
        })
        continue
      }
      let updated = entry
      if (!observation.ownRead && !unread && entry.readAt === null) updated = { ...updated, readAt: now }
      if (known && !sameView(entry.view, observation.view)) updated = { ...updated, view: observation.view }
      if (updated !== entry) write(observation.key, updated)
      continue
    }
    if (!entry) continue
    let updated = entry
    // What waited is settled now: it is read from now on, as what it became, however long ago it was first seen.
    if (isWaitingKind(entry.kind))
      updated = { ...updated, kind: resolvedKind(entry.kind, observation.status), readAt: now }
    else if (entry.readAt === null) updated = { ...updated, readAt: now }
    if (known && !sameView(entry.view, observation.view)) updated = { ...updated, view: observation.view }
    if (updated !== entry) write(observation.key, updated)
  }

  const current: Record<string, InboxEntry> = next ?? { ...ledger }
  let pruned = false
  for (const [key, entry] of Object.entries(current)) {
    const observation = listed.get(key)
    const active = observation?.active != null
    const expired = !active && entry.readAt !== null && now - entry.readAt > INBOX_READ_TTL_MS
    const gone = !observation && (entry.transient === true || now - entry.at > FORGET_UNLISTED_MS)
    if (expired || gone) {
      delete current[key]
      pruned = true
    }
  }
  const keys = Object.keys(current)
  if (keys.length > MAX_ENTRIES) {
    for (const key of keys.sort((a, b) => current[a].at - current[b].at).slice(0, keys.length - MAX_ENTRIES))
      delete current[key]
    pruned = true
  }
  return next || pruned ? current : ledger
}

/** What a waiting item became once the owner acted on it, as its conversation's status says. */
function resolvedKind(kind: InboxKind, status: ConversationStatus | undefined): InboxKind {
  if (!isWaitingKind(kind)) return kind
  return status === 'error' ? 'error' : 'finished'
}

/**
 * The listed items, newest first: what waits for the owner, what ended and is unread, and what was read in the last
 * day. Only what a source lists now is shown, so that opening an item finds it; dismissed items wait for something
 * newer.
 */
export function inboxItems(ledger: InboxLedger, observations: readonly InboxObservation[], now: number): InboxItem[] {
  const items: InboxItem[] = []
  for (const observation of observations) {
    const entry = ledger[observation.key]
    if (!entry) continue
    if (entry.dismissedAt !== null && entry.dismissedAt >= entry.at) continue
    const base = {
      ...entry.view,
      key: observation.key,
      at: entry.at,
      status: observation.status,
      ...(observation.ownRead ? { ownRead: true } : {}),
    }
    if (observation.active) {
      const unread = observation.ownRead ? entry.readAt === null : observation.active.unread
      const group: InboxGroup = isWaitingKind(entry.kind) ? 'waiting' : 'new'
      // An ended turn is listed while it is unread; one read meanwhile is read.
      if (group === 'new' && !unread) {
        if (entry.readAt !== null && now - entry.readAt <= INBOX_READ_TTL_MS)
          items.push({
            ...base,
            kind: entry.kind,
            group: 'read',
            unread: false,
            expiresAt: entry.readAt + INBOX_READ_TTL_MS,
          })
        continue
      }
      items.push({ ...base, kind: entry.kind, group, unread, expiresAt: null })
      continue
    }
    if (entry.readAt === null || now - entry.readAt > INBOX_READ_TTL_MS) continue
    items.push({
      ...base,
      kind: resolvedKind(entry.kind, observation.status),
      group: 'read',
      unread: false,
      expiresAt: entry.readAt + INBOX_READ_TTL_MS,
    })
  }
  return items.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
}

/** The owner read an item; the same ledger when it was. */
export function markInboxRead(ledger: InboxLedger, keys: readonly string[], now: number): InboxLedger {
  let next: Record<string, InboxEntry> | null = null
  for (const key of keys) {
    const entry = ledger[key]
    if (!entry || entry.readAt !== null) continue
    next ??= { ...ledger }
    next[key] = { ...entry, readAt: now }
  }
  return next ?? ledger
}

/** Hides an item until something newer happens to it; dismissing reads it too. */
export function dismissInboxItem(ledger: InboxLedger, key: string, now: number): InboxLedger {
  const entry = ledger[key]
  if (!entry) return ledger
  return { ...ledger, [key]: { ...entry, readAt: entry.readAt ?? now, dismissedAt: Math.max(now, entry.at) } }
}

/** Puts back what an entry was, as undoing an action does. */
export function restoreInboxEntry(ledger: InboxLedger, key: string, entry: InboxEntry | undefined): InboxLedger {
  if (ledger[key] === entry) return ledger
  const next = { ...ledger }
  if (entry) next[key] = entry
  else delete next[key]
  return next
}

/** Shows the item the owner opened in the group it was in, until another opens: the list does not move under them. */
export function withStickyGroup(items: InboxItem[], sticky: { key: string; group: InboxGroup } | null): InboxItem[] {
  if (!sticky) return items
  return items.map((item) =>
    item.key === sticky.key && item.group !== sticky.group ? { ...item, group: sticky.group } : item
  )
}

export interface InboxFilter {
  /** A place's key; null for every place. */
  place: string | null
  source: InboxSource | null
  query: string
}

function matches(item: InboxItem, query: string): boolean {
  if (!query) return true
  return [item.title, item.project, item.bot?.name, item.summary, item.place.label].some((text) =>
    text?.toLowerCase().includes(query)
  )
}

export function filterInbox(items: readonly InboxItem[], filter: InboxFilter): InboxItem[] {
  const query = filter.query.trim().toLowerCase()
  return items.filter(
    (item) =>
      (filter.place === null || item.place.key === filter.place) &&
      (filter.source === null || item.source === filter.source) &&
      matches(item, query)
  )
}

/** The places items belong to, with how many each has, in the order they first appear. */
export function inboxPlaces(items: readonly InboxItem[]): Array<InboxPlace & { count: number }> {
  const places = new Map<string, InboxPlace & { count: number }>()
  for (const item of items) {
    const place = places.get(item.place.key)
    if (place) place.count++
    else places.set(item.place.key, { ...item.place, count: 1 })
  }
  return [...places.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export function inboxSourceCounts(items: readonly InboxItem[]): Record<InboxSource | 'all', number> {
  const counts = { all: items.length, workspace: 0, chat: 0, bot: 0 }
  for (const item of items) counts[item.source]++
  return counts
}

/** What the rail counts: what waits for the owner, and what ended unread. */
export function inboxCounts(items: readonly InboxItem[]): { waiting: number; unread: number } {
  let waiting = 0
  let unread = 0
  for (const item of items) {
    if (item.group === 'waiting') waiting++
    else if (item.group === 'new') unread++
  }
  return { waiting, unread }
}

const KINDS: ReadonlySet<string> = new Set(['question', 'approval', 'plan', 'help', 'error', 'finished', 'activity'])
const SOURCES: ReadonlySet<string> = new Set(['workspace', 'chat', 'bot'])
const LANES: ReadonlySet<string> = new Set(['main', 'routine', 'thread'])
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isString = (value: unknown): value is string => typeof value === 'string'

function readView(value: unknown): InboxView | null {
  if (!value || typeof value !== 'object') return null
  const view = value as Record<string, unknown>
  const place = view.place as Record<string, unknown> | undefined
  const target = view.target as Record<string, unknown> | undefined
  const bot = view.bot as Record<string, unknown> | undefined
  if (!isString(view.source) || !SOURCES.has(view.source) || !isString(view.title)) return null
  if (!place || !isString(place.key) || !isString(place.label)) return null
  if (!target) return null
  let parsedTarget: InboxTarget
  if (target.kind === 'conversation' && isString(target.conversationId))
    parsedTarget = { kind: 'conversation', conversationId: target.conversationId }
  else if (target.kind === 'bot' && isString(target.serverId) && isString(target.botId))
    parsedTarget = {
      kind: 'bot',
      serverId: target.serverId as FleetServerId,
      botId: target.botId,
      ...(isString(target.runId) ? { runId: target.runId } : {}),
      ...(isString(target.threadId) ? { threadId: target.threadId } : {}),
      ...(isString(target.requestId) ? { requestId: target.requestId } : {}),
    }
  else return null
  return {
    source: view.source as InboxSource,
    title: view.title,
    ...(isString(view.project) ? { project: view.project } : {}),
    ...(bot && isString(bot.name) && isString(bot.lane) && LANES.has(bot.lane)
      ? { bot: { name: bot.name, tint: isString(bot.tint) ? bot.tint : null, lane: bot.lane as InboxLane } }
      : {}),
    summary: isString(view.summary) ? view.summary : null,
    place: { key: place.key, label: place.label },
    target: parsedTarget,
  }
}

/** The ledger as stored; what does not read back as an entry is left out. */
export function parseInboxLedger(raw: string | null): InboxLedger {
  if (!raw) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const ledger: Record<string, InboxEntry> = {}
  for (const [key, stored] of Object.entries(value as Record<string, unknown>)) {
    if (!stored || typeof stored !== 'object') continue
    const entry = stored as Record<string, unknown>
    const view = readView(entry.view)
    if (!view || !isString(entry.kind) || !KINDS.has(entry.kind) || !isNumber(entry.at)) continue
    ledger[key] = {
      kind: entry.kind as InboxKind,
      at: entry.at,
      readAt: isNumber(entry.readAt) ? entry.readAt : null,
      dismissedAt: isNumber(entry.dismissedAt) ? entry.dismissedAt : null,
      view,
      ...(entry.transient === true ? { transient: true } : {}),
    }
  }
  return ledger
}
