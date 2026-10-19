import {
  compareFleetTranscriptItems,
  type FleetBot,
  type FleetEnvironment,
  type FleetGatewayEvent,
  type FleetInboxItem,
  type FleetPeerThread,
  type FleetRoutineRun,
  type FleetRoutineRunPage,
  type FleetTranscriptItem,
  type FleetTranscriptPage,
} from '@maestrly/bot-fleet-protocol'
import type { StreamState } from '../gateway/event-stream'
import { botOfLaneKey, laneKey, sortRuns, sortThreads } from './lanes'
import type { OutboxEntry } from './outbox'

export type TranscriptState = {
  items: FleetTranscriptItem[]
  before: string | null
  loading: boolean
  /** The server reset this conversation; the open view reloads it. */
  stale: boolean
  loaded: boolean
  /** The last load failed; the view offers to try again. */
  failed: boolean
}

/** A bot's routine runs (`routine-conversations`), newest first, as far back as loaded. */
export type RunsState = {
  runs: FleetRoutineRun[]
  before: string | null
  loaded: boolean
  loading: boolean
  failed: boolean
}

/** A bot's conversations with other bots (`peer-conversations`), the most recently active first. */
export type ThreadsState = { threads: FleetPeerThread[]; loaded: boolean; loading: boolean; failed: boolean }

/**
 * What the owner has seen of each bot's side conversations, kept on the phone: the runs they opened, and each
 * thread's last activity when they last looked at it. A bot absent from it has not been read yet.
 */
export type LanesSeen = { runs: Record<string, string[]>; threads: Record<string, Record<string, string>> }

export type FleetState = {
  connection: StreamState
  /** When the stream tries again, while it is `retrying`. */
  retryAt: number | null
  /** The first list of bots arrived from the server. */
  loaded: boolean
  features: string[]
  bots: FleetBot[]
  environments: FleetEnvironment[]
  inbox: FleetInboxItem[]
  transcripts: Record<string, TranscriptState>
  outbox: OutboxEntry[]
  runs: Record<string, RunsState>
  threads: Record<string, ThreadsState>
  /** The transcripts of runs' and threads' own conversations, by `laneKey`. */
  lanes: Record<string, TranscriptState>
  seen: LanesSeen
}

export type FleetAction =
  | { type: 'snapshot'; bots: FleetBot[]; environments: FleetEnvironment[]; inbox: FleetInboxItem[] }
  | { type: 'event'; event: FleetGatewayEvent }
  | { type: 'connection'; state: StreamState; retryAt: number | null }
  | { type: 'features'; features: string[] }
  | { type: 'transcript-loading'; botId: string }
  | { type: 'transcript-failed'; botId: string }
  | { type: 'transcript-page'; botId: string; page: FleetTranscriptPage; mode: 'latest' | 'older' }
  | { type: 'outbox'; entries: OutboxEntry[] }
  | { type: 'runs-loading'; botId: string }
  | { type: 'runs-failed'; botId: string }
  | { type: 'runs-page'; botId: string; page: FleetRoutineRunPage; mode: 'latest' | 'older' }
  | { type: 'run'; botId: string; run: FleetRoutineRun }
  | { type: 'threads-loading'; botId: string }
  | { type: 'threads-failed'; botId: string }
  | { type: 'threads-list'; botId: string; threads: FleetPeerThread[] }
  | { type: 'thread'; botId: string; thread: FleetPeerThread }
  | { type: 'lane-loading'; key: string }
  | { type: 'lane-failed'; key: string }
  | { type: 'lane-page'; key: string; page: FleetTranscriptPage; mode: 'latest' | 'older' }
  | { type: 'seen'; seen: LanesSeen }

export const initialFleetState: FleetState = {
  connection: 'connecting',
  retryAt: null,
  loaded: false,
  features: [],
  bots: [],
  environments: [],
  inbox: [],
  transcripts: {},
  outbox: [],
  runs: {},
  threads: {},
  lanes: {},
  seen: { runs: {}, threads: {} },
}

export const emptyTranscript: TranscriptState = {
  items: [],
  before: null,
  loading: false,
  stale: false,
  loaded: false,
  failed: false,
}
export const emptyRuns: RunsState = { runs: [], before: null, loaded: false, loading: false, failed: false }
export const emptyThreads: ThreadsState = { threads: [], loaded: false, loading: false, failed: false }

/** Items by id, in transcript order: a newer copy of an item replaces the older one. */
function merge(existing: FleetTranscriptItem[], incoming: FleetTranscriptItem[]): FleetTranscriptItem[] {
  const items = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) items.set(item.id, item)
  return [...items.values()].sort(compareFleetTranscriptItems)
}

