import type { FleetBot, FleetRoutine, FleetRoutineSchedule, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { FLEET_ROUTINE_LIMITS } from '@maestrly/bot-fleet-protocol'

export function visibleTranscriptItems(items: FleetTranscriptItem[]): FleetTranscriptItem[] {
  return items.filter((item) => item.kind !== 'user' || item.source !== 'continuation')
}

/** Like desktop chats, a bot conversation shows only its latest to-do list, where it was last written. */
export function latestTodoItemId(items: FleetTranscriptItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item.kind === 'tool' && item.name === 'todo_write' && item.todos) return item.id
  }
  return null
}

export function formatUptime(milliseconds: number): { days: number; hours: number; minutes: number; long: boolean } {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000))
  const days = Math.floor(totalMinutes / 1440)
  return {
    days,
    hours: days >= 2 ? Math.floor((totalMinutes % 1440) / 60) : Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
    long: days >= 2,
  }
}

export const ceilingValues = ['ask', 'auto', 'full'] as const
export type Ceiling = FleetBot['ceiling']

export function nextRadioIndex(index: number, key: string, length: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % length
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index + length - 1) % length
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  return null
}

export type RoutineForm = {
  mode: 'weekly' | 'interval'
  every: string
  everyUnit: 'minutes' | 'hours'
  title: string
  prompt: string
  time: string
  days: number[]
  timezone: string
  enabled: boolean
}

export function validateRoutine(form: RoutineForm): 'title' | 'prompt' | 'time' | 'timezone' | 'interval' | null {
  if (!form.title.trim() || form.title.length > 80) return 'title'
  if (!form.prompt.trim() || form.prompt.length > 4000) return 'prompt'
  if (form.mode === 'interval') {
    const value = Number(form.every)
    const minutes = form.everyUnit === 'hours' ? value * 60 : value
    if (
      !/^\d+$/.test(form.every) ||
      !Number.isInteger(minutes) ||
      minutes < FLEET_ROUTINE_LIMITS.intervalMinMinutes ||
      minutes > FLEET_ROUTINE_LIMITS.intervalMaxMinutes
    )
      return 'interval'
    return null
  }
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(form.time)) return 'time'
  if (!form.timezone || form.timezone.length > 64) return 'timezone'
  return null
}

export function routineSchedule(form: RoutineForm): FleetRoutineSchedule {
  if (form.mode === 'interval')
    return {
      kind: 'interval',
      everyMinutes: Number(form.every) * (form.everyUnit === 'hours' ? 60 : 1),
    }
  return { kind: 'weekly', time: form.time, days: [...form.days].sort(), timezone: form.timezone }
}

export function routineFormFrom(routine: FleetRoutine): RoutineForm {
  const schedule = routine.schedule
  const hours = schedule.kind === 'interval' && schedule.everyMinutes % 60 === 0
  return {
    title: routine.title,
    prompt: routine.prompt,
    enabled: routine.enabled,
    mode: schedule.kind,
    every: schedule.kind === 'interval' ? String(hours ? schedule.everyMinutes / 60 : schedule.everyMinutes) : '30',
    everyUnit: hours ? 'hours' : 'minutes',
    time: schedule.kind === 'weekly' ? schedule.time : '09:00',
    days: schedule.kind === 'weekly' ? schedule.days : [],
    timezone: schedule.kind === 'weekly' ? schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

export function routineScheduleSummary(
  schedule: FleetRoutineSchedule,
  dayLabels: string[],
  everyDay: string
): { key: string; values: Record<string, string | number> } {
  if (schedule.kind === 'weekly')
    return {
      key: 'routine.schedule.weekly',
      values: {
        time: schedule.time,
        days: schedule.days.length ? schedule.days.map((day) => dayLabels[day - 1]).join(', ') : everyDay,
        timezone: schedule.timezone,
      },
    }
  const hours = Math.floor(schedule.everyMinutes / 60)
  const minutes = schedule.everyMinutes % 60
  if (hours && minutes) return { key: 'routine.schedule.hoursMinutes', values: { hours, minutes } }
  if (hours) return { key: 'routine.schedule.hours', values: { hours } }
  return { key: 'routine.schedule.minutes', values: { minutes } }
}

export function formatTimer(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
