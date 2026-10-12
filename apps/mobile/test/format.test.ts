import { describe, expect, it } from 'vitest'
import { translator } from '../src/i18n/translate'
import { formatCost, formatSchedule, formatTokens } from '../src/fleet/format'

const en = translator('en')
const weekly = (days: number[], time: string) => ({ kind: 'weekly' as const, days, time, timezone: 'UTC' })

describe('formatting', () => {
  it('shortens token counts like the desktop', () => {
    expect(formatTokens(64000)).toBe('64.0k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(950)).toBe('950')
  })
  it('formats costs with enough precision to read', () => {
    expect(formatCost(2.41)).toBe('$2.41')
    expect(formatCost(0.08)).toBe('$0.080')
  })
  it('describes routine schedules', () => {
    expect(formatSchedule(weekly([1, 2, 3, 4, 5], '08:30'), en, 'en')).toBe('Weekdays at 08:30')
    expect(formatSchedule(weekly([1, 2, 3, 4, 5, 6, 7], '02:00'), en, 'en')).toBe('Daily at 02:00')
    expect(formatSchedule(weekly([], '02:00'), en, 'en')).toBe('Daily at 02:00')
    expect(formatSchedule(weekly([1], '07:00'), en, 'en')).toBe('Mondays at 07:00')
    expect(formatSchedule(weekly([6, 7], '10:00'), en, 'en')).toBe('Weekends at 10:00')
    expect(formatSchedule(weekly([1, 3], '09:00'), en, 'en')).toBe('Mon, Wed at 09:00')
    expect(formatSchedule({ kind: 'interval', everyMinutes: 120 }, en, 'en')).toBe('Every 2 hours')
    expect(formatSchedule({ kind: 'interval', everyMinutes: 60 }, en, 'en')).toBe('Every hour')
    expect(formatSchedule({ kind: 'interval', everyMinutes: 90 }, en, 'en')).toBe('Every 90 minutes')
  })
})
