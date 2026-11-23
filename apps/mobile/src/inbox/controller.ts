import {
  FLEET_ATTENTION_LIMITS,
  parseFleetAttentionKey,
  type FleetAttentionEntry,
  type FleetBot,
  type FleetInboxItem,
  type MobileLists,
} from '@maestrly/bot-fleet-protocol'
import {
  botRequestSummary,
  dismissInboxItem,
  inboxCounts,
  inboxItems,
  isWaitingKind,
  markInboxRead,
  parseInboxLedger,
  reconcileInbox,
  restoreInboxEntry,
  type InboxEntry,
  type InboxLane,
  type InboxLedger,
  type InboxObservation,
  type InboxSource,
  type InboxTarget,
} from '@maestrly/bot-fleet-protocol/inbox'
import { allConversations } from '../chats/state'
import type { KeyValueStore } from '../servers/registry'
import { computeBadgeOthers } from './badge-sync'
import {
  inboxItemKey,
  mobileInboxPlace,
  parseInboxItemKey,
  type InboxUndo,
  type MobileInboxItem,
  type MobileInboxServer,
} from './types'

/** AsyncStorage key where this phone's notifications-center ledger is kept. */
export const INBOX_LEDGER_KEY = 'inbox.ledger'
const DEFAULT_PERSIST_DEBOUNCE_MS = 300
const DEFAULT_TICK_MS = 60_000

export interface InboxServerInput {
  id: string
  name: string
  features: readonly string[]
  supportsAttention: boolean
  reachable: boolean
  loaded: boolean
  /** Active entries from `GET /v1/attention` + SSE deltas (when `supportsAttention` is true). */
  entries: ReadonlyMap<string, FleetAttentionEntry>
  /** Known environments for this server (`environmentId -> name`). */
  environments: ReadonlyMap<string, string>
  /** Optional active-server enrichment for bots, pending requests, and bridge chats. */
  bots?: readonly FleetBot[]
  inbox?: readonly FleetInboxItem[]
  activeEnvironmentId?: string | null
  chatLists?: MobileLists | null
  /** Fallback observations for an active server without `FLEET_ATTENTION_FEATURE`. */
  fallback?: readonly InboxObservation<string>[]
}

export interface InboxControllerState {
  items: MobileInboxItem[]
  counts: { waiting: number; unread: number; total: number }
  servers: MobileInboxServer[]
  badgeOthers: Record<string, number>
}

export interface InboxControllerOptions {
  kv: KeyValueStore
  /** Fires `POST /v1/attention/seen` for one attention-capable server with a batch of <= 200 raw keys. */
  sendSeen?: (serverId: string, keys: string[]) => Promise<void> | void
  /** Optional one-time ledger entries seeded when a server (e.g. demo) first appears with an empty ledger slice. */
  seedEntries?: (serverId: string, now: number) => InboxLedger<string> | null
  now?: () => number
  persistDebounceMs?: number
  tickMs?: number
}

export interface InboxController {
  getState(): InboxControllerState
  subscribe(listener: () => void): () => void
  /** Loads the persisted ledger from storage and starts the expiry tick. */
  start(): Promise<void>
  /** Replaces the current view of every paired server and recomputes items, counts and badgeOthers. */
  setServers(inputs: readonly InboxServerInput[]): void
  /** Forces a time-based recomputation (e.g. on foreground). */
  tick(): void
  markRead(keys: readonly string[]): void
  markAllRead(): void
  dismiss(key: string): InboxUndo
  restore(undo: InboxUndo): void
  /** Flushes any pending debounced ledger write immediately (e.g. on app background). */
  flushPersist(): Promise<void>
  stop(): void
}

interface ItemMeta {
  serverId: string
  serverName: string
  environmentId: string | null
  environmentName: string | null
  stale: boolean
}

function resolveEntryEnvironment(entry: FleetAttentionEntry, botsById: ReadonlyMap<string, FleetBot>): string | null {
  if (entry.environmentId) return entry.environmentId
  const parsed = parseFleetAttentionKey(entry.key)
  if (parsed?.source === 'chat') return parsed.environmentId
  if (entry.botId) return botsById.get(entry.botId)?.environmentId ?? null
  if (parsed && (parsed.source === 'bot' || parsed.source === 'request')) {
    return botsById.get(parsed.botId)?.environmentId ?? null
  }
  return null
}

function resolveLedgerEnvironment(
  serverId: string,
  entryKey: string,
  entry: InboxEntry<string>,
  botsById: ReadonlyMap<string, FleetBot>
): string | null {
  const parsed = parseFleetAttentionKey(entryKey)
  if (parsed?.source === 'chat') return parsed.environmentId
  const placePrefix = `${serverId}/`
  if (entry.view.place.key.startsWith(placePrefix)) return entry.view.place.key.slice(placePrefix.length)
  if (entry.view.target.kind === 'bot') return botsById.get(entry.view.target.botId)?.environmentId ?? null
  return null
}

