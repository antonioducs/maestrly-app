import { describe, expect, it } from 'vitest'
import type { ScheduleSpec } from '@maestrly/host-protocol'
import {
  describeSchedule,
  enumerate,
  isAmbiguousInstant,
  latestDue,
  localReading,
  nextOccurrences,
  resolveLocal,
  MAX_LOOKBACK_MS,
} from '../src/routines/calendar.js'

const at = (iso: string) => Date.parse(iso)
const utcOf = (occurrences: { scheduledForUtc: string }[]) => occurrences.map((occurrence) => occurrence.scheduledForUtc)
const localOf = (occurrences: { scheduledForLocal: string }[]) => occurrences.map((occurrence) => occurrence.scheduledForLocal)

describe('daily and weekly calendars in a real zone', () => {
  it('fires at the person\'s local time even when the Host and the client are elsewhere', () => {
    const spec: ScheduleSpec = { kind: 'daily', hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' }
    // Mid-January: São Paulo is UTC-3 all year since 2019, so 09:00 local is 12:00Z.
    const next = nextOccurrences(spec, at('2026-01-05T00:00:00.000Z'), 3)
    expect(utcOf(next)).toEqual(['2026-01-05T12:00:00.000Z', '2026-01-06T12:00:00.000Z', '2026-01-07T12:00:00.000Z'])
    expect(localOf(next)).toEqual(['2026-01-05 09:00', '2026-01-06 09:00', '2026-01-07 09:00'])
    // A Host reading the same specification from another zone computes the same instants.
    const fromTokyo = nextOccurrences(spec, at('2026-01-05T00:00:00.000Z'), 1)
    expect(utcOf(fromTokyo)).toEqual(['2026-01-05T12:00:00.000Z'])
  })

  it('keeps European summer time honest: the UTC instant moves, the local reading does not', () => {
    const spec: ScheduleSpec = { kind: 'daily', hour: 9, minute: 0, timeZone: 'Europe/Lisbon' }
    const winter = nextOccurrences(spec, at('2026-03-27T00:00:00.000Z'), 1)
    const summer = nextOccurrences(spec, at('2026-03-30T00:00:00.000Z'), 1)
    expect(utcOf(winter)).toEqual(['2026-03-27T09:00:00.000Z'])
    expect(utcOf(summer)).toEqual(['2026-03-30T08:00:00.000Z'])
    expect(localOf(winter).concat(localOf(summer))).toEqual(['2026-03-27 09:00', '2026-03-30 09:00'])
  })

  it('uses ISO weekdays taken from the local date, not the UTC one', () => {
    // 21:00 in Auckland is still the previous UTC day: a naive UTC weekday would fire wrong.
    const spec: ScheduleSpec = { kind: 'weekly', daysOfWeek: [1], hour: 21, minute: 0, timeZone: 'Pacific/Auckland' }
    const next = nextOccurrences(spec, at('2026-02-01T00:00:00.000Z'), 2)
    for (const occurrence of next) expect(occurrence.scheduledForLocal.endsWith('21:00')).toBe(true)
    expect(utcOf(next)).toEqual(['2026-02-02T08:00:00.000Z', '2026-02-09T08:00:00.000Z'])
    expect(new Date(next[0].scheduledForUtc).getUTCDay()).toBe(1)
  })

  it('lists several weekdays in calendar order regardless of how they were written', () => {
    const spec: ScheduleSpec = { kind: 'weekly', daysOfWeek: [5, 1, 3], hour: 8, minute: 30, timeZone: 'America/Sao_Paulo' }
    const next = nextOccurrences(spec, at('2026-09-13T00:00:00.000Z'), 4)
    expect(utcOf(next)).toEqual([
      '2026-09-14T11:30:00.000Z',
      '2026-09-16T11:30:00.000Z',
      '2026-09-18T11:30:00.000Z',
      '2026-09-21T11:30:00.000Z',
    ])
  })
})

describe('daylight saving transitions', () => {
  it('skips 02:30 on the spring-forward day in New York instead of inventing an instant', () => {
    // 09/03/2025: the clock goes 01:59 → 03:00, so 02:30 never happens.
    expect(resolveLocal('America/New_York', { year: 2025, month: 3, day: 9, hour: 2, minute: 30 })).toEqual({ kind: 'gap' })
    const spec: ScheduleSpec = { kind: 'daily', hour: 2, minute: 30, timeZone: 'America/New_York' }
    const result = enumerate(spec, at('2025-03-08T00:00:00.000Z'), 3)
    expect(utcOf(result.occurrences)).toEqual(['2025-03-08T07:30:00.000Z', '2025-03-10T06:30:00.000Z', '2025-03-11T06:30:00.000Z'])
    expect(result.warnings.map((warning) => warning.code)).toContain('DST_GAP_SKIPPED')
    // The skipped day is simply absent; nothing was moved to another hour silently.
    expect(localOf(result.occurrences)).toEqual(['2025-03-08 02:30', '2025-03-10 02:30', '2025-03-11 02:30'])
  })

  it('runs only the first 01:30 on the fall-back day in New York', () => {
    // 02/11/2025: the clock goes 01:59 → 01:00, so 01:30 happens at 05:30Z and again at 06:30Z.
    const resolution = resolveLocal('America/New_York', { year: 2025, month: 11, day: 2, hour: 1, minute: 30 })
    expect(resolution.kind).toBe('ambiguous')
    if (resolution.kind === 'ambiguous')
      expect(resolution.instants.map((instant) => new Date(instant).toISOString())).toEqual(['2025-11-02T05:30:00.000Z', '2025-11-02T06:30:00.000Z'])
    const spec: ScheduleSpec = { kind: 'daily', hour: 1, minute: 30, timeZone: 'America/New_York' }
    const result = enumerate(spec, at('2025-11-01T00:00:00.000Z'), 3)
    expect(utcOf(result.occurrences)).toEqual(['2025-11-01T05:30:00.000Z', '2025-11-02T05:30:00.000Z', '2025-11-03T06:30:00.000Z'])
    expect(result.warnings.map((warning) => warning.code)).toContain('DST_OVERLAP_FIRST')
    // Exactly one firing that day, not two.
    expect(result.occurrences.filter((occurrence) => occurrence.scheduledForLocal.startsWith('2025-11-02')).length).toBe(1)
  })

  it('flags a single appointment whose local reading happens twice so the person chooses', () => {
    const early = at('2025-11-02T05:30:00.000Z')
    const late = at('2025-11-02T06:30:00.000Z')
    expect(isAmbiguousInstant('America/New_York', early)).toBe(true)
    expect(isAmbiguousInstant('America/New_York', late)).toBe(true)
    expect(localReading('America/New_York', early)).toBe(localReading('America/New_York', late))
    const result = enumerate({ kind: 'once', atUtc: '2025-11-02T05:30:00.000Z', timeZone: 'America/New_York' }, at('2025-11-01T00:00:00.000Z'), 3)
    expect(result.warnings.map((warning) => warning.code)).toContain('AMBIGUOUS_INSTANT')
    expect(utcOf(result.occurrences)).toEqual(['2025-11-02T05:30:00.000Z'])
  })
})

describe('monthly and leap-year calendars', () => {
  it('skips months that have no such day instead of falling back to the last one', () => {
    const spec: ScheduleSpec = { kind: 'monthly', dayOfMonth: 31, hour: 8, minute: 0, timeZone: 'America/Sao_Paulo' }
    const result = enumerate(spec, at('2026-01-01T00:00:00.000Z'), 4)
    expect(localOf(result.occurrences)).toEqual(['2026-01-31 08:00', '2026-03-31 08:00', '2026-05-31 08:00', '2026-07-31 08:00'])
    expect(result.warnings.map((warning) => warning.code)).toContain('MONTH_WITHOUT_DAY')
  })

  it('knows 29 February exists in a leap year and not otherwise', () => {
    const spec: ScheduleSpec = { kind: 'monthly', dayOfMonth: 29, hour: 12, minute: 0, timeZone: 'UTC' }
    const leap = enumerate(spec, at('2028-02-01T00:00:00.000Z'), 1)
    expect(localOf(leap.occurrences)).toEqual(['2028-02-29 12:00'])
    const common = enumerate(spec, at('2026-02-01T00:00:00.000Z'), 1)
    expect(localOf(common.occurrences)).toEqual(['2026-03-29 12:00'])
    // 2100 is not a leap year even though it is divisible by four.
    const century = enumerate(spec, at('2100-02-01T00:00:00.000Z'), 1)
    expect(localOf(century.occurrences)).toEqual(['2100-03-29 12:00'])
  })
})

describe('intervals do not drift', () => {
  it('anchors every firing on the anchor, never on when the previous one finished', () => {
    const spec: ScheduleSpec = { kind: 'interval', anchorUtc: '2026-01-01T00:00:00.000Z', everyMinutes: 30, timeZone: 'UTC' }
    // A firing that started at 10:00 and only ended at 10:17 must not push 10:30 to 10:47.
    expect(utcOf(nextOccurrences(spec, at('2026-01-01T10:17:00.000Z'), 2))).toEqual(['2026-01-01T10:30:00.000Z', '2026-01-01T11:00:00.000Z'])
    expect(utcOf(nextOccurrences(spec, at('2026-01-01T10:30:00.000Z'), 1))).toEqual(['2026-01-01T11:00:00.000Z'])
    // Even a thousand steps later the grid is exact, with no accumulated error.
    expect(utcOf(nextOccurrences(spec, at('2026-01-21T20:59:00.000Z'), 1))).toEqual(['2026-01-21T21:00:00.000Z'])
  })
})

describe('what the Host missed while it was off', () => {
  const daily: ScheduleSpec = { kind: 'daily', hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' }
  const window = 24 * 60 * 60_000

  it('recovers at most one firing and summarises the rest as a range with a cause', () => {
    // A thousand missed days: exactly one occurrence may be recovered, never a backlog.
    const summary = latestDue(daily, at('2023-01-01T00:00:00.000Z'), at('2026-09-16T13:00:00.000Z'), window)
    expect(summary.latest?.scheduledForUtc).toBe('2026-09-16T12:00:00.000Z')
    expect(summary.cause).toBe('MISSED_WINDOW')
    expect(summary.skipped).toBeGreaterThan(300)
    expect(summary.firstSkippedUtc).toBeDefined()
    expect(summary.lastSkippedUtc).toBe('2026-09-15T12:00:00.000Z')
    // The lookback itself is bounded: older firings are reported as gone, not enumerated.
    expect(summary.truncated).toBe(true)
    expect(at('2026-09-16T13:00:00.000Z') - Date.parse(summary.firstSkippedUtc!)).toBeLessThanOrEqual(MAX_LOOKBACK_MS)
  })

  it('recovers nothing when the last missed firing is older than the window', () => {
    const summary = latestDue(daily, at('2026-09-01T00:00:00.000Z'), at('2026-09-16T13:00:00.000Z'), 60_000)
    expect(summary.latest).toBeUndefined()
    expect(summary.skipped).toBe(16)
    expect(summary.lastSkippedUtc).toBe('2026-09-16T12:00:00.000Z')
  })

  it('reports nothing due when the Host was only briefly away', () => {
    const summary = latestDue(daily, at('2026-09-16T12:00:00.000Z'), at('2026-09-16T12:00:30.000Z'), window)
    expect(summary).toMatchObject({ skipped: 0, cause: 'ON_TIME' })
    expect(summary.latest).toBeUndefined()
  })

  it('counts an interval backlog by arithmetic instead of walking every step', () => {
    const spec: ScheduleSpec = { kind: 'interval', anchorUtc: '2026-01-01T00:00:00.000Z', everyMinutes: 15, timeZone: 'UTC' }
    const started = performance.now()
    const summary = latestDue(spec, at('2026-01-01T00:00:00.000Z'), at('2026-09-16T00:07:00.000Z'), window)
    expect(performance.now() - started).toBeLessThan(200)
    expect(summary.latest?.scheduledForUtc).toBe('2026-09-16T00:00:00.000Z')
    // 258 days × 96 firings a day, minus the one that is recovered and the anchor itself.
    expect(summary.skipped).toBe(24_767)
  })
})

describe('a clock that moves backwards', () => {
  it('never reopens a slot that was already processed', () => {
    const spec: ScheduleSpec = { kind: 'daily', hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' }
    const watermark = at('2026-09-16T12:00:00.000Z')
    // The machine clock jumped back an hour after the firing was recorded.
    const summary = latestDue(spec, watermark, at('2026-09-16T11:00:00.000Z'), 24 * 60 * 60_000)
    expect(summary.latest).toBeUndefined()
    expect(summary.skipped).toBe(0)
    // And the next firing is still strictly after the watermark.
    expect(utcOf(nextOccurrences(spec, watermark, 1))).toEqual(['2026-09-17T12:00:00.000Z'])
  })
})

describe('human-readable summaries', () => {
  it('always names the zone so a schedule is never silently interpreted', () => {
    expect(describeSchedule({ kind: 'daily', hour: 9, minute: 5, timeZone: 'America/Sao_Paulo' })).toBe('todos os dias às 09:05 (America/Sao_Paulo)')
    expect(describeSchedule({ kind: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' })).toBe('toda segunda às 09:00 (America/Sao_Paulo)')
    expect(describeSchedule({ kind: 'monthly', dayOfMonth: 5, hour: 7, minute: 0, timeZone: 'UTC' })).toBe('todo dia 5 às 07:00 (UTC)')
    expect(describeSchedule({ kind: 'interval', anchorUtc: '2026-01-01T00:00:00.000Z', everyMinutes: 120, timeZone: 'UTC' })).toBe('a cada 2 hora(s) (UTC)')
    expect(describeSchedule({ kind: 'once', atUtc: '2026-09-16T12:00:00.000Z', timeZone: 'America/Sao_Paulo' })).toContain('2026-09-16 09:00')
  })
})
