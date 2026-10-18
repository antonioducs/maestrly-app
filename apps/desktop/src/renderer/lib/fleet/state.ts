import {
  compareFleetTranscriptItems,
  type FleetActivityEntry,
  type FleetEnvironment,
  type FleetGatewayEvent,
  type FleetRoutineRun,
  type FleetRoutineRunPage,
  type FleetTranscriptItem,
  type FleetTranscriptPage,
} from '@maestrly/bot-fleet-protocol'
import type { FleetConnectionView, FleetSnapshot } from '../../../preload/api-fleet'
import { compareByName } from './selectors'

export type TranscriptState = FleetTranscriptPage & {
  loaded: boolean
  loading: boolean
  error: string | null
}
/** A bot's routine runs (`routine-conversations`), newest first, as far back as loaded. */
export type RunsState = {
  runs: FleetRoutineRun[]
  before: string | null
  loaded: boolean
  loading: boolean
  error: string | null
}
export type FleetState = {
  connection: FleetConnectionView
  snapshot: FleetSnapshot
  ownerMemoryRevision: number
  activity: FleetActivityEntry[]
  transcripts: Record<string, TranscriptState>
  runs: Record<string, RunsState>
  /** The transcripts of runs' own conversations, by `runTranscriptKey`. */
  runTranscripts: Record<string, TranscriptState>
}
export const emptyRuns: RunsState = { runs: [], before: null, loaded: false, loading: false, error: null }
/** The key of a run's transcript in the state: its bot and its run. */
export const runTranscriptKey = (botId: string, runId: string): string => `${botId}\u0000${runId}`
const ofBots = <T>(record: Record<string, T>, bots: ReadonlySet<string>, key = (id: string) => id): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => !bots.has(key(id))))
const botOfRunKey = (key: string) => key.slice(0, key.indexOf('\u0000'))
/** Runs newest first, by when they were delivered, then by id as the gateway pages them. */
export function sortRuns(runs: FleetRoutineRun[]): FleetRoutineRun[] {
  return [...runs].sort((a, b) =>
    a.deliveredAt === b.deliveredAt ? (a.id < b.id ? 1 : -1) : a.deliveredAt < b.deliveredAt ? 1 : -1
  )
}
function upsertRun(state: FleetState, botId: string, run: FleetRoutineRun): FleetState {
  const previous = state.runs[botId]
  if (!previous?.loaded) return state
  return {
    ...state,
    runs: {
      ...state.runs,
      [botId]: { ...previous, runs: sortRuns([...previous.runs.filter((item) => item.id !== run.id), run]) },
    },
  }
}
export const emptyTranscript: TranscriptState = {
  items: [],
  before: null,
  loaded: false,
  loading: false,
  error: null,
}
export const initialFleetState: FleetState = {
  connection: {
    features: [],
    state: 'unconfigured',
    deviceId: null,
    url: null,
    hostname: null,
    error: null,
    tokenPersistence: 'secure',
  },
  snapshot: { host: null, bots: [], environments: [], inbox: [], peerMessages: [] },
  ownerMemoryRevision: 0,
  activity: [],
  transcripts: {},
  runs: {},
  runTranscripts: {},
}

export function mergeTranscriptItems(
  existing: FleetTranscriptItem[],
  incoming: FleetTranscriptItem[]
): FleetTranscriptItem[] {
  const items = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) items.set(item.id, item)
  return [...items.values()].sort(compareFleetTranscriptItems)
}

/** A snapshot without environments (a gateway that predates them, or a view resetting the list) has none. */
export type FleetSnapshotInput = Omit<FleetSnapshot, 'environments'> & { environments?: FleetEnvironment[] }

/** An archived or removed environment takes its bots along, with their inbox items and transcripts. */
function withoutEnvironment(state: FleetState, environmentId: string): FleetState {
  const bots = new Set(state.snapshot.bots.filter((bot) => bot.environmentId === environmentId).map((bot) => bot.id))
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      environments: state.snapshot.environments.filter((environment) => environment.id !== environmentId),
      bots: state.snapshot.bots.filter((bot) => !bots.has(bot.id)),
      inbox: state.snapshot.inbox.filter((item) => !bots.has(item.botId)),
    },
    transcripts: ofBots(state.transcripts, bots),
    runs: ofBots(state.runs, bots),
    runTranscripts: ofBots(state.runTranscripts, bots, botOfRunKey),
  }
}

