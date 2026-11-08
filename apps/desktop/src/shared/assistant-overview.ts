import type { FleetBotStatus } from '@maestrly/bot-fleet-protocol'
import type { ConversationStatus } from './conversation'

/**
 * What the assistant sees across this computer, its remote workspaces hosts and its bot servers, in one compact
 * picture. Each item carries a `ref` the assistant's tools take to read or act on it.
 */
export type OverviewPlace =
  | { kind: 'local' }
  | { kind: 'host'; hostId: string; hostName: string }
  | { kind: 'bot-server'; serverId: string; serverName: string }

/** `local:<conversationId>`, `host:<hostId>:<conversationId>` or `bot:<serverId>:<botId>`. */
export type OverviewRef = string

export type ParsedOverviewRef =
  | { kind: 'local'; conversationId: string }
  | { kind: 'host'; hostId: string; conversationId: string }
  | { kind: 'bot'; serverId: string; botId: string }

const PART = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,299}$/

export const localRef = (conversationId: string): OverviewRef => `local:${conversationId}`
export const hostRef = (hostId: string, conversationId: string): OverviewRef => `host:${hostId}:${conversationId}`
export const botRef = (serverId: string, botId: string): OverviewRef => `bot:${serverId}:${botId}`

/** A ref from the overview, or a bare conversation id (taken as this computer's); null for anything else. */
export function parseOverviewRef(ref: string): ParsedOverviewRef | null {
  const value = ref.trim()
  if (ID.test(value) && !value.includes(':')) return { kind: 'local', conversationId: value }
  const at = value.indexOf(':')
  if (at < 0) return null
  const prefix = value.slice(0, at)
  const rest = value.slice(at + 1)
  if (prefix === 'local') return ID.test(rest) ? { kind: 'local', conversationId: rest } : null
  if (prefix !== 'host' && prefix !== 'bot') return null
  const split = rest.indexOf(':')
  if (split < 0) return null
  const owner = rest.slice(0, split)
  const id = rest.slice(split + 1)
  if (!PART.test(owner) || !ID.test(id)) return null
  return prefix === 'host'
    ? { kind: 'host', hostId: owner, conversationId: id }
    : { kind: 'bot', serverId: owner, botId: id }
}

export type OverviewNeed = 'question' | 'approval' | 'plan' | 'error'

export interface OverviewPending {
  /** What `respond_pending` takes; empty when the item cannot be answered from here (a remote host's). */
  itemId: string
  need: OverviewNeed
  /** At most 200 characters. */
  summary: string
}

export interface OverviewConversation {
  ref: OverviewRef
  name: string
  place: OverviewPlace
  workspaceName: string | null
  branch: string | null
  status: ConversationStatus
  running: boolean
  pending: OverviewPending[]
  /** A bot created it on this computer. */
  botCreated: boolean
  lastActivityAt: number | null
}

export interface OverviewBot {
  ref: OverviewRef
  name: string
  role: string | null
  place: OverviewPlace
  status: FleetBotStatus
  /** What it is doing now, in a few words. */
  activity: string | null
  pending: OverviewPending[]
  runningRoutine: string | null
}

export interface OverviewWorkspace {
  workspaceId: string
  name: string
  place: OverviewPlace
  conversations: number
  running: number
}

export interface OverviewHostState {
  place: OverviewPlace
  state: 'online' | 'offline' | 'unavailable'
  error?: string
}

export interface AssistantOverview {
  generatedAt: number
  /** What waits for the person: questions first, then approvals, plans and errors. */
  needsYou: Array<OverviewConversation | OverviewBot>
  running: OverviewConversation[]
  /** Conversations active in the last day, outside the lists above. */
  recent: OverviewConversation[]
  bots: OverviewBot[]
  workspaces: OverviewWorkspace[]
  hosts: OverviewHostState[]
  truncated: { needsYou: boolean; running: boolean; recent: boolean; bots: boolean }
}

export const OVERVIEW_SUMMARY_MAX = 200
export const OVERVIEW_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_LIMITS = { needsYou: 20, running: 20, recent: 10, bots: 30 }
const NEED_RANK: Record<OverviewNeed, number> = { question: 0, approval: 1, plan: 2, error: 3 }

export function overviewSummary(text: string | null | undefined): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > OVERVIEW_SUMMARY_MAX ? `${clean.slice(0, OVERVIEW_SUMMARY_MAX - 1)}…` : clean
}

const isBot = (item: OverviewConversation | OverviewBot): item is OverviewBot => item.ref.startsWith('bot:')

/** The most pressing thing an item needs; null when it needs nothing. */
function needOf(item: OverviewConversation | OverviewBot): OverviewNeed | null {
  let best: OverviewNeed | null = null
  for (const pending of item.pending)
    if (best === null || NEED_RANK[pending.need] < NEED_RANK[best]) best = pending.need
  if (best === null && !isBot(item) && item.status === 'error') return 'error'
  return best
}

function cap<T>(items: T[], limit: number): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, limit), truncated: items.length > limit }
}

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

export function placeName(place: OverviewPlace): string {
  if (place.kind === 'local') return 'this computer'
  return place.kind === 'host' ? place.hostName : place.serverName
}

