import { describe, expect, it } from 'vitest'
import { nextRun, nextWeeklyRun, upcomingRuns } from '../src/index.js'

describe('routine schedule math', () => {
  it('computes weekly runs across days and wraps around the week', () => {
    const monWedFri = { kind: 'weekly' as const, time: '08:30', days: [1, 3, 5], timezone: 'UTC' }
    // Monday 2026-11-16 before 08:30 -> same day
    expect(nextWeeklyRun(monWedFri, new Date('2026-11-16T08:00:00.000Z'))).toBe('2026-11-16T08:30:00.000Z')
    // Monday 2026-11-16 at 08:30 -> Wednesday 2026-11-18
    expect(nextWeeklyRun(monWedFri, new Date('2026-11-16T08:30:00.000Z'))).toBe('2026-11-18T08:30:00.000Z')
    // Friday 2026-11-20 after 08:30 -> Monday 2026-11-23
    expect(nextWeeklyRun(monWedFri, new Date('2026-11-20T09:00:00.000Z'))).toBe('2026-11-23T08:30:00.000Z')

    const daily = { kind: 'weekly' as const, time: '22:15', days: [], timezone: 'UTC' }
    expect(nextWeeklyRun(daily, new Date('2026-11-18T22:14:00.000Z'))).toBe('2026-11-18T22:15:00.000Z')
    expect(nextWeeklyRun(daily, new Date('2026-11-18T22:15:00.000Z'))).toBe('2026-11-19T22:15:00.000Z')
  })

  it('handles Europe/Lisbon DST transitions', () => {
    // Spring forward: 2026-03-29 01:00 WET -> 02:00 WEST. 01:30 does not exist -> first minute after gap is 02:00 WEST (01:00 UTC).
    expect(
      nextWeeklyRun(
        { kind: 'weekly', time: '01:30', days: [], timezone: 'Europe/Lisbon' },
        new Date('2026-03-29T00:30:00.000Z')
      )
    ).toBe('2026-03-29T01:00:00.000Z')

    // Normal summer day in WEST (UTC+1): 08:00 local = 07:00 UTC.
    expect(
      nextWeeklyRun(
        { kind: 'weekly', time: '08:00', days: [], timezone: 'Europe/Lisbon' },
        new Date('2026-03-29T06:00:00.000Z')
      )
    ).toBe('2026-03-29T07:00:00.000Z')

    // Fall back: 2026-10-25 02:00 WEST -> 01:00 WET. 01:30 occurs twice; picks first occurrence (00:30 UTC).
    expect(
      nextWeeklyRun(
        { kind: 'weekly', time: '01:30', days: [], timezone: 'Europe/Lisbon' },
        new Date('2026-10-25T00:15:00.000Z')
      )
    ).toBe('2026-10-25T00:30:00.000Z')

    // After fall-back into WET (UTC+0): 08:00 local = 08:00 UTC.
    expect(
      nextWeeklyRun(
        { kind: 'weekly', time: '08:00', days: [], timezone: 'Europe/Lisbon' },
        new Date('2026-10-25T07:00:00.000Z')
      )
    ).toBe('2026-10-25T08:00:00.000Z')
  })

  it('rejects invalid time zones with a plain Error', () => {
    expect(() =>
      nextWeeklyRun({ kind: 'weekly', time: '08:00', days: [], timezone: 'Mars/Olympus' }, new Date())
    ).toThrowError('Invalid time zone')
  })

  it('computes interval and weekly nextRun', () => {
    const after = new Date('2026-11-18T10:00:00.000Z')
    expect(nextRun({ kind: 'interval', everyMinutes: 30 }, after)).toBe('2026-11-18T10:30:00.000Z')
    expect(nextRun({ kind: 'weekly', time: '12:00', days: [], timezone: 'UTC' }, after)).toBe(
      '2026-11-18T12:00:00.000Z'
    )
  })

  it('computes upcomingRuns for weekly and interval schedules with optional first override', () => {
    const after = new Date('2026-11-18T10:00:00.000Z')
    expect(upcomingRuns({ kind: 'weekly', time: '08:00', days: [], timezone: 'UTC' }, after, 0)).toEqual([])

    const weekly = upcomingRuns(
      { kind: 'weekly', time: '08:00', days: [1, 4], timezone: 'Europe/Lisbon' },
      new Date('2026-03-26T07:00:00.000Z'), // Thursday before 08:00 WET (UTC+0)
      3
    )
    expect(weekly.map((d) => d.toISOString())).toEqual([
      '2026-03-26T08:00:00.000Z', // Thu WET (UTC+0)
      '2026-03-30T07:00:00.000Z', // Mon WEST (UTC+1, after DST)
      '2026-04-02T07:00:00.000Z', // Thu WEST (UTC+1)
    ])

    const interval = upcomingRuns(
      { kind: 'interval', everyMinutes: 45 },
      after,
      3,
      new Date('2026-11-18T10:12:00.000Z')
    )
    expect(interval.map((d) => d.toISOString())).toEqual([
      '2026-11-18T10:12:00.000Z',
      '2026-11-18T10:57:00.000Z',
      '2026-11-18T11:42:00.000Z',
    ])

    // Past first override is ignored
    const pastFirst = upcomingRuns(
      { kind: 'interval', everyMinutes: 30 },
      after,
      2,
      new Date('2026-11-18T09:50:00.000Z')
    )
    expect(pastFirst.map((d) => d.toISOString())).toEqual([
      '2026-11-18T10:30:00.000Z',
      '2026-11-18T11:00:00.000Z',
    ])
  })
})
