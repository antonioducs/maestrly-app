import {
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_TRANSCRIPT_REASONING_FEATURE,
  fleetMetaFeatures,
  type FleetBot,
  type FleetGatewayEvent,
  type FleetInteractionResolution,
  type FleetPatchBotRequest,
} from '@maestrly/bot-fleet-protocol'
import type { KeyValueStore } from '../servers/registry'
import { sentMediaType, type OutboxAttachment } from './attachments'
import { afterSendFailure, MissingFileError, nextToSend, outboxEntriesSchema, type OutboxEntry } from './outbox'
import type { EventHandlers, FleetSource } from './source'
import { fleetReducer, initialFleetState, type FleetAction, type FleetState } from './state'

export type BotAction = 'start' | 'stop' | 'restart' | 'pause' | 'resume' | 'cancel'
const ACTION_ROUTES = {
  start: 'botStart',
  stop: 'botStop',
  restart: 'botRestart',
  pause: 'botPause',
  resume: 'botResume',
  cancel: 'botCancel',
} as const
const PAGE_SIZE = 50

/** A version 4 UUID, the format the gateway requires for idempotency keys; the app passes expo-crypto's instead. */
function randomUuid(): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export type FleetControllerOptions = {
  uuid?: () => string
  now?: () => number
  /** How long a message waits before trying again after a server error. */
  retryMs?: number
  /** The server's features changed (it was updated); the registry keeps them for the next start. */
  onFeatures?: (features: string[]) => void
}

/**
 * Keeps one server's fleet live on the phone: the event stream, the snapshot it refreshes, the open bot's transcript,
 * and the messages written while offline, which it sends in order once the server is reachable.
 */
