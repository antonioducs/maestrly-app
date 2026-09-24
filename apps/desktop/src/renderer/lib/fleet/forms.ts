import type {
  FleetActivityEntry,
  FleetBot,
  FleetRoutineSchedule,
  FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'

export function visibleTranscriptItems(items: FleetTranscriptItem[]): FleetTranscriptItem[] {
  return items.filter((item) => item.kind !== 'user' || item.source !== 'continuation')
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

export function digestKey(entry: FleetActivityEntry): string {
  return `digest.kind.${entry.kind}`
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
  title: string
  prompt: string
  time: string
  days: number[]
  timezone: string
  enabled: boolean
}

export function validateRoutine(form: RoutineForm): 'title' | 'prompt' | 'time' | 'timezone' | null {
  if (!form.title.trim() || form.title.length > 80) return 'title'
  if (!form.prompt.trim() || form.prompt.length > 4000) return 'prompt'
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(form.time)) return 'time'
  if (!form.timezone || form.timezone.length > 64) return 'timezone'
  return null
}

export function routineSchedule(form: RoutineForm): FleetRoutineSchedule {
  return { kind: 'weekly', time: form.time, days: [...form.days].sort(), timezone: form.timezone }
}

export function formatTimer(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function formatDuration(milliseconds: number): { hours: number; minutes: number } {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000))
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 }
}
