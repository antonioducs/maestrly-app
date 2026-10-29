import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, FolderOpen, Loader2, ShieldAlert, Trash2 } from 'lucide-react'
import type { RunnerConfigPatch, RunnerHistoryItem, RunnerJobItem, RunnerStatus } from '../../../shared/runner'
import { Button } from '@/components/ui/button'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { RunnerLogDialog } from '@/components/fleet/RunnerLogDialog'
import { RunnerUsage } from '@/components/fleet/RunnerUsage'
import { SettingsSwitch } from '@/components/fleet/SettingsSwitch'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { fileSizeLabel } from '@/lib/fleet/downloads'
import { bytesToGb, dockerNoticeKey, gbToBytes, jobDuration, RUNNER_SLOT_CHOICES } from '@/lib/runner'
import { cn } from '@/lib/utils'
import { dockerUrl } from './bot-server/BotServerLocalSetup'
import { SettingLimitField } from './fields'
import type { TFn } from './shared'

const card = 'flex flex-col gap-3 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5'
const heading = 'text-sm font-semibold text-foreground'
const hint = 'text-[11px] leading-snug text-muted-foreground'
/** How often the jobs and what they use are read again while a job runs, besides when the runner says they changed. */
const JOBS_REFRESH_MS = 5_000

/** The clock the job list reads durations from, ticking once a second while there is a job to time. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/**
 * Settings → Runner: whether this computer runs jobs for bots, how, how many at once, where it keeps their files, and
 * the jobs it runs now. Every change is saved at once.
 */
export function RunnerSection({ t }: { t: TFn }) {
  const [status, setStatus] = useState<RunnerStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const now = useNow((status?.jobs.length ?? 0) > 0)

  const refresh = useCallback(async (recheckDocker = false) => {
    try {
      setStatus(await window.api.runnerStatus({ recheckDocker }))
      setError('')
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    }
  }, [])
  useEffect(() => {
    void refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    // The jobs and the storage change often while jobs run: the screen reads them again in one go.
    const offChanged = window.api.onRunnerChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 250)
    })
    const offServers = window.api.onFleetServers(() => void refresh())
    return () => {
      clearTimeout(timer)
      offChanged()
      offServers()
    }
  }, [refresh])

  // What a job uses changes all the time: while one runs and the window is in view, the screen reads it again.
  const running = (status?.jobs.length ?? 0) > 0
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, JOBS_REFRESH_MS)
    return () => clearInterval(timer)
  }, [running, refresh])

  /** Runs one action, then reads everything again; a failure is said, not hidden. */
  const perform = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      setError('')
      try {
        await action()
        await refresh()
      } catch (cause) {
        setError(fleetErrorMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )
  const change = (patch: RunnerConfigPatch) => perform(() => window.api.runnerSetSettings(patch))

  return (
    <RunnerSettingsView
      t={t}
      status={status}
      now={now}
      busy={busy}
      error={error}
      cancelling={cancelling}
      onChange={(patch) => void change(patch)}
      onChooseFolder={() =>
        void perform(async () => {
          const folder = await window.api.runnerChooseStorageDir()
          if (folder) await window.api.runnerSetSettings({ storageDir: folder })
        })
      }
      onClearCaches={(scope) => void perform(() => window.api.runnerClearCaches(scope))}
      onCancelJob={(job) => {
        setCancelling((current) => new Set(current).add(job.jobId))
        void window.api
          .runnerCancelJob(job.serverId, job.jobId)
          .catch((cause) => setError(fleetErrorMessage(cause)))
          .finally(() => void refresh())
      }}
      onRecheckDocker={() => void refresh(true)}
    />
  )
}

export interface RunnerSettingsViewProps {
  t: TFn
  status: RunnerStatus | null
  /** The time now, in milliseconds since the epoch, for the jobs' durations. */
  now: number
  busy: boolean
  error: string
  cancelling: ReadonlySet<string>
  onChange(patch: RunnerConfigPatch): void
  onChooseFolder(): void
  onClearCaches(scope?: { serverId: string; botId: string }): void
  onCancelJob(job: RunnerJobItem): void
  onRecheckDocker(): void
}

