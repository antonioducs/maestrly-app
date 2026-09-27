import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Boxes } from 'lucide-react'
import {
  FLEET_ENVIRONMENT_LIMITS,
  type FleetBot,
  type FleetEnvironment,
  type FleetSelectionOption,
} from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { compactionFormFrom, compactionModelLabel, compactionPatch, compactionSourceOf } from '@/lib/fleet/compaction'
import { fleetErrorText } from '@/lib/fleet/errors'
import {
  createKeyWatcher,
  environmentBots,
  environmentUpdateAvailable,
  formatNames,
  memoryLimitChoices,
  memoryLimitFromValue,
  memoryLimitValue,
  type ProvisioningSubject,
} from '@/lib/fleet/environments'
import { gb } from '@/lib/fleet/format'
import { formatUptime } from '@/lib/fleet/forms'
import {
  environmentCompactionAvailability,
  environmentJoinAvailability,
  environmentJoinHint,
  environmentProvisioningKey,
  environmentScreenAvailability,
  provisioningAvailability,
  useFleetProvisioning,
} from '@/lib/fleet/provisioning'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { FleetView } from '@/lib/use-main-panels'
import { ApiKeyAccountForm } from './ApiKeyAccountForm'
import { BotAccountsSection } from './BotAccountsSection'
import { BotSkillsMcpSection } from './BotSkillsMcpSection'
import { CompactionFields } from './CompactionFields'
import { EnvironmentScreen } from './EnvironmentScreen'

const tabs = ['overview', 'screen'] as const
type Confirm = 'restart' | 'update' | 'stop' | 'archive'

