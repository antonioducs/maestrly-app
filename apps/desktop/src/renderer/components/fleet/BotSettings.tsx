import { fleetErrorMessage } from '@/lib/fleet/errors'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  FleetApiKeyProviderKind,
  FleetBot,
  FleetRoutine,
  FleetSelectionOption,
} from '@maestrly/bot-fleet-protocol'
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
import { FastModeChip } from '@/components/chat/ChatFastModeToggle'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { gb } from '@/lib/fleet/format'
import { compactionFormFrom, compactionPatch } from '@/lib/fleet/compaction'
import { choiceClass } from '@/lib/fleet/choice'
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
import { BotFields, type BotFieldsValue } from './BotFields'
import { ChoiceMark } from './ChoiceMark'
import { RoutineRunHistory } from './RoutineRunHistory'
import { BotMemorySection } from './BotMemorySection'

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

export function BotSettings({
  bot,
  fleet,
  onArchived,
  onOpenScreen,
}: {
  bot: FleetBot
  fleet: FleetController
  onArchived: () => void
  onOpenScreen: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
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
  const [compaction, setCompaction] = useState(() => compactionFormFrom(bot.compaction))
  const [compactionBusy, setCompactionBusy] = useState(false)
  const [compactionSaved, setCompactionSaved] = useState(false)
  const [compactionError, setCompactionError] = useState('')
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({})
  const latestBotActivitySeq = fleet.state.activity.findLast((entry) => entry.botId === bot.id)?.seq ?? 0
  const [routines, setRoutines] = useState<FleetRoutine[]>([])
  const [routine, setRoutine] = useState<RoutineForm | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'archive' | 'delete' | 'account'; id?: string } | null>(null)
  const [accountKind, setAccountKind] = useState<FleetApiKeyProviderKind>('openai')
  const [accountName, setAccountName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [accountBusy, setAccountBusy] = useState(false)
  const [accountError, setAccountError] = useState('')
  const keyRef = useRef<HTMLInputElement>(null)
  const compactionRef = useRef<HTMLElement>(null)
  const needsCompaction = bot.activity?.kind === 'setup' && bot.activity.need === 'compaction'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const routineRadios = useRef<Array<HTMLButtonElement | null>>([])
  const latestRoutineActivity = fleet.state.activity.findLast(
    (entry) =>
      entry.botId === bot.id &&
      ['routine_created', 'routine_updated', 'routine_deleted', 'routine_ran', 'routine_skipped'].includes(entry.kind)
  )
  const lastRoutineActivitySeq = useRef(fleet.state.activity.at(-1)?.seq ?? 0)
  useEffect(() => {
    setFields({ name: bot.name, instructions: bot.instructions, ceiling: bot.ceiling, talksTo: bot.talksTo })
    setRole(bot.role)
    setSelectionId(bot.selection ? `${bot.selection.providerId}::${bot.selection.modelId}` : '')
  }, [bot.id, bot.name, bot.instructions, bot.ceiling, bot.talksTo, bot.role, bot.selection])
  useEffect(() => {
    setCompaction(compactionFormFrom(bot.compaction))
  }, [
    bot.id,
    bot.compaction?.providerId,
    bot.compaction?.modelId,
    bot.compaction?.reasoning,
    bot.compaction?.fastMode,
    bot.compaction?.intervalTokens,
  ])
  // The section sits below the main form; a bot blocked on it opens scrolled straight to the fix, once per bot so a
  // status update never yanks the owner's scroll.
  useEffect(() => {
    if (needsCompaction) compactionRef.current?.scrollIntoView({ block: 'start' })
  }, [bot.id])
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
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [bot.id])
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
  const compactionChoice = options.find((option) => option.id === compaction.modelId)
  const compactionValue = compactionPatch(compaction)
  const compactionDirty = JSON.stringify(compactionValue) !== JSON.stringify(bot.compaction)
  const dayLabels = [1, 2, 3, 4, 5, 6, 7].map((day) => t(`routine.day.${day}`))
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
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  async function saveCompaction() {
    if (!compactionValue || !compactionDirty || compactionBusy) return
    setCompactionBusy(true)
    setCompactionError('')
    setCompactionSaved(false)
    try {
      const updated = await window.api.fleetUpdateBot(bot.id, { compaction: compactionValue })
      fleet.dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot: updated } })
      setCompactionSaved(true)
    } catch (cause) {
      setCompactionError(fleetErrorMessage(cause))
    } finally {
      setCompactionBusy(false)
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
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  async function refreshBot() {
    const updated = await window.api.fleetGetBot(bot.id)
    fleet.dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot: updated } })
    const models = await window.api.fleetListSelections(bot.id)
    setOptions(models.options)
  }
  async function addAccount() {
    const key = keyRef.current?.value ?? ''
    const name = accountName.trim()
    const url = baseURL.trim()
    if (accountBusy) return
    if (
      !name ||
      name.length > 40 ||
      !key.trim() ||
      key.length > 512 ||
      (url && (url.length > 300 || !/^https?:\/\//i.test(url) || !URL.canParse(url)))
    ) {
      setAccountError(t('botSettings.accountInvalid'))
      return
    }
    setAccountBusy(true)
    setAccountError('')
    try {
      await window.api.fleetAddApiKeyAccount(bot.id, { kind: accountKind, name, key, baseURL: url || null })
      if (keyRef.current) keyRef.current.value = ''
      setAccountName('')
      setBaseURL('')
      await refreshBot()
    } catch {
      setAccountError(t('botSettings.accountAddFailed'))
    } finally {
      setAccountBusy(false)
    }
  }
  async function logInOnScreen() {
    setAccountBusy(true)
    setAccountError('')
    try {
      if (bot.takeover.state !== 'human') await window.api.fleetTakeover(bot.id)
      await window.api.fleetUiOpen(bot.id, { target: 'accounts' })
      onOpenScreen()
    } catch {
      setAccountError(t('botSettings.screenLoginFailed'))
    } finally {
      setAccountBusy(false)
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
      } else if (confirm.kind === 'account' && confirm.id) {
        await window.api.fleetRemoveAccount(bot.id, confirm.id)
        await refreshBot()
      } else if (confirm.id) {
        await window.api.fleetDeleteRoutine(bot.id, confirm.id)
        setRoutines((await window.api.fleetListRoutines(bot.id)).routines)
      }
      setConfirm(null)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
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
        <section className="space-y-3">
          <h2 className="font-semibold">{t('botSettings.accounts')}</h2>
          <p className="text-xs text-muted-foreground">{t('botSettings.accountsNote')}</p>
          {bot.accounts.providers.map((provider) => (
            <div
              key={provider.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-elevated p-3 text-sm"
            >
              <span>{provider.label}</span>
              {provider.id.startsWith('prov_') && (
                <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'account', id: provider.id })}>
                  {t('botSettings.removeAccount')}
                </Button>
              )}
            </div>
          ))}
          {!bot.accounts.providers.length && (
            <p className="text-xs text-muted-foreground">{t('botSettings.noAccounts')}</p>
          )}
          <div className="space-y-3 rounded-lg border border-border bg-surface-elevated p-4">
            <h3 className="text-sm font-medium">{t('botSettings.addApiKey')}</h3>
            <label className="block text-xs" htmlFor="fleet-account-kind">
              {t('botSettings.providerKind')}
            </label>
            <Select value={accountKind} onValueChange={(value) => setAccountKind(value as FleetApiKeyProviderKind)}>
              <SelectTrigger id="fleet-account-kind" aria-label={t('botSettings.providerKind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">{t('botSettings.kindOpenAI')}</SelectItem>
                <SelectItem value="openai-responses">{t('botSettings.kindResponses')}</SelectItem>
                <SelectItem value="anthropic">{t('botSettings.kindAnthropic')}</SelectItem>
              </SelectContent>
            </Select>
            <label className="block text-xs" htmlFor="fleet-account-name">
              {t('botSettings.accountName')}
            </label>
            <Input
              className="bg-surface-elevated"
              id="fleet-account-name"
              value={accountName}
              maxLength={40}
              onChange={(event) => setAccountName(event.target.value)}
            />
            <label className="block text-xs" htmlFor="fleet-account-key">
              {t('botSettings.apiKey')}
            </label>
            <Input
              className="bg-surface-elevated"
              id="fleet-account-key"
              ref={keyRef}
              type="password"
              autoComplete="off"
              maxLength={512}
            />
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">{t('botSettings.advanced')}</summary>
              <label className="mt-3 block text-xs" htmlFor="fleet-account-url">
                {t('botSettings.baseURL')}
              </label>
              <Input
                className="bg-surface-elevated"
                id="fleet-account-url"
                value={baseURL}
                maxLength={300}
                placeholder="https://api.example.com/v1"
                onChange={(event) => setBaseURL(event.target.value)}
              />
            </details>
            {accountError && (
              <p role="alert" className="text-xs text-destructive">
                {accountError}
              </p>
            )}
            <Button size="sm" disabled={accountBusy} onClick={() => void addAccount()}>
              {t('botSettings.addAccount')}
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={accountBusy || bot.lifecycle !== 'running'}
            onClick={() => void logInOnScreen()}
          >
            {t('botSettings.loginOnScreen')}
          </Button>
        </section>
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
        <section ref={compactionRef} className="space-y-3" aria-labelledby="fleet-compaction-heading">
          <h2 id="fleet-compaction-heading" className="font-semibold">
            {t('botSettings.compaction.heading')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('botSettings.compaction.description')}</p>
          {bot.compactionState?.problem && (
            <p role="status" className="text-xs text-amber-300">
              {t(`botSettings.compaction.problem.${bot.compactionState.problem}`, {
                // A gone model has no option left: name its account by label, never by its internal id.
                model: bot.compaction
                  ? `${
                      options.find((option) => option.providerId === bot.compaction?.providerId)?.providerLabel ??
                      bot.accounts.providers.find((provider) => provider.id === bot.compaction?.providerId)?.label ??
                      t('botSettings.compaction.removedAccount')
                    } · ${bot.compaction.modelId}`
                  : '',
              })}
            </p>
          )}
          <div>
            <label className="mb-2 block text-sm font-medium">{t('botSettings.compaction.model')}</label>
            <SearchSelect
              value={compaction.modelId || undefined}
              options={options.map((option) => ({
                id: option.id,
                label: `${option.providerLabel} · ${option.modelLabel}`,
              }))}
              onChange={(id) => {
                setCompaction((current) => ({ ...current, modelId: id ?? '', reasoning: null, fastMode: false }))
                setCompactionSaved(false)
              }}
              disabled={!options.length}
              placeholder={t('botSettings.chooseModel')}
              ariaLabel={t('botSettings.compaction.model')}
            />
          </div>
          {compactionChoice && compactionChoice.efforts.length > 0 && (
            <div>
              <label className="mb-2 block text-sm font-medium" htmlFor="fleet-compaction-reasoning">
                {t('botSettings.compaction.reasoning')}
              </label>
              <Select
                value={compaction.reasoning ?? 'default'}
                onValueChange={(value) =>
                  setCompaction((current) => ({ ...current, reasoning: value === 'default' ? null : value }))
                }
              >
                <SelectTrigger id="fleet-compaction-reasoning">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t('botSettings.compaction.default')}</SelectItem>
                  {compactionChoice.efforts.map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {effort}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {compactionChoice?.fastMode && (
            <div className="flex">
              <FastModeChip
                enabled={compaction.fastMode}
                onToggle={() => setCompaction((current) => ({ ...current, fastMode: !current.fastMode }))}
              />
            </div>
          )}
          <div>
            <label className="mb-2 block text-sm font-medium" htmlFor="fleet-compaction-interval">
              {t('botSettings.compaction.interval')}
            </label>
            <Input
              id="fleet-compaction-interval"
              type="number"
              min={10}
              max={1000}
              step={1}
              className="w-32 bg-surface-elevated"
              value={compaction.intervalThousands}
              aria-invalid={!compactionValue && Boolean(compaction.modelId)}
              onChange={(event) => setCompaction((current) => ({ ...current, intervalThousands: event.target.value }))}
            />
            {!compactionValue && compaction.modelId && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {t('botSettings.compaction.intervalInvalid')}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button
              disabled={!compactionValue || !compactionDirty || compactionBusy}
              onClick={() => void saveCompaction()}
            >
              {t('botSettings.compaction.save')}
            </Button>
            {compactionSaved && (
              <span role="status" className="text-xs text-primary">
                {t('botSettings.saved')}
              </span>
            )}
          </div>
          {compactionError && (
            <p role="alert" className="text-xs text-destructive">
              {compactionError}
            </p>
          )}
        </section>
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
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{item.title}</strong>
                    {item.createdBy === 'bot' && (
                      <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t('routine.createdByBot')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      routineScheduleSummary(item.schedule, dayLabels, t('routine.schedule.everyDay')).key,
                      routineScheduleSummary(item.schedule, dayLabels, t('routine.schedule.everyDay')).values
                    )}
                  </p>
                  {(item.nextRunAt || item.lastOutcome) && (
                    <p className="text-xs text-muted-foreground">
                      {item.nextRunAt &&
                        t('routine.nextRun', {
                          time: new Date(item.nextRunAt).toLocaleString(i18n.language, {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          }),
                        })}
                      {item.nextRunAt && item.lastOutcome && ' · '}
                      {item.lastOutcome && t(`routine.outcome.${item.lastOutcome}`)}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={item.enabled}
                  aria-label={t('botSettings.toggleRoutine', { title: item.title })}
                  onClick={() => void actionRoutine('toggle', item)}
                  // Same switch as the rest of the app: a white knob on a cream track was barely visible.
                  className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${item.enabled ? 'bg-emerald-500/70' : 'bg-white/10'}`}
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
                    setRoutine(routineFormFrom(item))
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
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={!!historyOpen[item.id]}
                  onClick={() => setHistoryOpen((value) => ({ ...value, [item.id]: !value[item.id] }))}
                >
                  {t(historyOpen[item.id] ? 'routineRuns.hide' : 'routineRuns.history')}
                </Button>
                {historyOpen[item.id] && (
                  <RoutineRunHistory bot={bot} routineId={item.id} refreshKey={latestBotActivitySeq} />
                )}
              </div>
            ))}
            {!routines.length && <p className="text-xs text-muted-foreground">{t('botSettings.noRoutines')}</p>}
          </div>
        </section>
        <BotMemorySection key={bot.id} bot={bot} />
        <section>
          <h2 className="font-semibold">{t('botSettings.where')}</h2>
          <p className="mt-2 rounded-lg border border-border p-4 text-sm">
            {t('botSettings.container')} <code>maestrly-bot-{bot.id}</code> · {t('server.memory')}{' '}
            {bot.resources.memoryBytes === null ? '—' : `${gb(bot.resources.memoryBytes)} GB`} · {t('server.cpu')}{' '}
            {bot.resources.cpuPercent === null ? '—' : `${Math.round(bot.resources.cpuPercent)}%`} ·{' '}
            {t('botSettings.started')}{' '}
            {bot.resources.startedAt ? new Date(bot.resources.startedAt).toLocaleString(i18n.language) : '—'}
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
      {confirm && (
        <ConfirmDialog
          title={t(
            confirm.kind === 'archive'
              ? 'botSettings.archiveTitle'
              : confirm.kind === 'account'
                ? 'botSettings.removeAccountTitle'
                : 'routine.deleteTitle'
          )}
          message={t(
            confirm.kind === 'archive'
              ? 'botSettings.archiveConfirm'
              : confirm.kind === 'account'
                ? 'botSettings.removeAccountConfirm'
                : 'routine.deleteConfirm'
          )}
          confirmLabel={t(
            confirm.kind === 'archive'
              ? 'botSettings.archiveConfirmButton'
              : confirm.kind === 'account'
                ? 'botSettings.removeAccount'
                : 'routine.delete'
          )}
          destructive
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmAction()}
        />
      )}
    </section>
  )
}