export type FleetAction =
  | { type: 'connection'; value: FleetConnectionView }
  | { type: 'snapshot'; value: FleetSnapshotInput }
  | { type: 'event'; value: FleetGatewayEvent }
  | { type: 'transcript.loading'; botId: string }
  | {
      type: 'transcript.page'
      botId: string
      page: FleetTranscriptPage
      older: boolean
    }
  | { type: 'transcript.error'; botId: string; error: string }
  | { type: 'runs.loading'; botId: string }
  | { type: 'runs.page'; botId: string; page: FleetRoutineRunPage; older: boolean }
  | { type: 'runs.error'; botId: string; error: string }
  | { type: 'runs.upsert'; botId: string; run: FleetRoutineRun }
  | { type: 'runTranscript.loading'; botId: string; runId: string }
  | { type: 'runTranscript.page'; botId: string; runId: string; page: FleetTranscriptPage; older: boolean }
  | { type: 'runTranscript.error'; botId: string; runId: string; error: string }

/** A transcript with a page it loaded: an older page joins it, the newest one replaces what it covers. */
function transcriptWithPage(
  current: TranscriptState | undefined,
  page: FleetTranscriptPage,
  older: boolean
): TranscriptState {
  const previous = current ?? emptyTranscript
  const olderItems = page.items.length ? previous.items.filter((item) => item.at < page.items[0].at) : []
  const items = older ? mergeTranscriptItems(page.items, previous.items) : mergeTranscriptItems(olderItems, page.items)
  return { items, before: page.before, loaded: true, loading: false, error: null }
}