function withPage(previous: TranscriptState, page: FleetTranscriptPage, mode: 'latest' | 'older'): TranscriptState {
  const items = mode === 'older' ? merge(previous.items, page.items) : [...page.items].sort(compareFleetTranscriptItems)
  return { items, before: page.before, loading: false, stale: false, loaded: true, failed: false }
}

function upsertById<T extends { id: string }>(list: T[], value: T): T[] {
  const at = list.findIndex((item) => item.id === value.id)
  if (at < 0) return [...list, value]
  const next = list.slice()
  next[at] = value
  return next
}

const without = <T>(record: Record<string, T>, gone: (key: string) => boolean): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !gone(key)))

function withoutBots(state: FleetState, gone: (bot: Pick<FleetBot, 'id' | 'environmentId'>) => boolean): FleetState {
  const ids = new Set(state.bots.filter(gone).map((bot) => bot.id))
  if (ids.size === 0) return state
  return {
    ...state,
    bots: state.bots.filter((bot) => !ids.has(bot.id)),
    inbox: state.inbox.filter((item) => !ids.has(item.botId)),
    transcripts: without(state.transcripts, (botId) => ids.has(botId)),
    runs: without(state.runs, (botId) => ids.has(botId)),
    threads: without(state.threads, (botId) => ids.has(botId)),
    lanes: without(state.lanes, (key) => ids.has(botOfLaneKey(key))),
  }
}
const withoutBot = (state: FleetState, botId: string) => withoutBots(state, (bot) => bot.id === botId)
/** An environment that goes away takes its bots with it; the server sends no event for each of them. */
const withoutEnvironment = (state: FleetState, environmentId: string): FleetState =>
  withoutBots(
    { ...state, environments: state.environments.filter((item) => item.id !== environmentId) },
    (bot) => bot.environmentId === environmentId
  )

/**
 * The listed copies, except where the phone already holds a newer one: events that arrive while a list is loading
 * describe a later state than the list.
 */
function newest<T extends { id: string; updatedAt: string }>(current: T[], listed: T[]): T[] {
  const known = new Map(current.map((item) => [item.id, item]))
  return listed.map((item) => {
    const mine = known.get(item.id)
    return mine && Date.parse(mine.updatedAt) > Date.parse(item.updatedAt) ? mine : item
  })
}

/** A run joins a loaded list, or replaces its older copy there; an unloaded list waits for its first page. */
function upsertRun(state: FleetState, botId: string, run: FleetRoutineRun): FleetState {
  const previous = state.runs[botId]
  if (!previous?.loaded) return state
  const runs = sortRuns([...previous.runs.filter((item) => item.id !== run.id), run])
  return { ...state, runs: { ...state.runs, [botId]: { ...previous, runs } } }
}

function upsertThread(state: FleetState, botId: string, thread: FleetPeerThread): FleetState {
  const previous = state.threads[botId]
  if (!previous?.loaded) return state
  const threads = sortThreads([...previous.threads.filter((item) => item.id !== thread.id), thread])
  return { ...state, threads: { ...state.threads, [botId]: { ...previous, threads } } }
}

function laneItem(state: FleetState, key: string, item: FleetTranscriptItem): FleetState {
  const previous = state.lanes[key]
  if (!previous?.loaded) return state
  return { ...state, lanes: { ...state.lanes, [key]: { ...previous, items: merge(previous.items, [item]) } } }
}

function laneStale(state: FleetState, key: string): FleetState {
  const previous = state.lanes[key]
  if (!previous) return state
  return { ...state, lanes: { ...state.lanes, [key]: { ...previous, stale: true } } }
}

function applyEvent(state: FleetState, event: FleetGatewayEvent): FleetState {
  switch (event.type) {
    case 'bot.updated':
      // An archive reply can arrive after `bot.removed`: an archived bot is never listed.
      return event.bot.lifecycle === 'archived'
        ? withoutBot(state, event.bot.id)
        : { ...state, bots: upsertById(state.bots, event.bot) }
    case 'bot.removed':
      return withoutBot(state, event.botId)
    case 'environment.updated':
      return event.environment.lifecycle === 'archived'
        ? withoutEnvironment(state, event.environment.id)
        : { ...state, environments: upsertById(state.environments, event.environment) }
    case 'environment.removed':
      return withoutEnvironment(state, event.environmentId)
    case 'inbox.updated':
      return { ...state, inbox: event.items }
    case 'transcript.upsert': {
      const previous = state.transcripts[event.botId]
      if (!previous?.loaded) return state
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [event.botId]: { ...previous, items: merge(previous.items, [event.item]) },
        },
      }
    }
    case 'transcript.reset': {
      const previous = state.transcripts[event.botId]
      if (!previous) return state
      return { ...state, transcripts: { ...state.transcripts, [event.botId]: { ...previous, stale: true } } }
    }
    case 'routine_run.updated':
      return upsertRun(state, event.botId, event.run)
    case 'routine_run.removed': {
      const previous = state.runs[event.botId]
      const key = laneKey(event.botId, event.runId)
      return {
        ...state,
        runs: previous
          ? {
              ...state.runs,
              [event.botId]: { ...previous, runs: previous.runs.filter((run) => run.id !== event.runId) },
            }
          : state.runs,
        lanes: without(state.lanes, (lane) => lane === key),
      }
    }
    case 'routine_run.transcript.upsert':
      return laneItem(state, laneKey(event.botId, event.runId), event.item)
    case 'routine_run.transcript.reset':
      return laneStale(state, laneKey(event.botId, event.runId))
    case 'peer_thread.updated':
      return upsertThread(state, event.botId, event.thread)
    case 'peer_thread.removed': {
      const previous = state.threads[event.botId]
      const key = laneKey(event.botId, event.threadId)
      return {
        ...state,
        threads: previous
          ? {
              ...state.threads,
              [event.botId]: {
                ...previous,
                threads: previous.threads.filter((thread) => thread.id !== event.threadId),
              },
            }
          : state.threads,
        lanes: without(state.lanes, (lane) => lane === key),
      }
    }
    case 'peer_thread.transcript.upsert':
      return laneItem(state, laneKey(event.botId, event.threadId), event.item)
    case 'peer_thread.transcript.reset':
      return laneStale(state, laneKey(event.botId, event.threadId))
    default:
      return state
  }
}

