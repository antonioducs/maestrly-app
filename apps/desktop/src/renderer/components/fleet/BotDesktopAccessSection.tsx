import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Server } from 'lucide-react'
import type { FleetBot, FleetDesktopLinkView } from '@maestrly/bot-fleet-protocol'
import type { FleetDesktopAccessView } from '../../../shared/fleet-desktop-access'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { BotProviderOption, BotWorkspaceOption } from '@/components/bot/config'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { cn } from '@/lib/utils'
import { BotAccessCard } from './BotAccessCard'
import { SettingsCard, SettingsSection } from './SettingsSection'
import { hostApi } from '@/lib/hosts/host-context'
import { LOCAL_HOST_ID } from '../../../shared/host-key'
import { useFleetServerId } from '@/lib/fleet/server-context'

// A bot reaches this computer's workspaces and providers through its desktop link.
const localApi = hostApi(LOCAL_HOST_ID)

/**
 * What this computer gives one fleet bot: the projects it may start development conversations in, the models and actions
 * it may use and how far it may go, under a name the bot sees; and the other computers and environments that gave it
 * access, whose access can only be removed from here. Changes are saved with the card's own button, apart from the
 * bot's settings.
 */
export function BotDesktopAccessSection({ bot, id }: { bot: FleetBot; id: string }) {
  const serverId = useFleetServerId()
  const { t, i18n } = useTranslation('fleet')
  const [view, setView] = useState<FleetDesktopAccessView | null>(null)
  const [workspaces, setWorkspaces] = useState<BotWorkspaceOption[]>([])
  const [providers, setProviders] = useState<BotProviderOption[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<FleetDesktopLinkView | null>(null)

  const refresh = useCallback(async () => {
    const next = await window.api.fleetDesktopAccess(serverId, bot.id)
    setView(next)
    return next
  }, [serverId, bot.id])
  useEffect(() => {
    let alive = true
    setError('')
    void Promise.all([
      window.api.fleetDesktopAccess(serverId, bot.id),
      localApi.listWorkspaces(),
      localApi.chatExecutionProviders(),
    ])
      .then(([access, projects, accounts]) => {
        if (!alive) return
        setView(access)
        setWorkspaces(projects)
        setProviders(accounts)
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [serverId, bot.id])
  // Another computer removed this one, the bot was deleted, or this computer reconnected: read it again.
  useEffect(
    () =>
      window.api.onFleetDesktopAccess((changedServer, botId) => {
        if (changedServer === serverId && botId === bot.id) void refresh().catch(() => undefined)
      }),
    [serverId, bot.id, refresh]
  )

  async function remove(link: FleetDesktopLinkView) {
    setBusy(true)
    setError('')
    try {
      setView(await window.api.fleetDesktopAccessRemoveOther(serverId, bot.id, link.desktopId))
      setRemoving(null)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const others = view?.links?.filter((link) => !link.self) ?? []
  const date = (value: string) =>
    new Date(value).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <SettingsSection id={id} title={t('botSettings.desktops.title')} note={t('botSettings.desktops.note')}>
      <div className="flex flex-col gap-6" data-testid="fleet-desktop-access">
        {!view ? (
          <p className="text-sm text-muted-foreground">{error || t('botSettings.desktops.loading')}</p>
        ) : (
          <>
            <BotAccessCard
              id={id}
              place="computer"
              view={view}
              defaultName={view.defaultName}
              workspaces={workspaces}
              providers={providers}
              save={(input) => window.api.fleetDesktopAccessSave(serverId, bot.id, input)}
              disable={() => window.api.fleetDesktopAccessDisable(serverId, bot.id)}
              onView={setView}
            />

            <section
              aria-labelledby={`${id}-others`}
              className="flex flex-col gap-2"
              data-testid="fleet-desktop-others"
            >
              <div>
                <h3 id={`${id}-others`} className="text-sm font-semibold">
                  {t('botSettings.desktops.others.title')}
                </h3>
                <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t('botSettings.desktops.others.note')}</p>
              </div>
              {view.links === null ? (
                <p className="text-xs text-muted-foreground">
                  {view.availability === 'ready' ? t('botSettings.desktops.others.unknown') : '—'}
                </p>
              ) : others.length ? (
                <SettingsCard className="divide-y divide-border">
                  {others.map((link) => (
                    <div
                      key={link.desktopId}
                      data-testid="fleet-desktop-other"
                      data-desktop-id={link.desktopId}
                      data-kind={link.kind ?? 'computer'}
                      className="flex flex-wrap items-center gap-3 px-[18px] py-3"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {link.kind === 'environment' && (
                            <Server className="size-3.5 text-muted-foreground" aria-hidden="true" />
                          )}
                          {link.name}
                          {link.kind === 'environment' && (
                            <span className="text-xs font-normal text-muted-foreground">
                              {t('botSettings.desktops.others.environment')}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                            <span
                              aria-hidden="true"
                              className={cn(
                                'size-1.5 rounded-full',
                                link.online ? 'bg-status-ready' : 'bg-muted-foreground/70'
                              )}
                            />
                            {link.online
                              ? t('botSettings.desktops.others.online')
                              : t('botSettings.desktops.others.offline')}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t('botSettings.desktops.others.linkedAt', { date: date(link.linkedAt) })}
                          {!link.online && link.lastSeenAt
                            ? ` · ${t('botSettings.desktops.others.lastSeen', { date: date(link.lastSeenAt) })}`
                            : ''}
                        </span>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy || view.availability !== 'ready'}
                        className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setRemoving(link)}
                      >
                        {t('botSettings.desktops.others.remove')}
                      </Button>
                    </div>
                  ))}
                </SettingsCard>
              ) : (
                <p className="text-xs text-muted-foreground">{t('botSettings.desktops.others.empty')}</p>
              )}
            </section>
          </>
        )}
      </div>
      {removing && (
        <ConfirmDialog
          title={t('botSettings.desktops.others.removeTitle', { name: removing.name })}
          message={t(
            removing.kind === 'environment'
              ? 'botSettings.desktops.others.removeEnvironmentMessage'
              : 'botSettings.desktops.others.removeMessage',
            { name: removing.name }
          )}
          confirmLabel={t('botSettings.desktops.others.removeConfirm')}
          destructive
          busy={busy}
          error={error || null}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove(removing)}
        />
      )}
    </SettingsSection>
  )
}
