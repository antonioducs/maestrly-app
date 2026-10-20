import {
  FLEET_CANCEL_CONVERSATION_QUERY,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_PARALLEL_TURNS_FEATURE,
  FLEET_TRANSCRIPT_REASONING_FEATURE,
  fleetMetaFeatures,
  type FleetBot,
  type FleetGatewayEvent,
  type FleetInteractionResolution,
  type FleetPatchBotRequest,
  type FleetPeerThreadPatchRequest,
  type FleetPeerThreadSettings,
  type FleetRoutineRunSettings,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import type { KeyValueStore } from '../servers/registry'
import { sentMediaType, type OutboxAttachment } from './attachments'
import type { NewBotRequest } from './create-bot'
import { laneKey, type LaneRef } from './lanes'
import { afterSendFailure, MissingFileError, nextToSend, outboxEntriesSchema, type OutboxEntry } from './outbox'
import type { EventHandlers, FleetSource } from './source'
import { fleetReducer, initialFleetState, type FleetAction, type FleetState, type LanesSeen } from './state'

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
/** Runs one page of a bot's run history holds on the phone; the gateway allows up to 200. */
const RUNS_PAGE_SIZE = 100
/** Runs and threads remembered as seen per bot: the oldest are forgotten first. */
const SEEN_MAX = 500

const lanesSeenSchema = z.object({
  runs: z.record(z.string(), z.array(z.string())),
  threads: z.record(z.string(), z.record(z.string(), z.string())),
})

/** Where the phone keeps what the owner has seen of a server's side conversations. */
export const lanesSeenKey = (serverId: string) => `lanesSeen.${serverId}`

/** The gateway refuses a change to a run or a thread whose conversation works or is gone: the view says so. */
export class LaneConflictError extends Error {
  constructor() {
    super('conflict')
    this.name = 'LaneConflictError'
  }
}
const conflictOr = (error: unknown): never => {
  if (error instanceof Error && 'status' in error && (error as { status: unknown }).status === 409)
    throw new LaneConflictError()
  throw error
}

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
  const seenKey = lanesSeenKey(source.serverId)
  let state: FleetState = { ...initialFleetState, features: source.features }
  const listeners = new Set<() => void>()
  let stream: { close(): void; reconnectNow(): void } | null = null
  let openBotId: string | null = null
  // The run's or thread's conversation on screen, which reloads after a hello or a reset like the bot's own.
  let openLane: { botId: string; lane: LaneRef } | null = null
  let flushing = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let saving: Promise<void> = Promise.resolve()
  let savingSeen: Promise<void> = Promise.resolve()
  // Each hello may follow missed events: a transcript or a list loaded before the latest hello is reloaded when it is
  // shown again, a newer one is not. Keys are a bot's id for its transcript, `runs:`/`threads:` and a lane's key.
  let hellos = 0
  const loadedAtHello = new Map<string, number>()
  const fresh = (key: string) => (loadedAtHello.get(key) ?? -1) >= hellos
  let stopped = false
  // The last create request the server has not confirmed, with the idempotency key it was sent with.
  let unconfirmedCreate: { body: string; key: string } | null = null
  /**
   * What events said while a list or a page was loading, which the loaded copy may predate: removals and the inbox
   * for a refresh, transcript items for a bot's latest page or a side conversation's.
   */
  type Watch = { bots: Set<string>; environments: Set<string>; inbox: boolean; items: Map<string, FleetGatewayEvent[]> }
  const watches = new Set<Watch>()
  const watch = (): Watch => {
    const value: Watch = { bots: new Set(), environments: new Set(), inbox: false, items: new Map() }
    watches.add(value)
    return value
  }
  const watchedItem = (seen: Watch, key: string, event: FleetGatewayEvent) =>
    seen.items.set(key, [...(seen.items.get(key) ?? []), event])

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

  async function loadSeen() {
    const raw = await persistence.get(seenKey).catch(() => null)
    if (!raw) return
    try {
      const parsed = lanesSeenSchema.safeParse(JSON.parse(raw))
      if (parsed.success) dispatch({ type: 'seen', seen: parsed.data })
    } catch {
      // What was seen is forgotten rather than blocking the app: everything there counts as seen again.
    }
  }
  const setSeen = (seen: LanesSeen) => {
    dispatch({ type: 'seen', seen })
    const snapshot = JSON.stringify(seen)
    savingSeen = savingSeen.then(() => persistence.set(seenKey, snapshot)).catch(() => {})
    return savingSeen
  }
  const seenRuns = (botId: string, ids: string[]) =>
    setSeen({ ...state.seen, runs: { ...state.seen.runs, [botId]: ids.slice(-SEEN_MAX) } })
  const seenThreads = (botId: string, entries: Array<[string, string]>) =>
    setSeen({
      ...state.seen,
      threads: { ...state.seen.threads, [botId]: Object.fromEntries(entries.slice(-SEEN_MAX)) },
    })

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
    if (openBotId && !fresh(openBotId)) void loadLatest(openBotId)
    // The open bot's runs and threads show in its tabs: what changed while the stream was down shows at once.
    if (openBotId && state.runs[openBotId]?.loaded && !fresh(`runs:${openBotId}`)) void loadRuns(openBotId)
    if (openBotId && state.threads[openBotId]?.loaded && !fresh(`threads:${openBotId}`)) void loadThreads(openBotId)
    if (openLane && !fresh(laneKey(openLane.botId, openLane.lane.id))) void loadLane(openLane.botId, openLane.lane)
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

  /** A page of a bot's routine runs: the newest, or with `before` the ones before it. */
  async function loadRuns(botId: string, before?: string) {
    if (!before) loadedAtHello.set(`runs:${botId}`, hellos)
    dispatch({ type: 'runs-loading', botId })
    try {
      const page = await source.call('botRuns', {
        params: { id: botId },
        query: { limit: RUNS_PAGE_SIZE, ...(before ? { before } : {}) },
      })
      dispatch({ type: 'runs-page', botId, page, mode: before ? 'older' : 'latest' })
      // The first time a bot's runs are read, every run there counts as seen: only runs that end afterwards are new.
      if (!state.seen.runs[botId]) await seenRuns(botId, page.runs.map((run) => run.id).reverse())
    } catch {
      dispatch({ type: 'runs-failed', botId })
    }
  }

  async function loadThreads(botId: string) {
    loadedAtHello.set(`threads:${botId}`, hellos)
    dispatch({ type: 'threads-loading', botId })
    try {
      const { threads } = await source.call('botPeerThreads', { params: { id: botId } })
      dispatch({ type: 'threads-list', botId, threads })
      if (!state.seen.threads[botId])
        await seenThreads(
          botId,
          threads.map((thread) => [thread.id, thread.lastActivityAt])
        )
    } catch {
      dispatch({ type: 'threads-failed', botId })
    }
  }

  /** A run's or a thread's own conversation: its newest page, or with `before` the one before it. */
  async function loadLane(botId: string, lane: LaneRef, before?: string) {
    const key = laneKey(botId, lane.id)
    if (!before) loadedAtHello.set(key, hellos)
    dispatch({ type: 'lane-loading', key })
    const seen = before ? null : watch()
    try {
      const options = { query: transcriptQuery(before) }
      const page =
        lane.kind === 'run'
          ? await source.call('botRunTranscript', { params: { id: botId, runId: lane.id }, ...options })
          : await source.call('botPeerThreadTranscript', { params: { id: botId, threadId: lane.id }, ...options })
      dispatch({ type: 'lane-page', key, page, mode: before ? 'older' : 'latest' })
      for (const event of seen?.items.get(key) ?? []) dispatch({ type: 'event', event })
    } catch {
      dispatch({ type: 'lane-failed', key })
    } finally {
      if (seen) watches.delete(seen)
    }
  }

  /** What an owner's message to a run or a thread carries: its text and the files chosen on the phone. */
  async function messageBody(text: string, attachments: OutboxAttachment[]) {
    const files = await Promise.all(
      attachments.map(async (item) => {
        const dataBase64 = await source.readAttachment(item.uri).catch(() => {
          throw new MissingFileError(item.name)
        })
        return { name: item.name, kind: item.kind, mediaType: sentMediaType(item), dataBase64 }
      })
    )
    return { text, idempotencyKey: uuid(), attachments: files } as never
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
        else if (event.type === 'transcript.upsert') watchedItem(seen, event.botId, event)
        else if (event.type === 'routine_run.transcript.upsert')
          watchedItem(seen, laneKey(event.botId, event.runId), event)
        else if (event.type === 'peer_thread.transcript.upsert')
          watchedItem(seen, laneKey(event.botId, event.threadId), event)
      }
      dispatch({ type: 'event', event })
      if (event.type === 'hello') {
        hellos++
        void refresh()
      }
      if (event.type === 'transcript.reset' && event.botId === openBotId) {
        void loadLatest(event.botId)
        // The bot restarted or its stream broke: what its runs and threads did meanwhile is read again too.
        if (state.runs[event.botId]?.loaded) void loadRuns(event.botId)
        if (state.threads[event.botId]?.loaded) void loadThreads(event.botId)
      }
      if (event.type === 'transcript.reset' && openLane?.botId === event.botId)
        void loadLane(openLane.botId, openLane.lane)
      const reset =
        event.type === 'routine_run.transcript.reset'
          ? laneKey(event.botId, event.runId)
          : event.type === 'peer_thread.transcript.reset'
            ? laneKey(event.botId, event.threadId)
            : null
      if (reset && openLane && laneKey(openLane.botId, openLane.lane.id) === reset)
        void loadLane(openLane.botId, openLane.lane)
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
        body: {
          text: entry.text,
          idempotencyKey: entry.id,
          attachments,
          ...(entry.citation ? { citation: { runId: entry.citation } } : {}),
        } as never,
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
      await Promise.all([loadOutbox(), loadSeen()])
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
    /** A message to the bot's own conversation, sent in order once the server is reachable. */
    async send(
      botId: string,
      text: string,
      attachments: OutboxAttachment[],
      /** A routine run of the bot the message refers to: the bot reads its report and files to answer. */
      citation: string | null = null
    ): Promise<OutboxEntry> {
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
        ...(citation ? { citation } : {}),
      }
      await setOutbox([...state.outbox, entry])
      void flush()
      return entry
    },
    // --- Side conversations: routine runs (`routine-conversations`) and threads with other bots. ---
    /** Reads a bot's runs unless they are loaded and current. */
    ensureRuns(botId: string) {
      const current = state.runs[botId]
      if (current?.loading || (current?.loaded && fresh(`runs:${botId}`))) return
      void loadRuns(botId)
    },
    reloadRuns: (botId: string) => loadRuns(botId),
    loadOlderRuns(botId: string) {
      const current = state.runs[botId]
      if (!current?.loaded || current.loading || !current.before) return
      void loadRuns(botId, current.before)
    },
    ensureThreads(botId: string) {
      const current = state.threads[botId]
      if (current?.loading || (current?.loaded && fresh(`threads:${botId}`))) return
      void loadThreads(botId)
    },
    reloadThreads: (botId: string) => loadThreads(botId),
    /** Shows a run's or a thread's own conversation, read again unless it is loaded and current. */
    async openLane(botId: string, lane: LaneRef) {
      openLane = { botId, lane }
      const key = laneKey(botId, lane.id)
      const current = state.lanes[key]
      if (!current?.loaded || current.stale || !fresh(key)) await loadLane(botId, lane)
    },
    closeLane(botId: string, laneId: string) {
      if (openLane?.botId === botId && openLane.lane.id === laneId) openLane = null
    },
    reloadLane: (botId: string, lane: LaneRef) => loadLane(botId, lane),
    loadOlderLane(botId: string, lane: LaneRef) {
      const current = state.lanes[laneKey(botId, lane.id)]
      if (!current?.loaded || current.loading || !current.before) return
      void loadLane(botId, lane, current.before)
    },
    /**
     * The owner's message in a run's conversation (a change the bot makes there, with what the run did) or in a
     * thread's (the bot decides what to pass on to the other bot). Sent at once: these conversations have no outbox.
     */
    async sendLane(botId: string, lane: LaneRef, text: string, attachments: OutboxAttachment[]) {
      const body = await messageBody(text, attachments)
      if (lane.kind === 'run')
        await source.call('botRunMessageSend', { params: { id: botId, runId: lane.id }, body }).catch(conflictOr)
      else
        await source
          .call('botPeerThreadMessageSend', { params: { id: botId, threadId: lane.id }, body })
          .catch(conflictOr)
      void loadLane(botId, lane)
    },
    /** Stops the turn of one side conversation; the bot's own conversation and its other ones keep working. */
    async cancelLane(botId: string, laneId: string) {
      // A gateway without parallel turns runs one turn at a time: stopping the bot stops the run it works on.
      const query = has(FLEET_PARALLEL_TURNS_FEATURE) ? { [FLEET_CANCEL_CONVERSATION_QUERY]: laneId } : undefined
      await source.call('botCancel', { params: { id: botId }, query })
    },
    async pinRun(botId: string, runId: string, pinned: boolean) {
      const run = await source.call('botRunPatch', { params: { id: botId, runId }, body: { pinned } })
      dispatch({ type: 'run', botId, run })
    },
    /** Deletes a run's conversation: its report and its files stay. */
    async deleteRunConversation(botId: string, runId: string) {
      const run = await source.call('botRunConversationDelete', { params: { id: botId, runId } }).catch(conflictOr)
      dispatch({ type: 'run', botId, run })
    },
    /** Keeps a thread (`pinned`), or lets a paused one go on (`resume`). */
    async patchThread(botId: string, threadId: string, patch: FleetPeerThreadPatchRequest) {
      const thread = await source
        .call('botPeerThreadPatch', { params: { id: botId, threadId }, body: patch })
        .catch(conflictOr)
      dispatch({ type: 'thread', botId, thread })
    },
    async deleteThreadConversation(botId: string, threadId: string) {
      const thread = await source
        .call('botPeerThreadConversationDelete', { params: { id: botId, threadId } })
        .catch(conflictOr)
      dispatch({ type: 'thread', botId, thread })
    },
    async saveRunSettings(botId: string, settings: FleetRoutineRunSettings) {
      const runSettings = await source.call('botRunSettings', { params: { id: botId }, body: settings })
      const bot = state.bots.find((item) => item.id === botId)
      if (bot) applyBot({ ...bot, runSettings })
    },
    async saveThreadSettings(botId: string, settings: FleetPeerThreadSettings) {
      const peerSettings = await source.call('botPeerThreadSettings', { params: { id: botId }, body: settings })
      const bot = state.bots.find((item) => item.id === botId)
      if (bot) applyBot({ ...bot, peerSettings })
    },
    /** The owner opened a run: it no longer counts as new. A bot not read before counts all its runs as seen. */
    markRunSeen(botId: string, runId: string) {
      const seen = state.seen.runs[botId] ?? (state.runs[botId]?.runs ?? []).map((run) => run.id).reverse()
      if (!seen.includes(runId) || !state.seen.runs[botId])
        void seenRuns(botId, [...seen.filter((id) => id !== runId), runId])
    },
    /** The owner looked at a thread as it is now: only later activity counts as new. */
    markThreadSeen(botId: string, threadId: string, lastActivityAt: string) {
      const seen =
        state.seen.threads[botId] ??
        Object.fromEntries((state.threads[botId]?.threads ?? []).map((thread) => [thread.id, thread.lastActivityAt]))
      if (seen[threadId] === lastActivityAt && state.seen.threads[botId]) return
      const entries = Object.entries(seen).filter(([id]) => id !== threadId)
      void seenThreads(botId, [...entries, [threadId, lastActivityAt]])
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
      // Every action answers with the bot except cancel, which answers with nothing. The phone shows the bot's own
      // conversation: its Stop stops that conversation's turn, and the bot's routine runs keep working.
      const query =
        action === 'cancel' && has(FLEET_PARALLEL_TURNS_FEATURE)
          ? { [FLEET_CANCEL_CONVERSATION_QUERY]: 'primary' }
          : undefined
      const result = (await source.call(ACTION_ROUTES[action], { params: { id: botId }, query })) as
        | FleetBot
        | undefined
      if (result) applyBot(result)
    },
    async patchBot(botId: string, patch: FleetPatchBotRequest) {
      applyBot(await source.call('botPatch', { params: { id: botId }, body: patch }))
    },
    /**
     * Creates a bot in an existing environment. The same request tried again after a failure keeps its idempotency
     * key: when the server created the bot and only its answer was lost, it answers with that bot rather than another.
     */
    async createBot(request: NewBotRequest): Promise<FleetBot> {
      const body = JSON.stringify(request)
      const key = unconfirmedCreate?.body === body ? unconfirmedCreate.key : uuid()
      unconfirmedCreate = { body, key }
      const bot = await source.call('botsCreate', { body: { ...request, idempotencyKey: key } })
      unconfirmedCreate = null
      applyBot(bot)
      return bot
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