export function fleetReducer(state: FleetState, action: FleetAction): FleetState {
  switch (action.type) {
    case 'snapshot':
      return {
        ...state,
        loaded: true,
        bots: newest(state.bots, action.bots),
        environments: newest(state.environments, action.environments),
        inbox: action.inbox,
      }
    case 'event':
      return applyEvent(state, action.event)
    case 'connection':
      return { ...state, connection: action.state, retryAt: action.retryAt }
    case 'features':
      return { ...state, features: action.features }
    case 'transcript-loading': {
      const previous = state.transcripts[action.botId] ?? emptyTranscript
      return { ...state, transcripts: { ...state.transcripts, [action.botId]: { ...previous, loading: true } } }
    }
    case 'transcript-failed': {
      const previous = state.transcripts[action.botId] ?? emptyTranscript
      return {
        ...state,
        transcripts: { ...state.transcripts, [action.botId]: { ...previous, loading: false, failed: true } },
      }
    }
    case 'transcript-page': {
      const previous = state.transcripts[action.botId] ?? emptyTranscript
      return {
        ...state,
        transcripts: { ...state.transcripts, [action.botId]: withPage(previous, action.page, action.mode) },
      }
    }
    case 'outbox':
      return { ...state, outbox: action.entries }
    case 'runs-loading':
    case 'runs-failed': {
      const previous = state.runs[action.botId] ?? emptyRuns
      const loading = action.type === 'runs-loading'
      return { ...state, runs: { ...state.runs, [action.botId]: { ...previous, loading, failed: !loading } } }
    }
    case 'runs-page': {
      const previous = state.runs[action.botId] ?? emptyRuns
      // A first page replaces what it covers; runs older than it, loaded before, stay.
      const oldest = action.page.runs.at(-1)?.deliveredAt
      const kept =
        action.mode === 'older'
          ? previous.runs
          : oldest && action.page.before
            ? previous.runs.filter((run) => run.deliveredAt < oldest)
            : []
      const byId = new Map([...kept, ...action.page.runs].map((run) => [run.id, run]))
      return {
        ...state,
        runs: {
          ...state.runs,
          [action.botId]: {
            runs: sortRuns([...byId.values()]),
            before: action.mode === 'older' || !kept.length ? action.page.before : previous.before,
            loaded: true,
            loading: false,
            failed: false,
          },
        },
      }
    }
    case 'run':
      return upsertRun(state, action.botId, action.run)
    case 'threads-loading':
    case 'threads-failed': {
      const previous = state.threads[action.botId] ?? emptyThreads
      const loading = action.type === 'threads-loading'
      return { ...state, threads: { ...state.threads, [action.botId]: { ...previous, loading, failed: !loading } } }
    }
    case 'threads-list':
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.botId]: { threads: sortThreads(action.threads), loaded: true, loading: false, failed: false },
        },
      }
    case 'thread':
      return upsertThread(state, action.botId, action.thread)
    case 'lane-loading':
    case 'lane-failed': {
      const previous = state.lanes[action.key] ?? emptyTranscript
      const loading = action.type === 'lane-loading'
      return { ...state, lanes: { ...state.lanes, [action.key]: { ...previous, loading, failed: !loading } } }
    }
    case 'lane-page':
      return {
        ...state,
        lanes: {
          ...state.lanes,
          [action.key]: withPage(state.lanes[action.key] ?? emptyTranscript, action.page, action.mode),
        },
      }
    case 'seen':
      return { ...state, seen: action.seen }
  }
}
