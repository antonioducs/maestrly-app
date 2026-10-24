import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fleetPeerThreadSchema, type FleetPeerThread, type FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { fleetReducer, initialFleetState, runTranscriptKey, type FleetState } from '../../src/renderer/lib/fleet/state'
import {
  readSeenThreads,
  threadExpiresInDays,
  threadGroups,
  threadSeenKey,
  threadState,
  unseenThreads,
  writeSeenThreads,
} from '../../src/renderer/lib/fleet/threads'
import { createFleetActions } from '../../src/renderer/lib/fleet/use-fleet'
import type { FleetServerId } from '../../src/shared/fleet-servers'

const AT = '2026-10-18T12:00:00.000Z'
const LATER = '2026-10-18T12:05:00.000Z'
const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
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

describe('thread helpers', () => {
  const idle = { status: 'idle' as const, runningRun: null, turns: [] }
  it("tells what a thread is now, from the thread and from the bot's turns", () => {
    expect(threadState(thread('t1', AT))).toBe('open')
    expect(threadState(thread('t1', AT, { peerWorking: true }))).toBe('working')
    expect(threadState(thread('t1', AT, { status: 'paused', working: true }))).toBe('paused')
    expect(threadState(thread('t1', AT, { conversation: 'deleted' }))).toBe('deleted')
    // A bot's turn in the thread makes it work before the thread itself says so.
    const busy = {
      status: 'working' as const,
      runningRun: null,
      turns: [{ kind: 'peer' as const, id: 't1', title: 'Release 4.2', startedAt: AT, tool: null, cancelling: false }],
    }
    expect(threadState(thread('t1', AT), busy)).toBe('working')
    expect(threadState(thread('t2', AT), busy)).toBe('open')
    expect(threadState(thread('t1', AT), idle)).toBe('open')
  })

  it('lists the threads that wait for the owner first, then those at work, then the others', () => {
    const groups = threadGroups([
      thread('t1', AT),
      thread('t2', AT, { status: 'paused' }),
      thread('t3', AT, { working: true }),
      thread('t4', AT, { conversation: 'deleted' }),
    ])
    expect(groups.map((group) => [group.key, group.threads.map((item) => item.id)])).toEqual([
      ['needs', ['t2']],
      ['active', ['t3']],
      ['earlier', ['t1', 't4']],
    ])
    expect(threadGroups([thread('t1', AT)]).map((group) => group.key)).toEqual(['earlier'])
  })

  it('counts the days left before retention deletes a conversation', () => {
    const now = Date.parse(AT)
    expect(threadExpiresInDays(thread('t1', AT), now)).toBeNull()
    expect(
      threadExpiresInDays(thread('t1', AT, { expiresAt: new Date(now + 2.5 * 86_400_000).toISOString() }), now)
    ).toBe(3)
    expect(threadExpiresInDays(thread('t1', AT, { expiresAt: new Date(now - 1000).toISOString() }), now)).toBe(0)
  })
})

describe('seen threads', () => {
  const storage = new Map<string, string>()
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('counts what is there the first time as seen, then new activity and every paused thread as new', () => {
    const key = threadSeenKey('https://gateway.test', 'alpha')
    const first = [thread('t1', '2026-10-18T09:00:00.000Z'), thread('t2', '2026-10-18T10:00:00.000Z')]
    const seen = readSeenThreads(key, first)
    expect(unseenThreads(first, seen)).toEqual([])
    const later = [
      thread('t1', '2026-10-18T11:00:00.000Z'),
      thread('t2', '2026-10-18T10:00:00.000Z', { status: 'paused' }),
      thread('t3', '2026-10-18T11:30:00.000Z'),
      thread('t4', '2026-10-18T11:40:00.000Z', { conversation: 'deleted' }),
    ]
    const again = readSeenThreads(key, later)
    expect(unseenThreads(later, again).map((item) => item.id)).toEqual(['t1', 't2', 't3'])
    writeSeenThreads(key, new Map([...again, ['t1', later[0].lastActivityAt], ['t3', later[2].lastActivityAt]]))
    // A paused thread waits for the owner whether they saw it or not.
    expect(unseenThreads(later, readSeenThreads(key, later)).map((item) => item.id)).toEqual(['t2'])
  })

  it('counts as new the activity the gateway says no device of the owner saw, and every paused thread', () => {
    const threads = [
      thread('t1', LATER, { seenActivityAt: AT }),
      thread('t2', LATER, { seenActivityAt: LATER }),
      thread('t3', LATER, { seenActivityAt: LATER, status: 'paused' }),
      thread('t4', LATER),
      thread('t5', LATER, { conversation: 'deleted' }),
    ]
    expect(unseenThreads(threads, 'gateway').map((item) => item.id)).toEqual(['t1', 't3', 't4'])
  })
})

describe('telling the gateway the owner saw a thread', () => {
  afterEach(() => vi.unstubAllGlobals())
  function setup(patch: (...args: unknown[]) => Promise<FleetPeerThread>) {
    let state = fleetReducer(initialFleetState, {
      type: 'threads.list',
      botId: 'alpha',
      threads: [thread('t1', AT), thread('t2', AT, { seenActivityAt: AT })],
    })
    const api = { fleetPatchPeerThread: vi.fn(patch) }
    vi.stubGlobal('window', { api })
    const actions = createFleetActions(
      SERVER,
      (action) => {
        state = fleetReducer(state, action)
      },
      () => state,
      () => undefined
    )
    const find = (id: string) => state.threads.alpha.threads.find((item) => item.id === id)!
    const apply = (action: Parameters<typeof fleetReducer>[1]) => {
      state = fleetReducer(state, action)
    }
    return { actions, api, find, apply }
  }

  it('shows it seen at once and asks once for each activity the owner sees', async () => {
    let answer!: (thread: FleetPeerThread) => void
    const s = setup(() => new Promise((resolve) => (answer = resolve)))
    s.actions.seeThread('alpha', 't1')
    s.actions.seeThread('alpha', 't1')
    s.actions.seeThread('alpha', 't2')
    expect(s.find('t1').seenActivityAt).toBe(AT)
    expect(s.api.fleetPatchPeerThread.mock.calls).toEqual([[SERVER, 'alpha', 't1', { seen: true }]])
    answer(thread('t1', AT, { seenActivityAt: AT }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.find('t1').seenActivityAt).toBe(AT)
    // Later activity, seen while it is shown, is told too.
    s.apply({ type: 'threads.upsert', botId: 'alpha', thread: thread('t1', LATER, { seenActivityAt: AT }) })
    s.actions.seeThread('alpha', 't1')
    expect(s.api.fleetPatchPeerThread).toHaveBeenCalledTimes(2)
    expect(s.find('t1').seenActivityAt).toBe(LATER)
  })

  it('shows as seen a thread the owner saw on another device, from its event', () => {
    const s = setup(async () => thread('t1', AT))
    expect(unseenThreads([s.find('t1')], 'gateway')).toHaveLength(1)
    s.apply({
      type: 'event',
      value: {
        type: 'peer_thread.updated',
        at: AT,
        botId: 'alpha',
        thread: thread('t1', AT, { seenActivityAt: AT }),
      },
    })
    expect(unseenThreads([s.find('t1')], 'gateway')).toEqual([])
    s.actions.seeThread('alpha', 't1')
    expect(s.api.fleetPatchPeerThread).not.toHaveBeenCalled()
  })
})
