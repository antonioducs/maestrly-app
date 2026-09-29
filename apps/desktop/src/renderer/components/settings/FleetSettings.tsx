import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FLEET_INSTALLER_ERROR_CODES, type FleetInstallerStatus } from '../../../shared/fleet-installer'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { useFleetInstaller } from '@/lib/fleet/use-fleet-installer'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { BotServerChoice } from './bot-server/BotServerChoice'
import { BotServerLocalSetup } from './bot-server/BotServerLocalSetup'
import { BotServerRemoteSetup } from './bot-server/BotServerRemoteSetup'
import { BotServerManualSetup } from './bot-server/BotServerManualSetup'
import { BotServerProgress } from './bot-server/BotServerProgress'
import { BotServerPanel } from './bot-server/BotServerPanel'

type SetupScreen = 'choice' | 'local' | 'remote' | 'manual'

export function FleetSettings({ fleet }: { fleet: FleetController }) {
  const { t } = useTranslation('fleet')
  const { status, refresh } = useFleetInstaller()
  const [screen, setScreen] = useState<SetupScreen>('choice')
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const retry = useRef<(() => Promise<FleetInstallerStatus>) | null>(null)
  const connection = fleet.state.connection
  // Once a job started from a setup form runs, its progress and then the panel follow, not the form again.
  const runningJobId = status?.job?.state === 'running' ? status.job.id : null
  useEffect(() => {
    if (runningJobId) setScreen('choice')
  }, [runningJobId])

  const errorText = (cause: unknown): string => {
    const message = fleetErrorMessage(cause)
    const code = FLEET_INSTALLER_ERROR_CODES.find((candidate) => message.includes(candidate))
    return code ? t(`botServer.error.${code}`) : message
  }
  const refreshFleet = async (disconnected = false) => {
    fleet.dispatch({ type: 'connection', value: await window.api.fleetGetConnection() })
    fleet.dispatch({
      type: 'snapshot',
      value: disconnected
        ? { host: null, bots: [], environments: [], inbox: [], peerMessages: [] }
        : await window.api.fleetGetSnapshot(),
    })
  }
  const run = async (action: () => Promise<FleetInstallerStatus>, keepRetry = true) => {
    setError(null)
    if (keepRetry) retry.current = action
    try {
      const result = await action()
      await refresh()
      if (result.job?.state === 'succeeded') {
        retry.current = null
        await refreshFleet(result.record === null)
        if (result.record === null) setScreen('choice')
      }
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const disconnect = async () => {
    setError(null)
    try {
      if (status?.record) await window.api.fleetInstallerDisconnect()
      else await window.api.fleetDisconnect()
      await refresh()
      await refreshFleet(true)
      setScreen('choice')
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const job = status?.job
  const progress =
    job && (job.state === 'running' || job.state === 'failed' || job.state === 'cancelled') && job.id !== dismissedJobId
  const installed =
    status?.record ||
    (connection.state !== 'unconfigured' && connection.state !== 'unauthorized' && connection.state !== 'incompatible')

  return (
    <section className="space-y-5 text-sm">
      <div>
        <h2 className="text-lg font-semibold">{t('settings.title')}</h2>
        <p className="mt-1 text-muted-foreground">{t('botServer.description')}</p>
      </div>
      {!status ? (
        <p role="status" className="text-muted-foreground">
          {t('botServer.loading')}
        </p>
      ) : progress && job ? (
        <BotServerProgress
          job={job}
          canRetry={retry.current !== null}
          onCancel={() => {
            void window.api.fleetInstallerCancel().catch((cause) => setError(errorText(cause)))
          }}
          onRetry={() => {
            if (retry.current) void run(retry.current)
          }}
          onBack={() => {
            setDismissedJobId(job.id)
            retry.current = null
            setScreen('choice')
          }}
        />
      ) : installed && screen !== 'remote' ? (
        <BotServerPanel
          status={status}
          connection={connection}
          reportedVersion={fleet.state.snapshot.host?.gatewayVersion ?? null}
          onAction={(action, allow) => {
            void run(
              action === 'update'
                ? () => window.api.fleetInstallerUpdate()
                : () => window.api.fleetInstallerSetPrivateNetwork(!!allow)
            )
          }}
          onDisconnect={disconnect}
          onRemove={() => run(() => window.api.fleetInstallerRemove({ confirm: 'remove' }))}
          onSetupAgain={() => setScreen('remote')}
        />
      ) : connection.state === 'unauthorized' || connection.state === 'incompatible' || screen === 'manual' ? (
        <BotServerManualSetup fleet={fleet} onBack={() => setScreen('choice')} />
      ) : screen === 'local' ? (
        <BotServerLocalSetup
          onBack={() => setScreen('choice')}
          onInstall={(input) => {
            void run(() => window.api.fleetInstallerInstallLocal(input))
          }}
        />
      ) : screen === 'remote' ? (
        <BotServerRemoteSetup
          record={status.record}
          onBack={() => setScreen('choice')}
          onInstall={(input) => {
            void run(async () => {
              const current = await window.api.fleetInstallerStatus()
              if (current.record?.mode === 'remote' && current.tunnel === 'host-key-changed')
                await window.api.fleetInstallerDisconnect()
              return window.api.fleetInstallerInstallRemote(input)
            })
          }}
        />
      ) : (
        <BotServerChoice onChoose={setScreen} />
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
