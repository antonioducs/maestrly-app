import type { FleetRoutineSchedule } from '@maestrly/bot-fleet-protocol'
import type { MessageKey, Text } from '../i18n/translate'

/** Token counts as the desktop shows them: 950, 64.0k, 1.2M. */
export const formatTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** A reasoning effort as people read it; levels this app does not know keep the server's name. */
export const effortLabel = (effort: string, t: Text['t']): string =>
  EFFORTS.has(effort) ? t(`effort.${effort}` as MessageKey) : effort.slice(0, 1).toUpperCase() + effort.slice(1)

/** A moment as a date and time in the app's language, such as when a device was last active. */
export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso)
  try {
    return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ')
  }
}

/** A time of day in the app's language, such as when a routine run ended. */
export function formatTime(iso: string, locale: string): string {
  const date = new Date(iso)
  try {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
}

/** A time, or its date when it was not today: a list of conversations shows each one's last activity this way. */
export function formatWhen(iso: string, locale: string, now: number): string {
  const date = new Date(iso)
  if (now - date.getTime() < 86_400_000 && new Date(now).getDate() === date.getDate()) return formatTime(iso, locale)
  try {
    return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
  } catch {
    return date.toISOString().slice(5, 10)
  }
}

/** A day of a history that is neither today nor yesterday: its weekday and date. */
export function formatDay(day: number, locale: string): string {
  try {
    const text = new Date(day).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'short' })
    return text.charAt(0).toUpperCase() + text.slice(1)
  } catch {
    return new Date(day).toISOString().slice(0, 10)
  }
}

/** File sizes in binary units, as the desktop shows them: 512 B, 1.5 KB, 4.0 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

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
