import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import {
  FLEET_INSTALLER_ERROR_CODES,
  type FleetInstallHosts,
  type FleetInstallerStatus,
} from '../../../shared/fleet-installer'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { useFleetInstaller } from '@/lib/fleet/use-fleet-installer'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { FleetServerProvider } from '@/lib/fleet/server-context'
import { fleetServerAddress, fleetServerName } from '@/lib/fleet/server-label'
import { Button } from '@/components/ui/button'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { BotServerChoice } from './bot-server/BotServerChoice'
import { BotServerLocalSetup } from './bot-server/BotServerLocalSetup'
import { BotServerRemoteSetup } from './bot-server/BotServerRemoteSetup'
import { BotServerManualSetup } from './bot-server/BotServerManualSetup'
import { BotServerProgress } from './bot-server/BotServerProgress'
import { BotServerPanel } from './bot-server/BotServerPanel'
import {
  defaultFleetServer,
  type FleetServerId,
  type FleetServerView,
  NO_FLEET_SERVER,
} from '../../../shared/fleet-servers'
import { installedRecord } from '@/lib/fleet/updates'

type SetupScreen = 'choice' | 'local' | 'remote' | 'manual'

/** A server for Settings to show, or `add` to add one; `seq` changes on every request. */
export type FleetSettingsRequest = { server: FleetServerId | 'add'; seq: number }

/**
 * Settings → Bot servers: the panel of one paired server at a time, chosen at the top when there are several, and
 * the ways to add one. This app installs one server; any number of others are paired with an address and a code.
 */
