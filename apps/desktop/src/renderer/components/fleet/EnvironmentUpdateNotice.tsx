import { useTranslation } from 'react-i18next'
import { CircleArrowUp, Clock } from 'lucide-react'
import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { environmentUpdateState, updateBlockers } from '@/lib/fleet/updates'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { botStatusDot } from './BotChatHeader'
import type { EnvironmentConfirmKind } from './EnvironmentConfirm'

/**
 * A newer image the server offers to an environment, at the top of its overview: updating waits for its bots, and a
 * waiting update says which bots it waits for and can be forced or cancelled. A gateway that cannot schedule updates
 * only restarts the environment onto the new image.
 */
export function EnvironmentUpdateNotice({
  environment,
  fleet,
  onConfirm,
  onOpenInbox,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  onConfirm: (kind: EnvironmentConfirmKind) => void
  onOpenInbox: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const host = fleet.state.snapshot.host
  const state = environmentUpdateState(environment, host)
  if (state === 'current') return null
  // A gateway that schedules updates reports them; an older one only restarts, as before.
  const schedulable = environment.update !== null
  const blockers = updateBlockers(environment, fleet.state.snapshot.bots)
  const pendingSince = environment.update?.pendingSince ?? null
  const pending = state === 'pending'
  return (
    <section
      aria-label={t('environment.updateRegion')}
      className="flex items-start gap-3 rounded-xl border border-border-strong bg-white/[0.035] px-4 py-3.5"
    >
      {pending ? (
        <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-300" />
      ) : (
        <CircleArrowUp aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-foreground/75" />
      )}
      <div role={pending ? 'status' : undefined} className="min-w-0 flex-1 space-y-1">
        <h2 className="text-[13.5px] font-semibold">
          {pending
            ? t('updates.pendingTitle')
            : host?.botImageVersion
              ? t('updates.availableVersion', { version: host.botImageVersion })
              : t('updates.availableNoVersion')}
        </h2>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {pending
            ? t('updates.pendingNote')
            : state === 'next-start'
              ? t('updates.nextStart')
              : schedulable
                ? t('environment.updateWhenIdle')
                : t('environment.updateRestarts')}
        </p>
        {pending && pendingSince && (
          <p className="text-[12.5px] text-muted-foreground">
            {t('updates.waitingSince', {
              time: new Date(pendingSince).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }),
            })}
          </p>
        )}
        {pending && blockers.length > 0 && (
          <ul className="space-y-1 pt-1 text-[12.5px] text-foreground/75">
            {blockers.map((bot) => (
              <li key={bot.id} className="flex flex-wrap items-center gap-2">
                <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${botStatusDot(bot.status)}`} />
                <span>{t(`updates.busy.${bot.status}`, { name: bot.name })}</span>
                {bot.status === 'waiting' && (
                  <button
                    type="button"
                    onClick={onOpenInbox}
                    className="rounded text-foreground underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t('sidebar.awaiting')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {state !== 'next-start' && (
          <div className="flex flex-wrap gap-1.5 pt-2">
            {pending ? (
              <>
                <Button size="sm" onClick={() => onConfirm('updateNow')}>
                  {t('updates.updateNow')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void fleet.cancelEnvironmentUpdate(environment.id)}>
                  {t('updates.cancel')}
                </Button>
              </>
            ) : schedulable ? (
              // Nothing is interrupted: the update waits for the environment's bots on the server.
              <Button size="sm" onClick={() => void fleet.updateEnvironment(environment.id, 'idle')}>
                {t('environment.update')}
              </Button>
            ) : (
              <Button size="sm" onClick={() => onConfirm('update')}>
                {t('environment.update')}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