function entryToObservation(
  server: InboxServerInput,
  entry: FleetAttentionEntry,
  ledger: InboxLedger<string>,
  botsById: ReadonlyMap<string, FleetBot>,
  requestsByKey: ReadonlyMap<string, FleetInboxItem>,
  chatsById: ReadonlyMap<string, { workspaceId: string | null; workspaceName: string | null }>
): { observation: InboxObservation<string>; meta: ItemMeta } {
  const key = inboxItemKey(server.id, entry.key)
  const parsedKey = parseFleetAttentionKey(entry.key)
  const environmentId = resolveEntryEnvironment(entry, botsById)
  const environmentName = environmentId ? (server.environments.get(environmentId) ?? null) : null
  const place = mobileInboxPlace(server.id, server.name, environmentId, environmentName, server.environments.size)
  const parsedAt = Date.parse(entry.at)
  const at = Number.isFinite(parsedAt) ? parsedAt : null

  let source: InboxSource
  let target: InboxTarget<string>
  let project: string | undefined
  let botView: { name: string; tint: string | null; lane: InboxLane } | undefined
  let summary: string | null = null

  if (entry.source === 'chat') {
    const conversationId = entry.conversationId ?? (parsedKey?.source === 'chat' ? parsedKey.conversationId : entry.key)
    const enriched =
      server.activeEnvironmentId && server.activeEnvironmentId === environmentId ? chatsById.get(conversationId) : null
    source = enriched?.workspaceId ? 'workspace' : 'chat'
    if (enriched?.workspaceName) project = enriched.workspaceName
    target = { kind: 'conversation', conversationId }
  } else {
    const botId =
      entry.botId ??
      (parsedKey && (parsedKey.source === 'bot' || parsedKey.source === 'request') ? parsedKey.botId : entry.key)
    const requestId = entry.requestId ?? (parsedKey?.source === 'request' ? parsedKey.requestId : undefined)
    const bot = botsById.get(botId)
    const lane: InboxLane = entry.runId ? 'routine' : entry.threadId ? 'thread' : 'main'
    source = 'bot'
    botView = { name: entry.title || bot?.name || botId, tint: bot?.tint ?? null, lane }
    if (entry.source === 'request') {
      const pending = requestsByKey.get(entry.key)
      if (pending) summary = botRequestSummary(pending)
    }
    target = {
      kind: 'bot',
      serverId: server.id,
      botId,
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(entry.threadId ? { threadId: entry.threadId } : {}),
      ...(requestId ? { requestId } : {}),
    }
  }

  const waiting = isWaitingKind(entry.kind)
  const existing = ledger[key]
  // For news (finished/error/activity), treat the entry as optimistically read if the local ledger already marked this
  // event read while waiting for the server's SSE removal; a newer timestamp reopens it via `unreadAgain`.
  const alreadyReadLocally =
    !waiting &&
    existing !== undefined &&
    existing.readAt !== null &&
    (at === null || at <= Math.max(existing.readAt, existing.at))

  const observation: InboxObservation<string> = {
    key,
    view: {
      source,
      title: entry.title || entry.botId || entry.conversationId || entry.key,
      ...(project ? { project } : {}),
      ...(botView ? { bot: botView } : {}),
      summary,
      place,
      target,
    },
    active: { kind: entry.kind, unread: waiting ? true : !alreadyReadLocally },
    at,
    ...(waiting ? { ownRead: true } : {}),
    ...(entry.source === 'request' ? { transient: true } : {}),
  }

  return {
    observation,
    meta: {
      serverId: server.id,
      serverName: server.name,
      environmentId,
      environmentName,
      stale: !server.reachable,
    },
  }
}

/** Chunks keys into batches of at most `FLEET_ATTENTION_LIMITS.seenKeysMax` (200) per server. */
export function batchSeenKeysByServer(
  keys: readonly string[],
  serversById: ReadonlyMap<string, Pick<InboxServerInput, 'supportsAttention'>>
): Array<{ serverId: string; keys: string[] }> {
  const grouped = new Map<string, Set<string>>()
  for (const key of keys) {
    const parsed = parseInboxItemKey(key)
    if (!parsed) continue
    const server = serversById.get(parsed.serverId)
    if (!server?.supportsAttention) continue
    let bucket = grouped.get(parsed.serverId)
    if (!bucket) {
      bucket = new Set()
      grouped.set(parsed.serverId, bucket)
    }
    bucket.add(parsed.entryKey)
  }
  const batches: Array<{ serverId: string; keys: string[] }> = []
  const max = FLEET_ATTENTION_LIMITS.seenKeysMax
  for (const [serverId, set] of grouped) {
    const all = [...set]
    for (let i = 0; i < all.length; i += max) {
      batches.push({ serverId, keys: all.slice(i, i + max) })
    }
  }
  return batches
}