export function createFleetController(
  source: FleetSource,
  persistence: KeyValueStore,
  options: FleetControllerOptions = {}
) {
  const uuid = options.uuid ?? randomUuid
  const now = options.now ?? Date.now
  const retryMs = options.retryMs ?? 5_000
  const outboxKey = `outbox.${source.serverId}`
  let state: FleetState = { ...initialFleetState, features: source.features }
  const listeners = new Set<() => void>()
  let stream: { close(): void; reconnectNow(): void } | null = null
  let openBotId: string | null = null
  let flushing = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let saving: Promise<void> = Promise.resolve()
  // Each hello may follow missed events: a transcript loaded before the latest hello is reloaded, a newer one is not.
  let hellos = 0
  const loadedAtHello = new Map<string, number>()
  let stopped = false
  /**
   * What events said while a list or a page was loading, which the loaded copy may predate: removals and the inbox
   * for a refresh, transcript items for a bot's latest page.
   */
  type Watch = { bots: Set<string>; environments: Set<string>; inbox: boolean; items: Map<string, FleetGatewayEvent[]> }
  const watches = new Set<Watch>()
  const watch = (): Watch => {
    const value: Watch = { bots: new Set(), environments: new Set(), inbox: false, items: new Map() }
    watches.add(value)
    return value
  }

  const dispatch = (action: FleetAction) => {
    state = fleetReducer(state, action)
    for (const listener of listeners) listener()
  }
  const has = (feature: string) => state.features.includes(feature)

  // Writes are queued so the stored list always ends as the last state written.
  const persist = () => {
    const snapshot = JSON.stringify(state.outbox)
    saving = saving.then(() => persistence.set(outboxKey, snapshot)).catch(() => {})
    return saving
  }
  const setOutbox = (entries: OutboxEntry[]) => {
    dispatch({ type: 'outbox', entries })
    return persist()
  }
  const replaceEntry = (entry: OutboxEntry) =>
    setOutbox(state.outbox.map((item) => (item.id === entry.id ? entry : item)))

  async function loadOutbox() {
    const raw = await persistence.get(outboxKey).catch(() => null)
    if (!raw) return
    try {
      const parsed = outboxEntriesSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) return
      // A send cut off by the app closing is sent again: its idempotency key keeps the server from doubling it.
      dispatch({
        type: 'outbox',
        entries: parsed.data.map((entry) => (entry.state === 'sending' ? { ...entry, state: 'waiting' } : entry)),
      })
    } catch {
      // A damaged list is dropped rather than blocking the app.
    }
  }

  async function refresh() {
    const seen = watch()
    try {
      const [meta, bots, environments, inbox] = await Promise.all([
        source.call('meta').catch(() => null),
        source.call('botsList'),
        has(FLEET_ENVIRONMENTS_FEATURE) ? source.call('environmentsList') : Promise.resolve({ environments: [] }),
        source.call('inbox'),
      ])
      const features = meta ? fleetMetaFeatures(meta) : null
      if (features && features.join() !== state.features.join()) {
        dispatch({ type: 'features', features })
        options.onFeatures?.(features)
      }
      dispatch({
        type: 'snapshot',
        bots: bots.bots.filter(
          (bot) => !seen.bots.has(bot.id) && !(bot.environmentId && seen.environments.has(bot.environmentId))
        ),
        environments: environments.environments.filter((item) => !seen.environments.has(item.id)),
        inbox: seen.inbox ? state.inbox : inbox.items,
      })
    } catch {
      // The stream reconnects and says hello again, which refreshes again.
    } finally {
      watches.delete(seen)
    }
    if (stopped) return
    if (openBotId && (loadedAtHello.get(openBotId) ?? -1) < hellos) void loadLatest(openBotId)
    void flush()
  }

  const transcriptQuery = (before?: string) => ({
    ...(before ? { before } : {}),
    limit: PAGE_SIZE,
    ...(has(FLEET_TRANSCRIPT_REASONING_FEATURE) ? { reasoning: 1 } : {}),
  })

  async function loadLatest(botId: string) {
    loadedAtHello.set(botId, hellos)
    dispatch({ type: 'transcript-loading', botId })
    const seen = watch()
    try {
      const page = await source.call('botTranscript', { params: { id: botId }, query: transcriptQuery() })
      dispatch({ type: 'transcript-page', botId, page, mode: 'latest' })
      // Items that changed while the page was on its way are newer than the page's copies.
      for (const event of seen.items.get(botId) ?? []) dispatch({ type: 'event', event })
    } catch {
      dispatch({ type: 'transcript-failed', botId })
    } finally {
      watches.delete(seen)
    }
  }

  const handlers: EventHandlers = {
    onState(next, detail) {
      dispatch({ type: 'connection', state: next, retryAt: detail ? now() + detail.retryInMs : null })
    },
    onEvent(event) {
      for (const seen of watches) {
        if (event.type === 'bot.removed') seen.bots.add(event.botId)
        else if (event.type === 'bot.updated' && event.bot.lifecycle === 'archived') seen.bots.add(event.bot.id)
        else if (event.type === 'environment.removed') seen.environments.add(event.environmentId)
        else if (event.type === 'environment.updated' && event.environment.lifecycle === 'archived')
          seen.environments.add(event.environment.id)
        else if (event.type === 'inbox.updated') seen.inbox = true
        else if (event.type === 'transcript.upsert')
          seen.items.set(event.botId, [...(seen.items.get(event.botId) ?? []), event])
      }
      dispatch({ type: 'event', event })
      if (event.type === 'hello') {
        hellos++
        void refresh()
      }
      if (event.type === 'transcript.reset' && event.botId === openBotId) void loadLatest(event.botId)
    },
  }

  async function sendOne(entry: OutboxEntry) {
    await replaceEntry({ ...entry, state: 'sending' })
    try {
      const attachments = await Promise.all(
        entry.attachments.map(async (item) => {
          const dataBase64 = await source.readAttachment(item.uri).catch(() => {
            throw new MissingFileError(item.name)
          })
          return { name: item.name, kind: item.kind, mediaType: sentMediaType(item), dataBase64 }
        })
      )
      await source.call('botMessageSend', {
        params: { id: entry.botId },
        body: { text: entry.text, idempotencyKey: entry.id, attachments } as never,
      })
      await setOutbox(state.outbox.filter((item) => item.id !== entry.id))
    } catch (error) {
      const current = state.outbox.find((item) => item.id === entry.id)
      if (current) await replaceEntry(afterSendFailure(current, error))
    }
  }

  async function flush() {
    if (flushing || state.connection !== 'open') return
    flushing = true
    const tried = new Set<string>()
    try {
      for (;;) {
        const batch = nextToSend(state.outbox, source.serverId).filter((entry) => !tried.has(entry.id))
        if (batch.length === 0 || state.connection !== 'open') break
        for (const entry of batch) tried.add(entry.id)
        await Promise.all(batch.map(sendOne))
      }
    } finally {
      flushing = false
    }
    // Messages that met a passing server error try again a little later; network errors wait for the next hello.
    const again = nextToSend(state.outbox, source.serverId).some((entry) => entry.attempts > 0)
    if (again && !retryTimer)
      retryTimer = setTimeout(() => {
        retryTimer = null
        void flush()
      }, retryMs)
  }

  const applyBot = (bot: FleetBot) =>
    dispatch({ type: 'event', event: { type: 'bot.updated', at: new Date(now()).toISOString(), bot } })

  const openStream = () => {
    stream = source.openEvents(handlers)
  }

  return {
    source,
    store: {
      getState: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    async start() {
      await loadOutbox()
      // Stopped while the stored messages were loading: the app moved to another server.
      if (!stream && !stopped) openStream()
    },
    stop() {
      stopped = true
      stream?.close()
      stream = null
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
    },
    /** The app came back to the screen: reconnect at once rather than wait for the backoff. */
    foreground() {
      if (stopped) return
      if (!stream) openStream()
      else stream.reconnectNow()
    },
    /** iOS suspends background apps and their connections; close the stream rather than leave it to time out. */
    background() {
      stream?.close()
      stream = null
    },
    async openBot(botId: string) {
      openBotId = botId
      const current = state.transcripts[botId]
      if (!current?.loaded || current.stale) await loadLatest(botId)
    },
    closeBot() {
      openBotId = null
    },
    async loadOlder(botId: string) {
      const current = state.transcripts[botId]
      if (!current?.loaded || current.loading || !current.before) return
      dispatch({ type: 'transcript-loading', botId })
      try {
        const page = await source.call('botTranscript', {
          params: { id: botId },
          query: transcriptQuery(current.before),
        })
        dispatch({ type: 'transcript-page', botId, page, mode: 'older' })
      } catch {
        dispatch({ type: 'transcript-failed', botId })
      }
    },
    async send(botId: string, text: string, attachments: OutboxAttachment[]): Promise<OutboxEntry> {
      const entry: OutboxEntry = {
        id: uuid(),
        serverId: source.serverId,
        botId,
        text,
        attachments,
        createdAt: new Date(now()).toISOString(),
        state: 'waiting',
        error: null,
        attempts: 0,
      }
      await setOutbox([...state.outbox, entry])
      void flush()
      return entry
    },
    async retryOutbox(id: string) {
      const entry = state.outbox.find((item) => item.id === id)
      if (!entry) return
      await replaceEntry({ ...entry, state: 'waiting', error: null, attempts: 0 })
      void flush()
    },
    deleteOutbox(id: string) {
      return setOutbox(state.outbox.filter((item) => item.id !== id))
    },
    /**
     * The owner's last message, edited (`message-edit`): the bot's conversation is cut from it and the new text runs
     * as a new turn. The message keeps its attachments.
     */
    async edit(botId: string, itemId: string, text: string) {
      await source.call('botMessageEdit', {
        params: { id: botId, inputId: itemId.replace(/^input:/, '') },
        body: { text, idempotencyKey: uuid() },
      })
      await loadLatest(botId)
    },
    resolve(botId: string, interactionId: string, resolution: FleetInteractionResolution) {
      return source.call('botInteractionResolve', { params: { id: botId, interactionId }, body: resolution })
    },
    async action(botId: string, action: BotAction) {
      // Every action answers with the bot except cancel, which answers with nothing.
      const result = (await source.call(ACTION_ROUTES[action], { params: { id: botId } })) as FleetBot | undefined
      if (result) applyBot(result)
    },
    async patchBot(botId: string, patch: FleetPatchBotRequest) {
      applyBot(await source.call('botPatch', { params: { id: botId }, body: patch }))
    },
    /**
     * Summarizes the bot's conversation with its compaction model. The bot answers at once; progress shows in its
     * activity and the summary arrives in the transcript.
     */
    compact(botId: string) {
      return conversationOp(botId, 'chatCompact')
    },
    /** Prepares the background summary again after it failed. */
    retryBackgroundCompaction(botId: string) {
      return conversationOp(botId, 'chatBackgroundCompactionRetry')
    },
  }

  async function conversationOp(botId: string, op: 'chatCompact' | 'chatBackgroundCompactionRetry') {
    const { result } = await source.call('botConversationCall', { params: { id: botId }, body: { op, args: [] } })
    const answer = result as { ok?: unknown; error?: unknown } | null
    if (answer?.ok === true) return
    throw new BotCompactError(
      answer?.error === 'busy' ? 'busy' : answer?.error === 'not-configured' ? 'notConfigured' : 'failed'
    )
  }
}

export type BotCompactIssue = 'busy' | 'notConfigured' | 'failed'
export class BotCompactError extends Error {
  constructor(readonly issue: BotCompactIssue) {
    super(issue)
    this.name = 'BotCompactError'
  }
}

export type FleetController = ReturnType<typeof createFleetController>
