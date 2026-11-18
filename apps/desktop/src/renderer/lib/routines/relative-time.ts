import type { RoutineTranslator } from './schedule-text'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const FALLBACK_MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const FALLBACK_WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

function monthsList(t: RoutineTranslator): readonly string[] {
  const raw = t('schedule.monthsShort', { returnObjects: true }) as unknown
  return Array.isArray(raw) && raw.length === 12 ? (raw as string[]) : FALLBACK_MONTHS
}

export function weekdaysList(t: RoutineTranslator): readonly string[] {
  const raw = t('schedule.weekdaysShort', { returnObjects: true }) as unknown
  return Array.isArray(raw) && raw.length === 7 ? (raw as string[]) : FALLBACK_WEEKDAYS
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function addLocalDays(ms: number, days: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

export function formatHHMM(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatDayShort(ms: number, t: RoutineTranslator): string {
  const d = new Date(ms)
  return `${d.getDate()} ${monthsList(t)[d.getMonth()]}`
}

export function formatDayName(ms: number, refMs: number, t: RoutineTranslator): string {
  const diff = startOfLocalDay(ms) - startOfLocalDay(refMs)
  if (diff === 0) return t('timeline.today')
  if (diff === DAY) return t('timeline.tomorrow')
  if (diff === -DAY) return t('timeline.yesterday')
  const d = new Date(ms)
  return `${weekdaysList(t)[d.getDay()]}, ${formatDayShort(ms, t)}`
}

export function formatWhen(ms: number, refMs: number, t: RoutineTranslator): string {
  return `${formatDayName(ms, refMs, t)}, ${formatHHMM(ms)}`
}

export function formatRunDay(ms: number, refMs: number, t: RoutineTranslator, withWeekday = false): string {
  const diff = startOfLocalDay(ms) - startOfLocalDay(refMs)
  if (diff === 0) return t('timeline.today')
  if (diff === -DAY) return t('timeline.yesterday')
  const d = new Date(ms)
  return `${withWeekday ? `${weekdaysList(t)[d.getDay()]} ` : ''}${formatDayShort(ms, t)}`
}

export function formatShortIn(ms: number, refMs: number, t: RoutineTranslator): string {
  const d = Math.max(0, ms - refMs)
  if (d < HOUR) return t('schedule.minutes', { count: Math.max(1, Math.round(d / MIN)) })
  if (d < DAY) return t('schedule.hours', { count: Math.round(d / HOUR) })
  return t('schedule.days', { count: Math.round(d / DAY) })
}

export function formatRelative(ms: number, refMs: number, t: RoutineTranslator): string {
  const diff = ms - refMs
  const abs = Math.abs(diff)
  let txt: string
  if (abs < MIN) txt = t('schedule.lessThanMin')
  else if (abs < HOUR) txt = t('schedule.minutes', { count: Math.round(abs / MIN) })
  else if (abs < DAY) txt = t('schedule.hours', { count: Math.round(abs / HOUR) })
  else txt = t('schedule.days', { count: Math.round(abs / DAY) })
  return diff >= 0 ? t('schedule.relativeFuture', { time: txt }) : t('schedule.relativePast', { time: txt })
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m >= 60) return `${Math.floor(m / 60)} h ${m % 60} min`
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
}
