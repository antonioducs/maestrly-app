import {
  compareFleetTranscriptItems,
  type FleetActivityEntry,
  type FleetGatewayEvent,
  type FleetTranscriptItem,
  type FleetTranscriptPage,
} from '@maestrly/bot-fleet-protocol'
import type { FleetConnectionView, FleetDigest, FleetSnapshot } from '../../../preload/api-fleet'

export type TranscriptState = FleetTranscriptPage & {
  loaded: boolean
  loading: boolean
  error: string | null
}
export type FleetState = {
  connection: FleetConnectionView
  snapshot: FleetSnapshot
  digest: FleetDigest
  activity: FleetActivityEntry[]
  transcripts: Record<string, TranscriptState>
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
    state: 'unconfigured',
    deviceId: null,
    url: null,
    hostname: null,
    error: null,
    tokenPersistence: 'secure',
  },
  snapshot: { host: null, bots: [], inbox: [], peerMessages: [] },
  digest: null,
  activity: [],
  transcripts: {},
}

export function mergeTranscriptItems(
  existing: FleetTranscriptItem[],
  incoming: FleetTranscriptItem[]
): FleetTranscriptItem[] {
  const items = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) items.set(item.id, item)
  return [...items.values()].sort(compareFleetTranscriptItems)
}

export type FleetAction =
  | { type: 'connection'; value: FleetConnectionView }
  | { type: 'snapshot'; value: FleetSnapshot }
  | { type: 'digest'; value: FleetDigest }
  | { type: 'event'; value: FleetGatewayEvent }
  | { type: 'transcript.loading'; botId: string }
  | {
      type: 'transcript.page'
      botId: string
      page: FleetTranscriptPage
      older: boolean
    }
  | { type: 'transcript.error'; botId: string; error: string }

export function fleetReducer(state: FleetState, action: FleetAction): FleetState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.value }
    case 'snapshot':
      return { ...state, snapshot: action.value }
    case 'digest':
      return { ...state, digest: action.value }
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
    case 'transcript.page': {
      const previous = state.transcripts[action.botId] ?? emptyTranscript
      const olderItems = action.page.items.length
        ? previous.items.filter((item) => item.at < action.page.items[0].at)
        : []
      const items = action.older
        ? mergeTranscriptItems(action.page.items, previous.items)
        : mergeTranscriptItems(olderItems, action.page.items)
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [action.botId]: {
            items,
            before: action.page.before,
            loaded: true,
            loading: false,
            error: null,
          },
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
          const { [event.botId]: _removed, ...transcripts } = state.transcripts
          return {
            ...state,
            snapshot: {
              ...state.snapshot,
              bots: state.snapshot.bots.filter((bot) => bot.id !== event.botId),
              inbox: state.snapshot.inbox.filter((item) => item.botId !== event.botId),
            },
            transcripts,
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
        case 'activity':
          return {
            ...state,
            activity: [...state.activity.filter((entry) => entry.seq !== event.entry.seq), event.entry]
              .sort((a, b) => a.seq - b.seq)
              .slice(-200),
          }
        case 'hello':
          return state
      }
    }
  }
}
