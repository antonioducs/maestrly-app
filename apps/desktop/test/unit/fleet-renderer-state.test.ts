import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FleetBot, FleetHostInfo, FleetTranscriptItem, FleetTranscriptPage } from '@maestrly/bot-fleet-protocol'
import {
  accountsExhaustedNotice,
  activityLabel,
  formatPairingCode,
  memorySegments,
} from '../../src/renderer/lib/fleet/format'
import {
  type FleetAction,
  type FleetState,
  fleetReducer,
  fleetServersReducer,
  initialFleetState,
  mergeTranscriptItems,
  runTranscriptKey,
} from '../../src/renderer/lib/fleet/state'
import { createFleetActions } from '../../src/renderer/lib/fleet/use-fleet'
import type { FleetServerId } from '../../src/shared/fleet-servers'

const user = (id: string, at: string, text = id): FleetTranscriptItem => ({
  kind: 'user',
  id,
  at,
  text,
  source: 'owner',
  queued: false,
  memories: [],
  images: [],
})
const bot = (id: string): FleetBot =>
  ({
    id,
    name: id,
    tint: '#123456',
    resources: { memoryBytes: 2 * 1024 ** 3 },
  }) as FleetBot
const host = {
  memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 5 * 1024 ** 3, botsBytes: 2 * 1024 ** 3 },
} as FleetHostInfo

