import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatPairingCode } from '@/lib/fleet/format'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import type { FleetController } from '@/lib/fleet/use-fleet'

export function BotServerManualSetup({ fleet, onBack }: { fleet: FleetController; onBack: () => void }) {
  const { t } = useTranslation('fleet')
  const [url, setUrl] = useState(fleet.state.connection.url ?? '')
  const [code, setCode] = useState('')
  const defaultDeviceName = t(`settings.deviceNameDefault.${window.api.platformInfo.os}`)
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (fleet.state.connection.url) setUrl(fleet.state.connection.url)
  }, [fleet.state.connection.url])
  async function connect() {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.fleetConnect({
        url: url.trim(),
        code,
        deviceName: deviceName.trim() || defaultDeviceName,
      })
      fleet.dispatch({ type: 'connection', value: result })
      setCode('')
      fleet.dispatch({ type: 'snapshot', value: await window.api.fleetGetSnapshot() })
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        {t('botServer.back')}
      </Button>
      <label className="block space-y-1">
        <span>{t('settings.address')}</span>
        <Input
          className="bg-surface-elevated"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          type="url"
          placeholder={t('settings.addressExample')}
        />
      </label>
      <label className="block space-y-1">
        <span>{t('settings.code')}</span>
        <Input
          className="bg-surface-elevated"
          value={code}
          onChange={(event) => setCode(formatPairingCode(event.target.value))}
          autoComplete="off"
          maxLength={9}
          placeholder="XXXX-XXXX"
        />
      </label>
      <label className="block space-y-1">
        <span>{t('settings.deviceName')}</span>
        <Input
          className="bg-surface-elevated"
          value={deviceName}
          onChange={(event) => setDeviceName(event.target.value)}
          maxLength={80}
        />
      </label>
      <Button disabled={busy || !url.trim() || code.replace('-', '').length !== 8} onClick={() => void connect()}>
        {t('settings.connect')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('settings.pairInstructions')}</p>
      <code className="block overflow-x-auto rounded-md bg-muted p-3 text-xs">
        docker compose exec maestrly-bot-gateway maestrly-bot-gateway pair
      </code>
      <p className="text-xs text-muted-foreground">{t('settings.tailscale')}</p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
