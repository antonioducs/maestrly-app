import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { formatPairingCode } from '@/lib/fleet/format'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { fleetErrorMessage } from '@/lib/fleet/errors'

export function FleetSettings({ fleet }: { fleet: FleetController }) {
  const { t } = useTranslation('fleet')
  const { connection } = fleet.state
  const [url, setUrl] = useState(connection.url ?? '')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState('Mac')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (connection.url) setUrl(connection.url)
  }, [connection.url])
  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.fleetConnect({ url: url.trim(), code, deviceName: deviceName.trim() || 'Mac' })
      fleet.dispatch({ type: 'connection', value: result })
      setCode('')
      const snapshot = await window.api.fleetGetSnapshot()
      fleet.dispatch({ type: 'snapshot', value: snapshot })
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const disconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.api.fleetDisconnect()
      fleet.dispatch({ type: 'connection', value: await window.api.fleetGetConnection() })
      fleet.dispatch({ type: 'snapshot', value: { host: null, bots: [], inbox: [], peerMessages: [] } })
      setConfirm(false)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-5 text-sm">
      <div>
        <h2 className="text-lg font-semibold">{t('settings.title')}</h2>
        <p className="mt-1 text-muted-foreground">{t('settings.description')}</p>
      </div>
      <div role="status" className="rounded-lg border border-border p-3">
        {t(`connection.${connection.state}`)}
        {connection.hostname && <span className="ml-2 text-muted-foreground">{connection.hostname}</span>}
        {connection.error && <p className="mt-1 text-destructive">{connection.error}</p>}
      </div>
      {connection.tokenPersistence === 'memory' && connection.state !== 'unconfigured' && (
        <p role="alert" className="rounded-md border border-amber-500/40 p-3 text-amber-500">
          {t('settings.memoryToken')}
        </p>
      )}
      {connection.state === 'unconfigured' ||
      connection.state === 'unauthorized' ||
      connection.state === 'incompatible' ? (
        <div className="space-y-4">
          <label className="block space-y-1">
            <span>{t('settings.address')}</span>
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              type="url"
              placeholder={t('settings.addressExample')}
            />
          </label>
          <label className="block space-y-1">
            <span>{t('settings.code')}</span>
            <Input
              value={code}
              onChange={(event) => setCode(formatPairingCode(event.target.value))}
              autoComplete="off"
              maxLength={9}
              placeholder="XXXX-XXXX"
            />
          </label>
          <label className="block space-y-1">
            <span>{t('settings.deviceName')}</span>
            <Input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} />
          </label>
          <Button disabled={busy || !url.trim() || code.replace('-', '').length !== 8} onClick={() => void connect()}>
            {t('settings.connect')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('settings.pairInstructions')}</p>
          <code className="block overflow-x-auto rounded-md bg-muted p-3 text-xs">
            docker compose exec maestrly-bot-gateway maestrly-bot-gateway pair
          </code>
          <p className="text-xs text-muted-foreground">{t('settings.tailscale')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-muted-foreground">{connection.url}</p>
          <Button variant="outline" disabled={busy} onClick={() => setConfirm(true)}>
            {t('settings.disconnect')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {confirm && (
        <ConfirmDialog
          title={t('settings.disconnect')}
          message={t('settings.disconnectConfirm')}
          confirmLabel={t('settings.disconnect')}
          destructive
          busy={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => void disconnect()}
        />
      )}
    </section>
  )
}
