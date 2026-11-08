import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle, XCircle } from 'lucide-react'
import { type FleetBackupStatus, isFleetBackupEvent } from '@maestrly/bot-fleet-protocol'
import type { FleetBackupApi } from '../../../../shared/fleet-backup'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { type BackupRowView, backupReducer, backupRowView } from '@/lib/fleet/backup'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { diskSize } from '@/lib/fleet/format'
import { bindFleetServer, useFleetServerId } from '@/lib/fleet/server-context'
import { cn } from '@/lib/utils'
import { BackupSetupDialog } from './BackupSetupDialog'
import { RecoveryKeyStep } from './RecoveryKeyStep'
import { RestoreBackupDialog } from './RestoreBackupDialog'

export type BackupsSectionState =
  | { kind: 'loading' }
  | { kind: 'old' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: FleetBackupStatus }

export interface BackupsSectionViewProps {
  state: BackupsSectionState
  environmentNames: Record<string, string>
  /** Runs asked for that the server has not answered yet, by environment. */
  pending: ReadonlySet<string>
  onRetry: () => void
  onSetUp: () => void
  /** Absent until restoring is available. */
  onRestore?: () => void
  onRunNow: (environmentId: string) => void
  onCancel: (runId: string) => void
  onChange: () => void
  onToggle: () => void
  onShowKey: () => void
  onDisconnect: () => void
}

const TONE_ICON: Record<BackupRowView['tone'], typeof CheckCircle2> = {
  ok: CheckCircle2,
  running: Loader2,
  warning: AlertTriangle,
  error: XCircle,
  muted: MinusCircle,
}
const TONE_CLASS: Record<BackupRowView['tone'], string> = {
  ok: 'text-emerald-500',
  running: 'animate-spin text-primary',
  warning: 'text-amber-500',
  error: 'text-destructive',
  muted: 'text-muted-foreground',
}

