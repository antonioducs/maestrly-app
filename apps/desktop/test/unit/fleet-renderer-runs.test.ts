import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
  fleetRoutineRunSchema,
  type FleetBot,
  type FleetRoutineRun,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import {
  readSeenRuns,
  runDayLabel,
  runDays,
  runExpiresInDays,
  runMarkers,
  runSeenKey,
  runState,
  runSummary,
  unseenRuns,
  writeSeenRuns,
} from '../../src/renderer/lib/fleet/runs'
import { fleetReducer, initialFleetState, runTranscriptKey, type FleetState } from '../../src/renderer/lib/fleet/state'

const AT = '2026-10-18T12:00:00.000Z'
const run = (id: string, deliveredAt: string, fields: Partial<FleetRoutineRun> = {}): FleetRoutineRun =>
  fleetRoutineRunSchema.parse({
    id,
    routineId: 'routine-1',
    botId: 'alpha',
    trigger: 'schedule',
    status: 'completed',
    deliveredAt,
    finishedAt: deliveredAt,
    report: null,
    finalText: null,
    routineTitle: 'Inbox',
    conversation: 'own',
    ...fields,
  })
const idle: Pick<FleetBot, 'runningRun'> = { runningRun: null }
const local = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime()
const iso = (time: number) => new Date(time).toISOString()
const user = (id: string, at: string): FleetTranscriptItem => ({
  kind: 'user',
  id,
  at,
  text: id,
  source: 'owner',
  queued: false,
  memories: [],
  images: [],
})

describe('routine run helpers', () => {
  it('tells what a run is now, the run working first', () => {
    expect(
      runState(run('r1', AT, { status: 'delivered' }), {
        runningRun: { id: 'r1', routineId: 'routine-1', title: 'Inbox', startedAt: AT },
      })
    ).toBe('running')
    expect(runState(run('r1', AT, { status: 'delivered' }), idle)).toBe('queued')
    expect(runState(run('r1', AT, { conversation: 'deleted', status: 'failed' }), idle)).toBe('deleted')
    expect(runState(run('r1', AT, { status: 'failed' }), idle)).toBe('failed')
    expect(runState(run('r1', AT, { status: 'cancelled' }), idle)).toBe('cancelled')
    expect(runState(run('r1', AT, { quiet: true }), idle)).toBe('quiet')
    expect(runState(run('r1', AT), idle)).toBe('ok')
  })

  it('summarizes a run by its report, or else by the first line of its answer', () => {
    expect(runSummary(run('r1', AT, { report: { summary: 'Filed 3 invoices', pending: null, notes: null } }))).toBe(
      'Filed 3 invoices'
    )
    expect(runSummary(run('r1', AT, { finalText: '\n  Two new replies.\nMore detail' }))).toBe('Two new replies.')
    expect(runSummary(run('r1', AT))).toBeNull()
  })

  it('counts the days left before retention deletes a conversation', () => {
    const now = Date.parse(AT)
    expect(runExpiresInDays(run('r1', AT), now)).toBeNull()
    expect(runExpiresInDays(run('r1', AT, { expiresAt: iso(now + 2.5 * 86_400_000) }), now)).toBe(3)
    expect(runExpiresInDays(run('r1', AT, { expiresAt: iso(now - 1000) }), now)).toBe(0)
  })

  it('groups runs by day and folds the runs of one routine with nothing new', () => {
    const runs = [
      run('r5', iso(local(2026, 10, 18, 15)), { quiet: true }),
      run('r4', iso(local(2026, 10, 18, 14)), { routineId: 'routine-2', quiet: true }),
      run('r3', iso(local(2026, 10, 18, 13))),
      run('r2', iso(local(2026, 10, 18, 11)), { quiet: true }),
      run('r1', iso(local(2026, 10, 17, 9)), { quiet: true }),
    ]
    const days = runDays(runs, idle)
    expect(days.map((day) => day.entries.length)).toEqual([3, 1])
    const [folded, single, other] = days[0].entries
    expect(folded.kind === 'quiet' && folded.runs.map((item) => item.id)).toEqual(['r5', 'r2'])
    expect(single.kind === 'run' && single.run.id).toBe('r4')
    expect(other.kind === 'run' && other.run.id).toBe('r3')
    expect(days[1].entries[0].kind).toBe('run')
  })

  it('names today and yesterday, and dates the other days', () => {
    const now = local(2026, 10, 18, 9)
    const words = { today: 'Today', yesterday: 'Yesterday' }
    expect(runDayLabel(local(2026, 10, 18, 0), now, 'en-US', words)).toBe('Today')
    expect(runDayLabel(local(2026, 10, 17, 0), now, 'en-US', words)).toBe('Yesterday')
    expect(runDayLabel(local(2026, 10, 15, 0), now, 'en-US', words)).toContain('15')
  })

  it('tells the owner about finished runs as the settings say, never about runs in the conversation', () => {
    const runs = [
      run('new', AT),
      run('quiet', AT, { quiet: true }),
      run('failed', AT, { status: 'failed', quiet: true }),
      run('working', AT, { status: 'delivered', finishedAt: null }),
      run('legacy', AT, { conversation: 'primary' }),
    ]
    const ids = (notify: 'notable' | 'all' | 'none') =>
      runMarkers(runs, { ...FLEET_ROUTINE_RUN_SETTINGS_DEFAULT, notify }).map((item) => item.id)
    expect(ids('notable')).toEqual(['new', 'failed'])
    expect(ids('all')).toEqual(['new', 'quiet', 'failed'])
    expect(ids('none')).toEqual([])
  })
})

