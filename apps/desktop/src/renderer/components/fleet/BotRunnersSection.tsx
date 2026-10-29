import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Cpu, ShieldAlert } from 'lucide-react'
import { FLEET_RUNNER_JOB_FINAL_STATES, FLEET_RUNNER_LIMITS, type FleetBot } from '@maestrly/bot-fleet-protocol'
import type { FleetRunnerJob, FleetRunnerLinkView } from '@maestrly/bot-fleet-protocol'
import type { RunnerAccessView } from '../../../shared/runner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { fileSizeLabel } from '@/lib/fleet/downloads'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { useFleetServerId } from '@/lib/fleet/server-context'
import { RUNNER_OS_NAMES } from '@/lib/runner'
import { useSettings } from '@/lib/use-settings'
import { cn } from '@/lib/utils'
import { fieldInput } from './BotAccessCard'
import { SettingsCard, SettingsSection } from './SettingsSection'
import { SettingsSwitch } from './SettingsSwitch'

/** The newest jobs the tab lists. */
const JOBS_SHOWN = 10

/**
 * Which computers run this bot's jobs: on a computer that runs jobs for bots, the switch that lets this bot use it under a
 * name the bot sees; on every computer, the runners linked to the bot, which can be removed from here, and the bot's
 * newest jobs. Changes are saved at once, apart from the bot's settings.
 */
