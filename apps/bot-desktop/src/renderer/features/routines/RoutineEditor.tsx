import { useState } from 'react'
import type { RoutinePreview, RoutineSpec, ScheduleSpec, TargetRef } from '@maestrly/host-protocol'
import { Button, Input, Select, Surface, Textarea } from '../../ui'
import { useT } from '../../i18n'

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]
/** The person's own zone, as the system reports it. It is always shown, never assumed silently. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/**
 * Creating or editing a routine, in the words a person uses: what to do, how often and at what
 * time. Every field maps to one closed calendar shape — there is no cron box, because an
 * expression nobody can read is not something anybody can approve.
 *
 * The preview is the contract: the real instants, the effective ceiling and every warning are
 * shown before the confirm button does anything, and confirming sends back exactly the
 * fingerprint that was displayed.
 */
export function RoutineEditor({
  target,
  targetName,
  initial,
  preview,
  busy,
  onPreview,
  onActivate,
  onCancel,
}: {
  target: TargetRef
  targetName: string
  initial?: Partial<RoutineSpec>
  preview?: RoutinePreview
  busy: boolean
  onPreview: (spec: RoutineSpec) => void
  onActivate: () => void
  onCancel: () => void
}) {
  const t = useT()
  const [name, setName] = useState(initial?.name ?? '')
  const [request, setRequest] = useState(initial?.request ?? '')
  const [kind, setKind] = useState<ScheduleSpec['kind']>(initial?.schedule?.kind ?? 'weekly')
  const [time, setTime] = useState(() => {
    const schedule = initial?.schedule
    if (schedule && schedule.kind !== 'once' && schedule.kind !== 'interval')
      return `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
    return '09:00'
  })
  const [days, setDays] = useState<number[]>(initial?.schedule?.kind === 'weekly' ? initial.schedule.daysOfWeek : [1])
  const [dayOfMonth, setDayOfMonth] = useState(initial?.schedule?.kind === 'monthly' ? initial.schedule.dayOfMonth : 1)
  const [everyMinutes, setEveryMinutes] = useState(initial?.schedule?.kind === 'interval' ? initial.schedule.everyMinutes : 60)
  const [timeZone] = useState(initial?.schedule?.timeZone ?? localTimeZone())
  const [misfirePolicy, setMisfirePolicy] = useState<'skip' | 'latest'>(initial?.misfirePolicy ?? 'skip')

  const [hour, minute] = time.split(':').map((part) => Number(part))
  const schedule = (): ScheduleSpec => {
    if (kind === 'daily') return { kind: 'daily', hour, minute, timeZone }
    if (kind === 'monthly') return { kind: 'monthly', dayOfMonth, hour, minute, timeZone }
    if (kind === 'interval') return { kind: 'interval', anchorUtc: new Date().toISOString(), everyMinutes, timeZone }
    if (kind === 'once') {
      const at = new Date()
      at.setHours(hour, minute, 0, 0)
      if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1)
      return { kind: 'once', atUtc: at.toISOString(), timeZone }
    }
    return { kind: 'weekly', daysOfWeek: days.length ? days : [1], hour, minute, timeZone }
  }
  const spec = (): RoutineSpec =>
    ({ name: name.trim(), request: request.trim(), target, schedule: schedule(), misfirePolicy }) as RoutineSpec
  const ready = name.trim().length > 0 && request.trim().length > 0 && Number.isFinite(hour) && Number.isFinite(minute)

  return (
    <Surface className="routine-editor" role="group" aria-label={t('routineEditor')}>
      <label>
        {t('routineName')}
        <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {t('routineRequest')}
        <Textarea value={request} rows={4} maxLength={16_000} onChange={(event) => setRequest(event.target.value)} />
      </label>
      <label>
        {t('routineFrequency')}
        <Select value={kind} aria-label={t('routineFrequency')} onValueChange={(value) => setKind(value as ScheduleSpec['kind'])}>
          <option value="once">{t('routineOnce')}</option>
          <option value="daily">{t('routineDaily')}</option>
          <option value="weekly">{t('routineWeekly')}</option>
          <option value="monthly">{t('routineMonthly')}</option>
          <option value="interval">{t('routineInterval')}</option>
        </Select>
      </label>
      {kind === 'weekly' && (
        <fieldset className="routine-days">
          <legend>{t('routineDays')}</legend>
          {WEEKDAYS.map((day) => (
            <label key={day}>
              <input
                type="checkbox"
                checked={days.includes(day)}
                onChange={(event) => setDays(event.target.checked ? [...days, day].sort() : days.filter((value) => value !== day))}
              />
              {t(`weekday${day}` as never)}
            </label>
          ))}
        </fieldset>
      )}
      {kind === 'monthly' && (
        <label>
          {t('routineDayOfMonth')}
          <Input type="number" min={1} max={31} value={String(dayOfMonth)} onChange={(event) => setDayOfMonth(Number(event.target.value))} />
        </label>
      )}
      {kind === 'interval' && (
        <label>
          {t('routineEveryMinutes')}
          <Input type="number" min={15} max={1440} value={String(everyMinutes)} onChange={(event) => setEveryMinutes(Number(event.target.value))} />
        </label>
      )}
      {kind !== 'interval' && (
        <label>
          {t('routineTime')}
          <Input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </label>
      )}
      {/* The zone is never implicit: a routine that runs an hour off is a routine nobody trusts. */}
      <p className="routine-zone">{t('routineZone').replace('{zone}', timeZone)}</p>
      <label className="routine-advanced">
        {t('routineMisfire')}
        <Select value={misfirePolicy} aria-label={t('routineMisfire')} onValueChange={(value) => setMisfirePolicy(value as 'skip' | 'latest')}>
          <option value="skip">{t('routineMisfireSkip')}</option>
          <option value="latest">{t('routineMisfireLatest')}</option>
        </Select>
      </label>

      {preview && (
        <div className="routine-preview" aria-live="polite">
          <h4>{t('routinePreviewTitle')}</h4>
          <p>{t('routineTarget')}: {targetName}</p>
          <ul>
            {preview.occurrences.map((occurrence) => (
              <li key={occurrence.scheduledForUtc}>{occurrence.scheduledForLocal}</li>
            ))}
          </ul>
          {!preview.occurrences.length && <p>{t('routineNoNext')}</p>}
          <p>{t('routineCeilingValue').replace('{minutes}', String(Math.round(preview.effectiveCeiling.activeMs / 60_000))).replace('{actions}', String(preview.effectiveCeiling.maxTools))}</p>
          {preview.warnings.map((warning) => (
            <p className="routine-warning" key={warning.code}>
              {warning.message}
            </p>
          ))}
        </div>
      )}

      <div className="routine-actions">
        <Button type="button" disabled={!ready || busy} onClick={() => onPreview(spec())}>
          {t('routinePreviewAction')}
        </Button>
        <Button className="primary" type="button" disabled={busy || !preview?.feasible} onClick={onActivate}>
          {t('routineActivate')}
        </Button>
        <Button type="button" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </Surface>
  )
}
