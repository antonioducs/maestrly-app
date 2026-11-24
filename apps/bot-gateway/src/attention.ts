import {
  FLEET_ATTENTION_LIMITS,
  fleetAttentionKey,
  parseFleetAttentionKey,
  type FleetAttentionEntry,
  type FleetAttentionKind,
  type FleetAttentionSeenRequest,
  type FleetAttentionSeenResponse,
  type FleetAttentionSnapshot,
  type FleetAttentionUpdatedEvent,
  type FleetChatAttentionKind,
  type FleetChatAttentionSnapshotItem,
  type FleetGatewayEvent,
  type FleetPendingInteraction,
} from '@maestrly/bot-fleet-protocol'

const CHAT_KIND_MAP: Record<FleetChatAttentionKind, FleetAttentionKind> = {
  waiting: 'approval',
  question: 'question',
  plan: 'plan',
  finished: 'finished',
  failed: 'error',
}

const REQUEST_KIND_MAP: Record<FleetPendingInteraction['kind'], FleetAttentionKind> = {
  permission: 'approval',
  question: 'question',
  help: 'help',
}

export interface AttentionPersistence {
  listAttentionEntries(): FleetAttentionEntry[]
  applyAttentionDelta(upsert: readonly FleetAttentionEntry[], remove: readonly string[]): void
  getBot(id: string): { name: string } | null
}

export interface AttentionStoreOptions {
  store: AttentionPersistence
  /** True only for environments whose running host advertises `FLEET_CHAT_ATTENTION_SYNC_CAPABILITY`. */
  environmentHasChatSync: (environmentId: string) => boolean
  /** Forwards seen chat keys to a workspaces host's `POST /v1/chat-attention/clear`. */
  clearChatAttention?: (environmentId: string, conversationIds: string[]) => Promise<string[]>
  onUpdate?: (event: FleetAttentionUpdatedEvent) => void
  now?: () => string
  maxEntries?: number
  /** Current pending interactions on startup; rebuilds `request` entries across gateway restarts. */
  initialInbox?: ReadonlyArray<{ botId: string; interaction: FleetPendingInteraction }>
}

function trimTitle(title: string): string {
  return title.slice(0, FLEET_ATTENTION_LIMITS.titleMax)
}

function entryEquals(a: FleetAttentionEntry, b: FleetAttentionEntry): boolean {
  return (
    a.key === b.key &&
    a.source === b.source &&
    a.kind === b.kind &&
    a.at === b.at &&
    a.title === b.title &&
    (a.environmentId ?? null) === (b.environmentId ?? null) &&
    (a.botId ?? null) === (b.botId ?? null) &&
    (a.conversationId ?? null) === (b.conversationId ?? null) &&
    (a.requestId ?? null) === (b.requestId ?? null) &&
    (a.runId ?? null) === (b.runId ?? null) &&
    (a.threadId ?? null) === (b.threadId ?? null)
  )
}

function oldestFirst(a: FleetAttentionEntry, b: FleetAttentionEntry): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