export function BotRunnersSection({ bot, id }: { bot: FleetBot; id: string }) {
  const serverId = useFleetServerId()
  const [view, setView] = useState<RunnerAccessView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setView(await window.api.fleetRunnerAccess(serverId, bot.id))
      setLoadError('')
    } catch (cause) {
      setLoadError(fleetErrorMessage(cause))
    }
  }, [serverId, bot.id])
  useEffect(() => {
    void refresh()
    // Another computer linked or removed itself, a job changed state, or the owner came back to this window.
    const off = window.api.onFleetRunnerAccess((changedServer, botId) => {
      if (changedServer === serverId && botId === bot.id) void refresh()
    })
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [serverId, bot.id, refresh])

  /** Runs a change and shows the view it answers with; a failure is said and keeps the dialog it came from open. */
  const perform = useCallback(async (action: () => Promise<RunnerAccessView>): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      setView(await action())
      return true
    } catch (cause) {
      setError(fleetErrorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <BotRunnersView
      id={id}
      view={view}
      loadError={loadError}
      busy={busy}
      error={error}
      onLink={(name) => perform(() => window.api.fleetRunnerAccessLink(serverId, bot.id, name))}
      onUnlink={() => perform(() => window.api.fleetRunnerAccessUnlink(serverId, bot.id))}
      onRemove={(link) => perform(() => window.api.fleetRunnerAccessRemoveOther(serverId, bot.id, link.runnerId))}
    />
  )
}

export interface BotRunnersViewProps {
  /** A prefix for the ids of the section's fields, unique on the page. */
  id: string
  view: RunnerAccessView | null
  loadError: string
  busy: boolean
  error: string
  /** Each answers whether the change was made. */
  onLink(name: string): Promise<boolean>
  onUnlink(): Promise<boolean>
  onRemove(link: FleetRunnerLinkView): Promise<boolean>
}

/** What the Runners tab shows for a view; the section above keeps the state, this only draws it. */
export function BotRunnersView({ id, view, loadError, busy, error, onLink, onUnlink, onRemove }: BotRunnersViewProps) {
  const { t, i18n } = useTranslation('fleet')
  const { openSettings } = useSettings()
  /** Whether the person is turning this computer on and has not saved yet. */
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState<FleetRunnerLinkView | null>(null)
  const self = view?.self ?? null
  // The name starts as the link's, else this computer's pairing name; the person's edits stay until the link changes.
  const startName = self?.name ?? view?.defaultName ?? ''
  useEffect(() => setName(startName), [startName])

  const date = (value: string) =>
    new Date(value).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <SettingsSection id={id} title={t('botSettings.runners.title')} note={t('botSettings.runners.note')}>
      <div className="flex flex-col gap-6" data-testid="fleet-runners">
        {!view ? (
          <p className="text-sm text-muted-foreground">{loadError || t('botSettings.runners.loading')}</p>
        ) : (
          <>
            {!view.connected ? (
              <Notice testId="fleet-runners-unavailable" text={t('botSettings.runners.unavailable.disconnected')} />
            ) : !view.supported ? (
              <Notice testId="fleet-runners-unavailable" text={t('botSettings.runners.unavailable.gateway-update')} />
            ) : (
              !view.botSupported && (
                <Notice testId="fleet-runners-unavailable" text={t('botSettings.runners.unavailable.bot-update')} />
              )
            )}

            <SettingsCard className="flex flex-col gap-4 p-[18px]">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-foreground/5 text-foreground/75"
                  >
                    <Cpu className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {self
                        ? t('botSettings.runners.thisComputer.on', { name: self.name })
                        : t('botSettings.runners.thisComputer.enable')}
                    </p>
                    <p className="text-xs text-muted-foreground">{t('botSettings.runners.thisComputer.enableHint')}</p>
                  </div>
                </div>
                <div data-testid="fleet-runners-switch">
                  <SettingsSwitch
                    checked={!!self || adding}
                    disabled={busy || !view.connected || (!self && !(view.supported && view.runnerEnabled))}
                    label={
                      self
                        ? t('botSettings.runners.thisComputer.turnOff')
                        : t('botSettings.runners.thisComputer.enable')
                    }
                    onChange={() => {
                      if (self) setConfirming(true)
                      else setAdding(!adding)
                    }}
                  />
                </div>
              </div>

              {!view.runnerEnabled && (
                <div className="flex flex-wrap items-center gap-3" data-testid="fleet-runners-off">
                  <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {t('botSettings.runners.thisComputer.runnerOff')}
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={() => openSettings('runner')}>
                    {t('botSettings.runners.thisComputer.openSettings')}
                  </Button>
                </div>
              )}

              {(self || adding) && (
                <form
                  className="flex flex-col gap-4 border-t border-border pt-4"
                  data-testid="fleet-runners-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!name.trim()) return
                    void onLink(name.trim()).then((done) => done && setAdding(false))
                  }}
                >
                  <p
                    role="note"
                    className="flex items-start gap-2 rounded-md border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-xs"
                  >
                    <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
                    {t(
                      view.executor === 'container'
                        ? 'botSettings.runners.thisComputer.warningContainer'
                        : 'botSettings.runners.thisComputer.warningNative'
                    )}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={`${id}-runner-name`} className="text-[13px] font-medium">
                      {t('botSettings.runners.thisComputer.name')}
                    </label>
                    <input
                      id={`${id}-runner-name`}
                      className={fieldInput}
                      value={name}
                      maxLength={FLEET_RUNNER_LIMITS.nameMax}
                      autoComplete="off"
                      aria-invalid={!name.trim()}
                      aria-describedby={`${id}-runner-name-hint`}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <p id={`${id}-runner-name-hint`} className="text-xs text-muted-foreground">
                      {name.trim()
                        ? t('botSettings.runners.thisComputer.nameHint')
                        : t('botSettings.runners.thisComputer.nameRequired')}
                    </p>
                  </div>
                  {(adding || (self && name.trim() !== self.name)) && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="submit" size="sm" data-testid="fleet-runners-save" disabled={busy || !name.trim()}>
                        {busy
                          ? t('botSettings.runners.thisComputer.saving')
                          : t('botSettings.runners.thisComputer.give')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setAdding(false)
                          setName(startName)
                        }}
                      >
                        {t('botSettings.runners.thisComputer.cancel')}
                      </Button>
                    </div>
                  )}
                </form>
              )}
              {error && !confirming && !removing && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </SettingsCard>

            <section aria-labelledby={`${id}-list`} className="flex flex-col gap-2" data-testid="fleet-runners-list">
              <div>
                <h3 id={`${id}-list`} className="text-sm font-semibold">
                  {t('botSettings.runners.list.title')}
                </h3>
                <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t('botSettings.runners.list.note')}</p>
              </div>
              {view.links === null ? (
                <p className="text-xs text-muted-foreground">
                  {view.supported && view.connected ? t('botSettings.runners.list.unknown') : '—'}
                </p>
              ) : view.links.length ? (
                <SettingsCard className="divide-y divide-border">
                  {view.links.map((link) => (
                    <RunnerRow
                      key={link.runnerId}
                      link={link}
                      date={date}
                      busy={busy}
                      onRemove={() => setRemoving(link)}
                    />
                  ))}
                </SettingsCard>
              ) : (
                <p className="text-xs text-muted-foreground">{t('botSettings.runners.list.empty')}</p>
              )}
            </section>

            <section aria-labelledby={`${id}-jobs`} className="flex flex-col gap-2" data-testid="fleet-runners-jobs">
              <h3 id={`${id}-jobs`} className="text-sm font-semibold">
                {t('botSettings.runners.jobs.title')}
              </h3>
              {view.jobs === null ? (
                <p className="text-xs text-muted-foreground">
                  {view.supported && view.connected ? t('botSettings.runners.list.unknown') : '—'}
                </p>
              ) : view.jobs.length ? (
                <SettingsCard className="divide-y divide-border">
                  {[...view.jobs]
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .slice(0, JOBS_SHOWN)
                    .map((job) => (
                      <JobRow key={job.jobId} job={job} date={date} />
                    ))}
                </SettingsCard>
              ) : (
                <p className="text-xs text-muted-foreground">{t('botSettings.runners.jobs.empty')}</p>
              )}
            </section>
          </>
        )}
      </div>
      {confirming && (
        <ConfirmDialog
          title={t('botSettings.runners.thisComputer.turnOffTitle')}
          message={t('botSettings.runners.thisComputer.turnOffMessage')}
          confirmLabel={t('botSettings.runners.thisComputer.turnOffConfirm')}
          destructive
          busy={busy}
          error={error || null}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void onUnlink().then((done) => done && setConfirming(false))}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={t('botSettings.runners.list.removeTitle', { name: removing.name })}
          message={t('botSettings.runners.list.removeMessage', { name: removing.name })}
          confirmLabel={t('botSettings.runners.list.removeConfirm')}
          destructive
          busy={busy}
          error={error || null}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void onRemove(removing).then((done) => done && setRemoving(null))}
        />
      )}
    </SettingsSection>
  )
}