/** An environment: its bots, the accounts, skills and MCP servers they share, its screen and its lifecycle. */
export function EnvironmentView({
  environment,
  view,
  fleet,
  onView,
  onOpenBot,
  onCreateBot,
}: {
  environment: FleetEnvironment
  view: Extract<FleetView, { kind: 'environment' }>
  fleet: FleetController
  onView: (view: FleetView) => void
  onOpenBot: (id: string) => void
  onCreateBot: (environmentId: string) => void
}) {
  const { t } = useTranslation('fleet')
  const tab = view.tab
  const setTab = (next: typeof tab) => onView({ kind: 'environment', environmentId: environment.id, tab: next })
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.indexOf(tab)
    const next =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(index + tabs.length - 1) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs[tabs.length - 1]
              : null
    if (!next) return
    event.preventDefault()
    setTab(next)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#fleet-environment-tab-${next}`)?.focus()
  }
  const host = fleet.state.snapshot.host?.hostname
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border px-5 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-elevated text-muted-foreground">
            <Boxes className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 shrink-0">
            <h1 className="truncate text-sm font-semibold">{environment.name}</h1>
            <p className="max-w-40 truncate text-xs text-muted-foreground">
              {t('environment.label')} · {t('environment.botCount', { count: environment.botIds.length })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onView({ kind: 'server' })}
            className="max-w-36 truncate rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            title={host ?? t('view.server')}
          >
            {host ?? t('view.server')}
          </button>
          <div
            role="tablist"
            aria-label={t('environment.views')}
            className="flex min-w-0 items-center gap-1 rounded-lg border border-border p-0.5"
          >
            {tabs.map((name) => (
              <button
                key={name}
                id={`fleet-environment-tab-${name}`}
                type="button"
                role="tab"
                aria-selected={tab === name}
                aria-controls={`fleet-environment-panel-${name}`}
                onClick={() => setTab(name)}
                onKeyDown={onKeyDown}
                className={`rounded-md px-3 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-ring ${tab === name ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {name === 'overview' ? t('environment.overview') : t('environment.screen')}
              </button>
            ))}
          </div>
          <span className="ml-auto shrink-0 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
            {t(`environment.lifecycle.${environment.lifecycle}`)}
          </span>
        </div>
      </header>
      {fleet.actionError?.environmentId === environment.id && (
        <p role="alert" className="px-5 py-2 text-xs text-destructive">
          {fleetErrorText(fleet.actionError.message, t)}
        </p>
      )}
      <div
        id={`fleet-environment-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`fleet-environment-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === 'overview' ? (
          <EnvironmentOverview
            key={environment.id}
            environment={environment}
            fleet={fleet}
            onOpenBot={onOpenBot}
            onCreateBot={onCreateBot}
            onOpenScreen={() => setTab('screen')}
            onArchived={() => onView({ kind: 'server' })}
          />
        ) : (
          <EnvironmentScreen key={environment.id} environment={environment} fleet={fleet} />
        )}
      </div>
    </div>
  )
}

function EnvironmentOverview({
  environment,
  fleet,
  onOpenBot,
  onCreateBot,
  onOpenScreen,
  onArchived,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  onOpenBot: (id: string) => void
  onCreateBot: (environmentId: string) => void
  onOpenScreen: () => void
  onArchived: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const bots = environmentBots(environment, fleet.state.snapshot.bots)
  const running = environment.lifecycle === 'running'
  const stopped = environment.lifecycle === 'stopped' || environment.lifecycle === 'failed'
  const availability = provisioningAvailability(fleet, environment)
  const lists = useFleetProvisioning({ environmentId: environment.id }, availability === 'ready' && running)
  // The shared lists reload when the environment's Maestrly or its bots' accounts change, never on resource samples.
  const listsKey = environmentProvisioningKey(environment, fleet.state.snapshot.bots)
  const [listsChanged] = useState(() => createKeyWatcher(listsKey))
  useEffect(() => {
    if (listsChanged(listsKey)) lists.refresh()
  }, [listsKey, listsChanged, lists.refresh])
  const subject: ProvisioningSubject = {
    target: { environmentId: environment.id },
    name: environment.name,
    running,
  }
  const join = environmentJoinAvailability(fleet, environment)
  const joinHint = join === 'ready' ? null : environmentJoinHint(join)
  // An image from before environments has no environment screen: its settings open in its bot's browser area.
  const oldImage = environmentScreenAvailability(environment) === 'restart-environment'
  const host = fleet.state.snapshot.host
  const update = environmentUpdateAvailable(environment, host)
  const names =
    formatNames(
      bots.map((bot) => bot.name),
      i18n.language
    ) || t('environment.noBotsNamed')
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  // Stable: the dialog refocuses on a new callback, and this view re-renders with every resource sample.
  const cancelConfirm = useCallback(() => setConfirm(null), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [screenBusy, setScreenBusy] = useState(false)
  const [screenError, setScreenError] = useState('')
  const [limitBusy, setLimitBusy] = useState(false)
  const [limitSaved, setLimitSaved] = useState(false)
  const [limitError, setLimitError] = useState('')
  const { memoryBytes, cpuPercent, startedAt } = environment.resources
  const uptime = startedAt ? formatUptime(Date.now() - Date.parse(startedAt)) : null

  async function logInOnScreen() {
    setScreenBusy(true)
    setScreenError('')
    try {
      await window.api.fleetEnvironmentUiOpen(environment.id, 'accounts')
      onOpenScreen()
    } catch {
      setScreenError(t('environment.screenLoginFailed'))
    } finally {
      setScreenBusy(false)
    }
  }
  async function saveLimit(value: string) {
    if (limitBusy) return
    setLimitBusy(true)
    setLimitSaved(false)
    setLimitError('')
    try {
      const updated = await window.api.fleetPatchEnvironment(environment.id, {
        memoryLimitBytes: memoryLimitFromValue(value),
      })
      fleet.dispatch({
        type: 'event',
        value: { type: 'environment.updated', at: new Date().toISOString(), environment: updated },
      })
      setLimitSaved(true)
    } catch (cause) {
      setLimitError(fleetErrorText(cause, t))
    } finally {
      setLimitBusy(false)
    }
  }
  async function confirmAction() {
    if (!confirm || busy) return
    setBusy(true)
    setError('')
    try {
      // Updating is a restart: the environment comes back on the image the server offers.
      const updated = await window.api.fleetEnvironmentAction(
        environment.id,
        confirm === 'update' ? 'restart' : confirm
      )
      fleet.dispatch({
        type: 'event',
        value: { type: 'environment.updated', at: new Date().toISOString(), environment: updated },
      })
      setConfirm(null)
      if (confirm === 'archive') onArchived()
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-8">
        <section className="space-y-3" aria-labelledby="fleet-environment-bots">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="fleet-environment-bots" className="font-semibold">
              {t('environment.bots')}
            </h2>
            <span className="text-xs text-muted-foreground">
              {t('environment.capacity', {
                count: environment.botIds.length,
                max: FLEET_ENVIRONMENT_LIMITS.botsMax,
              })}
            </span>
          </div>
          {bots.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border bg-surface-elevated">
              {bots.map((bot) => (
                <li key={bot.id}>
                  <BotRow bot={bot} onOpen={() => onOpenBot(bot.id)} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t('environment.noBots')}</p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={join !== 'ready'} onClick={() => onCreateBot(environment.id)}>
              {t('environment.newBotHere')}
            </Button>
            {joinHint && <p className="text-xs text-muted-foreground">{t(joinHint.key, joinHint.values)}</p>}
          </div>
          <p className="text-xs text-muted-foreground">{t('environment.sharedNote')}</p>
        </section>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-6">
          <p className="text-xs text-muted-foreground">{t('environment.sharedConfig')}</p>
          <Button size="sm" variant="ghost" disabled={availability !== 'ready' || !running} onClick={lists.refresh}>
            {t('environment.refresh')}
          </Button>
        </div>
        <BotAccountsSection
          key={environment.id}
          subject={subject}
          lists={lists}
          availability={availability}
          onChanged={fleet.refresh}
        >
          <ApiKeyAccountForm
            target={subject.target}
            onAdded={async () => {
              lists.refresh()
              await fleet.refresh()
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={screenBusy || !running || oldImage}
            onClick={() => void logInOnScreen()}
          >
            {t('environment.loginOnScreen')}
          </Button>
          {oldImage && <p className="text-xs text-muted-foreground">{t('environment.loginNeedsRestart')}</p>}
          {screenError && (
            <p role="alert" className="text-xs text-destructive">
              {screenError}
            </p>
          )}
        </BotAccountsSection>
        <BotSkillsMcpSection key={environment.id} subject={subject} lists={lists} availability={availability} />
        <EnvironmentCompaction
          key={`compaction-${environment.id}`}
          environment={environment}
          bots={bots}
          fleet={fleet}
          optionsKey={listsKey}
        />
        <section className="space-y-2" aria-labelledby="fleet-environment-screen">
          <h2 id="fleet-environment-screen" className="font-semibold">
            {t('environment.screenTitle')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('environment.screenDescription')}</p>
          <Button size="sm" variant="outline" disabled={oldImage} onClick={onOpenScreen}>
            {t('environment.openScreen')}
          </Button>
          {oldImage && <p className="text-xs text-muted-foreground">{t('screen.restartEnvironment')}</p>}
        </section>
        <section className="space-y-3" aria-labelledby="fleet-environment-resources">
          <h2 id="fleet-environment-resources" className="font-semibold">
            {t('environment.resources')}
          </h2>
          <p className="rounded-lg border border-border p-4 text-sm">
            {t('server.memory')} {memoryBytes === null ? '—' : `${gb(memoryBytes)} GB`} · {t('server.cpu')}{' '}
            {cpuPercent === null ? '—' : `${Math.round(cpuPercent)}%`} · {t('server.uptime')}{' '}
            {uptime ? t(uptime.long ? 'server.uptimeDays' : 'server.uptimeValue', uptime) : '—'}
            {environment.appVersion && ` · ${t('environment.version', { version: environment.appVersion })}`}
          </p>
          <div>
            <label className="mb-2 block text-sm font-medium" htmlFor="fleet-environment-memory-limit">
              {t('environment.memoryLimit')}
            </label>
            <div className="flex items-center gap-3">
              <Select
                value={memoryLimitValue(environment.memoryLimitBytes)}
                disabled={limitBusy}
                onValueChange={(value) => void saveLimit(value)}
              >
                <SelectTrigger
                  id="fleet-environment-memory-limit"
                  aria-label={t('environment.memoryLimit')}
                  className="w-48"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {memoryLimitChoices(environment.memoryLimitBytes).map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.gb === null
                        ? t('environment.memoryLimitDefault')
                        : t('environment.memoryLimitValue', { value: choice.gb })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {limitSaved && (
                <span role="status" className="text-xs text-primary">
                  {t('environment.saved')}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('environment.memoryLimitNote')}</p>
            {limitError && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {limitError}
              </p>
            )}
          </div>
        </section>
        <section className="space-y-3" aria-labelledby="fleet-environment-lifecycle">
          <h2 id="fleet-environment-lifecycle" className="font-semibold">
            {t('environment.lifecycleTitle')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('environment.lifecycleNote')}</p>
          <div className="flex flex-wrap gap-2">
            {stopped ? (
              <Button size="sm" onClick={() => void fleet.environmentAction(environment.id, 'start')}>
                {t('environment.start')}
              </Button>
            ) : (
              <>
                <Button size="sm" variant="outline" disabled={!running} onClick={() => setConfirm('restart')}>
                  {t('environment.restart')}
                </Button>
                {update && (
                  <Button size="sm" disabled={!running} onClick={() => setConfirm('update')}>
                    {t('environment.update')}
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={!running} onClick={() => setConfirm('stop')}>
                  {t('environment.stop')}
                </Button>
              </>
            )}
          </div>
          {update && host?.botImageVersion && (
            <p className="text-xs text-muted-foreground">
              {t('environment.updateAvailable', { version: host.botImageVersion })}
            </p>
          )}
        </section>
        <section className="flex items-center justify-between gap-3 rounded-lg border border-destructive/50 p-4">
          <p className="text-xs text-muted-foreground">{t('environment.archiveNote')}</p>
          <Button variant="destructive" size="sm" onClick={() => setConfirm('archive')}>
            {t('environment.archive', { name: environment.name })}
          </Button>
        </section>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title={
            confirm === 'restart'
              ? t('environment.confirmRestartTitle', { name: environment.name })
              : confirm === 'update'
                ? t('environment.confirmUpdateTitle', { name: environment.name })
                : confirm === 'stop'
                  ? t('environment.confirmStopTitle', { name: environment.name })
                  : t('environment.confirmArchiveTitle')
          }
          message={
            confirm === 'restart'
              ? t('environment.confirmRestart', { bots: names })
              : confirm === 'update'
                ? t('environment.confirmUpdate', { bots: names })
                : confirm === 'stop'
                  ? t('environment.confirmStop', { bots: names })
                  : t('environment.confirmArchive', { bots: names })
          }
          confirmLabel={
            confirm === 'restart'
              ? t('environment.restartButton')
              : confirm === 'update'
                ? t('environment.updateButton')
                : confirm === 'stop'
                  ? t('environment.stopButton')
                  : t('environment.archiveButton')
          }
          destructive={confirm === 'archive' || confirm === 'stop'}
          busy={busy}
          onCancel={cancelConfirm}
          onConfirm={() => void confirmAction()}
        />
      )}
    </section>
  )
}

/**
 * The compaction model of the environment's bots without one of their own. Its models are those of the environment's
 * accounts, read again when they change (the key of the shared lists), never on resource samples.
 */
function EnvironmentCompaction({
  environment,
  bots,
  fleet,
  optionsKey,
}: {
  environment: FleetEnvironment
  bots: FleetBot[]
  fleet: FleetController
  optionsKey: string
}) {
  const { t, i18n } = useTranslation('fleet')
  const availability = environmentCompactionAvailability(fleet, environment)
  const ready = availability === 'ready'
  const current = environment.compaction
  const [options, setOptions] = useState<FleetSelectionOption[]>([])
  const [form, setForm] = useState(() => compactionFormFrom(current))
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setForm(compactionFormFrom(current))
  }, [current?.providerId, current?.modelId, current?.reasoning, current?.fastMode, current?.intervalTokens])
  useEffect(() => {
    if (!ready) return
    let alive = true
    window.api.fleetEnvironmentSelections(environment.id).then(
      (value) => {
        if (alive) setOptions(value.options)
      },
      (cause: unknown) => {
        if (alive) setError(fleetErrorText(cause, t))
      }
    )
    return () => {
      alive = false
    }
  }, [environment.id, ready, optionsKey])
  if (availability === 'unsupported') return null
  const value = compactionPatch(form)
  const dirty = JSON.stringify(value) !== JSON.stringify(current)
  const users = bots.filter((bot) => compactionSourceOf(bot) === 'environment').map((bot) => bot.name)
  async function save() {
    if (!value || !dirty || busy) return
    setBusy(true)
    setSaved(false)
    setError('')
    try {
      const updated = await window.api.fleetPatchEnvironment(environment.id, { compaction: value })
      fleet.dispatch({
        type: 'event',
        value: { type: 'environment.updated', at: new Date().toISOString(), environment: updated },
      })
      setSaved(true)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-3" aria-labelledby="fleet-environment-compaction">
      <h2 id="fleet-environment-compaction" className="font-semibold">
        {t('environment.compaction.heading')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('environment.compaction.description')}</p>
      {!current && <p className="text-xs text-muted-foreground">{t('environment.compaction.unset')}</p>}
      {ready ? (
        <>
          <CompactionFields
            form={form}
            onChange={(next) => {
              setForm(next)
              setSaved(false)
            }}
            options={options}
            idPrefix="fleet-environment-compaction"
          />
          {!options.length && <p className="text-xs text-muted-foreground">{t('environment.compaction.noModels')}</p>}
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={!value || !dirty || busy} onClick={() => void save()}>
              {t('environment.compaction.save')}
            </Button>
            {saved && (
              <span role="status" className="text-xs text-primary">
                {t('environment.saved')}
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          {current && (
            <p className="rounded-lg border border-border p-4 text-sm">
              {t('environment.compaction.current', { model: compactionModelLabel(current, options) })}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {availability === 'stopped'
              ? t('environment.compaction.startToChange')
              : t('environment.compaction.restart')}
          </p>
        </>
      )}
      {current && (
        <p className="text-xs text-muted-foreground">
          {users.length
            ? t('environment.compaction.usedBy', { bots: formatNames(users, i18n.language) })
            : t('environment.compaction.usedByNone')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

function BotRow({ bot, onOpen }: { bot: FleetBot; onOpen: () => void }) {
  const { t } = useTranslation('fleet')
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-white"
        style={{ background: bot.tint }}
      >
        {bot.name.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{bot.name}</span>
        {bot.role && <span className="block truncate text-xs text-muted-foreground">{bot.role}</span>}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{t(`status.${bot.status}`)}</span>
    </button>
  )
}
