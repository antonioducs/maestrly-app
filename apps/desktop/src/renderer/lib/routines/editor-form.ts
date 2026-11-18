import { isValidTimeZone } from '@maestrly/bot-fleet-protocol'
import type { ChatPermMode } from '../../../shared/chat'
import type {
  RoutineDraft,
  RoutineMissed,
  RoutineModel,
  RoutineNotify,
  RoutineRetentionDays,
} from '../../../shared/routines'
import type { RoutineTranslator } from './schedule-text'

export interface RoutineEditorForm {
  title: string
  instruction: string
  mode: 'weekly' | 'interval'
  time: string
  days: number[]
  timezone: string
  everyValue: string
  everyUnit: 'minutes' | 'hours'
  missed: RoutineMissed
  permMode: ChatPermMode
  model: RoutineModel
  notify: RoutineNotify
  retentionDays: RoutineRetentionDays
}

export type RoutineEditorErrorField = 'title' | 'instruction' | 'time' | 'every' | 'timezone'

export type RoutineValidationResult =
  | { ok: true; draft: RoutineDraft }
  | { ok: false; field: RoutineEditorErrorField; message: string }

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function formFromDraft(draft: RoutineDraft, fallbackTz = systemTimeZone()): RoutineEditorForm {
  const weekly = draft.schedule.kind === 'weekly' ? draft.schedule : null
  const interval = draft.schedule.kind === 'interval' ? draft.schedule : null
  const everyMinutes = interval ? interval.everyMinutes : 60
  const inHours = everyMinutes >= 60 && everyMinutes % 60 === 0
  return {
    title: draft.title,
    instruction: draft.instruction,
    mode: draft.schedule.kind,
    time: weekly ? weekly.time : '08:00',
    days: weekly ? [...weekly.days] : [],
    timezone: weekly ? weekly.timezone : fallbackTz,
    everyValue: String(inHours ? everyMinutes / 60 : everyMinutes),
    everyUnit: inHours ? 'hours' : 'minutes',
    missed: draft.missed,
    permMode: draft.permMode,
    model: { ...draft.model },
    notify: draft.notify,
    retentionDays: draft.retentionDays,
  }
}

export function draftFromForm(form: RoutineEditorForm): RoutineDraft {
  const schedule =
    form.mode === 'weekly'
      ? {
          kind: 'weekly' as const,
          time: form.time.trim(),
          days: [...form.days].sort((a, b) => a - b),
          timezone: form.timezone.trim(),
        }
      : {
          kind: 'interval' as const,
          everyMinutes: Math.round(
            Number(form.everyValue) * (form.everyUnit === 'hours' ? 60 : 1)
          ),
        }

  return {
    title: form.title.trim(),
    instruction: form.instruction.trim(),
    schedule,
    permMode: form.permMode,
    model: { ...form.model },
    notify: form.notify,
    missed: form.missed,
    retentionDays: form.retentionDays,
  }
}

export function validateEditorForm(form: RoutineEditorForm, t: RoutineTranslator): RoutineValidationResult {
  if (!form.title.trim()) {
    return { ok: false, field: 'title', message: t('editor.errors.titleRequired') }
  }
  if (!form.instruction.trim()) {
    return { ok: false, field: 'instruction', message: t('editor.errors.promptRequired') }
  }
  if (form.mode === 'weekly') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time.trim())) {
      return { ok: false, field: 'time', message: t('editor.errors.timeInvalid') }
    }
    if (!isValidTimeZone(form.timezone.trim())) {
      return { ok: false, field: 'timezone', message: t('editor.errors.tzInvalid') }
    }
  } else {
    const raw = Number(form.everyValue)
    const minutes = Number.isFinite(raw) ? Math.round(raw * (form.everyUnit === 'hours' ? 60 : 1)) : 0
    if (!Number.isFinite(raw) || minutes < 15) {
      return { ok: false, field: 'every', message: t('editor.errors.everyMin') }
    }
    if (minutes > 24 * 60) {
      return { ok: false, field: 'every', message: t('editor.errors.everyMax') }
    }
  }
  return { ok: true, draft: draftFromForm(form) }
}