function Notice({ text, testId }: { text: string; testId: string }) {
  return (
    <p
      role="status"
      data-testid={testId}
      className="flex items-start gap-2 rounded-xl border border-amber-300/35 bg-amber-300/10 px-3.5 py-3 text-[13px]"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
      {text}
    </p>
  )
}

/** One runner of the bot: its name, whether it is online, what it is, and its slots; another computer's can be removed. */
function RunnerRow({
  link,
  date,
  busy,
  onRemove,
}: {
  link: FleetRunnerLinkView
  date: (value: string) => string
  busy: boolean
  onRemove(): void
}) {
  const { t, i18n } = useTranslation('fleet')
  const caps = link.capabilities
  const details = caps
    ? [
        t(`botSettings.runners.list.${caps.executor}`),
        RUNNER_OS_NAMES[caps.os],
        t('botSettings.runners.list.cpus', { count: caps.cpus }),
        fileSizeLabel(caps.memoryBytes, i18n.language),
        caps.gpu ? caps.gpu.name : t('botSettings.runners.list.noGpu'),
      ].join(' · ')
    : ''
  return (
    <div
      data-testid="fleet-runner"
      data-runner-id={link.runnerId}
      data-self={link.self}
      className="flex flex-wrap items-center gap-3 px-[18px] py-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {link.name}
          {link.self && (
            <span className="rounded-full border border-border px-2 py-px text-[11.5px] font-normal text-muted-foreground">
              {t('botSettings.runners.list.self')}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn('size-1.5 rounded-full', link.online ? 'bg-status-ready' : 'bg-muted-foreground/70')}
            />
            {link.online ? t('botSettings.runners.list.online') : t('botSettings.runners.list.offline')}
          </span>
        </span>
        {details && <span className="text-xs text-muted-foreground">{details}</span>}
        <span className="text-xs text-muted-foreground">
          {caps && link.online
            ? `${t('botSettings.runners.list.slots', { busy: link.busySlots, slots: caps.slots })}`
            : ''}
          {!link.online && link.lastSeenAt
            ? t('botSettings.runners.list.lastSeen', { date: date(link.lastSeenAt) })
            : ''}
        </span>
      </div>
      {!link.self && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onRemove}
        >
          {t('botSettings.runners.list.remove')}
        </Button>
      )}
    </div>
  )
}

/** One of the bot's jobs: its state, the runner that has it or had it, and when it was sent. */
function JobRow({ job, date }: { job: FleetRunnerJob; date: (value: string) => string }) {
  const { t } = useTranslation('fleet')
  const ended = FLEET_RUNNER_JOB_FINAL_STATES.includes(job.state)
  return (
    <div data-testid="fleet-runner-job" data-state={job.state} className="flex flex-col gap-0.5 px-[18px] py-3">
      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {t(`botSettings.runners.jobs.state.${job.state}`)}
        <span className="text-xs font-normal text-muted-foreground">
          {job.runnerName ?? t('botSettings.runners.jobs.unknownRunner')}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">{date(job.createdAt)}</span>
      {ended && job.state !== 'succeeded' && job.error && (
        <span className="text-xs text-muted-foreground">{job.error.message}</span>
      )}
    </div>
  )
}