function newestFirst(a: FleetAttentionEntry, b: FleetAttentionEntry): number {
  if (a.at !== b.at) return a.at > b.at ? -1 : 1
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/**
 * Persisted source of "what needs the owner" on this server for phones: workspaces-host chats (only for hosts
 * advertising `chat-attention-sync`), bot turns/failures, and pending bot requests.
 */
export class AttentionStore {
  private readonly entries = new Map<string, FleetAttentionEntry>()
  private readonly now: () => string
  private readonly maxEntries: number

  constructor(private readonly deps: AttentionStoreOptions) {
    this.now = deps.now ?? (() => new Date().toISOString())
    this.maxEntries = deps.maxEntries ?? FLEET_ATTENTION_LIMITS.entriesMax
    for (const entry of deps.store.listAttentionEntries()) this.entries.set(entry.key, entry)
    if (this.entries.size > this.maxEntries) this.commit([], [], false)
    if (deps.initialInbox !== undefined) this.syncInbox(deps.initialInbox, false)
  }

  get size(): number {
    return this.entries.size
  }

  snapshot(): FleetAttentionSnapshot {
    return {
      entries: [...this.entries.values()].sort(newestFirst).map((entry) => ({ ...entry })),
      at: this.now(),
    }
  }

  /** Observes gateway events to keep bot turns, pending requests, and removals in sync. */
  observe(event: FleetGatewayEvent): void {
    if (event.type === 'inbox.updated') {
      this.syncInbox(event.items, true)
      return
    }
    if (event.type === 'bot.removed') {
      this.removeBot(event.botId)
      return
    }
    if (event.type === 'environment.removed') {
      this.removeEnvironment(event.environmentId)
      return
    }
    if (event.type !== 'activity' || !event.entry.botId) return
    const { botId, kind, at, data } = event.entry
    let attentionKind: FleetAttentionKind | null = null
    if (kind === 'turn_completed') {
      if (data.source === 'routine') {
        if (data.alert !== false) attentionKind = 'finished'
      } else if (data.source === 'owner') {
        attentionKind = 'finished'
      }
    } else if (kind === 'turn_failed' || kind === 'bot_failed') {
      attentionKind = 'error'
    }
    if (!attentionKind) return
    const bot = this.deps.store.getBot(botId)
    if (!bot) return
    const key = fleetAttentionKey.bot(botId)
    if (key.length > FLEET_ATTENTION_LIMITS.keyMax) return
    const threadId = typeof data.threadId === 'string' && data.threadId ? data.threadId : undefined
    // Peer thread turns carry the thread id in `event.runId` on the instance side; surface it as `threadId` only.
    const runId = !threadId && typeof data.runId === 'string' && data.runId ? data.runId : undefined
    const entry: FleetAttentionEntry = {
      key,
      source: 'bot',
      kind: attentionKind,
      at,
      title: trimTitle(bot.name),
      botId,
      ...(runId ? { runId } : {}),
      ...(threadId ? { threadId } : {}),
    }
    this.commit([entry], [], true)
  }

  /** Upserts a workspaces-host chat entry when the environment supports `chat-attention-sync`. */
  chatAttention(
    environmentId: string,
    conversationId: string,
    name: string,
    kind: FleetChatAttentionKind,
    at = this.now()
  ): void {
    if (!this.deps.environmentHasChatSync(environmentId)) return
    const key = fleetAttentionKey.chat(environmentId, conversationId)
    if (key.length > FLEET_ATTENTION_LIMITS.keyMax) return
    const entry: FleetAttentionEntry = {
      key,
      source: 'chat',
      kind: CHAT_KIND_MAP[kind],
      at,
      title: trimTitle(name),
      environmentId,
      conversationId,
    }
    this.commit([entry], [], true)
  }

  /** Removes a workspaces-host chat entry when the host reports it cleared. */
  chatAttentionCleared(environmentId: string, conversationId: string): void {
    if (!this.deps.environmentHasChatSync(environmentId)) return
    const key = fleetAttentionKey.chat(environmentId, conversationId)
    if (!this.entries.has(key)) return
    this.commit([], [key], true)
  }

  /**
   * Replaces all chat entries of `environmentId` with the host's connect snapshot. Entries of other environments,
   * bots, and requests are left untouched.
   */
  chatAttentionSnapshot(environmentId: string, conversations: readonly FleetChatAttentionSnapshotItem[]): void {
    if (!this.deps.environmentHasChatSync(environmentId)) return
    const desired = new Map<string, FleetAttentionEntry>()
    for (const item of conversations) {
      const key = fleetAttentionKey.chat(environmentId, item.conversationId)
      if (key.length > FLEET_ATTENTION_LIMITS.keyMax) continue
      const candidate: FleetAttentionEntry = {
        key,
        source: 'chat',
        kind: CHAT_KIND_MAP[item.kind],
        at: item.at,
        title: trimTitle(item.name),
        environmentId,
        conversationId: item.conversationId,
      }
      const existing = desired.get(key)
      if (!existing || existing.at <= candidate.at) desired.set(key, candidate)
    }
    const remove: string[] = []
    for (const [key, entry] of this.entries) {
      if (entry.source === 'chat' && entry.environmentId === environmentId && !desired.has(key)) remove.push(key)
    }
    this.commit([...desired.values()], remove, true)
  }

  /** Removes the bot entry and any pending request entries belonging to `botId`. */
  removeBot(botId: string): void {
    const remove: string[] = []
    for (const [key, entry] of this.entries) {
      if ((entry.source === 'bot' || entry.source === 'request') && entry.botId === botId) remove.push(key)
    }
    if (remove.length) this.commit([], remove, true)
  }

  /** Removes all chat entries belonging to `environmentId`. */
  removeEnvironment(environmentId: string): void {
    const remove: string[] = []
    for (const [key, entry] of this.entries) {
      if (entry.source === 'chat' && entry.environmentId === environmentId) remove.push(key)
    }
    if (remove.length) this.commit([], remove, true)
  }

  /** Rebuilds `request` entries to mirror the current pending inbox items. */
  syncInbox(items: ReadonlyArray<{ botId: string; interaction: FleetPendingInteraction }>, notify = true): void {
    const desired = new Map<string, FleetAttentionEntry>()
    for (const { botId, interaction } of items) {
      const key = fleetAttentionKey.request(botId, interaction.id)
      if (key.length > FLEET_ATTENTION_LIMITS.keyMax) continue
      const bot = this.deps.store.getBot(botId)
      const entry: FleetAttentionEntry = {
        key,
        source: 'request',
        kind: REQUEST_KIND_MAP[interaction.kind],
        at: interaction.at,
        title: trimTitle(bot?.name ?? botId),
        botId,
        requestId: interaction.id,
        ...(interaction.runId ? { runId: interaction.runId } : {}),
      }
      desired.set(key, entry)
    }
    const remove: string[] = []
    for (const [key, entry] of this.entries) {
      if (entry.source === 'request' && !desired.has(key)) remove.push(key)
    }
    this.commit([...desired.values()], remove, notify)
  }

  /**
   * Handles `POST /v1/attention/seen`:
   * - `bot:*` keys are removed locally if present.
   * - `request:*` keys are a no-op (they stay until answered).
   * - `chat:*` keys are grouped by environment and forwarded to each capable host's `chatAttentionClear`; the ids
   *   the host reports cleared (no longer needing the owner) are removed locally and emitted in a delta immediately.
   *   Unreachable hosts never fail the request; only keys actually cleared are returned.
   */
  async seen(request: FleetAttentionSeenRequest): Promise<FleetAttentionSeenResponse> {
    const uniqueKeys = [...new Set(request.keys)]
    const botKeysToRemove: string[] = []
    const chatsByEnv = new Map<string, string[]>()
    for (const key of uniqueKeys) {
      const parsed = parseFleetAttentionKey(key)
      if (!parsed) continue
      if (parsed.source === 'bot') {
        const existing = this.entries.get(key)
        if (existing?.source === 'bot') botKeysToRemove.push(key)
      } else if (parsed.source === 'chat') {
        if (!this.deps.environmentHasChatSync(parsed.environmentId)) continue
        if (parsed.conversationId.length > 200) continue
        const list = chatsByEnv.get(parsed.environmentId)
        if (list) list.push(parsed.conversationId)
        else chatsByEnv.set(parsed.environmentId, [parsed.conversationId])
      }
      // `request` keys intentionally stay until answered.
    }

    if (botKeysToRemove.length) this.commit([], botKeysToRemove, true)

    const clearedChatKeys: string[] = []
    if (chatsByEnv.size && this.deps.clearChatAttention) {
      const clearChat = this.deps.clearChatAttention
      const results = await Promise.all(
        [...chatsByEnv.entries()].map(async ([environmentId, conversationIds]) => {
          const requested = new Set(conversationIds)
          try {
            const clearedIds = await clearChat(environmentId, conversationIds)
            const keys: string[] = []
            const seenIds = new Set<string>()
            for (const conversationId of clearedIds) {
              if (!requested.has(conversationId) || seenIds.has(conversationId)) continue
              seenIds.add(conversationId)
              keys.push(fleetAttentionKey.chat(environmentId, conversationId))
            }
            return keys
          } catch {
            return []
          }
        })
      )
      for (const keys of results) clearedChatKeys.push(...keys)
    }

    if (clearedChatKeys.length) this.commit([], clearedChatKeys, true)

    return { cleared: [...botKeysToRemove, ...clearedChatKeys] }
  }

  private commit(upserts: readonly FleetAttentionEntry[], removals: readonly string[], notify: boolean): void {
    const existedBefore = new Set(this.entries.keys())
    const removedKeys = new Set<string>()
    const upsertedKeys = new Set<string>()

    for (const key of removals) {
      if (this.entries.delete(key)) removedKeys.add(key)
    }
    for (const entry of upserts) {
      const previous = this.entries.get(entry.key)
      if (previous && entryEquals(previous, entry)) continue
      this.entries.set(entry.key, entry)
      removedKeys.delete(entry.key)
      upsertedKeys.add(entry.key)
    }

    if (this.entries.size > this.maxEntries) {
      const overflow = this.entries.size - this.maxEntries
      const victims = [...this.entries.values()].sort(oldestFirst).slice(0, overflow)
      for (const victim of victims) {
        this.entries.delete(victim.key)
        if (upsertedKeys.has(victim.key)) {
          upsertedKeys.delete(victim.key)
          if (existedBefore.has(victim.key)) removedKeys.add(victim.key)
        } else {
          removedKeys.add(victim.key)
        }
      }
    }

    if (!upsertedKeys.size && !removedKeys.size) return

    const upsert = [...upsertedKeys].map((key) => this.entries.get(key)!)
    const remove = [...removedKeys]
    this.deps.store.applyAttentionDelta(upsert, remove)
    if (notify) this.deps.onUpdate?.({ type: 'attention.updated', upsert, remove })
  }
}
