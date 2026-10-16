import { useCallback, useEffect, useState } from 'react'
import { version as desktopVersion } from '../../../../package.json'
import { useTranslation } from 'react-i18next'
import {
  FLEET_ENVIRONMENT_LIMITS,
  FLEET_WORKSPACES_ENVIRONMENTS_FEATURE,
  FLEET_WORKSPACES_HOST_FEATURE,
  type FleetBot,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { gb, memorySegments } from '@/lib/fleet/format'
import { formatUptime } from '@/lib/fleet/forms'
import {
  botsWithDifferentVersion,
  groupBotsByEnvironment,
  isWorkspacesEnvironment,
  workspacesEnvironments,
} from '@/lib/fleet/selectors'
import { environmentBots, formatNames, hasEnvironments } from '@/lib/fleet/environments'
import { fleetErrorText } from '@/lib/fleet/errors'
import { useFleetInstaller } from '@/lib/fleet/use-fleet-installer'
import { ArchivedBots } from './ArchivedBots'
import { ArchivedEnvironments } from './ArchivedEnvironments'
import { BotUpdateBanner } from './BotUpdateBanner'
import { CreateWorkspacesDialog } from './CreateWorkspacesDialog'

function ResourceBar({ label, fraction, value }: { label: string; fraction: number; value: string }) {
  return (
    <div className="grid grid-cols-[90px_1fr_auto] items-center gap-3 text-sm">
      <span>{label}</span>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full bg-primary" style={{ width: `${Math.min(100, fraction * 100)}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{value}</span>
    </div>
  )
}

function Uptime({ startedAt }: { startedAt: string | null }) {
  const { t } = useTranslation('fleet')
  if (!startedAt) return '—'
  const duration = formatUptime(Date.now() - Date.parse(startedAt))
  return t(duration.long ? 'server.uptimeDays' : 'server.uptimeValue', duration)
}

function BotRow({
  bot,
  onOpenBot,
  onAction,
}: {
  bot: FleetBot
  onOpenBot: (id: string) => void
  onAction: (action: 'restart' | 'stop' | 'start') => void
}) {
  const { t } = useTranslation('fleet')
  return (
    <tr className="border-t border-border">
      <td className="p-3">
        <button type="button" className="text-primary hover:underline" onClick={() => onOpenBot(bot.id)}>
          {bot.name}
        </button>
      </td>
      <td className="p-3">{t(`status.${bot.status}`)}</td>
      <td className="p-3">{bot.resources.memoryBytes === null ? '—' : `${gb(bot.resources.memoryBytes)} GB`}</td>
      <td className="p-3">{bot.resources.cpuPercent === null ? '—' : `${Math.round(bot.resources.cpuPercent)}%`}</td>
      <td className="p-3">
        <Uptime startedAt={bot.resources.startedAt} />
      </td>
      <td className="p-3">
        <div className="flex flex-nowrap gap-2 whitespace-nowrap">
          {(['restart', 'stop', 'start'] as const).map((action) => (
            <button
              key={action}
              type="button"
              disabled={
                action === 'start' ? bot.status !== 'offline' : bot.status === 'offline' || bot.status === 'human'
              }
              onClick={() => onAction(action)}
              className="text-primary disabled:opacity-40"
            >
              {t(`action.${action}`)}
            </button>
          ))}
        </div>
      </td>
    </tr>
  )
}

/** An environment's row, with its resources and lifecycle, and its bots under it (their resources are its own). */
function EnvironmentRows({
  environment,
  bots,
  onOpenEnvironment,
  onOpenBot,
  onAction,
}: {
  environment: FleetEnvironment
  bots: FleetBot[]
  onOpenEnvironment: (id: string) => void
  onOpenBot: (id: string) => void
  onAction: (action: 'restart' | 'stop' | 'start') => void
}) {
  const { t } = useTranslation('fleet')
  const { memoryBytes, cpuPercent, startedAt } = environment.resources
  const running = environment.lifecycle === 'running'
  const stopped = environment.lifecycle === 'stopped' || environment.lifecycle === 'failed'
  return (
    <>
      <tr className="border-t border-border">
        <td className="p-3">
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={() => onOpenEnvironment(environment.id)}
          >
            {environment.name}
          </button>
          <span className="ml-2 text-xs text-muted-foreground">
            {t('environment.botCount', { count: environment.botIds.length })}
          </span>
        </td>
        <td className="p-3">{t(`environment.lifecycle.${environment.lifecycle}`)}</td>
        <td className="p-3">{memoryBytes === null ? '—' : `${gb(memoryBytes)} GB`}</td>
        <td className="p-3">{cpuPercent === null ? '—' : `${Math.round(cpuPercent)}%`}</td>
        <td className="p-3">
          <Uptime startedAt={startedAt} />
        </td>
        <td className="p-3">
          <div className="flex flex-nowrap gap-2 whitespace-nowrap">
            {(['restart', 'stop', 'start'] as const).map((action) => (
              <button
                key={action}
                type="button"
                disabled={action === 'start' ? !stopped : !running}
                onClick={() => onAction(action)}
                className="text-primary disabled:opacity-40"
              >
                {t(`action.${action}`)}
              </button>
            ))}
          </div>
        </td>
      </tr>
      {bots.map((bot) => (
        <tr key={bot.id} className="border-t border-border/60 text-muted-foreground">
          <td className="p-3 pl-8">
            <button type="button" className="text-primary hover:underline" onClick={() => onOpenBot(bot.id)}>
              {bot.name}
            </button>
          </td>
          <td className="p-3">{t(`status.${bot.status}`)}</td>
          {[0, 1, 2].map((cell) => (
            <td key={cell} className="p-3" title={t('server.measuredByEnvironment')}>
              —
            </td>
          ))}
          <td className="p-3" />
        </tr>
      ))}
    </>
  )
}

/** A workspaces environment on the Server page: its color and name, its state, and what can be done with it. */
function WorkspacesRow({
  environment,
  onStart,
  onConfirm,
  onOpen,
}: {
  environment: FleetEnvironment
  onStart: () => void
  onConfirm: (action: 'restart' | 'stop') => void
  onOpen: () => void
}) {
  const { t } = useTranslation('fleet')
  const stopped = environment.lifecycle === 'stopped' || environment.lifecycle === 'failed'
  const running = environment.lifecycle === 'running'
  return (
    <li
      data-workspaces-environment={environment.id}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border py-3 text-sm first:border-t-0 first:pt-0 last:pb-0"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full bg-muted-foreground"
          style={environment.tint ? { backgroundColor: environment.tint } : undefined}
        />
        <button type="button" className="truncate font-medium text-primary hover:underline" onClick={onOpen}>
          {environment.name}
        </button>
      </span>
      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
        {t(`environment.lifecycle.${environment.lifecycle}`)}
      </span>
      <span className="text-xs text-muted-foreground">
        {t('server.memory')}{' '}
        {environment.resources.memoryBytes === null ? '—' : `${gb(environment.resources.memoryBytes)} GB`} ·{' '}
        {t('server.uptime')} <Uptime startedAt={environment.resources.startedAt} />
      </span>
      {environment.isolation?.restartRequired && (
        <span className="text-xs text-amber-300">{t('workspaces.isolation.restartShort')}</span>
      )}
      <div className="ml-auto flex flex-wrap gap-2">
        {stopped ? (
          <Button size="sm" onClick={onStart}>
            {t('action.start')}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="outline" disabled={!running} onClick={() => onConfirm('restart')}>
              {t('action.restart')}
            </Button>
            <Button size="sm" variant="outline" disabled={!running} onClick={() => onConfirm('stop')}>
              {t('action.stop')}
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onOpen}>
          {t('workspaces.manage')}
        </Button>
      </div>
    </li>
  )
}

export function ServerView({
  fleet,
  onOpenBot,
  onOpenEnvironment,
}: {
  fleet: FleetController
  onOpenBot: (id: string) => void
  onOpenEnvironment: (id: string) => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const { host, bots, environments } = fleet.state.snapshot
  const { status: installer } = useFleetInstaller()
  const runsHere = installer?.record?.mode === 'local'
  // With environments, rows are environments (their resources counted once) with their bots under them.
  const grouped = hasEnvironments(fleet.state.connection) ? groupBotsByEnvironment(environments, bots) : null
  const [confirm, setConfirm] = useState<{ environment: FleetEnvironment; action: 'restart' | 'stop' } | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  // Stable: the dialog refocuses on a new callback, and this view re-renders with every resource sample.
  const cancelConfirm = useCallback(() => setConfirm(null), [])
  const [version, setVersion] = useState(desktopVersion)
  // The server's chats and workspaces: environments of their own kind, one per scope of the owner's work, shown apart
  // from the ones bots run in.
  const workspaces = grouped ? workspacesEnvironments(environments) : []
  const workspacesSupported = fleet.state.connection.features.includes(FLEET_WORKSPACES_HOST_FEATURE)
  // A server from before scopes hosts one; a full one hosts no more.
  const scoped = fleet.state.connection.features.includes(FLEET_WORKSPACES_ENVIRONMENTS_FEATURE)
  const canAddWorkspaces =
    workspacesSupported &&
    (scoped ? workspaces.length < FLEET_ENVIRONMENT_LIMITS.workspacesMax : workspaces.length === 0)
  const [creatingWorkspaces, setCreatingWorkspaces] = useState(false)
  useEffect(() => {
    void window.api
      .getAppInfo()
      .then((info) => setVersion(info.isPackaged ? info.version : desktopVersion))
      .catch(() => {})
  }, [])
  const memory = memorySegments(host, bots, environments)
  const confirmNames = confirm
    ? formatNames(
        environmentBots(confirm.environment, bots).map((bot) => bot.name),
        i18n.language
      ) || t('environment.noBotsNamed')
    : ''
  async function confirmAction() {
    if (!confirm || confirmBusy) return
    setConfirmBusy(true)
    await fleet.environmentAction(confirm.environment.id, confirm.action)
    setConfirmBusy(false)
    setConfirm(null)
  }
  const uptime = formatUptime((host?.uptimeSeconds ?? 0) * 1000)
  const differentVersions = botsWithDifferentVersion(bots, version)
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-8">
        <header>
          <h1 className="text-xl font-semibold">{t('server.title')}</h1>
          <p className="text-sm text-muted-foreground">{host?.hostname ?? fleet.state.connection.hostname}</p>
        </header>
        <BotUpdateBanner fleet={fleet} />
        {host && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-border bg-surface-elevated p-4">
                <div className="text-xs text-muted-foreground">{t('server.yourMac')}</div>
                <strong>{t(runsHere ? 'server.localTitle' : 'server.canTurnOff')}</strong>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(runsHere ? 'server.localNote' : 'server.macNote')}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface-elevated p-4">
                <div className="text-xs text-muted-foreground">{t('server.server')}</div>
                <strong>{host.hostname}</strong>
                <p className="mt-1 text-xs text-muted-foreground">
                  {host.os} · {host.arch}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface-elevated p-4">
                <div className="text-xs text-muted-foreground">{t('server.uptime')}</div>
                <strong>{t(uptime.long ? 'server.uptimeDays' : 'server.uptimeValue', uptime)}</strong>
                <p className="mt-1 text-xs text-muted-foreground">{host.kernel}</p>
              </div>
              <div className="rounded-lg border border-border bg-surface-elevated p-4">
                <div className="text-xs text-muted-foreground">{t('server.version')}</div>
                <strong>{version || t('server.unknown')}</strong>
                <ul className="mt-1 text-xs text-muted-foreground">
                  {bots.map((bot) => (
                    <li key={bot.id}>
                      {bot.name}: {bot.appVersion ?? t('server.unknown')}
                    </li>
                  ))}
                </ul>
                {differentVersions.length > 0 && (
                  <p className="mt-1 text-xs text-destructive">
                    {t('server.versionMismatch', {
                      bots: differentVersions.map((bot) => `${bot.name} (${bot.appVersion})`).join(', '),
                    })}
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('server.gatewayVersion', { version: host.gatewayVersion })}
                </p>
              </div>
            </div>
            <section>
              <h2 className="mb-3 font-semibold">{t('server.resources')}</h2>
              <div className="space-y-3 rounded-lg border border-border bg-surface-elevated p-4">
                <div className="grid grid-cols-[90px_1fr_auto] items-center gap-3 text-sm">
                  <span>{t('server.memory')}</span>
                  <div
                    className="flex h-2 overflow-hidden rounded-full bg-muted"
                    role="meter"
                    aria-label={t('server.memory')}
                    aria-valuenow={Math.round((host.memory.usedBytes / host.memory.totalBytes) * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    {memory.map((segment) => (
                      <span
                        key={`${segment.kind}:${segment.id}`}
                        style={{
                          width: `${segment.fraction * 100}%`,
                          background: segment.tint,
                        }}
                      />
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {gb(host.memory.usedBytes)} / {gb(host.memory.totalBytes)} GB
                  </span>
                </div>
                <p className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {memory.map((segment) => (
                    <span key={`${segment.kind}:${segment.id}`}>
                      <i className="mr-1 inline-block size-2 rounded-full" style={{ background: segment.tint }} />
                      {segment.kind === 'system' ? t('server.system') : segment.name}
                    </span>
                  ))}
                </p>
                <ResourceBar
                  label={t('server.cpu')}
                  fraction={(host.cpuPercent ?? 0) / 100}
                  value={`${host.cpuPercent === null ? '—' : `${Math.round(host.cpuPercent)}%`} · ${host.cpus} vCPU`}
                />
                <ResourceBar
                  label={t('server.disk')}
                  fraction={host.disk.totalBytes ? host.disk.usedBytes / host.disk.totalBytes : 0}
                  value={`${gb(host.disk.usedBytes)} / ${gb(host.disk.totalBytes)} GB`}
                />
              </div>
            </section>
          </>
        )}
        {grouped && (
          <section aria-labelledby="fleet-server-workspaces" data-testid="server-workspaces">
            <h2 id="fleet-server-workspaces" className="mb-3 font-semibold">
              {t('workspaces.title')}
            </h2>
            <div className="space-y-3 rounded-lg border border-border bg-surface-elevated p-4">
              <p className="text-sm text-muted-foreground">{t('workspaces.description')}</p>
              {workspaces.length > 0 && (
                <ul aria-label={t('workspaces.title')}>
                  {workspaces.map((environment) => (
                    <WorkspacesRow
                      key={environment.id}
                      environment={environment}
                      onStart={() => void fleet.environmentAction(environment.id, 'start')}
                      onConfirm={(action) => setConfirm({ environment, action })}
                      onOpen={() => onOpenEnvironment(environment.id)}
                    />
                  ))}
                </ul>
              )}
              {!workspacesSupported ? (
                <p className="text-xs text-muted-foreground">{t('workspaces.unsupported')}</p>
              ) : canAddWorkspaces ? (
                <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
                  <Button
                    size="sm"
                    variant={workspaces.length ? 'outline' : 'default'}
                    onClick={() => setCreatingWorkspaces(true)}
                  >
                    <Plus aria-hidden="true" />
                    {t(workspaces.length ? 'workspaces.createAnother' : 'workspaces.create')}
                  </Button>
                  <p className="text-xs text-muted-foreground">{t('workspaces.scopesNote')}</p>
                </div>
              ) : (
                <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                  {t(scoped ? 'workspaces.limitReached' : 'workspaces.scopesUnsupported')}
                </p>
              )}
            </div>
          </section>
        )}
        <section>
          <h2 className="mb-3 font-semibold">{grouped ? t('server.environments') : t('server.bots')}</h2>
          <div className="overflow-x-auto rounded-lg border border-border bg-surface-elevated">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-surface-elevated text-xs text-muted-foreground">
                <tr>
                  {['name', 'status', 'memory', 'cpu', 'uptime', 'actions'].map((key) => (
                    <th key={key} className="p-3">
                      {t(`server.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grouped?.groups.map((group) => (
                  <EnvironmentRows
                    key={group.environment.id}
                    environment={group.environment}
                    bots={group.bots}
                    onOpenEnvironment={onOpenEnvironment}
                    onOpenBot={onOpenBot}
                    onAction={(action) =>
                      action === 'start'
                        ? void fleet.environmentAction(group.environment.id, 'start')
                        : setConfirm({ environment: group.environment, action })
                    }
                  />
                ))}
                {(grouped ? grouped.ungrouped : bots).map((bot) => (
                  <BotRow
                    key={bot.id}
                    bot={bot}
                    onOpenBot={onOpenBot}
                    onAction={(action) => void fleet.botAction(bot.id, action)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {grouped && <ArchivedEnvironments fleet={fleet} />}
        <ArchivedBots fleet={fleet} />
        <section>
          <h2 className="mb-2 font-semibold">{t('server.howTitle')}</h2>
          <p className="rounded-lg border border-border bg-surface-elevated p-4 text-sm text-muted-foreground">
            {grouped ? t('server.howDescriptionEnvironments') : t('server.howDescription')}
          </p>
        </section>
        {fleet.actionError && (
          <p role="alert" className="text-xs text-destructive">
            {fleetErrorText(fleet.actionError.message, t)}
          </p>
        )}
      </div>
      {creatingWorkspaces && (
        <CreateWorkspacesDialog
          fleet={fleet}
          onClose={() => setCreatingWorkspaces(false)}
          onCreated={(environment) => {
            setCreatingWorkspaces(false)
            onOpenEnvironment(environment.id)
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={
            confirm.action === 'restart'
              ? t('environment.confirmRestartTitle', { name: confirm.environment.name })
              : t('environment.confirmStopTitle', { name: confirm.environment.name })
          }
          message={
            isWorkspacesEnvironment(confirm.environment)
              ? t(confirm.action === 'restart' ? 'workspaces.confirmRestart' : 'workspaces.confirmStop')
              : confirm.action === 'restart'
                ? t('environment.confirmRestart', { bots: confirmNames })
                : t('environment.confirmStop', { bots: confirmNames })
          }
          confirmLabel={confirm.action === 'restart' ? t('environment.restartButton') : t('environment.stopButton')}
          destructive={confirm.action === 'stop'}
          busy={confirmBusy}
          onCancel={cancelConfirm}
          onConfirm={() => void confirmAction()}
        />
      )}
    </section>
  )
}
