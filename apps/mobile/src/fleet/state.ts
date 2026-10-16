import {
  compareFleetTranscriptItems,
  type FleetBot,
  type FleetEnvironment,
  type FleetGatewayEvent,
  type FleetInboxItem,
  type FleetTranscriptItem,
  type FleetTranscriptPage,
} from '@maestrly/bot-fleet-protocol'
import type { StreamState } from '../gateway/event-stream'
import type { OutboxEntry } from './outbox'

export type TranscriptState = {
  items: FleetTranscriptItem[]
  before: string | null
  loading: boolean
  /** The server reset this conversation; the open view reloads it. */
  stale: boolean
  loaded: boolean
}

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
}

const emptyTranscript: TranscriptState = { items: [], before: null, loading: false, stale: false, loaded: false }

/** Items by id, in transcript order: a newer copy of an item replaces the older one. */
function merge(existing: FleetTranscriptItem[], incoming: FleetTranscriptItem[]): FleetTranscriptItem[] {
  const items = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) items.set(item.id, item)
  return [...items.values()].sort(compareFleetTranscriptItems)
}

function upsertById<T extends { id: string }>(list: T[], value: T): T[] {
  const at = list.findIndex((item) => item.id === value.id)
  if (at < 0) return [...list, value]
  const next = list.slice()
  next[at] = value
  return next
}

function withoutBots(state: FleetState, gone: (bot: Pick<FleetBot, 'id' | 'environmentId'>) => boolean): FleetState {
  const ids = new Set(state.bots.filter(gone).map((bot) => bot.id))
  if (ids.size === 0) return state
  return {
    ...state,
    bots: state.bots.filter((bot) => !ids.has(bot.id)),
    inbox: state.inbox.filter((item) => !ids.has(item.botId)),
    transcripts: Object.fromEntries(Object.entries(state.transcripts).filter(([botId]) => !ids.has(botId))),
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
      return { ...state, transcripts: { ...state.transcripts, [action.botId]: { ...previous, loading: false } } }
    }
    case 'transcript-page': {
      const previous = state.transcripts[action.botId] ?? emptyTranscript
      const items =
        action.mode === 'older'
          ? merge(previous.items, action.page.items)
          : [...action.page.items].sort(compareFleetTranscriptItems)
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [action.botId]: { items, before: action.page.before, loading: false, stale: false, loaded: true },
        },
      }
    }
    case 'outbox':
      return { ...state, outbox: action.entries }
  }
}
