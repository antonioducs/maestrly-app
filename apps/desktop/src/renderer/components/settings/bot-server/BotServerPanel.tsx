import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetInstallerStatus } from '../../../../shared/fleet-installer'
import type { FleetConnectionView } from '../../../../preload/api-fleet'
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
import { panelState } from '@/lib/fleet/installer'
import { PrivateNetworkSwitch } from './PrivateNetworkSwitch'

export function BotServerPanel({
  status,
  connection,
  onAction,
  onDisconnect,
  onRemove,
  onSetupAgain,
}: {
  status: FleetInstallerStatus
  connection: FleetConnectionView
  onAction: (action: 'update' | 'privateNetwork', allow?: boolean) => void
  onDisconnect: () => Promise<void>
  onRemove: () => Promise<void>
  onSetupAgain: () => void
}) {
  const { t } = useTranslation('fleet')
  const panel = panelState(status, connection)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const cancelDisconnect = useCallback(() => setConfirmDisconnect(false), [])
  const runConfirmed = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
      setConfirmDisconnect(false)
      setConfirmRemove(false)
      setTyped('')
    } finally {
      setBusy(false)
    }
  }
  const record = status.record
  const mode = panel.mode
  const title =
    mode === 'local'
      ? t('botServer.choice.localTitle')
      : mode === 'remote'
        ? t('botServer.panel.remoteTitle', { host: record?.remote?.host ?? '' })
        : (connection.url ?? '')
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface-elevated p-4">
        <p className="text-xs text-muted-foreground">{t('botServer.panel.location')}</p>
        <h3 className="mt-1 font-semibold break-all">{title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{t(`connection.${connection.state}`)}</p>
        {connection.error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {connection.error}
          </p>
        )}
        {record && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('botServer.panel.versions', { server: record.version ?? t('server.unknown'), app: status.appVersion })}
          </p>
        )}
      </div>
      {record && (
        <>
          {panel.canUpdate && <Button onClick={() => onAction('update')}>{t('botServer.panel.update')}</Button>}
          {panel.serverNewer && (
            <p className="rounded-md border border-amber-500/40 p-3 text-xs text-amber-500">
              {t('botServer.panel.serverNewer')}
            </p>
          )}
          {mode === 'remote' && status.tunnel === 'reconnecting' && (
            <p role="status" className="text-xs text-muted-foreground">
              {t('botServer.tunnel.reconnecting')}
            </p>
          )}
          {mode === 'remote' && (status.tunnel === 'host-key-changed' || status.tunnel === 'needs-credentials') && (
            <div role="alert" className="space-y-2 rounded-md border border-amber-500/40 p-3 text-xs text-amber-500">
              <p>
                {t(
                  status.tunnel === 'host-key-changed'
                    ? 'botServer.tunnel.hostKeyChanged'
                    : 'botServer.tunnel.signInAgain'
                )}
              </p>
              {status.tunnel === 'host-key-changed' && <p>{t('botServer.tunnel.hostKeyHelp')}</p>}
              <Button variant="outline" size="sm" onClick={onSetupAgain}>
                {t('botServer.panel.setupAgain')}
              </Button>
            </div>
          )}
          <PrivateNetworkSwitch
            mode={record.mode}
            checked={record.allowPrivateNetwork}
            disabled={!panel.canTogglePrivateNetwork}
            onChange={(allow) => onAction('privateNetwork', allow)}
          />
          {status.keyPersistence === 'memory' && mode === 'remote' && (
            <p role="alert" className="rounded-md border border-amber-500/40 p-3 text-xs text-amber-500">
              {t('botServer.panel.memoryKey')}
            </p>
          )}
        </>
      )}
      {connection.tokenPersistence === 'memory' && connection.state !== 'unconfigured' && (
        <p role="alert" className="rounded-md border border-amber-500/40 p-3 text-xs text-amber-500">
          {t('settings.memoryToken')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || panel.busy} onClick={() => setConfirmDisconnect(true)}>
          {record ? t('botServer.panel.disconnect') : t('settings.disconnect')}
        </Button>
        {record && (
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={!panel.canRemove || busy}
            onClick={() => {
              setTyped('')
              setConfirmRemove(true)
            }}
          >
            {t('botServer.panel.remove')}
          </Button>
        )}
      </div>
      {confirmDisconnect && (
        <ConfirmDialog
          title={record ? t('botServer.panel.disconnect') : t('settings.disconnect')}
          message={record ? t(`botServer.panel.disconnectConfirm.${record.mode}`) : t('settings.disconnectConfirm')}
          confirmLabel={record ? t('botServer.panel.disconnect') : t('settings.disconnect')}
          destructive
          busy={busy}
          onCancel={cancelDisconnect}
          onConfirm={() => void runConfirmed(onDisconnect)}
        />
      )}
      <Dialog
        open={confirmRemove}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmRemove(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('botServer.panel.remove')}</DialogTitle>
            <DialogDescription>{t(`botServer.panel.removeConfirm.${record?.mode ?? 'local'}`)}</DialogDescription>
          </DialogHeader>
          <label className="block text-sm">
            {t('botServer.panel.typeRemove', { word: t('botServer.panel.removeWord') })}
            <Input
              className="mt-1"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmRemove(false)}>
              {t('botServer.progress.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy || typed.trim() !== t('botServer.panel.removeWord')}
              onClick={() => void runConfirmed(onRemove)}
            >
              {t('botServer.panel.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
