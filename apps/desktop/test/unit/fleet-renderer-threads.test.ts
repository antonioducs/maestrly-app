import { describe, expect, it } from 'vitest'
import { fleetPeerThreadSchema, type FleetPeerThread, type FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { fleetReducer, initialFleetState, runTranscriptKey, type FleetState } from '../../src/renderer/lib/fleet/state'

const AT = '2026-10-18T12:00:00.000Z'
const thread = (id: string, lastActivityAt: string, fields: Partial<FleetPeerThread> = {}): FleetPeerThread =>
  fleetPeerThreadSchema.parse({
    id,
    botId: 'alpha',
    peer: { botId: 'nina', name: 'Nina' },
    title: 'Release 4.2',
    origin: 'peer',
    status: 'open',
    hops: 1,
    hopLimit: 8,
    messages: 1,
    pinned: false,
    conversation: 'own',
    report: null,
    reportAt: null,
    working: false,
    peerWorking: false,
    createdAt: AT,
    lastActivityAt,
    expiresAt: null,
    conversationDeletedAt: null,
    kept: null,
    ...fields,
  })
const assistant = (id: string, text: string): FleetTranscriptItem => ({
  kind: 'assistant',
  id,
  at: AT,
  text,
  streaming: false,
})
const event = (state: FleetState, value: Parameters<typeof fleetReducer>[1] & { type: 'event' }) =>
  fleetReducer(state, value)

describe('threads between bots in the renderer state', () => {
  it('lists threads the most recently active first and keeps a failed load apart', () => {
    let state = fleetReducer(initialFleetState, { type: 'threads.loading', botId: 'alpha' })
    expect(state.threads.alpha).toMatchObject({ loading: true, loaded: false })
    state = fleetReducer(state, { type: 'threads.error', botId: 'alpha', error: 'Gateway unavailable' })
    expect(state.threads.alpha).toMatchObject({ loading: false, error: 'Gateway unavailable' })
    state = fleetReducer(state, {
      type: 'threads.list',
      botId: 'alpha',
      threads: [thread('t1', '2026-10-18T09:00:00.000Z'), thread('t2', '2026-10-18T11:00:00.000Z')],
    })
    expect(state.threads.alpha).toMatchObject({ loaded: true, loading: false, error: null })
    expect(state.threads.alpha.threads.map((item) => item.id)).toEqual(['t2', 't1'])
  })

  it('applies thread events only to threads it loaded, and keeps their transcripts beside the runs', () => {
    const before = event(initialFleetState, {
      type: 'event',
      value: { type: 'peer_thread.updated', at: AT, botId: 'alpha', thread: thread('t1', AT) },
    })
    expect(before.threads.alpha).toBeUndefined()
    let state = fleetReducer(initialFleetState, { type: 'threads.list', botId: 'alpha', threads: [] })
    state = event(state, {
      type: 'event',
      value: { type: 'peer_thread.updated', at: AT, botId: 'alpha', thread: thread('t1', AT, { status: 'paused' }) },
    })
    expect(state.threads.alpha.threads).toEqual([expect.objectContaining({ id: 't1', status: 'paused' })])
    const key = runTranscriptKey('alpha', 't1')
    // A transcript not loaded yet takes no item; a loaded one takes each item once.
    state = event(state, {
      type: 'event',
      value: {
        type: 'peer_thread.transcript.upsert',
        at: AT,
        botId: 'alpha',
        threadId: 't1',
        item: assistant('m:0', 'Hi'),
      },
    })
    expect(state.runTranscripts[key]).toBeUndefined()
    state = fleetReducer(state, {
      type: 'runTranscript.page',
      botId: 'alpha',
      runId: 't1',
      page: { items: [], before: null },
      older: false,
    })
    for (const text of ['Hi', 'Hi again'])
      state = event(state, {
        type: 'event',
        value: {
          type: 'peer_thread.transcript.upsert',
          at: AT,
          botId: 'alpha',
          threadId: 't1',
          item: assistant('m:0', text),
        },
      })
    expect(state.runTranscripts[key].items).toEqual([expect.objectContaining({ text: 'Hi again' })])
    expect(state.transcripts.alpha).toBeUndefined()
    state = event(state, {
      type: 'event',
      value: { type: 'peer_thread.transcript.reset', at: AT, botId: 'alpha', threadId: 't1' },
    })
    expect(state.runTranscripts[key]).toMatchObject({ items: [], loaded: false })
    state = event(state, {
      type: 'event',
      value: { type: 'peer_thread.removed', at: AT, botId: 'alpha', threadId: 't1' },
    })
    expect(state.threads.alpha.threads).toEqual([])
    expect(state.runTranscripts[key]).toBeUndefined()
  })

  it("drops a bot's threads with the bot", () => {
    let state = fleetReducer(initialFleetState, { type: 'threads.list', botId: 'alpha', threads: [thread('t1', AT)] })
    state = fleetReducer(state, {
      type: 'runTranscript.page',
      botId: 'alpha',
      runId: 't1',
      page: { items: [], before: null },
      older: false,
    })
    state = event(state, { type: 'event', value: { type: 'bot.removed', at: AT, botId: 'alpha' } })
    expect(state.threads.alpha).toBeUndefined()
    expect(state.runTranscripts[runTranscriptKey('alpha', 't1')]).toBeUndefined()
  })
})
