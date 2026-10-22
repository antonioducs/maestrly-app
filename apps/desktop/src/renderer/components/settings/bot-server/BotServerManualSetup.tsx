import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatPairingCode } from '@/lib/fleet/format'
import { fleetErrorText } from '@/lib/fleet/errors'
import type { FleetServerId, FleetServerView } from '../../../../shared/fleet-servers'

/**
 * Pairs this computer with a running server by its address and a code. With `again`, a server that refused this
 * computer is paired again under its own id; otherwise a server is added.
 */
export function BotServerManualSetup({
  again,
  onBack,
  onPaired,
}: {
  again: { serverId: FleetServerId; url: string | null } | null
  onBack: () => void
  onPaired?: (server: FleetServerView) => void
}) {
  const { t } = useTranslation('fleet')
  const [url, setUrl] = useState(again?.url ?? '')
  const [code, setCode] = useState('')
  const defaultDeviceName = t(`settings.deviceNameDefault.${window.api.platformInfo.os}`)
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (again?.url) setUrl(again.url)
  }, [again?.url])
  async function connect() {
    setBusy(true)
    setError(null)
    try {
      // The window follows the server list that main broadcasts.
      const server = await window.api.fleetConnect(
        { url: url.trim(), code, deviceName: deviceName.trim() || defaultDeviceName },
        again?.serverId
      )
      setCode('')
      onPaired?.(server)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
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
