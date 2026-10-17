import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import {
  FLEET_DESKTOP_BRIDGE_FEATURE,
  FLEET_HOST_DESKTOP_CALLS_FEATURE,
  type FleetBot,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import type { FleetDesktopAccessView } from '../../../shared/fleet-desktop-access'
import type { HostView } from '../../../shared/hosts'
import type { BotProviderOption, BotWorkspaceOption } from '@/components/bot/config'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { environmentOf, workspacesEnvironments } from '@/lib/fleet/selectors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { hostApi } from '@/lib/hosts/host-context'
import { useHosts } from '@/lib/hosts/use-hosts'
import { cn } from '@/lib/utils'
import { BotAccessCard } from './BotAccessCard'
import { SettingsSection } from './SettingsSection'

function Notice({ children, testId }: { children: string; testId?: string }) {
  return (
    <p
      role="status"
      data-testid={testId}
      className="flex items-start gap-2 rounded-xl border border-amber-300/35 bg-amber-300/10 px-3.5 py-3 text-[13px]"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
      {children}
    </p>
  )
}

/**
 * What the server's workspaces environments give one fleet bot: the projects it may start development conversations
 * in there, whether or not any of the owner's computers is on. Each environment keeps the access it gives, set from
 * here over its bridge, the way each computer keeps its own.
 */
export function BotEnvironmentAccessSection({ bot, fleet, id }: { bot: FleetBot; fleet: FleetController; id: string }) {
  const { t } = useTranslation('fleet')
  const snapshot = fleet.state.snapshot
  const environments = workspacesEnvironments(snapshot.environments)
  const hosts = useHosts()
  // A bot that is not running reports nothing itself; its environment's Maestrly tells what it has.
  const capable = [...bot.capabilities, ...(environmentOf(snapshot.environments, bot)?.capabilities ?? [])]
  const missing = !fleet.state.connection.features.includes(FLEET_HOST_DESKTOP_CALLS_FEATURE)
    ? 'gateway-update'
    : !capable.includes(FLEET_DESKTOP_BRIDGE_FEATURE)
      ? 'bot-update'
      : null
  return (
    <SettingsSection id={id} title={t('botSettings.environments.title')} note={t('botSettings.environments.note')}>
      <div className="flex flex-col gap-6" data-testid="fleet-environments-access">
        {missing ? (
          <Notice testId="fleet-environments-access-unavailable">
            {t(`botSettings.environments.unavailable.${missing}`)}
          </Notice>
        ) : environments.length ? (
          environments.map((environment) => (
            <EnvironmentAccess
              key={environment.id}
              id={`${id}-${environment.id}`}
              bot={bot}
              environment={environment}
              host={hosts.find((host) => host.environment?.id === environment.id) ?? null}
            />
          ))
        ) : (
          <p className="text-xs text-muted-foreground">{t('botSettings.environments.none')}</p>
        )}
      </div>
    </SettingsSection>
  )
}

/** One environment's access for the bot, read from its host once the environment runs and its bridge is up. */
function EnvironmentAccess({
  id,
  bot,
  environment,
  host,
}: {
  id: string
  bot: FleetBot
  environment: FleetEnvironment
  host: HostView | null
}) {
  const { t } = useTranslation('fleet')
  const running = environment.lifecycle === 'running'
  const capable = environment.capabilities.includes(FLEET_HOST_DESKTOP_CALLS_FEATURE)
  const online = host?.state === 'online'
  const ready = running && capable && online && host !== null
  const [view, setView] = useState<FleetDesktopAccessView | null>(null)
  const [workspaces, setWorkspaces] = useState<BotWorkspaceOption[]>([])
  const [providers, setProviders] = useState<BotProviderOption[]>([])
  const [error, setError] = useState('')
  const hostId = host?.id ?? null
  const epoch = host?.epoch ?? 0

  const refresh = useCallback(async () => {
    if (!hostId) return
    setView(await hostApi(hostId).environmentBotAccess(bot.id))
  }, [hostId, bot.id])
  useEffect(() => {
    if (!ready || !hostId) return
    let alive = true
    const api = hostApi(hostId)
    setError('')
    void Promise.all([api.environmentBotAccess(bot.id), api.listWorkspaces(), api.chatExecutionProviders()])
      .then(([access, projects, accounts]) => {
        if (!alive) return
        setView(access)
        setWorkspaces(projects)
        setProviders(accounts)
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    // The access changed on the host: from another computer, or once the server dropped the link.
    const stop = api.onEnvironmentBotAccess(({ botId }) => {
      if (botId === bot.id) void refresh().catch(() => undefined)
    })
    return () => {
      alive = false
      stop()
    }
    // A host that answers again (`epoch`) is read again.
  }, [ready, hostId, epoch, bot.id, refresh])

  return (
    <section
      aria-labelledby={`${id}-name`}
      className="flex flex-col gap-3"
      data-testid="fleet-environment-access"
      data-environment-id={environment.id}
    >
      <h3 id={`${id}-name`} className="flex items-center gap-2 text-sm font-semibold">
        {environment.name}
        <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn('size-1.5 rounded-full', running ? 'bg-status-ready' : 'bg-muted-foreground/70')}
          />
          {t(`environment.lifecycle.${environment.lifecycle}`)}
        </span>
      </h3>
      {!running ? (
        <Notice testId="fleet-environment-access-stopped">{t('botSettings.environments.stopped')}</Notice>
      ) : !capable ? (
        <Notice testId="fleet-environment-access-unavailable">
          {t('botSettings.environments.unavailable.host-update')}
        </Notice>
      ) : !ready || !hostId ? (
        <p className="text-sm text-muted-foreground">{t('botSettings.environments.connecting')}</p>
      ) : !view ? (
        <p className="text-sm text-muted-foreground">{error || t('botSettings.desktops.loading')}</p>
      ) : (
        <BotAccessCard
          id={id}
          place="environment"
          view={view}
          defaultName={environment.name}
          workspaces={workspaces}
          providers={providers}
          save={(input) => hostApi(hostId).environmentBotAccessSave(bot.id, { ...input, botName: bot.name })}
          disable={() => hostApi(hostId).environmentBotAccessDisable(bot.id)}
          onView={setView}
        />
      )}
    </section>
  )
}