describe('seen routine runs', () => {
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

  it('counts every run there already as seen the first time, and only later ones as new', () => {
    const key = runSeenKey('https://gateway.test', 'alpha')
    const first = readSeenRuns(key, [run('r1', AT), run('r2', AT, { status: 'failed' })])
    expect([...first]).toEqual(['r1', 'r2'])
    const runs = [run('r3', AT), run('r4', AT, { quiet: true }), run('r1', AT)]
    const seen = readSeenRuns(key, runs)
    expect(unseenRuns(runs, seen, idle).map((item) => item.id)).toEqual(['r3'])
    writeSeenRuns(key, new Set([...seen, 'r3']))
    expect(unseenRuns(runs, readSeenRuns(key, runs), idle)).toEqual([])
  })
})

describe('routine runs in the renderer state', () => {
  const loaded = (state: FleetState = initialFleetState) =>
    fleetReducer(state, {
      type: 'runs.page',
      botId: 'alpha',
      page: { runs: [run('r2', '2026-10-18T10:00:00.000Z'), run('r1', '2026-10-18T09:00:00.000Z')], before: 'cursor' },
      older: false,
    })

  it('joins older pages and keeps the newest run first', () => {
    const older = fleetReducer(loaded(), {
      type: 'runs.page',
      botId: 'alpha',
      page: { runs: [run('r0', '2026-10-18T08:00:00.000Z')], before: null },
      older: true,
    })
    expect(older.runs.alpha.runs.map((item) => item.id)).toEqual(['r2', 'r1', 'r0'])
    expect(older.runs.alpha.before).toBeNull()
    // A newer first page keeps what was loaded before it.
    const refreshed = fleetReducer(older, {
      type: 'runs.page',
      botId: 'alpha',
      page: { runs: [run('r3', '2026-10-18T11:00:00.000Z'), run('r2', '2026-10-18T10:00:00.000Z')], before: 'cursor' },
      older: false,
    })
    expect(refreshed.runs.alpha.runs.map((item) => item.id)).toEqual(['r3', 'r2', 'r1', 'r0'])
    expect(refreshed.runs.alpha.before).toBeNull()
  })

  it('applies run events only to runs it loaded', () => {
    const updated = run('r3', '2026-10-18T11:00:00.000Z', { status: 'delivered', finishedAt: null })
    const event = {
      type: 'event' as const,
      value: { type: 'routine_run.updated' as const, at: AT, botId: 'alpha', run: updated },
    }
    expect(fleetReducer(initialFleetState, event).runs).toEqual({})
    const state = fleetReducer(loaded(), event)
    expect(state.runs.alpha.runs.map((item) => item.id)).toEqual(['r3', 'r2', 'r1'])
    const removed = fleetReducer(state, {
      type: 'event',
      value: { type: 'routine_run.removed', at: AT, botId: 'alpha', runId: 'r2' },
    })
    expect(removed.runs.alpha.runs.map((item) => item.id)).toEqual(['r3', 'r1'])
  })

  it("keeps a run's transcript apart from the bot's, and drops both with the bot", () => {
    const key = runTranscriptKey('alpha', 'r1')
    let state = fleetReducer(loaded(), {
      type: 'runTranscript.page',
      botId: 'alpha',
      runId: 'r1',
      page: { items: [user('m1', AT)], before: null },
      older: false,
    })
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'routine_run.transcript.upsert', at: AT, botId: 'alpha', runId: 'r1', item: user('m2', AT) },
    })
    expect(state.runTranscripts[key].items.map((item) => item.id)).toEqual(['m1', 'm2'])
    expect(state.transcripts.alpha).toBeUndefined()
    const reset = fleetReducer(state, {
      type: 'event',
      value: { type: 'routine_run.transcript.reset', at: AT, botId: 'alpha', runId: 'r1' },
    })
    expect(reset.runTranscripts[key].loaded).toBe(false)
    const gone = fleetReducer(state, { type: 'event', value: { type: 'bot.removed', at: AT, botId: 'alpha' } })
    expect(gone.runs).toEqual({})
    expect(gone.runTranscripts).toEqual({})
  })
})
