import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetRoutine, FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
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
import { Input } from '@/components/ui/input'
import { SearchSelect } from '@/components/ui/search-select'
import { gb } from '@/lib/fleet/format'
import { routineSchedule, validateRoutine, type RoutineForm } from '@/lib/fleet/forms'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { BotFields, type BotFieldsValue } from './BotFields'

const timezones = Intl.supportedValuesOf('timeZone').map((id) => ({ id, label: id.replaceAll('_', ' ') }))
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const emptyRoutine = (): RoutineForm => ({
  title: '',
  prompt: '',
  time: '09:00',
  days: [],
  timezone: localZone,
  enabled: true,
})

export function BotSettings({
  bot,
  fleet,
  onArchived,
}: {
  bot: FleetBot
  fleet: FleetController
  onArchived: () => void
}) {
  const { t } = useTranslation('fleet')
  const [fields, setFields] = useState<BotFieldsValue>({
    name: bot.name,
    instructions: bot.instructions,
    ceiling: bot.ceiling,
    talksTo: bot.talksTo,
  })
  const [role, setRole] = useState(bot.role)
  const [selectionId, setSelectionId] = useState(
    bot.selection ? `${bot.selection.providerId}::${bot.selection.modelId}` : ''
  )
  const [options, setOptions] = useState<FleetSelectionOption[]>([])
  const [routines, setRoutines] = useState<FleetRoutine[]>([])
  const [routine, setRoutine] = useState<RoutineForm | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'archive' | 'delete'; id?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setFields({ name: bot.name, instructions: bot.instructions, ceiling: bot.ceiling, talksTo: bot.talksTo })
    setRole(bot.role)
    setSelectionId(bot.selection ? `${bot.selection.providerId}::${bot.selection.modelId}` : '')
  }, [bot.id, bot.name, bot.instructions, bot.ceiling, bot.talksTo, bot.role, bot.selection])
  useEffect(() => {
    let alive = true
    void Promise.all([window.api.fleetListSelections(bot.id), window.api.fleetListRoutines(bot.id)])
      .then(([models, list]) => {
        if (alive) {
          setOptions(models.options)
          setRoutines(list.routines)
        }
      })
      .catch((cause) => {
        if (alive) setError(String(cause))
      })
    return () => {
      alive = false
    }
  }, [bot.id])
  const original = JSON.stringify({
    name: bot.name,
    role: bot.role,
    instructions: bot.instructions,
    ceiling: bot.ceiling,
    talksTo: [...bot.talksTo].sort(),
    selectionId: bot.selection ? `${bot.selection.providerId}::${bot.selection.modelId}` : '',
  })
  const edited = JSON.stringify({
    name: fields.name.trim(),
    role: role.trim(),
    instructions: fields.instructions.trim(),
    ceiling: fields.ceiling,
    talksTo: [...fields.talksTo].sort(),
    selectionId,
  })
  const dirty = original !== edited
  const invalid = !fields.name.trim() || fields.name.length > 40 || role.length > 80
  async function save() {
    if (!dirty || invalid || busy) return
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      const chosen = options.find((option) => option.id === selectionId)
      const updated = await window.api.fleetUpdateBot(bot.id, {
        name: fields.name.trim(),
        role: role.trim(),
        instructions: fields.instructions.trim(),
        ceiling: fields.ceiling,
        talksTo: fields.talksTo,
        ...(selectionId !== (bot.selection ? `${bot.selection.providerId}::${bot.selection.modelId}` : '')
          ? {
              selection: chosen
                ? { providerId: chosen.providerId, modelId: chosen.modelId, reasoning: null, fastMode: false }
                : null,
            }
          : {}),
      })
      fleet.dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot: updated } })
      setSaved(true)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
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
      setError(String(cause))
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
      setError(String(cause))
    }
  }
  async function confirmAction() {
    if (!confirm) return
    setBusy(true)
    setError('')
    try {
      if (confirm.kind === 'archive') {
        const archived = await window.api.fleetBotAction(bot.id, 'archive')
        if (archived)
          fleet.dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot: archived } })
        onArchived()
      } else if (confirm.id) {
        await window.api.fleetDeleteRoutine(bot.id, confirm.id)
        setRoutines((await window.api.fleetListRoutines(bot.id)).routines)
      }
      setConfirm(null)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-8">
        <BotFields
          value={fields}
          onChange={(value) => {
            setFields(value)
            setSaved(false)
          }}
          bots={fleet.state.snapshot.bots}
          selfId={bot.id}
          role={role}
          onRoleChange={(value) => {
            setRole(value)
            setSaved(false)
          }}
        />
        <div>
          <label className="mb-2 block text-sm font-medium">{t('botSettings.model')}</label>
          <SearchSelect
            value={selectionId || undefined}
            options={options.map((option) => ({
              id: option.id,
              label: `${option.providerLabel} · ${option.modelLabel}`,
            }))}
            onChange={(id) => {
              setSelectionId(id ?? '')
              setSaved(false)
            }}
            disabled={!options.length}
            placeholder={t('botSettings.chooseModel')}
            ariaLabel={t('botSettings.model')}
          />
          {!options.length && <p className="mt-1 text-xs text-muted-foreground">{t('botSettings.noAccount')}</p>}
        </div>
        <div className="flex items-center gap-3">
          <Button disabled={!dirty || invalid || busy} onClick={() => void save()}>
            {t('botSettings.save')}
          </Button>
          {saved && (
            <span role="status" className="text-xs text-primary">
              {t('botSettings.saved')}
            </span>
          )}
        </div>
        <section>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{t('botSettings.routines')}</h2>
            <Button
              size="sm"
              onClick={() => {
                setRoutine(emptyRoutine())
                setEditingId(null)
              }}
            >
              {t('botSettings.addRoutine')}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('botSettings.routinesNote')}</p>
          <div className="mt-3 space-y-2">
            {routines.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm"
              >
                <div className="min-w-32 flex-1">
                  <strong>{item.title}</strong>
                  <p className="text-xs text-muted-foreground">
                    {item.schedule.time} · {item.schedule.timezone}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={item.enabled}
                  aria-label={t('botSettings.toggleRoutine', { title: item.title })}
                  onClick={() => void actionRoutine('toggle', item)}
                  className={`h-5 w-9 rounded-full p-0.5 ${item.enabled ? 'bg-primary' : 'bg-muted'}`}
                >
                  <span
                    className={`block size-4 rounded-full bg-white transition-transform motion-reduce:transition-none ${item.enabled ? 'translate-x-4' : ''}`}
                  />
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingId(item.id)
                    setRoutine({
                      title: item.title,
                      prompt: item.prompt,
                      time: item.schedule.time,
                      days: item.schedule.days,
                      timezone: item.schedule.timezone,
                      enabled: item.enabled,
                    })
                  }}
                >
                  {t('botSettings.edit')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void actionRoutine('run', item)}>
                  {t('botSettings.runNow')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'delete', id: item.id })}>
                  {t('botSettings.delete')}
                </Button>
              </div>
            ))}
            {!routines.length && <p className="text-xs text-muted-foreground">{t('botSettings.noRoutines')}</p>}
          </div>
        </section>
        <section>
          <h2 className="font-semibold">{t('botSettings.where')}</h2>
          <p className="mt-2 rounded-lg border border-border p-4 text-sm">
            {t('botSettings.container')} <code>maestrly-bot-{bot.id}</code> · {t('server.memory')}{' '}
            {bot.resources.memoryBytes === null ? '—' : `${gb(bot.resources.memoryBytes)} GB`} · {t('server.cpu')}{' '}
            {bot.resources.cpuPercent ?? '—'}% · {t('botSettings.started')}{' '}
            {bot.resources.startedAt ? new Date(bot.resources.startedAt).toLocaleString() : '—'}
          </p>
        </section>
        <section className="flex items-center justify-between gap-3 rounded-lg border border-destructive/50 p-4">
          <p className="text-xs text-muted-foreground">{t('botSettings.archiveNote')}</p>
          <Button variant="destructive" size="sm" onClick={() => setConfirm({ kind: 'archive' })}>
            {t('botSettings.archive', { name: bot.name })}
          </Button>
        </section>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
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
                      variant={routine.days.includes(day) ? 'secondary' : 'outline'}
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
      {confirm && (
        <ConfirmDialog
          title={t(confirm.kind === 'archive' ? 'botSettings.archiveTitle' : 'routine.deleteTitle')}
          message={t(confirm.kind === 'archive' ? 'botSettings.archiveConfirm' : 'routine.deleteConfirm')}
          confirmLabel={t(confirm.kind === 'archive' ? 'botSettings.archiveConfirmButton' : 'routine.delete')}
          destructive
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmAction()}
        />
      )}
    </section>
  )
}