/** What Settings → Runner shows for a status; the screen above keeps the state, this only draws it. */
export function RunnerSettingsView({
  t,
  status,
  now,
  busy,
  error,
  cancelling,
  onChange,
  onChooseFolder,
  onClearCaches,
  onCancelJob,
  onRecheckDocker,
}: RunnerSettingsViewProps) {
  const { t: tf, i18n } = useTranslation('fleet')
  const locale = i18n.language
  const os = window.api.platformInfo.os
  // The blob cache always has a size: a field the person emptied goes back to it.
  const [blobFieldReset, setBlobFieldReset] = useState(0)
  /** The job whose log is open. */
  const [logOf, setLogOf] = useState<{
    serverId: string
    jobId: string
    bot: string
    server: string
    command: string
  } | null>(null)

  const header = (
    <div>
      <h2 className={heading}>{t('settings.runner.title')}</h2>
      <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.runner.desc')}</p>
    </div>
  )
  if (!status)
    return (
      <section className="flex flex-col gap-4" data-testid="runner-settings">
        {header}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
        )}
      </section>
    )
  if (!status.available)
    return (
      <section className="flex flex-col gap-4" data-testid="runner-settings">
        {header}
        <p className={card}>{t('settings.runner.unavailable')}</p>
      </section>
    )

  const { config, docker, storage } = status
  const container = config.executor === 'container'
  const files = (bytes: number) => fileSizeLabel(bytes, locale)
  const cpus = status.capabilities?.cpus ?? null
  const botOnServer = (item: { botName: string | null; serverName: string }) =>
    t('settings.runner.jobs.bot', {
      bot: item.botName ?? t('settings.runner.jobs.unknownBot'),
      server: item.serverName,
    })
  const openLog = (item: RunnerJobItem | RunnerHistoryItem) =>
    setLogOf({
      serverId: item.serverId,
      jobId: item.jobId,
      bot: item.botName ?? t('settings.runner.jobs.unknownBot'),
      server: item.serverName,
      command: item.command,
    })
  // The log of a job still listed here is followed; that of one that ended is read once more, then left alone.
  const logLive =
    logOf !== null && status.jobs.some((job) => job.serverId === logOf.serverId && job.jobId === logOf.jobId)
  const when = (value: number) => new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <section className="flex flex-col gap-6" data-testid="runner-settings">
      {header}

      <div className={card}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{t('settings.runner.enable')}</div>
            <p className={hint}>{t('settings.runner.enableHint')}</p>
          </div>
          <div data-testid="runner-enable">
            <SettingsSwitch
              checked={config.enabled}
              disabled={busy}
              label={t('settings.runner.enable')}
              onChange={() => onChange({ enabled: !config.enabled })}
            />
          </div>
        </div>
        <p
          role="note"
          data-testid="runner-warning"
          className="flex items-start gap-2 rounded-md border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-[12px]"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
          <span>
            {t(container ? 'settings.runner.warningContainer' : 'settings.runner.warningNative')}
            {config.enabled ? ` ${t('settings.runner.stopsJobs')}` : ''}
          </span>
        </p>
        <div className="flex flex-col gap-1" data-testid="runner-servers">
          <div className="text-[12px] font-medium text-foreground">{t('settings.runner.servers.title')}</div>
          {status.servers.length === 0 ? (
            <p className={hint}>{t('settings.runner.servers.none')}</p>
          ) : (
            status.servers.map((server) => (
              <p key={server.serverId} className="flex flex-wrap items-center gap-x-2 text-[12px]">
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-1.5 rounded-full',
                    server.connected && server.supported && config.enabled
                      ? 'bg-status-ready'
                      : 'bg-muted-foreground/70'
                  )}
                />
                <span className="font-medium text-foreground">{server.name}</span>
                <span className="text-muted-foreground">
                  {!server.connected
                    ? t('settings.runner.servers.offline')
                    : !server.supported
                      ? t('settings.runner.servers.unsupported')
                      : config.enabled
                        ? t('settings.runner.servers.taking')
                        : t('settings.runner.servers.notTaking')}
                </span>
              </p>
            ))
          )}
        </div>
      </div>

      {config.enabled && (
        <>
          <section className="flex flex-col gap-3" aria-labelledby="runner-executor-heading">
            <h3 id="runner-executor-heading" className={heading}>
              {t('settings.runner.executor.title')}
            </h3>
            <div className={cn('grid gap-2', status.nativeAllowed ? 'grid-cols-2' : 'grid-cols-1')}>
              {(status.nativeAllowed ? (['native', 'container'] as const) : (['container'] as const)).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  data-testid={`runner-executor-${kind}`}
                  aria-pressed={config.executor === kind}
                  disabled={busy}
                  onClick={() => config.executor !== kind && onChange({ executor: kind })}
                  className={cn(
                    'flex flex-col items-start justify-start rounded-lg border px-3 py-2 text-left text-xs transition-colors disabled:opacity-60',
                    config.executor === kind
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-white/[0.04]'
                  )}
                >
                  <span className="block text-[13px] font-medium text-foreground">
                    {t(`settings.runner.executor.${kind}`)}
                  </span>
                  <span className="mt-0.5 block leading-snug">{t(`settings.runner.executor.${kind}Desc`)}</span>
                </button>
              ))}
            </div>
            {!status.nativeAllowed && <p className={hint}>{t('settings.runner.executor.windows')}</p>}
            {container && (
              <div role="status" data-testid="runner-docker" className={card}>
                <div className="text-[12px] font-medium text-foreground">{t('settings.runner.docker.title')}</div>
                {docker ? (
                  <>
                    <p className="text-sm">
                      {tf(dockerNoticeKey(docker), { version: docker.version ?? '', engine: docker.engine ?? '' })}
                    </p>
                    {docker.state === 'missing' && os === 'mac' && (
                      <p className={hint}>{tf('botServer.local.alternatives')}</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {docker.state === 'missing' && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-[12px]"
                          onClick={() => void window.api.openExternalUrl(dockerUrl[os])}
                        >
                          {tf('botServer.local.download')}
                        </Button>
                      )}
                      {docker.state !== 'ready' && (
                        <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={onRecheckDocker}>
                          {tf('botServer.local.checkAgain')}
                        </Button>
                      )}
                    </div>
                  </>
                ) : (
                  <p className={hint}>{t('settings.runner.docker.checking')}</p>
                )}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-labelledby="runner-capacity-heading">
            <h3 id="runner-capacity-heading" className={heading}>
              {t('settings.runner.capacity.title')}
            </h3>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div id="runner-slots-label" className="text-sm font-medium text-foreground">
                  {t('settings.runner.capacity.slots')}
                </div>
                <div className={hint}>{t('settings.runner.capacity.slotsHint')}</div>
              </div>
              <OptionSelect
                value={String(config.slots)}
                onValueChange={(value) => onChange({ slots: Number(value) })}
                disabled={busy}
                aria-labelledby="runner-slots-label"
                data-testid="runner-slots"
                className="h-8 w-20"
              >
                {RUNNER_SLOT_CHOICES.map((count) => (
                  <SelectOption key={count} value={String(count)}>
                    {count}
                  </SelectOption>
                ))}
              </OptionSelect>
            </div>
            {container && (
              <>
                <SettingLimitField
                  label={t('settings.runner.capacity.cpus')}
                  hint={t('settings.runner.capacity.cpusHint')}
                  value={config.jobCpus === null ? undefined : Math.max(1, Math.round(config.jobCpus))}
                  emptyNote={t('settings.runner.capacity.noLimit')}
                  placeholder={t('settings.runner.capacity.placeholder')}
                  onCommit={(value) => onChange({ jobCpus: value })}
                />
                <SettingLimitField
                  label={t('settings.runner.capacity.memory')}
                  hint={t('settings.runner.capacity.memoryHint')}
                  value={bytesToGb(config.jobMemoryBytes)}
                  emptyNote={t('settings.runner.capacity.noLimit')}
                  placeholder={t('settings.runner.capacity.placeholder')}
                  onCommit={(value) => onChange({ jobMemoryBytes: value === null ? null : gbToBytes(value) })}
                />
              </>
            )}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{t('settings.runner.capacity.gpu')}</div>
                <div className={hint} data-testid="runner-gpu-hint">
                  {status.detectedGpu
                    ? t('settings.runner.capacity.gpuDetected', { name: status.detectedGpu.name })
                    : t('settings.runner.capacity.gpuNone')}
                  {container && status.detectedGpu?.vendor === 'nvidia' && ` ${t('settings.runner.docker.gpuHint')}`}
                </div>
              </div>
              <SettingsSwitch
                checked={config.gpu}
                disabled={busy || (!status.detectedGpu && !config.gpu)}
                label={t('settings.runner.capacity.gpu')}
                onChange={() => onChange({ gpu: !config.gpu })}
              />
            </div>
          </section>
        </>
      )}

      <section className="flex flex-col gap-3" aria-labelledby="runner-storage-heading">
        <div>
          <h3 id="runner-storage-heading" className={heading}>
            {t('settings.runner.storage.title')}
          </h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.runner.storage.desc')}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-[12px] font-medium text-foreground">{t('settings.runner.storage.folder')}</div>
          <div className="flex items-center gap-2">
            <div
              data-testid="runner-storage-dir"
              title={config.storageDir ?? storage.dir}
              className="min-w-0 flex-1 truncate rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-[12px] text-foreground"
            >
              {config.storageDir ?? t('settings.runner.storage.defaultFolder')}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-[12px]"
              disabled={busy}
              onClick={onChooseFolder}
            >
              <FolderOpen className="size-3.5" />
              {t('settings.runner.storage.choose')}
            </Button>
            {config.storageDir && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-[12px]"
                disabled={busy}
                onClick={() => onChange({ storageDir: null })}
              >
                {t('settings.runner.storage.useDefault')}
              </Button>
            )}
          </div>
          {storage.dir && (config.storageDir ?? storage.dir) !== storage.dir && (
            <p className={hint} data-testid="runner-storage-restart">
              {t('settings.runner.storage.restartNote', { dir: storage.dir })}
            </p>
          )}
        </div>
        <SettingLimitField
          key={blobFieldReset}
          label={t('settings.runner.storage.blobCap')}
          hint={t('settings.runner.storage.blobCapHint')}
          value={bytesToGb(config.blobCapBytes)}
          emptyNote=""
          placeholder="50"
          onCommit={(value) =>
            value === null ? setBlobFieldReset((count) => count + 1) : onChange({ blobCapBytes: gbToBytes(value) })
          }
        />
        <div className={card} data-testid="runner-usage">
          {storage.bots.length === 0 ? (
            <p className={hint}>{t('settings.runner.storage.none')}</p>
          ) : (
            <>
              <p className="text-[12px] text-foreground">
                {t('settings.runner.storage.usage', {
                  files: files(storage.blobBytes),
                  caches: files(storage.cacheBytes),
                })}
              </p>
              <ul className="flex flex-col divide-y divide-border">
                {storage.bots.map((bot) => (
                  <li
                    key={bot.scope}
                    data-testid="runner-usage-bot"
                    className="flex flex-wrap items-center justify-between gap-2 py-1.5 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-foreground">
                        {bot.botId
                          ? t('settings.runner.storage.botOnServer', {
                              bot: bot.botName ?? bot.botId,
                              server: bot.serverName ?? '',
                            })
                          : t('settings.runner.storage.unknownBot')}
                      </div>
                      <div className={hint}>
                        {t('settings.runner.storage.perBot', {
                          files: files(bot.blobBytes),
                          caches: files(bot.cacheBytes),
                        })}
                      </div>
                    </div>
                    {bot.serverId && bot.botId && bot.cacheBytes > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 text-[12px]"
                        disabled={busy}
                        onClick={() => onClearCaches({ serverId: bot.serverId as string, botId: bot.botId as string })}
                      >
                        <Trash2 className="size-3.5" />
                        {t('settings.runner.storage.clearBot')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-[12px]"
              disabled={busy || storage.cacheBytes === 0}
              data-testid="runner-clear-caches"
              onClick={() => onClearCaches()}
            >
              <Trash2 className="size-3.5" />
              {t('settings.runner.storage.clearCaches')}
            </Button>
            <p className={cn(hint, 'min-w-0 flex-1')}>{t('settings.runner.storage.clearHint')}</p>
          </div>
        </div>
      </section>

      {(config.enabled || status.jobs.length > 0) && (
        <section className="flex flex-col gap-3" aria-labelledby="runner-jobs-heading">
          <h3 id="runner-jobs-heading" className={heading}>
            {t('settings.runner.jobs.title')}
          </h3>
          {status.jobs.length === 0 ? (
            <p className={hint} data-testid="runner-jobs-empty">
              {t('settings.runner.jobs.empty')}
            </p>
          ) : (
            <ul className={cn(card, 'divide-y divide-border')} data-testid="runner-jobs">
              {status.jobs.map((job) => (
                <li
                  key={`${job.serverId}:${job.jobId}`}
                  data-testid="runner-job"
                  data-job-id={job.jobId}
                  className="flex flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="truncate text-[12px] font-medium text-foreground">
                      {t('settings.runner.jobs.bot', {
                        bot: job.botName ?? t('settings.runner.jobs.unknownBot'),
                        server: job.serverName,
                      })}
                    </div>
                    <code className="truncate text-[11px] text-muted-foreground" title={job.command}>
                      {job.command}
                    </code>
                  </div>
                  <div className="flex shrink-0 flex-col items-end text-[11px] text-muted-foreground">
                    <span>{t(`settings.runner.jobs.phase.${job.phase}`)}</span>
                    <span className="tabular-nums">{jobDuration(now - job.startedAt)}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => openLog(job)}>
                      {t('settings.runner.jobs.log')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[12px]"
                      disabled={cancelling.has(job.jobId)}
                      onClick={() => onCancelJob(job)}
                    >
                      {cancelling.has(job.jobId) && <Loader2 className="mr-1 size-3 animate-spin" />}
                      {t(cancelling.has(job.jobId) ? 'settings.runner.jobs.cancelling' : 'settings.runner.jobs.cancel')}
                    </Button>
                  </div>
                  {job.usage && <RunnerUsage usage={job.usage} cpus={cpus} className="basis-full" />}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(config.enabled || status.history.length > 0) && (
        <section className="flex flex-col gap-3" aria-labelledby="runner-history-heading">
          <div>
            <h3 id="runner-history-heading" className={heading}>
              {t('settings.runner.history.title')}
            </h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.runner.history.desc')}</p>
          </div>
          {status.history.length === 0 ? (
            <p className={hint} data-testid="runner-history-empty">
              {t('settings.runner.history.empty')}
            </p>
          ) : (
            <ul
              className={cn(card, 'max-h-[28rem] gap-0 divide-y divide-border overflow-y-auto')}
              data-testid="runner-history"
            >
              {status.history.map((entry) => (
                <li
                  key={`${entry.serverId}:${entry.jobId}`}
                  data-testid="runner-history-job"
                  data-job-id={entry.jobId}
                  data-outcome={entry.outcome}
                  className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2 first:pt-0 last:pb-0"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-[12px] font-medium text-foreground">{botOnServer(entry)}</span>
                      <span
                        className={cn(
                          'shrink-0 text-[11px] font-medium',
                          entry.outcome === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                        )}
                      >
                        {t(`settings.runner.history.outcome.${entry.outcome}`)}
                      </span>
                    </div>
                    <code className="truncate text-[11px] text-muted-foreground" title={entry.command}>
                      {entry.command}
                    </code>
                    {(entry.error || (entry.outcome !== 'succeeded' && entry.exitCode !== null)) && (
                      <span className="break-words text-[11px] text-muted-foreground">
                        {entry.error?.message ?? t('settings.runner.history.exitCode', { code: entry.exitCode })}
                      </span>
                    )}
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {[
                        when(entry.endedAt),
                        t('settings.runner.history.took', { time: jobDuration(entry.endedAt - entry.startedAt) }),
                        entry.peakMemoryBytes !== null &&
                          t('settings.runner.history.peakMemory', { memory: files(entry.peakMemoryBytes) }),
                        entry.cpuSeconds !== null &&
                          t('settings.runner.history.cpuTime', { time: jobDuration(entry.cpuSeconds * 1000) }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={() => openLog(entry)}>
                    {t('settings.runner.jobs.log')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-1.5 break-words text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {logOf && (
        <RunnerLogDialog
          title={tf('botSettings.runners.log.title')}
          subtitle={`${t('settings.runner.jobs.bot', { bot: logOf.bot, server: logOf.server })} · ${logOf.command}`}
          jobId={logOf.jobId}
          live={logLive}
          read={(offset) => window.api.runnerJobLog(logOf.serverId, logOf.jobId, offset)}
          onClose={() => setLogOf(null)}
        />
      )}
    </section>
  )
}
