import type { FleetGatewayEvent, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { botRecord } from '../src/fleet/factories'
import { fleetReducer, initialFleetState, type FleetState } from '../src/fleet/state'

const at = (second: number) => `2026-10-12T12:00:${String(second).padStart(2, '0')}.000Z`
const assistant = (id: string, second: number, text: string): FleetTranscriptItem => ({
  id,
  at: at(second),
  kind: 'assistant',
  text,
  streaming: false,
})
type WithoutAt<T> = T extends unknown ? Omit<T, 'at'> : never
const event = (value: WithoutAt<FleetGatewayEvent>) =>
  ({ type: 'event', event: { at: at(0), ...value } as FleetGatewayEvent }) as const

const juno = botRecord({ id: 'juno', name: 'Juno' })
const atlas = botRecord({ id: 'atlas', name: 'Atlas' })
const permission = {
  botId: 'atlas',
  interaction: {
    kind: 'permission' as const,
    id: 'p1',
    at: at(1),
    title: 'Run',
    detail: null,
    tool: null,
    itemId: 'i1',
  },
}

function loaded(state: FleetState, botId: string, items: FleetTranscriptItem[]): FleetState {
  return fleetReducer(state, { type: 'transcript-page', botId, page: { items, before: 'cursor' }, mode: 'latest' })
}

describe('fleet state', () => {
  it('updates bots in place, adds new ones, and removes a bot with its transcript and requests', () => {
    let state = fleetReducer(initialFleetState, {
      type: 'snapshot',
      bots: [juno, atlas],
      environments: [],
      inbox: [permission],
    })
    state = fleetReducer(state, event({ type: 'bot.updated', bot: { ...juno, status: 'working' } }))
    expect(state.bots.map((bot) => [bot.id, bot.status])).toEqual([
      ['juno', 'working'],
      ['atlas', 'idle'],
    ])
    state = fleetReducer(state, event({ type: 'bot.updated', bot: botRecord({ id: 'pixel', name: 'Pixel' }) }))
    expect(state.bots.map((bot) => bot.id)).toEqual(['juno', 'atlas', 'pixel'])
    state = loaded(state, 'atlas', [assistant('a1', 1, 'hi')])
    state = fleetReducer(state, event({ type: 'bot.removed', botId: 'atlas' }))
    expect(state.bots.map((bot) => bot.id)).toEqual(['juno', 'pixel'])
    expect(state.transcripts.atlas).toBeUndefined()
    expect(state.inbox).toEqual([])
  })

  it('replaces the whole inbox', () => {
    let state = fleetReducer(initialFleetState, {
      type: 'snapshot',
      bots: [atlas],
      environments: [],
      inbox: [permission],
    })
    state = fleetReducer(state, event({ type: 'inbox.updated', items: [] }))
    expect(state.inbox).toEqual([])
  })

  it('upserts transcript items of a loaded transcript only', () => {
    let state = fleetReducer(
      initialFleetState,
      event({ type: 'transcript.upsert', botId: 'juno', item: assistant('a1', 1, 'x') })
    )
    expect(state.transcripts.juno).toBeUndefined()
    state = loaded(state, 'juno', [assistant('a1', 1, 'Hel'), assistant('a2', 2, 'Bye')])
    state = fleetReducer(state, event({ type: 'transcript.upsert', botId: 'juno', item: assistant('a1', 1, 'Hello') }))
    state = fleetReducer(state, event({ type: 'transcript.upsert', botId: 'juno', item: assistant('a3', 3, 'New') }))
    expect(state.transcripts.juno.items.map((item) => [item.id, item.kind === 'assistant' && item.text])).toEqual([
      ['a1', 'Hello'],
      ['a2', 'Bye'],
      ['a3', 'New'],
    ])
  })

  it('marks a reset transcript stale', () => {
    let state = loaded(initialFleetState, 'juno', [assistant('a1', 1, 'x')])
    state = fleetReducer(state, event({ type: 'transcript.reset', botId: 'juno' }))
    expect(state.transcripts.juno.stale).toBe(true)
  })

  it('replaces items with the latest page and prepends older pages without duplicates', () => {
    let state = fleetReducer(initialFleetState, { type: 'transcript-loading', botId: 'juno' })
    expect(state.transcripts.juno.loading).toBe(true)
    state = loaded(state, 'juno', [assistant('a3', 3, 'c'), assistant('a4', 4, 'd')])
    expect(state.transcripts.juno).toMatchObject({ loading: false, stale: false, before: 'cursor' })
    state = fleetReducer(state, {
      type: 'transcript-page',
      botId: 'juno',
      page: { items: [assistant('a1', 1, 'a'), assistant('a2', 2, 'b'), assistant('a3', 3, 'c')], before: null },
      mode: 'older',
    })
    expect(state.transcripts.juno.items.map((item) => item.id)).toEqual(['a1', 'a2', 'a3', 'a4'])
    expect(state.transcripts.juno.before).toBeNull()
    state = loaded(state, 'juno', [assistant('a5', 5, 'e')])
    expect(state.transcripts.juno.items.map((item) => item.id)).toEqual(['a5'])
  })

  it('keeps transcripts and the outbox across snapshots', () => {
    let state = loaded(initialFleetState, 'juno', [assistant('a1', 1, 'x')])
    state = fleetReducer(state, {
      type: 'outbox',
      entries: [
        {
          id: 'o1',
          serverId: 's',
          botId: 'juno',
          text: 'hi',
          attachments: [],
          createdAt: at(1),
          state: 'waiting',
          error: null,
          attempts: 0,
        },
      ],
    })
    state = fleetReducer(state, { type: 'snapshot', bots: [juno], environments: [], inbox: [] })
    expect(state.transcripts.juno.items).toHaveLength(1)
    expect(state.outbox).toHaveLength(1)
  })
})