/** Whether an item's name, workspace, host or bot server holds `query`, ignoring accents and case. */
export function matchesOverviewQuery(
  item: OverviewConversation | OverviewBot | OverviewWorkspace,
  query: string
): boolean {
  const needle = fold(query.trim())
  if (!needle) return true
  const fields = [item.name, placeName(item.place)]
  if ('workspaceName' in item && item.workspaceName) fields.push(item.workspaceName)
  if ('role' in item && item.role) fields.push(item.role)
  return fields.some((field) => fold(field).includes(needle))
}

/** How long ago, in a few words: "just now", "5 min ago", "3 h ago", "2 d ago". */
export function relativeAge(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** Drops nulls, empty strings, empty lists and false flags, so the model reads only what is there. */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(value)) {
      if (field === null || field === undefined || field === '' || field === false) continue
      if (Array.isArray(field) && field.length === 0) continue
      out[key] = prune(field)
    }
    return out
  }
  return value
}

function compactPending(pending: OverviewPending[]) {
  return pending.map((p) => ({ need: p.need, itemId: p.itemId, summary: p.summary }))
}

function compactConversation(c: OverviewConversation, now: number) {
  return {
    ref: c.ref,
    name: c.name,
    place: placeName(c.place),
    workspace: c.workspaceName,
    branch: c.branch,
    status: c.status,
    running: c.running,
    pending: compactPending(c.pending),
    createdByBot: c.botCreated,
    lastActivity: c.lastActivityAt ? relativeAge(c.lastActivityAt, now) : null,
  }
}

function compactBot(b: OverviewBot) {
  return {
    ref: b.ref,
    name: b.name,
    role: b.role,
    place: placeName(b.place),
    status: b.status,
    activity: b.activity,
    pending: compactPending(b.pending),
    runningRoutine: b.runningRoutine,
  }
}

const isBotItem = (item: OverviewConversation | OverviewBot): item is OverviewBot => item.ref.startsWith('bot:')

/** The overview as the assistant's tools return it: compact JSON with relative times and no empty fields. */
export function compactOverview(overview: AssistantOverview, now: number): Record<string, unknown> {
  const truncated = Object.entries(overview.truncated)
    .filter(([, cut]) => cut)
    .map(([list]) => list)
  return prune({
    needsYou: overview.needsYou.map((item) => (isBotItem(item) ? compactBot(item) : compactConversation(item, now))),
    running: overview.running.map((c) => compactConversation(c, now)),
    recent: overview.recent.map((c) => compactConversation(c, now)),
    bots: overview.bots.map(compactBot),
    workspaces: overview.workspaces.map((w) => ({
      name: w.name,
      place: placeName(w.place),
      conversations: w.conversations,
      running: w.running,
    })),
    hosts: overview.hosts.map((h) => ({
      place: placeName(h.place),
      kind: h.place.kind,
      state: h.state,
      error: h.error,
    })),
    truncated,
  }) as Record<string, unknown>
}

export function summarizeOverview(
  input: {
    conversations: OverviewConversation[]
    bots: OverviewBot[]
    workspaces: OverviewWorkspace[]
    hosts: OverviewHostState[]
    now: number
  },
  limits: Partial<typeof DEFAULT_LIMITS> = {}
): AssistantOverview {
  const max = { ...DEFAULT_LIMITS, ...limits }
  const activity = (item: OverviewConversation | OverviewBot) => (isBot(item) ? 0 : (item.lastActivityAt ?? 0))
  const waiting = [...input.conversations, ...input.bots]
    .map((item) => ({ item, need: needOf(item) }))
    .filter((entry): entry is { item: OverviewConversation | OverviewBot; need: OverviewNeed } => entry.need !== null)
    .sort((a, b) => NEED_RANK[a.need] - NEED_RANK[b.need] || activity(b.item) - activity(a.item))
    .map((entry) => entry.item)
  const waitingRefs = new Set(waiting.map((item) => item.ref))
  const byActivity = (a: OverviewConversation, b: OverviewConversation) =>
    (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
  const running = input.conversations.filter((c) => c.running && !waitingRefs.has(c.ref)).sort(byActivity)
  const runningRefs = new Set(running.map((c) => c.ref))
  const recent = input.conversations
    .filter(
      (c) =>
        !waitingRefs.has(c.ref) &&
        !runningRefs.has(c.ref) &&
        c.lastActivityAt !== null &&
        input.now - c.lastActivityAt <= OVERVIEW_RECENT_WINDOW_MS
    )
    .sort(byActivity)
  const needsYou = cap(waiting, max.needsYou)
  const runningCapped = cap(running, max.running)
  const recentCapped = cap(recent, max.recent)
  const bots = cap(input.bots, max.bots)
  return {
    generatedAt: input.now,
    needsYou: needsYou.items,
    running: runningCapped.items,
    recent: recentCapped.items,
    bots: bots.items,
    workspaces: input.workspaces,
    hosts: input.hosts,
    truncated: {
      needsYou: needsYou.truncated,
      running: runningCapped.truncated,
      recent: recentCapped.truncated,
      bots: bots.truncated,
    },
  }
}
