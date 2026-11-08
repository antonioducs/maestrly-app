import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type FleetBackupRestorePreview,
  type FleetBackupRun,
  type FleetBackupSnapshotGroup,
  type FleetBackupStatus,
  isFleetBackupEvent,
} from '@maestrly/bot-fleet-protocol'
import type { FleetBackupApi, FleetBackupDestinationDraft } from '../../../../shared/fleet-backup'
import type { FleetServerId } from '../../../../shared/fleet-servers'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { backupErrorText, backupRunFinished, restoreGroupView, restoreProblemKeys } from '@/lib/fleet/backup'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { cn } from '@/lib/utils'
import { BackupDestinationStep, ExistingKeyStep } from './BackupSetupDialog'

type Step =
  | { kind: 'where'; noBackup: boolean }
  | { kind: 'key'; draft: FleetBackupDestinationDraft; hasSavedKey: boolean }
  | { kind: 'list' }

/**
 * Restores an environment from a backup, as a new environment with its ids. A server without a destination connects to
 * one that holds backups first, with its recovery key.
 */
export function RestoreBackupDialog({
  api,
  serverId,
  status,
  onClose,
  onStatus,
}: {
  api: FleetBackupApi
  serverId: FleetServerId
  status: FleetBackupStatus
  onClose: () => void
  onStatus: (status: FleetBackupStatus) => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const date = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language]
  )
  const [step, setStep] = useState<Step>(status.destination ? { kind: 'list' } : { kind: 'where', noBackup: false })
  const [groups, setGroups] = useState<FleetBackupSnapshotGroup[] | null>(null)
  const [group, setGroup] = useState<FleetBackupSnapshotGroup | null>(null)
  const [snapshotId, setSnapshotId] = useState<string | null>(null)
  const [preview, setPreview] = useState<FleetBackupRestorePreview | null>(null)
  const [keep, setKeep] = useState(false)
  const [run, setRun] = useState<FleetBackupRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (step.kind !== 'list' || groups) return
    let current = true
    api
      .snapshots()
      .then((response) => current && setGroups(response.environments))
      .catch((cause) => current && setError(fleetErrorMessage(cause)))
    return () => {
      current = false
    }
  }, [api, groups, step.kind])
  useEffect(() => {
    if (!snapshotId) return
    let current = true
    setPreview(null)
    setKeep(false)
    api
      .restorePreview(snapshotId)
      .then((next) => current && setPreview(next))
      .catch((cause) => current && setError(fleetErrorMessage(cause)))
    return () => {
      current = false
    }
  }, [api, snapshotId])
  // The restore runs on the server: its events tell how it goes.
  const runId = run && !backupRunFinished(run) ? run.id : null
  const runEnvironment = run?.environmentId ?? null
  useEffect(() => {
    if (!runId || !runEnvironment) return
    const off = window.api.onFleetEvent((from, event) => {
      if (
        from === serverId &&
        isFleetBackupEvent(event) &&
        event.type === 'backup_run.updated' &&
        event.run.id === runId
      )
        setRun(event.run)
    })
    // One that ended before this listened is read back.
    void api
      .runs(runEnvironment)
      .then((runs) => {
        const found = runs.find((item) => item.id === runId)
        if (found && backupRunFinished(found)) setRun(found)
      })
      .catch(() => undefined)
    return off
  }, [api, runEnvironment, runId, serverId])

  const choose = (next: FleetBackupSnapshotGroup) => {
    setError(null)
    setGroup(next)
    setSnapshotId(next.snapshots[0]?.id ?? null)
  }
  const restore = async () => {
    if (!snapshotId) return
    setBusy(true)
    setError(null)
    try {
      setRun(await api.restore({ snapshotId, keepExistingProjects: keep }))
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const problems = preview ? restoreProblemKeys(preview) : []
  const needsKeep = preview?.projects?.state === 'not-empty'
  const restoring = run !== null && !backupRunFinished(run)
  const runError =
    run && (run.state === 'failed' || run.state === 'cancelled') && run.error ? backupErrorText(run.error) : null

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('botServer.backups.restoreDialog.title')}</DialogTitle>
          <DialogDescription>{t('botServer.backups.restoreDialog.description')}</DialogDescription>
        </DialogHeader>
        {step.kind === 'where' && (
          <>
            <BackupDestinationStep
              api={api}
              onProbed={(draft, result) => {
                if (result.state === 'empty') return setStep({ kind: 'where', noBackup: true })
                void api
                  .hasSavedKey(draft)
                  .catch(() => false)
                  .then((hasSavedKey) => setStep({ kind: 'key', draft, hasSavedKey }))
              }}
            />
            {step.noBackup && (
              <p role="alert" className="text-xs text-amber-500">
                {t('botServer.backups.restoreDialog.noBackupHere')}
              </p>
            )}
          </>
        )}
        {step.kind === 'key' && (
          <ExistingKeyStep
            api={api}
            draft={step.draft}
            hasSavedKey={step.hasSavedKey}
            onConnected={(next) => {
              onStatus(next)
              setStep({ kind: 'list' })
            }}
          />
        )}
        {step.kind === 'list' && !run && (
          <div className="space-y-3">
            {groups === null && !error && (
              <p role="status" className="text-xs text-muted-foreground">
                {t('botServer.backups.restoreDialog.loading')}
              </p>
            )}
            {groups?.length === 0 && (
              <p role="status" className="text-xs text-muted-foreground">
                {t('botServer.backups.restoreDialog.none')}
              </p>
            )}
            {groups && groups.length > 0 && (
              <ul className="space-y-1" aria-label={t('botServer.backups.restoreDialog.choose')}>
                {groups.map((item) => {
                  const view = restoreGroupView(item)
                  const selected = group?.environmentId === item.environmentId && group.serverId === item.serverId
                  return (
                    <li key={item.environmentId + '/' + item.serverId}>
                      <button
                        type="button"
                        disabled={view.disabled}
                        aria-pressed={selected}
                        className={cn(
                          'w-full rounded-md border p-2 text-left disabled:cursor-not-allowed disabled:opacity-60',
                          selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                        )}
                        onClick={() => choose(item)}
                      >
                        <span className="block text-sm font-medium">
                          {item.name} · {t(`botServer.backups.restoreDialog.kind.${item.kind}`)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {[
                            view.latest &&
                              t('botServer.backups.restoreDialog.latest', {
                                when: date.format(new Date(view.latest.at)),
                              }),
                            view.from && t(view.from.key, view.from.values),
                            view.reason && t(view.reason.key, view.reason.values),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {group && group.snapshots.length > 1 && snapshotId && (
              <label className="block space-y-1 text-sm">
                <span>{t('botServer.backups.restoreDialog.date')}</span>
                <OptionSelect value={snapshotId} onValueChange={setSnapshotId}>
                  {group.snapshots.map((snapshot) => (
                    <SelectOption key={snapshot.id} value={snapshot.id}>
                      {date.format(new Date(snapshot.at))}
                    </SelectOption>
                  ))}
                </OptionSelect>
              </label>
            )}
            {snapshotId && !preview && !error && (
              <p role="status" className="text-xs text-muted-foreground">
                {t('botServer.backups.restoreDialog.reading')}
              </p>
            )}
            {preview && (
              <div className="space-y-2 rounded-md border border-border p-3 text-xs">
                <p>
                  {preview.bots.length
                    ? t('botServer.backups.restoreDialog.bots', {
                        names: preview.bots.map((bot) => bot.name).join(', '),
                      })
                    : t('botServer.backups.restoreDialog.noBots')}
                </p>
                {preview.projects && (
                  <p>{t('botServer.backups.restoreDialog.projects', { path: preview.projects.path })}</p>
                )}
                {problems.map((problem) => (
                  <p key={problem.key} role="alert" className="text-destructive">
                    {t(problem.key, problem.values)}
                  </p>
                ))}
                {needsKeep && preview.projects && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={keep} onChange={(event) => setKeep(event.target.checked)} />
                    {t('botServer.backups.restoreDialog.keepExisting', { path: preview.projects.path })}
                  </label>
                )}
              </div>
            )}
          </div>
        )}
        {run && (
          <div className="space-y-2 text-sm">
            {restoring && (
              <p role="status">
                {t('botServer.backups.restoreDialog.restoring', {
                  percent: Math.round((run.progress ?? 0) * 100),
                })}
              </p>
            )}
            {run.state === 'succeeded' && <p role="status">{t('botServer.backups.restoreDialog.done')}</p>}
            {runError && (
              <p role="alert" className="text-destructive">
                {t(runError.key, runError.values)}
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {step.kind === 'key' && (
            <Button variant="ghost" onClick={() => setStep({ kind: 'where', noBackup: false })}>
              {t('botServer.backups.back')}
            </Button>
          )}
          {step.kind === 'list' && !run && (
            <Button
              disabled={busy || !preview || problems.length > 0 || (needsKeep && !keep)}
              onClick={() => void restore()}
            >
              {t('botServer.backups.restoreDialog.restore')}
            </Button>
          )}
          {run && !restoring && (
            <Button variant="outline" onClick={onClose}>
              {t('botServer.backups.key.close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
