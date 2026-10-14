import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluralCategory, translator } from '../src/i18n/translate'
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
    expect(formatSchedule(weekly([1, 2, 3, 4, 5], '08:30'), en)).toBe('Weekdays at 08:30')
    expect(formatSchedule(weekly([1, 2, 3, 4, 5, 6, 7], '02:00'), en)).toBe('Daily at 02:00')
    expect(formatSchedule(weekly([], '02:00'), en)).toBe('Daily at 02:00')
    expect(formatSchedule(weekly([1], '07:00'), en)).toBe('Mondays at 07:00')
    expect(formatSchedule(weekly([6, 7], '10:00'), en)).toBe('Weekends at 10:00')
    expect(formatSchedule(weekly([1, 3], '09:00'), en)).toBe('Mon, Wed at 09:00')
    expect(formatSchedule({ kind: 'interval', everyMinutes: 120 }, en)).toBe('Every 2 hours')
    expect(formatSchedule({ kind: 'interval', everyMinutes: 60 }, en)).toBe('Every hour')
    expect(formatSchedule({ kind: 'interval', everyMinutes: 90 }, en)).toBe('Every 90 minutes')
  })

  describe('without Intl.PluralRules or date formats, as on Hermes', () => {
    afterEach(() => vi.unstubAllGlobals())
    it('picks the plural form of each language', () => {
      vi.stubGlobal('Intl', { ...Intl, PluralRules: undefined, DateTimeFormat: undefined })
      expect([0, 1, 2, 1.5].map((count) => pluralCategory(count, 'en'))).toEqual(['other', 'one', 'other', 'other'])
      expect([0, 1, 2, 1.5].map((count) => pluralCategory(count, 'pt-BR'))).toEqual(['one', 'one', 'other', 'one'])
      expect(formatSchedule({ kind: 'interval', everyMinutes: 60 }, en)).toBe('Every hour')
      expect(formatSchedule({ kind: 'interval', everyMinutes: 120 }, translator('pt-BR'))).toBe('A cada 2 horas')
      expect(formatSchedule(weekly([1, 3], '09:00'), translator('pt-BR'))).toBe('seg, qua às 09:00')
      expect(formatSchedule(weekly([2, 4], '09:00'), en)).toBe('Tue, Thu at 09:00')
    })
  })
})
