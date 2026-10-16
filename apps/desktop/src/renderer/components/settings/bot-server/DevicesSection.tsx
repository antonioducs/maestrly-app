import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, Laptop, MonitorSmartphone, Smartphone } from 'lucide-react'
import type { FleetDevice } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { fleetErrorMessage } from '@/lib/fleet/errors'

/**
 * The phones and computers paired with the bot server, as `maestrly-bot-gateway devices list` shows them: any of them
 * can remove another one, which can then no longer reach the server.
 */
export function DevicesSection({ revision }: { revision: number }) {
  const { t, i18n } = useTranslation('fleet')
  const [devices, setDevices] = useState<FleetDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<FleetDevice | null>(null)
  const [busy, setBusy] = useState(false)
  const date = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language]
  )

  const load = useCallback(async () => {
    setError(null)
    try {
      setDevices((await window.api.fleetDevices()).devices)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load, revision])

  const remove = async () => {
    if (!removing) return
    setBusy(true)
    try {
      await window.api.fleetRevokeDevice(removing.id)
      setRemoving(null)
      await load()
    } catch (cause) {
      setError(fleetErrorMessage(cause))
      setRemoving(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="bot-server-devices" className="space-y-2 rounded-lg border border-border p-4">
      <h3 id="bot-server-devices" className="font-semibold">
        {t('botServer.devices.title')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('botServer.devices.description')}</p>
      {error && (
        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
          <span>{t('botServer.devices.loadFailed', { error })}</span>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            {t('botServer.devices.retry')}
          </Button>
        </div>
      )}
      {devices === null && !error ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('botServer.devices.loading')}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {(devices ?? []).map((device) => {
            const Icon = device.kind === 'phone' ? Smartphone : device.kind === 'computer' ? Laptop : MonitorSmartphone
            const what = [
              device.kind ? t(`botServer.devices.kind.${device.kind}`) : t('botServer.devices.kind.unknown'),
              device.platform ? t(`botServer.devices.platform.${device.platform}`) : null,
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <li key={device.id} className="flex items-center gap-3 py-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {device.name}
                    {device.current && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                        {t('botServer.devices.thisComputer')}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {what} · {t('botServer.devices.paired', { date: date.format(new Date(device.pairedAt)) })} ·{' '}
                    {device.lastSeenAt
                      ? t('botServer.devices.lastSeen', { date: date.format(new Date(device.lastSeenAt)) })
                      : t('botServer.devices.neverSeen')}
                  </p>
                </div>
                {device.notifications && (
                  <Bell
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label={t('botServer.devices.notifications')}
                  />
                )}
                {!device.current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    aria-label={t('botServer.devices.removeNamed', { name: device.name })}
                    onClick={() => setRemoving(device)}
                  >
                    {t('botServer.devices.remove')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {removing && (
        <ConfirmDialog
          title={t('botServer.devices.removeTitle', { name: removing.name })}
          message={t('botServer.devices.removeConfirm', { name: removing.name })}
          confirmLabel={t('botServer.devices.remove')}
          destructive
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove()}
        />
      )}
    </section>
  )
}
