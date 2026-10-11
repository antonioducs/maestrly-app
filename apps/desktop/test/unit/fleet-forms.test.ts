import { describe, expect, it } from 'vitest'
import type { FleetRoutine, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import {
  formatUptime,
  latestTodoItemId,
  visibleTranscriptItems,
  formatTimer,
  nextRadioIndex,
  routineSchedule,
  routineFormFrom,
  routineScheduleSummary,
  validateRoutine,
} from '../../src/renderer/lib/fleet/forms'

const valid = {
  mode: 'weekly' as const,
  every: '30',
  everyUnit: 'minutes' as const,
  title: 'Daily report',
  prompt: 'Check orders',
  time: '09:30',
  days: [] as number[],
  timezone: 'America/Sao_Paulo',
  enabled: true,
}
describe('fleet forms', () => {
  it('validates routine fields and treats no days as every day', () => {
    expect(validateRoutine(valid)).toBeNull()
    expect(validateRoutine({ ...valid, title: '' })).toBe('title')
    expect(validateRoutine({ ...valid, prompt: '' })).toBe('prompt')
    expect(validateRoutine({ ...valid, time: '24:01' })).toBe('time')
    expect(validateRoutine({ ...valid, timezone: '' })).toBe('timezone')
    expect(routineSchedule(valid)).toEqual({ kind: 'weekly', time: '09:30', days: [], timezone: 'America/Sao_Paulo' })
  })
  it('validates interval bounds and builds schedules in minutes', () => {
    const interval = { ...valid, mode: 'interval' as const, every: '30' }
    expect(validateRoutine(interval)).toBeNull()
    expect(routineSchedule(interval)).toEqual({ kind: 'interval', everyMinutes: 30 })
    for (const every of ['', '10', '14', '30.5', 'oops', '1441'])
      expect(validateRoutine({ ...interval, every })).toBe('interval')
    expect(validateRoutine({ ...interval, every: '1', everyUnit: 'hours' })).toBeNull()
    expect(routineSchedule({ ...interval, every: '2', everyUnit: 'hours' })).toEqual({
      kind: 'interval',
      everyMinutes: 120,
    })
    expect(validateRoutine({ ...interval, every: '25', everyUnit: 'hours' })).toBe('interval')
    expect(validateRoutine({ ...interval, every: '1', everyUnit: 'hours', timezone: '' })).toBeNull()
  })
  it('restores interval and weekly forms and summarizes schedules', () => {
    const routine = {
      id: 'r1',
      botId: 'scout',
      title: 'Check',
      prompt: 'Check orders',
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      lastOutcome: null,
      createdBy: 'bot',
      createdAt: '2026-09-25T10:00:00Z',
      updatedAt: '2026-09-25T10:00:00Z',
    } as const
    const interval = { ...routine, schedule: { kind: 'interval' as const, everyMinutes: 120 } } as FleetRoutine
    expect(routineFormFrom(interval)).toMatchObject({ mode: 'interval', every: '2', everyUnit: 'hours' })
    expect(routineFormFrom({ ...interval, schedule: { kind: 'interval', everyMinutes: 90 } })).toMatchObject({
      mode: 'interval',
      every: '90',
      everyUnit: 'minutes',
    })
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    expect(routineScheduleSummary(interval.schedule, labels, 'every day')).toEqual({
      key: 'routine.schedule.hours',
      values: { hours: 2 },
    })
    expect(routineScheduleSummary({ kind: 'interval', everyMinutes: 90 }, labels, 'every day')).toEqual({
      key: 'routine.schedule.hoursMinutes',
      values: { hours: 1, minutes: 30 },
    })
    expect(routineScheduleSummary({ kind: 'interval', everyMinutes: 30 }, labels, 'every day')).toEqual({
      key: 'routine.schedule.minutes',
      values: { minutes: 30 },
    })
    const weekly = { ...interval, schedule: { kind: 'weekly' as const, time: '09:00', days: [1, 3], timezone: 'UTC' } }
    expect(routineFormFrom(weekly)).toMatchObject({ mode: 'weekly', time: '09:00', days: [1, 3], timezone: 'UTC' })
    expect(routineScheduleSummary(weekly.schedule, labels, 'every day')).toEqual({
      key: 'routine.schedule.weekly',
      values: { time: '09:00', days: 'Mon, Wed', timezone: 'UTC' },
    })
  })
  it('formats control time', () => {
    expect(formatTimer(61_900)).toBe('01:01')
    expect(formatTimer(-100)).toBe('00:00')
  })
  it('formats uptime with days after 48 hours and hides continuation inputs', () => {
    expect(formatUptime(3_700_000)).toEqual({ days: 0, hours: 1, minutes: 1, long: false })
    expect(formatUptime(47 * 3_600_000)).toMatchObject({ hours: 47, long: false })
    expect(formatUptime((15 * 24 + 3) * 3_600_000)).toMatchObject({ days: 15, hours: 3, long: true })
    const continuation = {
      kind: 'user' as const,
      id: 'c',
      at: '2026-09-23T12:34:56Z',
      text: 'resume',
      source: 'continuation' as const,
      queued: false,
      memories: [],
      images: [],
    }
    const owner = { ...continuation, id: 'o', source: 'owner' as const }
    expect(visibleTranscriptItems([continuation, owner])).toEqual([owner])
  })
  it('keeps pending permissions and hides approved, denied and expired requests from the conversation', () => {
    const permission = (state: 'pending' | 'approved' | 'denied' | 'expired'): FleetTranscriptItem => ({
      kind: 'permission',
      id: state,
      at: '2026-09-23T12:34:56Z',
      requestId: state,
      title: 'Run a command',
      detail: null,
      tool: null,
      state,
      resolvedAt: null,
    })
    const pending = permission('pending')
    expect(
      visibleTranscriptItems([permission('approved'), pending, permission('denied'), permission('expired')])
    ).toEqual([pending])
  })
  it('picks the latest checklist, skipping other tools and todo_write rows from older instances', () => {
    const tool = (id: string, name: string, todos?: { content: string; status: 'pending' }[]) => ({
      kind: 'tool' as const,
      id,
      at: '2026-09-23T12:34:56Z',
      name,
      target: null,
      state: 'done' as const,
      output: null,
      images: [],
      ...(todos ? { todos } : {}),
    })
    const list = [{ content: 'Run tests', status: 'pending' as const }]
    expect(latestTodoItemId([])).toBeNull()
    expect(latestTodoItemId([tool('a', 'todo_write', list), tool('b', 'todo_write', []), tool('c', 'bash')])).toBe('b')
    expect(latestTodoItemId([tool('a', 'todo_write', list), tool('legacy', 'todo_write')])).toBe('a')
    expect(latestTodoItemId([tool('legacy', 'todo_write'), tool('c', 'bash', list)])).toBeNull()
  })
  it('wraps ceiling radio keyboard navigation', () => {
    expect(nextRadioIndex(2, 'ArrowRight', 3)).toBe(0)
    expect(nextRadioIndex(0, 'ArrowLeft', 3)).toBe(2)
    expect(nextRadioIndex(1, 'Home', 3)).toBe(0)
    expect(nextRadioIndex(1, 'End', 3)).toBe(2)
    expect(nextRadioIndex(1, 'Escape', 3)).toBeNull()
  })
})
