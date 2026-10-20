import {
  fleetPeerThreadSchema,
  fleetRoutineRunSchema,
  type FleetGatewayEvent,
  type FleetPeerThread,
  type FleetRoutineRun,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { botRecord, environmentRecord } from '../src/fleet/factories'
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

  it('keeps what events said while a list was loading when the list is older', () => {
    const newer = { ...juno, status: 'working' as const, updatedAt: at(30) }
    let state = fleetReducer(initialFleetState, event({ type: 'bot.updated', bot: newer }))
    state = fleetReducer(state, {
      type: 'snapshot',
      bots: [{ ...juno, updatedAt: at(10) }, atlas],
      environments: [],
      inbox: [],
    })
    expect(state.bots.map((bot) => [bot.id, bot.status])).toEqual([
      ['juno', 'working'],
      ['atlas', 'idle'],
    ])
    state = fleetReducer(state, {
      type: 'snapshot',
      bots: [{ ...juno, updatedAt: at(40) }],
      environments: [],
      inbox: [],
    })
    expect(state.bots.map((bot) => bot.status)).toEqual(['idle'])
  })

  it('removes the bots of an environment that goes away, with their transcripts and requests', () => {
    const studio = environmentRecord({ id: 'studio', name: 'studio', botIds: ['atlas'] })
    let state = fleetReducer(initialFleetState, {
      type: 'snapshot',
      bots: [juno, { ...atlas, environmentId: 'studio' }],
      environments: [studio],
      inbox: [permission],
    })
    state = loaded(state, 'atlas', [assistant('a1', 1, 'hi')])
    const removed = fleetReducer(state, event({ type: 'environment.removed', environmentId: 'studio' }))
    expect(removed.bots.map((bot) => bot.id)).toEqual(['juno'])
    expect(removed.environments).toEqual([])
    expect(removed.inbox).toEqual([])
    expect(removed.transcripts.atlas).toBeUndefined()
    const archived = fleetReducer(
      state,
      event({ type: 'environment.updated', environment: { ...studio, lifecycle: 'archived' } })
    )
    expect(archived.bots.map((bot) => bot.id)).toEqual(['juno'])
  })
})

