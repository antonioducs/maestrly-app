import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { BACKUP_HOUR_CHOICES, type BackupSchedulePreset } from '@/lib/fleet/backup'

/** The ISO weekdays, Monday first, named in the window's language. */
function weekdays(locale: string): { day: number; name: string }[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' })
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, index) => ({
    day: index + 1,
    name: format.format(new Date(Date.UTC(2024, 0, 1 + index))),
  }))
}

/** When backups run: every day at a time, every week on a day at a time, or every few hours. */
export function BackupScheduleFields({
  preset,
  onChange,
  disabled,
}: {
  preset: BackupSchedulePreset
  onChange: (preset: BackupSchedulePreset) => void
  disabled?: boolean
}) {
  const { t, i18n } = useTranslation('fleet')
  const days = useMemo(() => weekdays(i18n.language), [i18n.language])
  const time = preset.kind === 'hours' ? '03:00' : preset.time
  const day = preset.kind === 'weekly' ? preset.day : 1
  const every = preset.kind === 'hours' ? preset.every : 6
  const option = (kind: BackupSchedulePreset['kind'], label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="radio"
        name="backup-schedule"
        checked={preset.kind === kind}
        disabled={disabled}
        onChange={() =>
          onChange(
            kind === 'daily' ? { kind, time } : kind === 'weekly' ? { kind, day, time } : { kind: 'hours', every }
          )
        }
      />
      {label}
    </label>
  )
  const timeInput = (
    <Input
      type="time"
      className="h-8 w-28 bg-surface-elevated"
      aria-label={t('botServer.backups.when.at')}
      value={time}
      disabled={disabled}
      onChange={(event) => {
        const value = event.target.value
        if (!/^\d{2}:\d{2}$/.test(value)) return
        if (preset.kind === 'daily') onChange({ kind: 'daily', time: value })
        else if (preset.kind === 'weekly') onChange({ kind: 'weekly', day, time: value })
      }}
    />
  )
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t('botServer.backups.when.title')}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {option('daily', t('botServer.backups.when.daily'))}
        {preset.kind === 'daily' && timeInput}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {option('weekly', t('botServer.backups.when.weekly'))}
        {preset.kind === 'weekly' && (
          <>
            <OptionSelect
              className="h-8 w-40"
              aria-label={t('botServer.backups.when.weekly')}
              value={String(day)}
              disabled={disabled}
              onValueChange={(value) => onChange({ kind: 'weekly', day: Number(value), time })}
            >
              {days.map((item) => (
                <SelectOption key={item.day} value={String(item.day)}>
                  {item.name}
                </SelectOption>
              ))}
            </OptionSelect>
            <span className="text-sm">{t('botServer.backups.when.at')}</span>
            {timeInput}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {option('hours', t('botServer.backups.when.every'))}
        {preset.kind === 'hours' && (
          <OptionSelect
            className="h-8 w-44"
            aria-label={t('botServer.backups.when.every')}
            value={String(every)}
            disabled={disabled}
            onValueChange={(value) => onChange({ kind: 'hours', every: Number(value) })}
          >
            {BACKUP_HOUR_CHOICES.map((hours) => (
              <SelectOption key={hours} value={String(hours)}>
                {hours === 1
                  ? t('botServer.backups.when.hoursOne')
                  : t('botServer.backups.when.hours', { count: hours })}
              </SelectOption>
            ))}
          </OptionSelect>
        )}
      </div>
    </fieldset>
  )
}
