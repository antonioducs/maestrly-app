import type { FleetRoutineSchedule } from '@maestrly/bot-fleet-protocol'
import type { MessageKey, Text } from '../i18n/translate'

/** Token counts as the desktop shows them: 950, 64.0k, 1.2M. */
export const formatTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** A reasoning effort as people read it; levels this app does not know keep the server's name. */
export const effortLabel = (effort: string, t: Text['t']): string =>
  EFFORTS.has(effort) ? t(`effort.${effort}` as MessageKey) : effort.slice(0, 1).toUpperCase() + effort.slice(1)

export const formatCost = (usd: number): string =>
  usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(4)}`

export function formatSchedule(schedule: FleetRoutineSchedule, { t, plural }: Text): string {
  if (schedule.kind === 'interval') {
    const minutes = schedule.everyMinutes
    return minutes % 60 === 0 ? plural('schedule.hours', minutes / 60) : plural('schedule.minutes', minutes)
  }
  const days = [...new Set(schedule.days)].sort((a, b) => a - b)
  const time = schedule.time
  if (days.length === 0 || days.length === 7) return t('schedule.daily', { time })
  if (days.join() === '1,2,3,4,5') return t('schedule.weekdays', { time })
  if (days.join() === '6,7') return t('schedule.weekends', { time })
  const names =
    days.length === 1
      ? t(`schedule.days.${days[0]}` as MessageKey)
      : days.map((day) => t(`schedule.dayShort.${day}` as MessageKey)).join(', ')
  return t('schedule.weekly', { days: names, time })
}