describe('fleet pure state', () => {
  it('records owner memory revisions so views can refresh', () => {
    expect(initialFleetState.ownerMemoryRevision).toBe(0)
    const state = fleetReducer(initialFleetState, {
      type: 'event',
      value: { type: 'owner_memory.updated', revision: 7, at: '2026-09-25T00:00:00Z' },
    })
    expect(state.ownerMemoryRevision).toBe(7)
  })

  it('keeps the parts of one message in their order when they share its time', () => {
    const at = '2026-09-24T21:29:45.794Z'
    const merged = mergeTranscriptItems(
      [user('m:1', at), user('m:10', at), user('m:4', at)],
      [user('m:2', at), user('m:11', at)]
    )
    expect(merged.map((item) => item.id)).toEqual(['m:1', 'm:2', 'm:4', 'm:10', 'm:11'])
  })
  it('merges transcript updates by id in ascending time order', () => {
    expect(
      mergeTranscriptItems(
        [user('b', '2026-01-01T00:02:00Z'), user('a', '2026-01-01T00:01:00Z')],
        [user('a', '2026-01-01T00:01:00Z', 'updated')]
      ).map((item) => [item.id, item.kind === 'user' ? item.text : ''])
    ).toEqual([
      ['a', 'updated'],
      ['b', 'b'],
    ])
  })
  it('keeps older pages and removes stale items when the latest page is refreshed', () => {
    let state = fleetReducer(initialFleetState, {
      type: 'transcript.page',
      botId: 'b',
      page: {
        items: [
          user('old', '2026-01-01T00:00:00Z'),
          user('new', '2026-01-01T00:01:00Z'),
          user('stale', '2026-01-01T00:02:00Z'),
        ],
        before: null,
      },
      older: false,
    })
    state = fleetReducer(state, {
      type: 'transcript.page',
      botId: 'b',
      page: { items: [user('new', '2026-01-01T00:01:00Z')], before: null },
      older: false,
    })
    expect(state.transcripts.b.items.map((item) => item.id)).toEqual(['old', 'new'])
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'transcript.reset', botId: 'b', at: '2026-01-01T00:02:00Z' },
    })
    expect(state.transcripts.b.loaded).toBe(false)
  })
  it('applies bot, inbox and peer events without duplicating records', () => {
    let state = fleetReducer(initialFleetState, {
      type: 'event',
      value: { type: 'bot.updated', bot: bot('scout'), at: '2026-01-01T00:00:00Z' },
    })
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'bot.updated', bot: bot('scout'), at: '2026-01-01T00:01:00Z' },
    })
    expect(state.snapshot.bots).toHaveLength(1)
    state = fleetReducer(state, {
      type: 'event',
      value: {
        type: 'inbox.updated',
        items: [
          {
            botId: 'scout',
            interaction: {
              kind: 'help',
              id: 'help-1',
              at: '2026-01-01T00:01:00Z',
              reason: 'Sign in',
              itemId: 'item-1',
            },
          },
        ],
        at: '2026-01-01T00:01:00Z',
      },
    })
    expect(state.snapshot.inbox).toHaveLength(1)
    state = fleetReducer(state, {
      type: 'event',
      value: {
        type: 'peer.message',
        message: { id: 'peer-1', at: '2026-01-01T00:01:00Z', from: 'scout', to: 'dev', text: 'Hello', delivered: true },
        at: '2026-01-01T00:01:00Z',
      },
    })
    expect(state.snapshot.peerMessages).toHaveLength(1)
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'bot.removed', botId: 'scout', at: '2026-01-01T00:02:00Z' },
    })
    expect(state.snapshot.bots).toHaveLength(0)
    expect(state.snapshot.inbox).toHaveLength(0)
  })
  it('never lists an archived bot, even when its archive reply arrives after the removal event', () => {
    let state = fleetReducer(initialFleetState, {
      type: 'event',
      value: { type: 'bot.updated', bot: bot('scout'), at: '2026-01-01T00:00:00Z' },
    })
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'bot.removed', botId: 'scout', at: '2026-01-01T00:01:00Z' },
    })
    // The archive request's reply (the bot, now archived) is dispatched once the IPC call returns.
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'bot.updated', bot: { ...bot('scout'), lifecycle: 'archived' }, at: '2026-01-01T00:01:00Z' },
    })
    expect(state.snapshot.bots).toEqual([])
    // Restored, it is listed again.
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'bot.updated', bot: { ...bot('scout'), lifecycle: 'creating' }, at: '2026-01-01T00:02:00Z' },
    })
    expect(state.snapshot.bots.map((item) => item.id)).toEqual(['scout'])
  })
  it('keeps activity entries in sequence order without duplicates', () => {
    const entry = (seq: number) => ({
      seq,
      at: '2026-01-01T00:00:00Z',
      botId: null,
      environmentId: null,
      kind: 'bot_started' as const,
      summary: null,
      data: {},
    })
    let state = fleetReducer(initialFleetState, {
      type: 'event',
      value: { type: 'activity', at: '2026-01-01T00:00:00Z', entry: entry(2) },
    })
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'activity', at: '2026-01-01T00:00:00Z', entry: entry(1) },
    })
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'activity', at: '2026-01-01T00:00:00Z', entry: entry(2) },
    })
    expect(state.activity.map((item) => item.seq)).toEqual([1, 2])
  })
  it('formats pairing codes without punctuation or excess characters', () => {
    expect(formatPairingCode('ab 12--cD34!x')).toBe('AB12-CD34')
    expect(formatPairingCode('a')).toBe('A')
  })
  it('splits host memory into bot and system shares', () => {
    expect(memorySegments(host, [bot('scout')]).map((segment) => [segment.id, segment.fraction])).toEqual([
      ['scout', 0.25],
      ['system', 0.375],
    ])
    expect(memorySegments(null, [bot('scout')])).toEqual([])
  })
  it('maps activity variants to localization keys', () => {
    expect(activityLabel({ kind: 'tool', tool: 'bash', target: 'npm test' }, 'working')).toEqual({
      key: 'activity.tool',
      values: { tool: 'bash', target: 'npm test' },
    })
    expect(activityLabel({ kind: 'queued', count: 2 }, 'paused').key).toBe('activity.queued')
    expect(activityLabel(null, 'setup').key).toBe('status.setup')
  })
  it('reads a bot report that its accounts reached their usage limits', () => {
    expect(accountsExhaustedNotice('claude-accounts-exhausted until=2026-10-12T15:04:00.000Z')).toEqual({
      kind: 'claude',
      until: new Date('2026-10-12T15:04:00.000Z'),
    })
    expect(accountsExhaustedNotice('codex-accounts-exhausted')).toEqual({ kind: 'codex', until: null })
    expect(accountsExhaustedNotice('codex-accounts-exhausted until=never')).toEqual({ kind: 'codex', until: null })
    expect(accountsExhaustedNotice('Turn failed.')).toBeNull()
    expect(accountsExhaustedNotice(null)).toBeNull()
  })
})

