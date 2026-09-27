import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { History, MoreHorizontal, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import type { FleetBot, FleetRoutine } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { SearchSelect } from '@/components/ui/search-select'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { choiceClass } from '@/lib/fleet/choice'
import { fleetErrorMessage, fleetErrorText } from '@/lib/fleet/errors'
import {
  nextRadioIndex,
  routineFormFrom,
  routineSchedule,
  routineScheduleSummary,
  validateRoutine,
  type RoutineForm,
} from '@/lib/fleet/forms'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'
import { ChoiceMark } from './ChoiceMark'
import { RoutineRunHistory } from './RoutineRunHistory'
import { SavesNowTag, SettingsSection } from './SettingsSection'
import { SettingsSwitch } from './SettingsSwitch'

const timezones = Intl.supportedValuesOf('timeZone').map((id) => ({ id, label: id.replaceAll('_', ' ') }))
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const emptyRoutine = (): RoutineForm => ({
  mode: 'weekly',
  every: '30',
  everyUnit: 'minutes',
  title: '',
  prompt: '',
  time: '09:00',
  days: [],
  timezone: localZone,
  enabled: true,
})
const routineActivity = ['routine_created', 'routine_updated', 'routine_deleted', 'routine_ran', 'routine_skipped']

/** A bot's routines: each change is saved at once, apart from the settings that wait for the save button. */
export function BotRoutinesSection({ bot, fleet, id }: { bot: FleetBot; fleet: FleetController; id: string }) {
  const { t, i18n } = useTranslation('fleet')
  const [routines, setRoutines] = useState<FleetRoutine[]>([])
  const [routine, setRoutine] = useState<RoutineForm | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<FleetRoutine | null>(null)
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const routineRadios = useRef<Array<HTMLButtonElement | null>>([])
  const latestBotActivitySeq = fleet.state.activity.findLast((entry) => entry.botId === bot.id)?.seq ?? 0
  const latestRoutineActivity = fleet.state.activity.findLast(
    (entry) => entry.botId === bot.id && routineActivity.includes(entry.kind)
  )
  const lastRoutineActivitySeq = useRef(fleet.state.activity.at(-1)?.seq ?? 0)
  const dayLabels = [1, 2, 3, 4, 5, 6, 7].map((day) => t(`routine.day.${day}`))

  useEffect(() => {
    let alive = true
    void window.api
      .fleetListRoutines(bot.id)
      .then((list) => {
        if (alive) setRoutines(list.routines)
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [bot.id])
  // A routine the bot created, changed or ran shows up without reopening the settings.
  useEffect(() => {
    if (!latestRoutineActivity || latestRoutineActivity.seq <= lastRoutineActivitySeq.current) return
    lastRoutineActivitySeq.current = latestRoutineActivity.seq
    let alive = true
    void window.api
      .fleetListRoutines(bot.id)
      .then((list) => {
        if (alive) setRoutines(list.routines)
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [bot.id, latestRoutineActivity?.seq])

  function onRoutineModeKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextRadioIndex(index, event.key, 2)
    if (next === null || !routine) return
    event.preventDefault()
    setRoutine({ ...routine, mode: next === 0 ? 'weekly' : 'interval' })
    routineRadios.current[next]?.focus()
  }
  async function saveRoutine() {
    if (!routine || validateRoutine(routine) || busy) return
    setBusy(true)
    setError('')
    try {
      const input = {
        title: routine.title.trim(),
        prompt: routine.prompt.trim(),
        schedule: routineSchedule(routine),
        enabled: routine.enabled,
      }
      if (editingId) await window.api.fleetUpdateRoutine(bot.id, editingId, input)
      else await window.api.fleetCreateRoutine(bot.id, input)
      setRoutines((await window.api.fleetListRoutines(bot.id)).routines)
      setRoutine(null)
      setEditingId(null)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  async function actionRoutine(action: 'toggle' | 'run', item: FleetRoutine) {
    setError('')
    try {
      if (action === 'toggle') await window.api.fleetUpdateRoutine(bot.id, item.id, { enabled: !item.enabled })
      else await window.api.fleetRunRoutine(bot.id, item.id)
      setRoutines((await window.api.fleetListRoutines(bot.id)).routines)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    }
  }
  async function deleteRoutine() {
    if (!deleting) return
    setBusy(true)
    setError('')
    try {
      await window.api.fleetDeleteRoutine(bot.id, deleting.id)
      setRoutines((await window.api.fleetListRoutines(bot.id)).routines)
      setDeleting(null)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const openNew = () => {
    setRoutine(emptyRoutine())
    setEditingId(null)
  }
  const when = (value: string) =>
    new Date(value).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })

  return (
    <SettingsSection
      id={id}
      title={t('botSettings.routines')}
      note={t('botSettings.routinesNote')}
      aside={
        <>
          <SavesNowTag />
          <Button size="sm" variant="outline" className="ml-auto" onClick={openNew}>
            <Plus aria-hidden="true" />
            {t('botSettings.addRoutine')}
          </Button>
        </>
      }
    >
      {routines.length ? (
        <ul className="divide-y divide-border rounded-xl border border-border bg-foreground/[0.025]">
          {routines.map((item) => {
            const summary = routineScheduleSummary(item.schedule, dayLabels, t('routine.schedule.everyDay'))
            return (
              <li key={item.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
                    <span className="font-medium">{item.title}</span>
                    {item.createdBy === 'bot' && (
                      <span className="rounded-md border border-border-strong px-1.5 text-[11px] text-muted-foreground">
                        {t('routine.createdByBot')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {[
                      t(summary.key, summary.values),
                      item.enabled
                        ? item.nextRunAt && t('routine.nextRun', { time: when(item.nextRunAt) })
                        : t('botSettings.routinePaused'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    {item.lastOutcome && (
                      <>
                        {' · '}
                        <span className={cn(item.lastOutcome === 'failed' && 'text-destructive')}>
                          {t(`routine.outcome.${item.lastOutcome}`)}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <SettingsSwitch
                  checked={item.enabled}
                  label={t('botSettings.toggleRoutine', { title: item.title })}
                  onChange={() => void actionRoutine('toggle', item)}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('botSettings.routineActions', { title: item.title })}
                      className="flex size-[30px] shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground"
                    >
                      <MoreHorizontal className="size-4" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-48">
                    <DropdownMenuItem
                      onSelect={() => {
                        setEditingId(item.id)
                        setRoutine(routineFormFrom(item))
                      }}
                    >
                      <Pencil aria-hidden="true" />
                      {t('botSettings.edit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void actionRoutine('run', item)}>
                      <Play aria-hidden="true" />
                      {t('botSettings.runNow')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => setHistoryOpen((value) => ({ ...value, [item.id]: !value[item.id] }))}
                    >
                      <History aria-hidden="true" />
                      {t(historyOpen[item.id] ? 'routineRuns.hide' : 'routineRuns.history')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={() => setDeleting(item)}>
                      <Trash2 aria-hidden="true" />
                      {t('botSettings.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {historyOpen[item.id] && (
                  <RoutineRunHistory bot={bot} routineId={item.id} refreshKey={latestBotActivitySeq} />
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="flex flex-col items-start gap-2.5 rounded-xl border border-border bg-foreground/[0.025] p-4 text-[13px] text-muted-foreground">
          <p>
            {t('botSettings.noRoutines')} {t('botSettings.noRoutinesHint')}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={routine !== null}
        onOpenChange={(open) => {
          if (!open) setRoutine(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(editingId ? 'routine.editTitle' : 'routine.addTitle')}</DialogTitle>
            <DialogDescription>{t('routine.description')}</DialogDescription>
          </DialogHeader>
          {routine && (
            <div className="space-y-3">
              <label className="block text-sm">
                {t('routine.title')}
                <Input
                  className="mt-1"
                  value={routine.title}
                  maxLength={80}
                  onChange={(event) => setRoutine({ ...routine, title: event.target.value })}
                />
              </label>
              <label className="block text-sm">
                {t('routine.prompt')}
                <textarea
                  className="mt-1 min-h-24 w-full rounded-md border border-input bg-background p-2"
                  value={routine.prompt}
                  maxLength={4000}
                  onChange={(event) => setRoutine({ ...routine, prompt: event.target.value })}
                />
              </label>
              <fieldset>
                <legend className="mb-2 text-sm font-medium">{t('routine.scheduleMode')}</legend>
                <div role="radiogroup" aria-label={t('routine.scheduleMode')} className="grid grid-cols-2 gap-2">
                  {(['weekly', 'interval'] as const).map((mode, index) => (
                    <button
                      key={mode}
                      ref={(node) => {
                        routineRadios.current[index] = node
                      }}
                      type="button"
                      role="radio"
                      aria-checked={routine.mode === mode}
                      tabIndex={routine.mode === mode ? 0 : -1}
                      onClick={() => setRoutine({ ...routine, mode })}
                      onKeyDown={(event) => onRoutineModeKey(event, index)}
                      className={cn(
                        'flex items-center justify-between rounded-lg border p-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        choiceClass(routine.mode === mode)
                      )}
                    >
                      {t(`routine.mode.${mode}`)}
                      <ChoiceMark selected={routine.mode === mode} />
                    </button>
                  ))}
                </div>
              </fieldset>
              {routine.mode === 'weekly' ? (
                <>
                  <label className="block text-sm">
                    {t('routine.time')}
                    <Input
                      className="mt-1"
                      type="time"
                      value={routine.time}
                      onChange={(event) => setRoutine({ ...routine, time: event.target.value })}
                    />
                  </label>
                  <fieldset>
                    <legend className="text-sm">{t('routine.days')}</legend>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                        <Button
                          key={day}
                          size="sm"
                          variant="outline"
                          className={choiceClass(routine.days.includes(day))}
                          aria-pressed={routine.days.includes(day)}
                          onClick={() =>
                            setRoutine({
                              ...routine,
                              days: routine.days.includes(day)
                                ? routine.days.filter((value) => value !== day)
                                : [...routine.days, day],
                            })
                          }
                        >
                          {t(`routine.day.${day}`)}
                        </Button>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{t('routine.everyDay')}</p>
                  </fieldset>
                  <div>
                    <label className="mb-1 block text-sm">{t('routine.timezone')}</label>
                    <SearchSelect
                      value={routine.timezone}
                      options={timezones}
                      onChange={(id) => setRoutine({ ...routine, timezone: id ?? localZone })}
                      ariaLabel={t('routine.timezone')}
                    />
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_10rem] items-end gap-2">
                    <label className="block text-sm">
                      {t('routine.every')}
                      <Input
                        className="mt-1"
                        type="number"
                        min={1}
                        step={1}
                        value={routine.every}
                        onChange={(event) => setRoutine({ ...routine, every: event.target.value })}
                      />
                    </label>
                    <Select
                      value={routine.everyUnit}
                      onValueChange={(value: 'minutes' | 'hours') => setRoutine({ ...routine, everyUnit: value })}
                    >
                      <SelectTrigger aria-label={t('routine.unit')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="minutes">{t('routine.unitMinutes')}</SelectItem>
                        <SelectItem value="hours">{t('routine.unitHours')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('routine.intervalHint')}</p>
                </div>
              )}
              {validateRoutine(routine) && (
                <p role="alert" className="text-xs text-destructive">
                  {t(`routine.validation.${validateRoutine(routine)}`)}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoutine(null)}>
              {t('routine.cancel')}
            </Button>
            <Button disabled={!routine || !!validateRoutine(routine) || busy} onClick={() => void saveRoutine()}>
              {t('routine.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {deleting && (
        <ConfirmDialog
          title={t('routine.deleteTitle')}
          message={t('routine.deleteConfirm')}
          confirmLabel={t('routine.delete')}
          destructive
          busy={busy}
          onCancel={() => {
            if (!busy) setDeleting(null)
          }}
          onConfirm={() => void deleteRoutine()}
        />
      )}
    </SettingsSection>
  )
}
