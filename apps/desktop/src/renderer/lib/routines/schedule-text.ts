import { upcomingRuns } from '@maestrly/bot-fleet-protocol'
import type { RoutineSchedule } from '../../../shared/routines'

export type RoutineTranslator = (key: string, opts?: Record<string, unknown>) => string

export function daysSummary(days: readonly number[], t: RoutineTranslator): string {
  if (!days.length || days.length === 7) return t('schedule.everyDays')
  const sorted = [...days].sort((a, b) => a - b)
  if (sorted.join(',') === '1,2,3,4,5') return t('schedule.weekdays')
  if (sorted.join(',') === '6,7') return t('schedule.weekends')
  return sorted.map((d) => t(`schedule.daysShort.${d}`)).join(', ')
}

export function scheduleSummary(schedule: RoutineSchedule, t: RoutineTranslator): string {
  if (schedule.kind === 'weekly') {
    return t('schedule.weeklySummary', {
      time: schedule.time,
      days: daysSummary(schedule.days, t),
    })
  }
  const mins = schedule.everyMinutes
  if (mins < 60) return t('schedule.everyMinutes', { count: mins })
  if (mins % 60 === 0) return t('schedule.everyHours', { count: mins / 60 })
  return t('schedule.everyHoursMinutes', {
    hours: Math.floor(mins / 60),
    minutes: mins % 60,
  })
}

export function scheduleBigTime(schedule: RoutineSchedule): string {
  if (schedule.kind === 'weekly') return schedule.time
  const mins = schedule.everyMinutes
  return mins % 60 === 0 ? `${mins / 60} h` : `${mins} min`
}

export function scheduleUnitLabel(schedule: RoutineSchedule, t: RoutineTranslator): string {
  if (schedule.kind === 'weekly') return daysSummary(schedule.days, t)
  return t('schedule.intervalUnit')
}

export function upcomingRunDates(
  schedule: RoutineSchedule,
  count: number,
  afterMs = Date.now(),
  firstNextMs?: number | null
): Date[] {
  if (count <= 0) return []
  try {
    const after = new Date(afterMs)
    const first = firstNextMs && firstNextMs > afterMs ? new Date(firstNextMs) : undefined
    return upcomingRuns(schedule, after, count, first)
  } catch {
    return []
  }
}