export function FleetSettings({
  fleets,
  initialServer,
  request,
  initialSetup,
  defaultHosts,
}: {
  fleets: { servers: FleetServerView[]; controller(serverId: FleetServerId): FleetController }
  /** Shown first: the server the Bots tab shows. */
  initialServer?: FleetServerId
  request?: FleetSettingsRequest | null
  /** Opens on this setup screen, as when Settings → Artifacts sends the owner here. */
  initialSetup?: Exclude<SetupScreen, 'choice'>
  /** What a new server hosts unless the owner picks otherwise. */
  defaultHosts?: FleetInstallHosts
}) {
  const { t } = useTranslation('fleet')
  const { status, refresh } = useFleetInstaller()
  const servers = fleets.servers
  const [chosen, setChosen] = useState<FleetServerId | null>(initialServer ?? null)
  const [adding, setAdding] = useState(!!initialSetup)
  const [screen, setScreen] = useState<SetupScreen>(initialSetup ?? 'choice')
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const retry = useRef<(() => Promise<FleetInstallerStatus>) | null>(null)
  const current = servers.find((server) => server.id === chosen) ?? defaultFleetServer(servers)
  const serverId = current?.id ?? NO_FLEET_SERVER
  const fleet = fleets.controller(serverId)
  const connection = fleet.state.connection
  // This app installs one server: while it has one, a server is added by pairing it.
  const canInstall = !!status && !status.record
  const addMode = adding || servers.length === 0
  // Once a job started from a setup form runs, its progress and then the panel follow, not the form again.
  const runningJobId = status?.job?.state === 'running' ? status.job.id : null
  useEffect(() => {
    if (runningJobId) setScreen('choice')
  }, [runningJobId])
  useEffect(() => {
    if (!request) return
    setError(null)
    setScreen('choice')
    if (request.server === 'add') setAdding(true)
    else {
      setAdding(false)
      setChosen(request.server)
    }
  }, [request?.seq])

  const errorText = (cause: unknown): string => {
    const message = fleetErrorMessage(cause)
    const code = FLEET_INSTALLER_ERROR_CODES.find((candidate) => message.includes(candidate))
    return code ? t(`botServer.error.${code}`) : message
  }
  const show = (id: FleetServerId) => {
    setChosen(id)
    setAdding(false)
    setScreen('choice')
    setError(null)
  }
  const stopAdding = () => {
    setAdding(false)
    setScreen('choice')
    setError(null)
  }
  // From a setup form, back to the choice while installing is offered, else out of adding.
  const backFromSetup = () => (canInstall ? setScreen('choice') : stopAdding())
  // The servers and their connections arrive from main: only a server still paired is read again.
  const refreshFleet = async (disconnected = false) => {
    if (disconnected || serverId === NO_FLEET_SERVER) return
    await fleet.refresh().catch(() => undefined)
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
        // A server just installed is the one shown next.
        else if (result.record.serverId) show(result.record.serverId)
      }
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const disconnect = async () => {
    setError(null)
    try {
      // The installed server leaves through the installer, which also forgets its install; any other is unpaired.
      if (status && installedRecord(status, serverId)) await window.api.fleetInstallerDisconnect()
      else await window.api.fleetDisconnect(serverId)
      await refresh()
      await refreshFleet(true)
      setChosen(null)
      setScreen('choice')
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const job = status?.job
  const progress =
    job && (job.state === 'running' || job.state === 'failed' || job.state === 'cancelled') && job.id !== dismissedJobId
  // The installer's controls are for the server it installed.
  const panelStatus = status && { ...status, record: installedRecord(status, serverId) }
  const refused = connection.state === 'unauthorized' || connection.state === 'incompatible'

  const setupScreen = () =>
    screen === 'local' && canInstall ? (
      <BotServerLocalSetup
        defaultHosts={defaultHosts}
        onBack={backFromSetup}
        onInstall={(input) => {
          void run(() => window.api.fleetInstallerInstallLocal(input))
        }}
      />
    ) : screen === 'remote' ? (
      <BotServerRemoteSetup
        record={status!.record}
        defaultHosts={defaultHosts}
        onBack={addMode ? backFromSetup : () => setScreen('choice')}
        onInstall={(input) => {
          void run(async () => {
            const latest = await window.api.fleetInstallerStatus()
            if (latest.record?.mode === 'remote' && latest.tunnel === 'host-key-changed')
              await window.api.fleetInstallerDisconnect()
            return window.api.fleetInstallerInstallRemote(input)
          })
        }}
      />
    ) : screen === 'manual' || !canInstall ? (
      <BotServerManualSetup again={null} onBack={backFromSetup} onPaired={(server) => show(server.id)} />
    ) : (
      <div className="space-y-3">
        <BotServerChoice onChoose={setScreen} />
        {servers.length > 0 && (
          <Button variant="ghost" size="sm" onClick={stopAdding}>
            {t('botServer.back')}
          </Button>
        )}
      </div>
    )

  return (
    <section className="space-y-5 text-sm">
      <div>
        <h2 className="text-lg font-semibold">{t('settings.title')}</h2>
        <p className="mt-1 text-muted-foreground">{t('botServer.description')}</p>
      </div>
      {servers.length > 0 && !addMode && (
        <div className="flex flex-wrap items-center gap-2" data-fleet-servers>
          {servers.length > 1 && current && (
            <OptionSelect
              className="h-9 min-w-0 flex-1 sm:max-w-sm"
              aria-label={t('botServer.servers.choose')}
              value={current.id}
              onValueChange={(value) => show(value as FleetServerId)}
            >
              {servers.map((server) => (
                <SelectOption key={server.id} value={server.id} data-fleet-server-option={server.id}>
                  {t('botServer.servers.option', {
                    name: fleetServerName(server.connection),
                    address: fleetServerAddress(server.connection),
                    status: t(`botServer.servers.status.${server.connection.state}`),
                  })}
                </SelectOption>
              ))}
            </OptionSelect>
          )}
          <Button variant="outline" size="sm" data-fleet-add-server onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            {t('botServer.servers.add')}
          </Button>
        </div>
      )}
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
      ) : addMode ? (
        <>
          {servers.length > 0 && <h3 className="text-base font-semibold">{t('botServer.servers.addTitle')}</h3>}
          {setupScreen()}
        </>
      ) : current && panelStatus && (panelStatus.record || !refused) && screen !== 'remote' ? (
        <FleetServerProvider serverId={serverId}>
          <BotServerPanel
            status={panelStatus}
            connection={connection}
            reportedVersion={fleet.state.snapshot.host?.gatewayVersion ?? null}
            onAction={(action, allow) => {
              void run(
                action === 'update'
                  ? () => window.api.fleetUpdateBots().then((result) => result.status)
                  : () => window.api.fleetInstallerSetPrivateNetwork(!!allow)
              )
            }}
            onDisconnect={disconnect}
            onRemove={() => run(() => window.api.fleetInstallerRemove({ confirm: 'remove' }))}
            onSetupAgain={() => setScreen('remote')}
          />
        </FleetServerProvider>
      ) : current && refused ? (
        <BotServerManualSetup
          again={{ serverId, url: connection.url }}
          onBack={() => setScreen('choice')}
          onPaired={(server) => show(server.id)}
        />
      ) : (
        setupScreen()
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
