import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, FolderLock, Network, RotateCcw } from 'lucide-react'
import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { fleetErrorText } from '@/lib/fleet/errors'
import { isWorkspacesEnvironment } from '@/lib/fleet/selectors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { EnvironmentConfirmKind } from './EnvironmentConfirm'

/**
 * What a workspaces environment shares with the rest of its server: its network and its server folder, and whether its
 * container still runs with older ones. Its accounts, keys, site logins and conversations are always its own.
 */
export function EnvironmentIsolation({
  environment,
  fleet,
  onConfirm,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  onConfirm: (kind: EnvironmentConfirmKind) => void
}) {
  const serverId = fleet.serverId
  const { t } = useTranslation('fleet')
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const isolation = environment.isolation
  if (!isolation) return null
  const others = fleet.state.snapshot.environments.filter(
    (other) => other.id !== environment.id && isWorkspacesEnvironment(other)
  ).length
  const { folder } = isolation
  async function moveToOwnFolder() {
    setBusy(true)
    setError('')
    try {
      const updated = await window.api.fleetPatchEnvironment(serverId, environment.id, { hostFolder: 'own' })
      fleet.dispatch({
        type: 'event',
        value: { type: 'environment.updated', at: new Date().toISOString(), environment: updated },
      })
      setAsking(false)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-labelledby="fleet-environment-isolation" data-environment-isolation>
      <h2 id="fleet-environment-isolation" className="mb-3 text-[15px] font-semibold">
        {t('workspaces.isolation.title')}
      </h2>
      <div className="space-y-3.5 rounded-xl border border-border p-4 text-[12.5px]">
        {isolation.restartRequired && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-300/30 bg-amber-300/[0.06] px-3 py-2.5"
          >
            <p className="min-w-48 flex-1 text-amber-200">{t('workspaces.isolation.restartRequired')}</p>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={environment.lifecycle !== 'running'}
              onClick={() => onConfirm('restart')}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t('environment.restartButton')}
            </Button>
          </div>
        )}
        <div className="flex gap-3">
          <Network aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <h3 className="font-medium text-foreground/90">{t('workspaces.isolation.network')}</h3>
            <p className="text-muted-foreground">
              {t(
                isolation.network === 'own' ? 'workspaces.isolation.networkOwn' : 'workspaces.isolation.networkShared'
              )}
            </p>
          </div>
        </div>
        <div className="flex gap-3 border-t border-border pt-3.5">
          <FolderLock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <h3 className="font-medium text-foreground/90">{t('workspaces.isolation.folder')}</h3>
            {folder.path && (
              <p className="break-all font-mono text-[12px] text-foreground/75" data-host-folder={folder.mode}>
                {folder.path}
              </p>
            )}
            <p className="text-muted-foreground">
              {t(
                folder.mode === 'own'
                  ? 'workspaces.isolation.folderOwn'
                  : folder.mode === 'shared'
                    ? 'workspaces.isolation.folderShared'
                    : 'workspaces.isolation.folderNone'
              )}
            </p>
            {folder.mode === 'shared' && (
              <>
                {others > 0 && (
                  <p className="flex items-start gap-1.5 text-amber-200">
                    <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    {t('workspaces.isolation.folderSharedWarning', { count: others })}
                  </p>
                )}
                <Button size="sm" variant="outline" className="h-7" onClick={() => setAsking(true)}>
                  {t('workspaces.isolation.useOwnFolder')}
                </Button>
              </>
            )}
          </div>
        </div>
        <p className="border-t border-border pt-3.5 text-muted-foreground">{t('workspaces.isolation.always')}</p>
        {error && !asking && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      {asking && (
        <ConfirmDialog
          title={t('workspaces.isolation.useOwnFolderTitle', { name: environment.name })}
          message={t('workspaces.isolation.useOwnFolderMessage', {
            path: (folder.path ?? '').replace(/\/+$/, '') + '/' + environment.id,
            root: folder.path ?? '',
          })}
          confirmLabel={t('workspaces.isolation.useOwnFolderConfirm')}
          busy={busy}
          error={error || null}
          onCancel={() => {
            setAsking(false)
            setError('')
          }}
          onConfirm={() => void moveToOwnFolder()}
        />
      )}
    </section>
  )
}