describe('fleet state of several servers', () => {
  const A = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
  const B = 'bbbbbbbb-0000-4000-8000-000000000002' as FleetServerId
  const connected = { ...initialFleetState.connection, state: 'connected' as const, url: 'https://a.example' }
  const snapshotWithBot = (id: string) => ({ host: null, bots: [bot(id)], inbox: [], peerMessages: [] })

  it('applies an action to its own server only', () => {
    const a = fleetServersReducer({}, { serverId: A, action: { type: 'connection', value: connected } })
    const b = fleetServersReducer(a, { serverId: B, action: { type: 'snapshot', value: snapshotWithBot('alex') } })
    expect(b[A].connection).toEqual(connected)
    expect(b[A].snapshot.bots).toEqual([])
    expect(b[B].snapshot.bots.map((item) => item.id)).toEqual(['alex'])
    expect(b[B].connection).toEqual(initialFleetState.connection)
  })
  it('drops the state of servers that are no longer paired', () => {
    const state = { [A]: initialFleetState, [B]: initialFleetState }
    expect(Object.keys(fleetServersReducer(state, { type: 'retain', ids: [B] }))).toEqual([B])
    expect(fleetServersReducer(state, { type: 'retain', ids: [A, B] })).toBe(state)
  })
})

describe('a transcript and the events that reach it while it loads', () => {
  const T0 = '2026-01-01T00:00:00Z'
  const T1 = '2026-01-01T00:01:00Z'
  const T2 = '2026-01-01T00:02:00Z'
  const upsert = (item: FleetTranscriptItem): FleetAction => ({
    type: 'event',
    value: { type: 'transcript.upsert', botId: 'b', at: item.at, item },
  })
  const page = (items: FleetTranscriptItem[]): FleetAction => ({
    type: 'transcript.page',
    botId: 'b',
    page: { items, before: null },
    older: false,
  })
  const ids = (state: FleetState) => state.transcripts.b?.items.map((item) => item.id)

  it('keeps an item sent while the first page was on its way, read before it', () => {
    let state = fleetReducer(initialFleetState, { type: 'transcript.loading', botId: 'b' })
    state = fleetReducer(state, upsert(user('answer', T1)))
    state = fleetReducer(state, page([user('question', T0)]))
    expect(ids(state)).toEqual(['question', 'answer'])
    expect(state.transcripts.b.arrived).toBeUndefined()
  })
  it('keeps what arrived during a reload, newer than the page it read', () => {
    let state = fleetReducer(initialFleetState, page([user('question', T0)]))
    state = fleetReducer(state, { type: 'transcript.loading', botId: 'b' })
    state = fleetReducer(state, upsert(user('answer', T1)))
    expect(ids(state)).toEqual(['question', 'answer'])
    state = fleetReducer(state, page([user('question', T0)]))
    expect(ids(state)).toEqual(['question', 'answer'])
  })
  it('takes nothing for a transcript never opened, and forgets what arrived when its page fails', () => {
    expect(fleetReducer(initialFleetState, upsert(user('answer', T1)))).toBe(initialFleetState)
    let state = fleetReducer(initialFleetState, { type: 'transcript.loading', botId: 'b' })
    state = fleetReducer(state, upsert(user('answer', T1)))
    state = fleetReducer(state, { type: 'transcript.error', botId: 'b', error: 'offline' })
    state = fleetReducer(state, { type: 'transcript.loading', botId: 'b' })
    state = fleetReducer(state, page([user('question', T0)]))
    expect(ids(state)).toEqual(['question'])
  })
  it("does the same for a run's transcript", () => {
    const key = runTranscriptKey('b', 'r')
    let state = fleetReducer(initialFleetState, { type: 'runTranscript.loading', botId: 'b', runId: 'r' })
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'routine_run.transcript.upsert', botId: 'b', runId: 'r', at: T1, item: user('answer', T1) },
    })
    state = fleetReducer(state, {
      type: 'runTranscript.page',
      botId: 'b',
      runId: 'r',
      page: { items: [user('question', T0)], before: null },
      older: false,
    })
    expect(state.runTranscripts[key].items.map((item) => item.id)).toEqual(['question', 'answer'])
  })

  describe('loading it', () => {
    const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
    afterEach(() => vi.unstubAllGlobals())
    function setup(state: FleetState = initialFleetState) {
      const answers: Array<(page: FleetTranscriptPage) => void> = []
      const api = {
        fleetGetTranscript: vi.fn(() => new Promise<FleetTranscriptPage>((resolve) => answers.push(resolve))),
        fleetListRuns: vi.fn(async () => ({ runs: [], before: null })),
        fleetListPeerThreads: vi.fn(async () => ({ threads: [] })),
      }
      vi.stubGlobal('window', { api })
      const actions = createFleetActions(
        SERVER,
        (action) => {
          state = fleetReducer(state, action)
        },
        () => state,
        () => undefined
      )
      return { actions, api, answers, state: () => state }
    }

    it('drops the answer to a request a newer one overtook', async () => {
      const s = setup()
      const first = s.actions.loadTranscript('b')
      const second = s.actions.loadTranscript('b')
      s.answers[1]({ items: [user('question', T0), user('answer', T1)], before: null })
      await second
      s.answers[0]({ items: [user('question', T0)], before: null })
      await first
      expect(ids(s.state())).toEqual(['question', 'answer'])
    })
    it('reads a conversation shown before again each time it opens', async () => {
      const s = setup(fleetReducer(initialFleetState, page([user('question', T0)])))
      s.actions.ensureTranscript('b')
      // Shown again while its answer is on its way, it is not asked twice.
      s.actions.ensureTranscript('b')
      expect(s.api.fleetGetTranscript).toHaveBeenCalledTimes(1)
      expect(ids(s.state())).toEqual(['question'])
      s.answers[0]({ items: [user('question', T0), user('answer', T2)], before: null })
      await vi.waitFor(() => expect(ids(s.state())).toEqual(['question', 'answer']))
    })
    it('reads again what it holds once the stream reopens, and only then', () => {
      let held = fleetReducer(initialFleetState, page([user('question', T0)]))
      held = fleetReducer(held, { type: 'runs.page', botId: 'b', page: { runs: [], before: null }, older: false })
      const s = setup(held)
      s.actions.streamChanged('connected')
      expect(s.api.fleetGetTranscript).not.toHaveBeenCalled()
      // The connection telling something else while open reads nothing.
      s.actions.streamChanged('connected')
      expect(s.api.fleetGetTranscript).not.toHaveBeenCalled()
      s.actions.streamChanged('reconnecting')
      s.actions.streamChanged('connected')
      expect(s.api.fleetGetTranscript.mock.calls).toEqual([[SERVER, 'b', undefined]])
      expect(s.api.fleetListRuns.mock.calls).toEqual([[SERVER, 'b', null]])
      expect(s.api.fleetListPeerThreads).not.toHaveBeenCalled()
    })
    it('reads again a transcript reset while its first page was on its way', async () => {
      const s = setup()
      const first = s.actions.loadTranscript('b')
      const before = s.state()
      s.actions.dispatch({ type: 'event', value: { type: 'transcript.reset', botId: 'b', at: T1 } })
      s.actions.resyncBot('b', before)
      s.answers[1]({ items: [user('after', T1)], before: null })
      s.answers[0]({ items: [user('stale', T0)], before: null })
      await first
      await vi.waitFor(() => expect(ids(s.state())).toEqual(['after']))
    })
  })
})