describe('fleet state of side conversations', () => {
  const run = (id: string, second: number, fields: Partial<FleetRoutineRun> = {}) =>
    fleetRoutineRunSchema.parse({
      id,
      routineId: 'r1',
      botId: 'atlas',
      trigger: 'schedule',
      status: 'completed',
      deliveredAt: at(second),
      finishedAt: at(second + 1),
      report: null,
      finalText: null,
      conversation: 'own',
      ...fields,
    })
  const thread = (id: string, second: number, fields: Partial<FleetPeerThread> = {}) =>
    fleetPeerThreadSchema.parse({
      id,
      botId: 'atlas',
      peer: { botId: 'pixel', name: 'Pixel' },
      title: id,
      origin: 'primary',
      status: 'open',
      hops: 0,
      hopLimit: 8,
      messages: 1,
      pinned: false,
      conversation: 'own',
      report: null,
      reportAt: null,
      working: false,
      peerWorking: false,
      createdAt: at(second),
      lastActivityAt: at(second),
      expiresAt: null,
      conversationDeletedAt: null,
      kept: null,
      ...fields,
    })
  const withAtlas = fleetReducer(initialFleetState, { type: 'snapshot', bots: [atlas], environments: [], inbox: [] })
  const laneKey = (id: string) => `atlas\u0000${id}`

  it('keeps runs newest first, takes updates once loaded, and keeps older pages under a newer first page', () => {
    // Before its first page, a run's update has no list to go to.
    let state = fleetReducer(withAtlas, event({ type: 'routine_run.updated', botId: 'atlas', run: run('r0', 1) }))
    expect(state.runs.atlas).toBeUndefined()
    state = fleetReducer(state, {
      type: 'runs-page',
      botId: 'atlas',
      page: { runs: [run('r3', 30), run('r2', 20)], before: 'r2' },
      mode: 'latest',
    })
    state = fleetReducer(state, {
      type: 'runs-page',
      botId: 'atlas',
      page: { runs: [run('r1', 10)], before: null },
      mode: 'older',
    })
    expect(state.runs.atlas).toMatchObject({ loaded: true, before: null })
    state = fleetReducer(state, event({ type: 'routine_run.updated', botId: 'atlas', run: run('r4', 40) }))
    expect(state.runs.atlas.runs.map((item) => item.id)).toEqual(['r4', 'r3', 'r2', 'r1'])
    // The newest page again: what it covers is replaced, the older runs loaded before stay.
    state = fleetReducer(state, {
      type: 'runs-page',
      botId: 'atlas',
      page: { runs: [run('r4', 40, { pinned: true }), run('r3', 30)], before: 'r3' },
      mode: 'latest',
    })
    expect(state.runs.atlas.runs.map((item) => [item.id, item.pinned])).toEqual([
      ['r4', true],
      ['r3', false],
      ['r2', false],
      ['r1', false],
    ])
    expect(state.runs.atlas.before).toBeNull()
  })

  it('keeps each run’s and thread’s transcript apart, and marks it stale on a reset', () => {
    let state = fleetReducer(withAtlas, {
      type: 'lane-page',
      key: laneKey('r1'),
      page: { items: [assistant('x1', 1, 'first')], before: null },
      mode: 'latest',
    })
    state = fleetReducer(
      state,
      event({ type: 'routine_run.transcript.upsert', botId: 'atlas', runId: 'r1', item: assistant('x2', 2, 'second') })
    )
    // A thread's items never reach a run's conversation, nor the bot's own.
    state = fleetReducer(
      state,
      event({
        type: 'peer_thread.transcript.upsert',
        botId: 'atlas',
        threadId: 't1',
        item: assistant('y1', 3, 'elsewhere'),
      })
    )
    expect(state.lanes[laneKey('r1')].items.map((item) => item.id)).toEqual(['x1', 'x2'])
    expect(state.lanes[laneKey('t1')]).toBeUndefined()
    expect(state.transcripts.atlas).toBeUndefined()
    state = fleetReducer(state, event({ type: 'routine_run.transcript.reset', botId: 'atlas', runId: 'r1' }))
    expect(state.lanes[laneKey('r1')].stale).toBe(true)
    state = fleetReducer(state, { type: 'lane-failed', key: laneKey('r1') })
    expect(state.lanes[laneKey('r1')]).toMatchObject({ failed: true, loading: false })
  })

  it('keeps threads by last activity and drops what a removed run, thread or bot leaves', () => {
    let state = fleetReducer(withAtlas, {
      type: 'threads-list',
      botId: 'atlas',
      threads: [thread('t1', 1), thread('t2', 2)],
    })
    state = fleetReducer(
      state,
      event({ type: 'peer_thread.updated', botId: 'atlas', thread: thread('t1', 5, { status: 'paused' }) })
    )
    expect(state.threads.atlas.threads.map((item) => [item.id, item.status])).toEqual([
      ['t1', 'paused'],
      ['t2', 'open'],
    ])
    state = fleetReducer(state, {
      type: 'lane-page',
      key: laneKey('t2'),
      page: { items: [], before: null },
      mode: 'latest',
    })
    state = fleetReducer(state, event({ type: 'peer_thread.removed', botId: 'atlas', threadId: 't2' }))
    expect(state.threads.atlas.threads.map((item) => item.id)).toEqual(['t1'])
    expect(state.lanes[laneKey('t2')]).toBeUndefined()

    state = fleetReducer(state, {
      type: 'runs-page',
      botId: 'atlas',
      page: { runs: [run('r1', 1)], before: null },
      mode: 'latest',
    })
    state = fleetReducer(state, {
      type: 'lane-page',
      key: laneKey('r1'),
      page: { items: [], before: null },
      mode: 'latest',
    })
    const gone = fleetReducer(state, event({ type: 'bot.removed', botId: 'atlas' }))
    expect(gone.runs.atlas).toBeUndefined()
    expect(gone.threads.atlas).toBeUndefined()
    expect(gone.lanes).toEqual({})
  })
})
