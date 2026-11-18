import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import ptBRRoutines from '../../src/shared/i18n/pt-BR/routines'
import type { LocalRoutine, LocalRoutineRun, RoutineDraft } from '../../src/shared/routines'
import {
  daysSummary,
  scheduleBigTime,
  scheduleSummary,
  scheduleUnitLabel,
  upcomingRunDates,
} from '../../src/renderer/lib/routines/schedule-text'
import {
  formatDayName,
  formatDuration,
  formatHHMM,
  formatRelative,
  formatRunDay,
  formatShortIn,
  formatWhen,
} from '../../src/renderer/lib/routines/relative-time'
import { buildTimelineData } from '../../src/renderer/lib/routines/timeline'
import {
  draftFromForm,
  formFromDraft,
  validateEditorForm,
} from '../../src/renderer/lib/routines/editor-form'

function ptTranslator() {
  const instance = createInstance()
  void instance.init({
    lng: 'pt-BR',
    resources: { 'pt-BR': { routines: ptBRRoutines } },
    defaultNS: 'routines',
    interpolation: { escapeValue: false },
  })
  return (key: string, opts?: Record<string, unknown>) => instance.t(key, opts)
}

const t = ptTranslator()

function makeRoutine(overrides: Partial<LocalRoutine> = {}): LocalRoutine {
  return {
    id: 'r-1',
    title: 'Preço GRU → LIS',
    instruction: 'Confere passagem.',
    schedule: { kind: 'weekly', time: '08:00', days: [], timezone: 'America/Sao_Paulo' },
    enabled: true,
    pausedAt: null,
    permMode: 'auto',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', reasoning: 'medium', fastMode: false },
    notify: 'notable',
    missed: 'catchup',
    retentionDays: 30,
    origin: null,
    folder: '/tmp/routines/r-1',
    nextRunAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

describe('schedule-text helpers', () => {
  it('formats weekday groups and interval summaries identically to the prototype', () => {
    expect(daysSummary([], t)).toBe('todos os dias')
    expect(daysSummary([1, 2, 3, 4, 5], t)).toBe('Seg a Sex')
    expect(daysSummary([6, 7], t)).toBe('fins de semana')
    expect(daysSummary([5, 1, 3], t)).toBe('Seg, Qua, Sex')

    expect(scheduleSummary({ kind: 'weekly', time: '08:00', days: [], timezone: 'UTC' }, t)).toBe(
      '08:00 · todos os dias'
    )
    expect(scheduleSummary({ kind: 'interval', everyMinutes: 30 }, t)).toBe('A cada 30 min')
    expect(scheduleSummary({ kind: 'interval', everyMinutes: 120 }, t)).toBe('A cada 2 h')
    expect(scheduleSummary({ kind: 'interval', everyMinutes: 90 }, t)).toBe('A cada 1 h 30 min')

    expect(scheduleBigTime({ kind: 'weekly', time: '08:00', days: [], timezone: 'UTC' })).toBe('08:00')
    expect(scheduleBigTime({ kind: 'interval', everyMinutes: 30 })).toBe('30 min')
    expect(scheduleBigTime({ kind: 'interval', everyMinutes: 120 })).toBe('2 h')

    expect(scheduleUnitLabel({ kind: 'weekly', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'UTC' }, t)).toBe(
      'Seg a Sex'
    )
    expect(scheduleUnitLabel({ kind: 'interval', everyMinutes: 30 }, t)).toBe('intervalo')
  })

  it('computes upcoming run dates from shared schedule math', () => {
    const ref = new Date(2026, 10, 18, 10, 24).getTime()
    const dates = upcomingRunDates({ kind: 'interval', everyMinutes: 60 }, 3, ref)
    expect(dates).toHaveLength(3)
    expect(dates[0].getTime()).toBeGreaterThan(ref)
  })
})

describe('relative-time helpers', () => {
  const ref = new Date(2026, 10, 18, 10, 24).getTime()
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it('formats relative, short-in, day names, run days and durations', () => {
    expect(formatRelative(ref + 30_000, ref, t)).toBe('em menos de 1 min')
    expect(formatRelative(ref + 21 * HOUR, ref, t)).toBe('em 21 h')
    expect(formatRelative(ref - 3 * DAY, ref, t)).toBe('há 3 dias')
    expect(formatShortIn(ref + 21 * HOUR, ref, t)).toBe('21 h')
    expect(formatShortIn(ref + 45 * MIN, ref, t)).toBe('45 min')

    expect(formatDayName(ref, ref, t)).toBe('Hoje')
    expect(formatDayName(ref + DAY, ref, t)).toBe('Amanhã')
    expect(formatDayName(ref - DAY, ref, t)).toBe('Ontem')
    expect(formatWhen(new Date(2026, 10, 18, 8, 5).getTime(), ref, t)).toBe('Hoje, 08:05')
    expect(formatHHMM(new Date(2026, 10, 18, 8, 5).getTime())).toBe('08:05')

    expect(formatRunDay(ref, ref, t, true)).toBe('Hoje')
    expect(formatRunDay(ref - DAY, ref, t, true)).toBe('Ontem')
    expect(formatRunDay(ref - 3 * DAY, ref, t, true)).toContain('15 nov')
    expect(formatRunDay(ref - 3 * DAY, ref, t, false)).toBe('15 nov')

    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(72)).toBe('1 min 12 s')
    expect(formatDuration(3600)).toBe('1 h 0 min')
  })
})

describe('timeline helper', () => {
  it('lays out 7 days (-2..+4), nights 22h-6h, now marker, clamped past ticks, bars (<180m) and paused strip', () => {
    const nowMs = new Date(2026, 10, 18, 10, 24).getTime()
    const startOfToday = new Date(2026, 10, 18, 0, 0).getTime()
    const edgeRunAt = startOfToday - 2 * 24 * 3_600_000 // exact start of 7-day window

    const fastRoutine = makeRoutine({
      id: 'fast',
      title: 'Staging health',
      schedule: { kind: 'interval', everyMinutes: 120 },
    })
    const pausedRoutine = makeRoutine({
      id: 'paused',
      title: 'Docker disk',
      enabled: false,
      pausedAt: nowMs - 6 * 3_600_000,
      schedule: { kind: 'weekly', time: '09:00', days: [], timezone: 'America/Sao_Paulo' },
    })
    const runAtEdge: LocalRoutineRun = {
      id: 'run-edge',
      routineId: 'fast',
      scheduledAt: edgeRunAt,
      startedAt: edgeRunAt,
      finishedAt: edgeRunAt + 24_000,
      trigger: 'schedule',
      status: 'nothing_new',
      summary: 'OK',
      report: null,
      error: null,
      conversationId: 'c-run',
      conversationDeleted: false,
      pinned: false,
      unread: false,
    }

    const tl = buildTimelineData([fastRoutine, pausedRoutine], { fast: [runAtEdge], paused: [] }, nowMs, t)
    expect(tl.days).toHaveLength(7)
    expect(tl.days[2].isToday).toBe(true)
    expect(tl.days[2].label).toBe('Hoje')
    expect(tl.nights.length).toBeGreaterThanOrEqual(7)
    expect(tl.nowPct).toBeGreaterThan(28)
    expect(tl.nowPct).toBeLessThan(43)

    const fastRow = tl.rows.find((row) => row.routine.id === 'fast')!
    expect(fastRow.useBars).toBe(true)
    expect(fastRow.pastTicks[0].leftStyle).toBe('clamp(7px, 0.00%, calc(100% - 7px))')
    expect(fastRow.futureTicks.length).toBeGreaterThan(0)

    const pausedRow = tl.rows.find((row) => row.routine.id === 'paused')!
    expect(pausedRow.futureTicks).toEqual([])
    expect(pausedRow.pausedFromPct).not.toBeNull()
  })
})

describe('editor-form helpers', () => {
  const sampleDraft: RoutineDraft = {
    title: 'Check flights',
    instruction: 'Compare prices on Google Flights.',
    schedule: { kind: 'weekly', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'America/Sao_Paulo' },
    permMode: 'auto',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', reasoning: 'medium', fastMode: false },
    notify: 'notable',
    missed: 'catchup',
    retentionDays: 30,
  }

  it('round-trips a draft through form state and back', () => {
    const form = formFromDraft(sampleDraft, 'UTC')
    const built = draftFromForm(form)
    expect(built).toEqual(sampleDraft)

    const hourly = draftFromForm({
      ...form,
      mode: 'interval',
      everyValue: '2',
      everyUnit: 'hours',
    })
    expect(hourly.schedule).toEqual({ kind: 'interval', everyMinutes: 120 })
  })

  it('validates title, instruction, time, interval bounds and timezone', () => {
    const base = formFromDraft(sampleDraft, 'UTC')
    expect(validateEditorForm({ ...base, title: '  ' }, t)).toMatchObject({
      ok: false,
      field: 'title',
      message: ptBRRoutines.editor.errors.titleRequired,
    })
    expect(validateEditorForm({ ...base, instruction: '' }, t)).toMatchObject({
      ok: false,
      field: 'instruction',
      message: ptBRRoutines.editor.errors.promptRequired,
    })
    expect(validateEditorForm({ ...base, time: '99:00' }, t)).toMatchObject({
      ok: false,
      field: 'time',
      message: ptBRRoutines.editor.errors.timeInvalid,
    })
    expect(validateEditorForm({ ...base, timezone: 'Mars/Phobos' }, t)).toMatchObject({
      ok: false,
      field: 'timezone',
      message: ptBRRoutines.editor.errors.tzInvalid,
    })
    expect(validateEditorForm({ ...base, mode: 'interval', everyValue: '10', everyUnit: 'minutes' }, t)).toMatchObject({
      ok: false,
      field: 'every',
      message: ptBRRoutines.editor.errors.everyMin,
    })
    expect(validateEditorForm({ ...base, mode: 'interval', everyValue: '25', everyUnit: 'hours' }, t)).toMatchObject({
      ok: false,
      field: 'every',
      message: ptBRRoutines.editor.errors.everyMax,
    })
    expect(validateEditorForm(base, t).ok).toBe(true)
  })
})