/**
 * Pure-ish inbox controller managing the persisted ledger (`inbox.ledger`), merging attention snapshots and fallback
 * observations across all paired servers, and dispatching batched `POST /v1/attention/seen` calls.
 */
export function createInboxController(options: InboxControllerOptions): InboxController {
  const now = options.now ?? Date.now
  const persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS

  let ledger: InboxLedger<string> = {}
  let ledgerLoaded = false
  let serverInputs: readonly InboxServerInput[] = []
  let serversById = new Map<string, InboxServerInput>()
  const seededServers = new Set<string>()
  const listeners = new Set<() => void>()

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let persistPending = false
  let saving: Promise<void> = Promise.resolve()
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  let state: InboxControllerState = {
    items: [],
    counts: { waiting: 0, unread: 0, total: 0 },
    servers: [],
    badgeOthers: {},
  }

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const writeLedgerNow = (): Promise<void> => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (!persistPending) return saving
    persistPending = false
    const serialized = JSON.stringify(ledger)
    saving = saving.then(() => options.kv.set(INBOX_LEDGER_KEY, serialized)).catch(() => {})
    return saving
  }

  const schedulePersist = () => {
    if (stopped) return
    persistPending = true
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      void writeLedgerNow()
    }, persistDebounceMs)
  }

  const updateLedger = (next: InboxLedger<string>) => {
    if (next === ledger) return
    ledger = next
    if (ledgerLoaded) schedulePersist()
  }

  const maybeSeedServers = (currentNow: number) => {
    if (!options.seedEntries || !ledgerLoaded) return
    for (const server of serverInputs) {
      if (seededServers.has(server.id)) continue
      seededServers.add(server.id)
      const prefix = `${server.id}|`
      const hasAny = Object.keys(ledger).some((key) => key.startsWith(prefix))
      if (hasAny) continue
      const seed = options.seedEntries(server.id, currentNow)
      if (!seed || Object.keys(seed).length === 0) continue
      updateLedger({ ...seed, ...ledger })
    }
  }

  const buildObservations = (): {
    observations: InboxObservation<string>[]
    metaByKey: Map<string, ItemMeta>
  } => {
    const observations: InboxObservation<string>[] = []
    const metaByKey = new Map<string, ItemMeta>()

    for (const server of serverInputs) {
      const botsById = new Map((server.bots ?? []).map((bot) => [bot.id, bot]))
      const activeKeys = new Set<string>()

      if (server.supportsAttention) {
        const requestsByKey = new Map<string, FleetInboxItem>(
          (server.inbox ?? []).map((item) => [`request:${item.botId}/${item.interaction.id}`, item])
        )
        const chatsById = new Map(
          allConversations(server.chatLists ?? null).map((conv) => [
            conv.id,
            { workspaceId: conv.workspaceId, workspaceName: conv.workspaceName },
          ])
        )
        for (const entry of server.entries.values()) {
          const { observation, meta } = entryToObservation(server, entry, ledger, botsById, requestsByKey, chatsById)
          activeKeys.add(observation.key)
          observations.push(observation)
          metaByKey.set(observation.key, meta)
        }
      } else if (server.fallback) {
        for (const observation of server.fallback) {
          activeKeys.add(observation.key)
          observations.push(observation)
          const parsed = parseInboxItemKey(observation.key)
          const entryKey = parsed?.entryKey ?? ''
          const parsedEntry = parseFleetAttentionKey(entryKey)
          let environmentId: string | null = null
          if (parsedEntry?.source === 'chat') environmentId = parsedEntry.environmentId
          else if (observation.view.target.kind === 'bot') {
            environmentId = botsById.get(observation.view.target.botId)?.environmentId ?? null
          }
          const environmentName = environmentId ? (server.environments.get(environmentId) ?? null) : null
          metaByKey.set(observation.key, {
            serverId: server.id,
            serverName: server.name,
            environmentId,
            environmentName,
            stale: !server.reachable,
          })
        }
      }

      // Synthesize settled (`active: null`) observations for non-transient ledger entries of this server once loaded,
      // so items read locally or cleared on another device move into the `read` group and expire after INBOX_READ_TTL_MS.
      if (server.loaded) {
        const prefix = `${server.id}|`
        for (const [key, entry] of Object.entries(ledger)) {
          if (!key.startsWith(prefix) || activeKeys.has(key) || entry.transient) continue
          const entryKey = key.slice(prefix.length)
          const environmentId = resolveLedgerEnvironment(server.id, entryKey, entry, botsById)
          const environmentName = environmentId ? (server.environments.get(environmentId) ?? null) : null
          const place = mobileInboxPlace(
            server.id,
            server.name,
            environmentId,
            environmentName,
            server.environments.size
          )
          observations.push({
            key,
            view: { ...entry.view, place },
            active: null,
            at: entry.at,
            known: false,
          })
          metaByKey.set(key, {
            serverId: server.id,
            serverName: server.name,
            environmentId,
            environmentName,
            stale: !server.reachable,
          })
        }
      }
    }

    return { observations, metaByKey }
  }

  const recompute = () => {
    const currentNow = now()
    maybeSeedServers(currentNow)
    const { observations, metaByKey } = buildObservations()
    const reconciled = reconcileInbox(ledger, observations, currentNow)
    updateLedger(reconciled)

    const rawItems = inboxItems(ledger, observations, currentNow)
    const items: MobileInboxItem[] = rawItems.map((item) => {
      const meta = metaByKey.get(item.key)
      return {
        ...item,
        serverId: meta?.serverId ?? parseInboxItemKey(item.key)?.serverId ?? '',
        serverName: meta?.serverName ?? item.place.label,
        environmentId: meta?.environmentId ?? null,
        environmentName: meta?.environmentName ?? null,
        stale: meta?.stale ?? false,
      }
    })
    const { waiting, unread } = inboxCounts(items)
    const servers: MobileInboxServer[] = serverInputs.map((server) => ({
      id: server.id,
      name: server.name,
      reachable: server.reachable,
      supportsAttention: server.supportsAttention,
      environments: server.environments.size,
    }))
    const badgeOthers = computeBadgeOthers(serverInputs, items)

    state = {
      items,
      counts: { waiting, unread, total: waiting + unread },
      servers,
      badgeOthers,
    }
    notify()
  }

  const dispatchSeen = (keys: readonly string[]) => {
    if (!options.sendSeen || keys.length === 0) return
    for (const batch of batchSeenKeysByServer(keys, serversById)) {
      void Promise.resolve(options.sendSeen(batch.serverId, batch.keys)).catch(() => {})
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async start() {
      const raw = await options.kv.get(INBOX_LEDGER_KEY).catch(() => null)
      if (stopped) return
      const loaded = parseInboxLedger<string>(raw)
      ledgerLoaded = true
      // Keep any in-memory entries written before storage finished loading.
      if (Object.keys(loaded).length > 0) ledger = { ...loaded, ...ledger }
      recompute()
      if (!tickTimer && tickMs > 0) {
        tickTimer = setInterval(() => {
          if (!stopped) recompute()
        }, tickMs)
      }
    },
    setServers(inputs) {
      serverInputs = inputs
      serversById = new Map(inputs.map((server) => [server.id, server]))
      // Prune entries belonging to unpaired servers once the ledger has loaded.
      if (ledgerLoaded && inputs.length >= 0) {
        let next: Record<string, InboxEntry<string>> | null = null
        for (const key of Object.keys(ledger)) {
          const parsed = parseInboxItemKey(key)
          if (parsed && !serversById.has(parsed.serverId)) {
            next ??= { ...ledger }
            delete next[key]
          }
        }
        if (next) updateLedger(next)
      }
      recompute()
    },
    tick() {
      if (!stopped) recompute()
    },
    markRead(keys) {
      if (keys.length === 0) return
      const currentNow = now()
      const { observations } = buildObservations()
      const reconciled = reconcileInbox(ledger, observations, currentNow)
      updateLedger(markInboxRead(reconciled, keys, currentNow))
      recompute()
      dispatchSeen(keys)
    },
    markAllRead() {
      const unreadKeys = state.items.filter((item) => item.unread).map((item) => item.key)
      if (unreadKeys.length === 0) return
      const currentNow = now()
      const { observations } = buildObservations()
      const reconciled = reconcileInbox(ledger, observations, currentNow)
      updateLedger(markInboxRead(reconciled, unreadKeys, currentNow))
      recompute()
      dispatchSeen(unreadKeys)
    },
    dismiss(key) {
      const currentNow = now()
      const { observations } = buildObservations()
      const reconciled = reconcileInbox(ledger, observations, currentNow)
      const previous = reconciled[key]
      updateLedger(dismissInboxItem(reconciled, key, currentNow))
      recompute()
      return { key, entry: previous }
    },
    restore(undo) {
      updateLedger(restoreInboxEntry(ledger, undo.key, undo.entry))
      recompute()
    },
    flushPersist: writeLedgerNow,
    stop() {
      stopped = true
      if (tickTimer) clearInterval(tickTimer)
      tickTimer = null
      void writeLedgerNow()
    },
  }
}