export function fleetReducer(state: FleetState, action: FleetAction): FleetState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.value }
    case 'snapshot':
      return { ...state, snapshot: { ...action.value, environments: action.value.environments ?? [] } }
    case 'transcript.loading':
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [action.botId]: {
            ...(state.transcripts[action.botId] ?? emptyTranscript),
            loading: true,
            error: null,
          },
        },
      }
    case 'transcript.error':
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [action.botId]: {
            ...(state.transcripts[action.botId] ?? emptyTranscript),
            loading: false,
            error: action.error,
          },
        },
      }
    case 'transcript.page':
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [action.botId]: transcriptWithPage(state.transcripts[action.botId], action.page, action.older),
        },
      }
    case 'runs.loading':
    case 'runs.error':
      return {
        ...state,
        runs: {
          ...state.runs,
          [action.botId]: {
            ...(state.runs[action.botId] ?? emptyRuns),
            loading: action.type === 'runs.loading',
            error: action.type === 'runs.error' ? action.error : null,
          },
        },
      }
    case 'runs.page': {
      const previous = state.runs[action.botId] ?? emptyRuns
      // A first page replaces what it covers; runs older than it, loaded before, stay.
      const oldest = action.page.runs.at(-1)?.deliveredAt
      const kept = action.older
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
            before: action.older || !kept.length ? action.page.before : previous.before,
            loaded: true,
            loading: false,
            error: null,
          },
        },
      }
    }
    case 'runs.upsert':
      return upsertRun(state, action.botId, action.run)
    case 'runTranscript.loading':
    case 'runTranscript.error': {
      const key = runTranscriptKey(action.botId, action.runId)
      return {
        ...state,
        runTranscripts: {
          ...state.runTranscripts,
          [key]: {
            ...(state.runTranscripts[key] ?? emptyTranscript),
            loading: action.type === 'runTranscript.loading',
            error: action.type === 'runTranscript.error' ? action.error : null,
          },
        },
      }
    }
    case 'runTranscript.page': {
      const key = runTranscriptKey(action.botId, action.runId)
      return {
        ...state,
        runTranscripts: {
          ...state.runTranscripts,
          [key]: transcriptWithPage(state.runTranscripts[key], action.page, action.older),
        },
      }
    }
    case 'event': {
      const event = action.value
      switch (event.type) {
        case 'bot.updated':
          return {
            ...state,
            snapshot: {
              ...state.snapshot,
              // An archive reply can arrive after `bot.removed`: an archived bot is never listed.
              bots: [
                ...state.snapshot.bots.filter((bot) => bot.id !== event.bot.id),
                ...(event.bot.lifecycle === 'archived' ? [] : [event.bot]),
              ].sort((a, b) => a.name.localeCompare(b.name)),
            },
          }
        case 'bot.removed': {
          const removed = new Set([event.botId])
          return {
            ...state,
            snapshot: {
              ...state.snapshot,
              bots: state.snapshot.bots.filter((bot) => bot.id !== event.botId),
              inbox: state.snapshot.inbox.filter((item) => item.botId !== event.botId),
            },
            transcripts: ofBots(state.transcripts, removed),
            runs: ofBots(state.runs, removed),
            runTranscripts: ofBots(state.runTranscripts, removed, botOfRunKey),
          }
        }
        case 'host.updated':
          return {
            ...state,
            snapshot: { ...state.snapshot, host: event.host },
          }
        case 'inbox.updated':
          return {
            ...state,
            snapshot: { ...state.snapshot, inbox: event.items },
          }
        case 'peer.message':
          return {
            ...state,
            snapshot: {
              ...state.snapshot,
              peerMessages: [
                event.message,
                ...state.snapshot.peerMessages.filter((item) => item.id !== event.message.id),
              ],
            },
          }
        case 'transcript.upsert': {
          const previous = state.transcripts[event.botId]
          if (!previous?.loaded) return state
          return {
            ...state,
            transcripts: {
              ...state.transcripts,
              [event.botId]: {
                ...previous,
                items: mergeTranscriptItems(previous.items, [event.item]),
              },
            },
          }
        }
        case 'transcript.reset':
          return {
            ...state,
            transcripts: {
              ...state.transcripts,
              [event.botId]: emptyTranscript,
            },
          }
        case 'routine_run.updated':
          return upsertRun(state, event.botId, event.run)
        case 'routine_run.removed': {
          const previous = state.runs[event.botId]
          const { [runTranscriptKey(event.botId, event.runId)]: _gone, ...runTranscripts } = state.runTranscripts
          return {
            ...state,
            runs: previous
              ? {
                  ...state.runs,
                  [event.botId]: { ...previous, runs: previous.runs.filter((run) => run.id !== event.runId) },
                }
              : state.runs,
            runTranscripts,
          }
        }
        case 'routine_run.transcript.upsert': {
          const key = runTranscriptKey(event.botId, event.runId)
          const previous = state.runTranscripts[key]
          if (!previous?.loaded) return state
          return {
            ...state,
            runTranscripts: {
              ...state.runTranscripts,
              [key]: { ...previous, items: mergeTranscriptItems(previous.items, [event.item]) },
            },
          }
        }
        case 'routine_run.transcript.reset':
          return {
            ...state,
            runTranscripts: { ...state.runTranscripts, [runTranscriptKey(event.botId, event.runId)]: emptyTranscript },
          }
        case 'activity':
          return {
            ...state,
            activity: [...state.activity.filter((entry) => entry.seq !== event.entry.seq), event.entry]
              .sort((a, b) => a.seq - b.seq)
              .slice(-200),
          }
        case 'artifact.changed':
        case 'artifact.activity':
        // Desktop access is read by the bot settings that show it, on its own channel.
        case 'desktop.call':
        case 'desktop_link.updated':
          return state
        case 'owner_memory.updated':
          return { ...state, ownerMemoryRevision: event.revision }
        case 'environment.updated':
          // Like bots, an archived environment is never listed, whatever the order of its events and replies.
          if (event.environment.lifecycle === 'archived') return withoutEnvironment(state, event.environment.id)
          return {
            ...state,
            snapshot: {
              ...state.snapshot,
              environments: [
                ...state.snapshot.environments.filter((environment) => environment.id !== event.environment.id),
                event.environment,
              ].sort(compareByName),
            },
          }
        case 'environment.removed':
          return withoutEnvironment(state, event.environmentId)
        case 'hello':
          return state
      }
    }
  }
}
