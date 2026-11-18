import { nextRun } from '@maestrly/bot-fleet-protocol'
import { isRoutineRunSkipped, type LocalRoutine, type LocalRoutineRun, type RoutineRunStatus } from '../../../shared/routines'
import { addLocalDays, formatHHMM, formatWhen, startOfLocalDay, weekdaysList } from './relative-time'
import type { RoutineTranslator } from './schedule-text'

export type RoutineTone = 'notable' | 'quiet' | 'ok' | 'error' | 'warn' | 'run' | 'skip'

export interface TimelineDay {
  leftPct: number
  label: string
  isToday: boolean
}

export interface TimelineNight {
  leftPct: number
  widthPct: number
}

export interface TimelinePastTick {
  run: LocalRoutineRun
  at: number
  tone: RoutineTone
  skipped: boolean
  leftStyle: string
  ariaLabel: string
  tip: string
  tipSub: string
}

export interface TimelineFutureTick {
  at: number
  leftStyle: string
  tip: string
  tipSub: string
}

export interface TimelineRow {
  routine: LocalRoutine
  useBars: boolean
  pastTicks: TimelinePastTick[]
  futureTicks: TimelineFutureTick[]
  pausedFromPct: number | null
}

export interface TimelineData {
  start: number
  end: number
  span: number
  nowPct: number
  nowLabel: string
  days: TimelineDay[]
  nights: TimelineNight[]
  separators: number[]
  rows: TimelineRow[]
}

export function runTimestamp(run: Pick<LocalRoutineRun, 'startedAt' | 'scheduledAt'>): number {
  return run.startedAt ?? run.scheduledAt
}

export function outcomeTone(status: RoutineRunStatus): RoutineTone {
  switch (status) {
    case 'notable':
      return 'notable'
    case 'nothing_new':
      return 'quiet'
    case 'done':
    case 'stopped':
      return 'ok'
    case 'failed':
      return 'error'
    case 'waiting':
      return 'warn'
    case 'running':
      return 'run'
    default:
      return 'skip'
  }
}

function clampLeftStyle(pct: number): string {
  return `clamp(7px, ${pct.toFixed(2)}%, calc(100% - 7px))`
}

export function buildTimelineData(
  routines: readonly LocalRoutine[],
  runsByRoutine: Record<string, readonly LocalRoutineRun[]>,
  nowMs: number,
  t: RoutineTranslator
): TimelineData {
  const start = addLocalDays(startOfLocalDay(nowMs), -2)
  const end = addLocalDays(start, 7)
  const span = Math.max(1, end - start)
  const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - start) / span) * 100))
  const weekdays = weekdaysList(t)

  const days: TimelineDay[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(addLocalDays(start, i))
    const isToday = i === 2
    return {
      leftPct: (i / 7) * 100,
      label: isToday ? t('timeline.today') : `${weekdays[d.getDay()]} ${d.getDate()}`,
      isToday,
    }
  })

  const nights: TimelineNight[] = []
  const HOUR = 3_600_000
  for (let i = -1; i < 7; i++) {
    const dayDate = new Date(addLocalDays(start, i))
    dayDate.setHours(22, 0, 0, 0)
    const leftPct = pct(dayDate.getTime())
    const widthPct = pct(dayDate.getTime() + 8 * HOUR) - leftPct
    if (widthPct > 0) nights.push({ leftPct, widthPct })
  }

  const separators = Array.from({ length: 6 }, (_, i) => ((i + 1) / 7) * 100)

  const rows: TimelineRow[] = routines.map((routine) => {
    const useBars = routine.schedule.kind === 'interval' && routine.schedule.everyMinutes < 180
    const pastTicks: TimelinePastTick[] = []
    for (const run of runsByRoutine[routine.id] ?? []) {
      const at = runTimestamp(run)
      if (at < start || at > nowMs) continue
      const tone = outcomeTone(run.status)
      const label = t(`outcome.${run.status}.label`)
      pastTicks.push({
        run,
        at,
        tone,
        skipped: isRoutineRunSkipped(run),
        leftStyle: clampLeftStyle(pct(at)),
        ariaLabel: `${formatWhen(at, nowMs, t)}: ${label}`,
        tip: `${formatWhen(at, nowMs, t)} · ${label}`,
        tipSub: run.summary ?? '',
      })
    }

    const futureTicks: TimelineFutureTick[] = []
    if (routine.enabled) {
      try {
        let cursor = new Date(nowMs + 60_000)
        if (routine.nextRunAt && routine.nextRunAt > cursor.getTime() && routine.nextRunAt <= end) {
          const at = routine.nextRunAt
          futureTicks.push({
            at,
            leftStyle: clampLeftStyle(pct(at)),
            tip: `${formatWhen(at, nowMs, t)} · ${t('timeline.scheduled')}`,
            tipSub: routine.title,
          })
          cursor = new Date(at)
        }
        for (let i = 0; i < 800; i++) {
          const next = new Date(nextRun(routine.schedule, cursor)).getTime()
          if (next > end || next <= cursor.getTime()) break
          futureTicks.push({
            at: next,
            leftStyle: clampLeftStyle(pct(next)),
            tip: `${formatWhen(next, nowMs, t)} · ${t('timeline.scheduled')}`,
            tipSub: routine.title,
          })
          cursor = new Date(next)
        }
      } catch {
        // Ignore invalid schedule/timezone while editing
      }
    }

    const pausedFromPct = !routine.enabled ? pct(Math.max(routine.pausedAt ?? nowMs, start)) : null
    return { routine, useBars, pastTicks, futureTicks, pausedFromPct }
  })

  return {
    start,
    end,
    span,
    nowPct: pct(nowMs),
    nowLabel: formatHHMM(nowMs),
    days,
    nights,
    separators,
    rows,
  }
}
