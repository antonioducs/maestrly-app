import type { FleetRoutineSchedule, FleetWeeklySchedule } from './domain.js'
import { isValidTimeZone } from './helpers.js'

type Parts = { year: number; month: number; day: number; hour: number; minute: number }

function parts(formatter: Intl.DateTimeFormat, value: number): Parts {
  const entries = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  )
  return entries as Parts
}

function formatter(timezone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

export function nextWeeklyRun(schedule: FleetWeeklySchedule, after: Date): string {
  if (!isValidTimeZone(schedule.timezone)) throw new Error('Invalid time zone')
  const fmt = formatter(schedule.timezone)
  const start = parts(fmt, after.getTime())
  const date = Date.UTC(start.year, start.month - 1, start.day)
  const [hour, minute] = schedule.time.split(':').map(Number)
  for (let day = 0; day < 8; day++) {
    const localDate = new Date(date + day * 86400000)
    const year = localDate.getUTCFullYear(),
      month = localDate.getUTCMonth() + 1,
      dayOfMonth = localDate.getUTCDate()
    const isoDay = ((localDate.getUTCDay() + 6) % 7) + 1
    if (schedule.days.length && !schedule.days.includes(isoDay)) continue
    const noon = Date.UTC(year, month - 1, dayOfMonth, 12)
    const noonParts = parts(fmt, noon)
    const offset = Date.UTC(noonParts.year, noonParts.month - 1, noonParts.day, noonParts.hour, noonParts.minute) - noon
    const guess = Date.UTC(year, month - 1, dayOfMonth, hour, minute) - offset
    let first: number | null = null
    let firstAfterGap: number | null = null
    for (let time = guess - 3 * 3600000; time <= guess + 3 * 3600000; time += 60000) {
      const local = parts(fmt, time)
      if (local.year !== year || local.month !== month || local.day !== dayOfMonth) continue
      const localMinute = local.hour * 60 + local.minute
      if (localMinute === hour * 60 + minute) {
        first = time
        break
      }
      if (localMinute > hour * 60 + minute && firstAfterGap === null) firstAfterGap = time
    }
    const candidate = first ?? firstAfterGap
    if (candidate !== null && candidate > after.getTime()) return new Date(candidate).toISOString()
  }
  throw new Error('Could not calculate next routine run')
}

export function nextRun(schedule: FleetRoutineSchedule, after: Date): string {
  return schedule.kind === 'weekly'
    ? nextWeeklyRun(schedule, after)
    : new Date(after.getTime() + schedule.everyMinutes * 60_000).toISOString()
}

/** The next `count` run times after `after`; `first` overrides the first one (an interval routine's stored next run). */
export function upcomingRuns(schedule: FleetRoutineSchedule, after: Date, count: number, first?: Date): Date[] {
  if (count <= 0) return []
  const runs: Date[] = []
  let cursor = after
  if (first && first.getTime() > after.getTime()) {
    const clamped = new Date(first.getTime())
    runs.push(clamped)
    cursor = clamped
  }
  while (runs.length < count) {
    const next = new Date(nextRun(schedule, cursor))
    runs.push(next)
    cursor = next
  }
  return runs
}
