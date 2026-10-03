import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetInstallHosts, FleetInstallLocalInput, LocalDockerCheck } from '../../../../shared/fleet-installer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { BotServerHostsChoice } from './BotServerHostsChoice'
import { PrivateNetworkSwitch } from './PrivateNetworkSwitch'

const dockerUrl = {
  mac: 'https://docs.docker.com/desktop/setup/install/mac-install/',
  win: 'https://docs.docker.com/desktop/setup/install/windows-install/',
  linux: 'https://docs.docker.com/engine/install/',
}

export function BotServerLocalSetup({
  defaultHosts = 'bots-and-artifacts',
  onBack,
  onInstall,
}: {
  defaultHosts?: FleetInstallHosts
  onBack: () => void
  onInstall: (input: FleetInstallLocalInput) => void
}) {
  const { t } = useTranslation('fleet')
  const [check, setCheck] = useState<LocalDockerCheck | null>(null)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hosts, setHosts] = useState<FleetInstallHosts>(defaultHosts)
  const [deviceName, setDeviceName] = useState(t(`settings.deviceNameDefault.${window.api.platformInfo.os}`))
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false)
  const checkDocker = useCallback(async () => {
    setChecking(true)
    setError(null)
    try {
      setCheck(await window.api.fleetInstallerCheckLocal())
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setChecking(false)
    }
  }, [])
  useEffect(() => {
    void checkDocker()
  }, [checkDocker])
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        {t('botServer.back')}
      </Button>
      <h3 className="text-base font-semibold">{t('botServer.choice.localTitle')}</h3>
      {checking ? (
        <p role="status" className="text-muted-foreground">
          {t('botServer.local.checking')}
        </p>
      ) : (
        check && (
          <div role="status" className="rounded-lg border border-border bg-surface-elevated p-4">
            <p className="font-medium">
              {check.state === 'ready'
                ? t(check.engine ? 'botServer.local.readyEngine' : 'botServer.local.ready', {
                    version: check.version ?? '',
                    engine: check.engine,
                  })
                : t(`botServer.local.${check.state}`)}
            </p>
            {check.state === 'missing' && window.api.platformInfo.os === 'mac' && (
              <p className="mt-2 text-xs text-muted-foreground">{t('botServer.local.alternatives')}</p>
            )}
          </div>
        )
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {check?.state === 'missing' && (
        <Button
          variant="outline"
          onClick={() => void window.api.openExternalUrl(dockerUrl[window.api.platformInfo.os])}
        >
          {t('botServer.local.download')}
        </Button>
      )}
      {check?.state !== 'ready' && (
        <Button variant="outline" disabled={checking} onClick={() => void checkDocker()}>
          {t('botServer.local.checkAgain')}
        </Button>
      )}
      {check?.state === 'ready' && !checking && (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('botServer.hosts.localExpectations')}</p>
          <label className="block space-y-1">
            <span>{t('settings.deviceName')}</span>
            <Input
              className="bg-surface-elevated"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              maxLength={80}
            />
          </label>
          <BotServerHostsChoice value={hosts} onChange={setHosts} />
          <PrivateNetworkSwitch mode="local" checked={allowPrivateNetwork} onChange={setAllowPrivateNetwork} />
          <Button
            onClick={() =>
              onInstall({
                deviceName: deviceName.trim() || t(`settings.deviceNameDefault.${window.api.platformInfo.os}`),
                allowPrivateNetwork,
                hosts,
              })
            }
          >
            {t('botServer.local.install')}
          </Button>
        </>
      )}
    </div>
  )
}
