import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { FleetArchivedEnvironment } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { formatNames } from '@/lib/fleet/environments'
import type { FleetController } from '@/lib/fleet/use-fleet'

/** Archived environments: restore one with its bots on its kept files, or delete it and its bots forever. */
export function ArchivedEnvironments({ fleet }: { fleet: FleetController }) {
  const { t, i18n } = useTranslation('fleet')
  const [environments, setEnvironments] = useState<FleetArchivedEnvironment[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<FleetArchivedEnvironment | null>(null)
  const [typedName, setTypedName] = useState('')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  // Another Mac may archive or restore an environment: a change in the active list is the cue to reload this one.
  const activeCount = fleet.state.snapshot.environments.length
  useEffect(() => {
    let alive = true
    void window.api
      .fleetListArchivedEnvironments()
      .then((result) => alive && setEnvironments(result.environments))
      .catch((cause) => alive && setError(fleetErrorMessage(cause)))
    return () => {
      alive = false
    }
  }, [activeCount, revision])
  const reload = () => setRevision((value) => value + 1)
  async function restore(environment: FleetArchivedEnvironment) {
    setBusy(environment.id)
    setError('')
    try {
      const restored = await window.api.fleetRestoreArchivedEnvironment(environment.id)
      fleet.dispatch({
        type: 'event',
        value: { type: 'environment.updated', at: new Date().toISOString(), environment: restored },
      })
      setEnvironments((current) => current?.filter((item) => item.id !== environment.id) ?? null)
      // Its bots come back with it: list them without waiting for their events.
      await fleet.refresh()
    } catch (cause) {
      setError(fleetErrorMessage(cause))
      reload()
    } finally {
      setBusy(null)
    }
  }
  async function deleteForever() {
    if (!deleting) return
    setBusy(deleting.id)
    setError('')
    try {
      await window.api.fleetDeleteArchivedEnvironment(deleting.id)
      setEnvironments((current) => current?.filter((item) => item.id !== deleting.id) ?? null)
      setDeleting(null)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
      reload()
    } finally {
      setBusy(null)
    }
  }
  return (
    <section aria-labelledby="fleet-archived-environments-heading">
      <h2 id="fleet-archived-environments-heading" className="font-semibold">
        {t('server.archivedEnvironments.title')}
      </h2>
      <p className="mb-3 mt-1 text-xs text-muted-foreground">{t('server.archivedEnvironments.description')}</p>
      {environments === null ? (
        !error && <p className="text-xs text-muted-foreground">{t('server.archived.loading')}</p>
      ) : environments.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('server.archivedEnvironments.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-elevated">
          {environments.map((environment) => (
            <li key={environment.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{environment.name}</div>
                {environment.bots.length > 0 && (
                  <div className="truncate text-xs text-muted-foreground">
                    {t('server.archivedEnvironments.bots', {
                      bots: formatNames(
                        environment.bots.map((bot) => bot.name),
                        i18n.language
                      ),
                    })}
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  {t('server.archived.archivedAt', {
                    date: new Date(environment.archivedAt).toLocaleDateString(i18n.language, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    }),
                  })}{' '}
                  ·{' '}
                  {environment.files === 'kept' ? (
                    t('server.archived.filesKept')
                  ) : (
                    <span className="text-amber-500">{t('server.archived.filesMissing')}</span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  aria-label={t('server.archived.restoreLabel', { name: environment.name })}
                  onClick={() => void restore(environment)}
                >
                  {busy === environment.id && !deleting && <Loader2 className="animate-spin" />}
                  {t('server.archived.restore')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy !== null}
                  aria-label={t('server.archived.deleteLabel', { name: environment.name })}
                  onClick={() => {
                    setTypedName('')
                    setDeleting(environment)
                  }}
                >
                  {t('server.archived.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('server.archived.deleteTitle', { name: deleting?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('server.archivedEnvironments.deleteDescription', { name: deleting?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          {/* Typing the name keeps an irreversible delete from being one Enter away. */}
          <label className="block text-sm">
            {t('server.archived.deleteConfirmLabel', { name: deleting?.name ?? '' })}
            <Input
              className="mt-1"
              value={typedName}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTypedName(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" disabled={busy !== null} onClick={() => setDeleting(null)}>
              {t('server.archived.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== null || typedName.trim() !== deleting?.name}
              onClick={() => void deleteForever()}
            >
              {busy !== null && <Loader2 className="animate-spin" />}
              {t('server.archived.deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
