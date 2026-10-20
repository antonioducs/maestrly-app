import {
  FLEET_PEER_CONVERSATIONS_FEATURE,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  fleetPeerThreadSchema,
  fleetRoutineRunSchema,
  type FleetPeerThread,
  type FleetRoutineRun,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { botRecord } from '../src/fleet/factories'
import {
  dayKind,
  dayStart,
  lanesSupported,
  runDays,
  runMarkers,
  runState,
  runSummary,
  sideTurns,
  threadGroups,
  threadState,
  unseenRuns,
  unseenThreads,
} from '../src/fleet/lanes'
import { eventsQuery } from '../src/fleet/source'
import { transcriptRows, withExtras } from '../src/fleet/transcript-rows'

// Local times, so the runs fall on the days the test names wherever it runs.
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString()
const idle = { runningRun: null, turns: null }

function run(fields: Partial<FleetRoutineRun> & Pick<FleetRoutineRun, 'id'>): FleetRoutineRun {
  return fleetRoutineRunSchema.parse({
    routineId: 'r-check',
    botId: 'atlas',
    trigger: 'schedule',
    status: 'completed',
    deliveredAt: local(19, 9),
    finishedAt: local(19, 9, 1),
    report: null,
    finalText: null,
    conversation: 'own',
    ...fields,
  })
}

function thread(fields: Partial<FleetPeerThread> & Pick<FleetPeerThread, 'id'>): FleetPeerThread {
  return fleetPeerThreadSchema.parse({
    botId: 'atlas',
    peer: { botId: 'pixel', name: 'Pixel' },
    title: 'Pricing hero',
    origin: 'primary',
    status: 'open',
    hops: 0,
    hopLimit: 8,
    messages: 2,
    pinned: false,
    conversation: 'own',
    report: null,
    reportAt: null,
    working: false,
    peerWorking: false,
    createdAt: local(19, 8),
    lastActivityAt: local(19, 8),
    expiresAt: null,
    conversationDeletedAt: null,
    kept: null,
    ...fields,
  })
}

describe('side conversations', () => {
  it('shows tabs only where both the server and the bot keep runs and threads apart', () => {
    const both = [FLEET_ROUTINE_CONVERSATIONS_FEATURE, FLEET_PEER_CONVERSATIONS_FEATURE]
    expect(lanesSupported(both, botRecord({ id: 'a', name: 'A', capabilities: both }))).toEqual({
      runs: true,
      threads: true,
    })
    expect(
      lanesSupported(both, botRecord({ id: 'a', name: 'A', capabilities: [FLEET_ROUTINE_CONVERSATIONS_FEATURE] }))
    ).toEqual({
      runs: true,
      threads: false,
    })
    expect(lanesSupported([], botRecord({ id: 'a', name: 'A', capabilities: both }))).toEqual({
      runs: false,
      threads: false,
    })
  })

  it('reads a run’s state from the bot’s turns first, then from the run', () => {
    const working = {
      runningRun: null,
      turns: [
        { kind: 'routine' as const, id: 'r1', title: 'Check', startedAt: local(19, 9), tool: null, cancelling: false },
      ],
    }
    expect(runState(run({ id: 'r1', status: 'delivered' }), working)).toBe('running')
    expect(runState(run({ id: 'r1', status: 'delivered' }), idle)).toBe('queued')
    expect(runState(run({ id: 'r1', quiet: true }), idle)).toBe('quiet')
    expect(runState(run({ id: 'r1', status: 'failed' }), idle)).toBe('failed')
    expect(runState(run({ id: 'r1', conversation: 'deleted' }), idle)).toBe('deleted')
    // A gateway that predates parallel turns names the one run the bot works on.
    const legacy = { runningRun: { id: 'r1', routineId: 'r-check', title: 'Check', startedAt: local(19, 9) } }
    expect(runState(run({ id: 'r1', status: 'delivered' }), legacy)).toBe('running')
    expect(sideTurns({ status: 'working', ...legacy })).toEqual([
      { kind: 'routine', id: 'r1', title: 'Check', startedAt: local(19, 9) },
    ])
  })

  it('says what a run did from its report, or the first line of its answer', () => {
    expect(runSummary(run({ id: 'r1', report: { summary: 'All green.', pending: null, notes: null } }))).toBe(
      'All green.'
    )
    expect(runSummary(run({ id: 'r1', finalText: '\n  First line\nSecond' }))).toBe('First line')
    expect(runSummary(run({ id: 'r1' }))).toBeNull()
  })

  it('groups runs by day and folds a routine’s runs with nothing new, keeping a lone one apart', () => {
    const runs = [
      run({ id: 'a', deliveredAt: local(19, 12), quiet: true }),
      run({ id: 'b', deliveredAt: local(19, 11), routineId: 'r-release' }),
      run({ id: 'c', deliveredAt: local(19, 10), quiet: true }),
      run({ id: 'd', deliveredAt: local(19, 9), quiet: true }),
      run({ id: 'e', deliveredAt: local(18, 9), quiet: true }),
    ]
    const days = runDays(runs, idle)
    expect(days.map((day) => day.day)).toEqual([dayStart(Date.parse(local(19, 0))), dayStart(Date.parse(local(18, 0)))])
    expect(
      days[0].entries.map((entry) => (entry.kind === 'run' ? entry.run.id : entry.runs.map((item) => item.id)))
    ).toEqual([['a', 'c', 'd'], 'b'])
    expect(days[1].entries.map((entry) => entry.kind)).toEqual(['run'])
    expect(dayKind(days[0].day, Date.parse(local(19, 18)))).toBe('today')
    expect(dayKind(days[1].day, Date.parse(local(19, 18)))).toBe('yesterday')
    expect(dayKind(days[1].day, Date.parse(local(21, 18)))).toBe('other')
  })

  it('tells the conversation about the runs the bot’s settings ask for', () => {
    const runs = [
      run({ id: 'news' }),
      run({ id: 'quiet', quiet: true }),
      run({ id: 'failed', status: 'failed', quiet: true }),
      run({ id: 'working', status: 'delivered', finishedAt: null }),
      run({ id: 'legacy', conversation: 'primary' }),
    ]
    const ids = (notify: 'notable' | 'all' | 'none') =>
      runMarkers(runs, { retentionDays: 30, capPerRoutine: true, quietEarly: true, notify }).map((item) => item.id)
    expect(ids('notable')).toEqual(['news', 'failed'])
    expect(ids('all')).toEqual(['news', 'quiet', 'failed'])
    expect(ids('none')).toEqual([])
  })

  it('counts finished runs with news or failures the owner has not opened as new', () => {
    const runs = [run({ id: 'a' }), run({ id: 'b', status: 'failed' }), run({ id: 'c', quiet: true }), run({ id: 'd' })]
    expect(unseenRuns(runs, new Set(['d']), idle).map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('puts the threads that wait for the owner first, and counts them as new until answered', () => {
    const threads = [
      thread({ id: 'open', lastActivityAt: local(19, 10) }),
      thread({ id: 'paused', status: 'paused', hops: 8 }),
      thread({ id: 'working', peerWorking: true }),
      thread({ id: 'gone', conversation: 'deleted' }),
    ]
    expect(threadState(threads[2])).toBe('working')
    expect(threadState(threads[3])).toBe('deleted')
    expect(threadGroups(threads).map((group) => [group.key, group.threads.map((item) => item.id)])).toEqual([
      ['needs', ['paused']],
      ['active', ['working']],
      ['earlier', ['open', 'gone']],
    ])
    const seen = new Map([
      ['open', local(19, 8)],
      ['paused', local(19, 8)],
      ['working', local(19, 8)],
    ])
    // A paused thread waits whatever was seen of it; another counts once it moved on; a deleted one never does.
    expect(unseenThreads(threads, seen).map((item) => item.id)).toEqual(['open', 'paused'])
  })

  it('shows a run’s notice where the conversation was when it ended, without splitting a turn', () => {
    const item = (id: string, minute: number, kind: 'user' | 'assistant'): FleetTranscriptItem =>
      kind === 'user'
        ? { id, at: local(19, 9, minute), kind, text: id, source: 'owner', queued: false, memories: [], images: [] }
        : { id, at: local(19, 9, minute), kind, text: id, streaming: false }
    const rows = transcriptRows([item('u1', 0, 'user'), item('a1', 2, 'assistant'), item('u2', 10, 'user')])
    const placed = withExtras(rows, [
      { key: 'late', at: local(19, 9, 30) },
      { key: 'outbox' },
      { key: 'mid', at: local(19, 9, 1) },
    ])
    expect(
      placed.map((row) => (row.kind === 'extra' ? row.row.key : row.kind === 'item' ? row.item.id : row.kind))
    ).toEqual(['u1', 'a1', 'mid', 'u2', 'late', 'outbox'])
  })

  it('asks the event stream for runs and threads, and for reasoning when the server sends it', () => {
    expect(eventsQuery(true)).toEqual({ reasoning: 1, routineRuns: 1, peerThreads: 1 })
    expect(eventsQuery(false)).toEqual({ routineRuns: 1, peerThreads: 1 })
  })
})