/** Settings → Bot server → Backups, as its state shows it. */
export function BackupsSectionView(props: BackupsSectionViewProps) {
  const { t, i18n } = useTranslation('fleet')
  const date = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language]
  )
  const formats = { when: (iso: string) => date.format(new Date(iso)), size: diskSize }
  const { state } = props
  const body = (() => {
    if (state.kind === 'old')
      return (
        <p role="status" className="text-xs text-muted-foreground">
          {t('botServer.backups.old')}
        </p>
      )
    if (state.kind === 'loading')
      return (
        <p role="status" className="text-xs text-muted-foreground">
          {t('botServer.backups.loading')}
        </p>
      )
    if (state.kind === 'error')
      return (
        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
          <span>{t('botServer.backups.loadFailed', { error: state.message })}</span>
          <Button size="sm" variant="ghost" onClick={props.onRetry}>
            {t('botServer.backups.retry')}
          </Button>
        </div>
      )
    const { status } = state
    if (!status.destination)
      return (
        <>
          <p className="text-xs text-muted-foreground">{t('botServer.backups.intro')}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={props.onSetUp}>
              {t('botServer.backups.setUp')}
            </Button>
            {props.onRestore && (
              <Button size="sm" variant="outline" onClick={props.onRestore}>
                {t('botServer.backups.restore')}
              </Button>
            )}
          </div>
        </>
      )
    const { destination } = status
    const active = new Map(status.active.map((run) => [run.environmentId, run]))
    return (
      <>
        <div className="space-y-0.5 text-xs text-muted-foreground">
          <p>{t('botServer.backups.destination', { label: destination.label })}</p>
          {destination.account && <p>{t('botServer.backups.account', { account: destination.account })}</p>}
          {destination.repositoryBytes !== null && (
            <p>{t('botServer.backups.status.used', { size: diskSize(destination.repositoryBytes) })}</p>
          )}
          {!status.enabled && (
            <p role="status" className="text-amber-500">
              {t('botServer.backups.status.paused')}
            </p>
          )}
        </div>
        <ul className="divide-y divide-border">
          {status.environments.map((row) => {
            const view = backupRowView(row, active.get(row.environmentId) ?? null, formats)
            const Icon = TONE_ICON[view.tone]
            const reason = view.error ? t(view.error.key, view.error.values) : undefined
            return (
              <li key={row.environmentId} className="flex items-center gap-3 py-2">
                <Icon className={cn('size-4 shrink-0', TONE_CLASS[view.tone])} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {props.environmentNames[row.environmentId] ?? row.environmentId}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(view.key, { ...view.values, ...(reason === undefined ? {} : { reason }) })}
                  </p>
                  {view.next && status.enabled && (
                    <p className="text-xs text-muted-foreground">{t(view.next.key, view.next.values)}</p>
                  )}
                  {view.running && (
                    <div
                      className="mt-1 h-1 overflow-hidden rounded bg-muted"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round((view.running.progress ?? 0) * 100)}
                    >
                      <div
                        className="h-full bg-primary transition-[width]"
                        style={{ width: `${Math.round((view.running.progress ?? 0) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
                {view.running ? (
                  <Button size="sm" variant="ghost" onClick={() => props.onCancel(view.running!.runId)}>
                    {t('botServer.backups.actions.cancel')}
                  </Button>
                ) : (
                  row.included &&
                  row.eligibility === 'ok' && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={props.pending.has(row.environmentId)}
                      onClick={() => props.onRunNow(row.environmentId)}
                    >
                      {t('botServer.backups.actions.runNow')}
                    </Button>
                  )
                )}
              </li>
            )
          })}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={props.onChange}>
            {t('botServer.backups.actions.change')}
          </Button>
          <Button size="sm" variant="outline" onClick={props.onToggle}>
            {status.enabled
              ? t('botServer.backups.actions.pause')
              : status.schedule
                ? t('botServer.backups.actions.resume')
                : t('botServer.backups.actions.turnOn')}
          </Button>
          {props.onRestore && (
            <Button size="sm" variant="outline" onClick={props.onRestore}>
              {t('botServer.backups.restore')}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={props.onShowKey}>
            {t('botServer.backups.key.show')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={props.onDisconnect}
          >
            {t('botServer.backups.actions.disconnect')}
          </Button>
        </div>
      </>
    )
  })()
  return (
    <section aria-labelledby="bot-server-backups" className="space-y-2 rounded-lg border border-border p-4">
      <h3 id="bot-server-backups" className="font-semibold">
        {t('botServer.backups.title')}
      </h3>
      {body}
    </section>
  )
}

/** The server's backups: loaded once, then kept current by its backup events. */
export function BackupsSection() {
  const serverId = useFleetServerId()
  const { t } = useTranslation('fleet')
  const api = useMemo(() => bindFleetServer(window.api.fleetBackup, serverId) as FleetBackupApi, [serverId])
  const [state, setState] = useState<BackupsSectionState>({ kind: 'loading' })
  const [names, setNames] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [dialog, setDialog] = useState<'setup' | 'change' | 'restore' | 'key' | 'disconnect' | null>(null)
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const readNames = useCallback(async () => {
    try {
      const snapshot = await window.api.fleetGetSnapshot(serverId)
      setNames(Object.fromEntries(snapshot.environments.map((environment) => [environment.id, environment.name])))
    } catch {
      /* The ids show instead. */
    }
  }, [serverId])
  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const status = await api.status()
      setState(status ? { kind: 'ready', status } : { kind: 'old' })
      void readNames()
    } catch (cause) {
      setState({ kind: 'error', message: fleetErrorMessage(cause) })
    }
  }, [api, readNames])
  useEffect(() => {
    void load()
    return window.api.onFleetEvent((from, event) => {
      if (from !== serverId || !isFleetBackupEvent(event)) return
      setState((current) => {
        if (current.kind !== 'ready')
          return event.type === 'backup.updated' ? { kind: 'ready', status: event.status } : current
        const status = backupReducer(current.status, event)
        return status ? { kind: 'ready', status } : current
      })
      if (event.type === 'backup.updated') void readNames()
    })
  }, [load, readNames, serverId])

  const status = state.kind === 'ready' ? state.status : null
  const setStatus = (next: FleetBackupStatus) => setState({ kind: 'ready', status: next })
  const act = async (action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    }
  }
  const runNow = (environmentId: string) => {
    setPending((current) => new Set([...current, environmentId]))
    void act(async () => {
      await api.runNow(environmentId)
    }).finally(() => setPending((current) => new Set([...current].filter((id) => id !== environmentId))))
  }
  const toggle = () => {
    if (!status) return
    if (!status.enabled && !status.schedule) return setDialog('change')
    void act(async () => setStatus(await api.update({ enabled: !status.enabled })))
  }
  const showKey = () =>
    void act(async () => {
      setRecoveryKey(await api.recoveryKey())
      setDialog('key')
    })
  const disconnect = async () => {
    setBusy(true)
    await act(async () => {
      setStatus(await api.disconnect())
      setDialog(null)
    })
    setBusy(false)
  }

  return (
    <>
      <BackupsSectionView
        state={state}
        environmentNames={names}
        pending={pending}
        onRetry={() => void load()}
        onSetUp={() => setDialog('setup')}
        onRestore={() => setDialog('restore')}
        onRunNow={runNow}
        onCancel={(runId) => void act(async () => void (await api.cancel(runId)))}
        onChange={() => setDialog('change')}
        onToggle={toggle}
        onShowKey={showKey}
        onDisconnect={() => setDialog('disconnect')}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {status && (dialog === 'setup' || dialog === 'change') && (
        <BackupSetupDialog
          api={api}
          status={status}
          environmentNames={names}
          change={dialog === 'change'}
          onClose={() => setDialog(null)}
          onStatus={setStatus}
        />
      )}
      {status && dialog === 'restore' && (
        <RestoreBackupDialog
          api={api}
          serverId={serverId}
          status={status}
          onClose={() => setDialog(null)}
          onStatus={setStatus}
        />
      )}
      {dialog === 'key' && recoveryKey && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('botServer.backups.key.title')}</DialogTitle>
            </DialogHeader>
            <RecoveryKeyStep recoveryKey={recoveryKey} savedOnThisComputer onSave={() => api.exportRecoveryKey()} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog(null)}>
                {t('botServer.backups.key.close')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {dialog === 'disconnect' && status?.destination && (
        <ConfirmDialog
          title={t('botServer.backups.disconnectTitle')}
          message={t('botServer.backups.disconnectConfirm', { label: status.destination.label })}
          confirmLabel={t('botServer.backups.actions.disconnect')}
          destructive
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => void disconnect()}
        />
      )}
    </>
  )
}
