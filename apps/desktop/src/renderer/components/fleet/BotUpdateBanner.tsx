import { useTranslation } from 'react-i18next'
import { CircleArrowUp, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatNames } from '@/lib/fleet/environments'
import { updateBlockers } from '@/lib/fleet/updates'
import { useBotUpdates } from '@/lib/fleet/use-bot-updates'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'

/** Tells that bots can be updated and updates them in one click; shows the update while it runs or waits. */
export function BotUpdateBanner({ fleet, compact = false }: { fleet: FleetController; compact?: boolean }) {
  const { t, i18n } = useTranslation('fleet')
  const { summary, installer, run, starting, error } = useBotUpdates(fleet)
  const { environments, bots, host } = fleet.state.snapshot
  const updatingServer = installer?.job?.state === 'running' && installer.job.kind === 'update'
  const waiting = environments.filter((environment) => summary.environments[environment.id] === 'pending')
  const blockers = waiting.flatMap((environment) => updateBlockers(environment, bots)).map((bot) => bot.name)
  const behind = summary.server === 'behind' && host && installer
  if (!updatingServer && !waiting.length && !summary.canUpdate && !behind && !error) return null
  return (
    <section
      className={cn(
        'space-y-2 rounded-lg border border-border bg-surface-elevated p-3',
        compact ? 'mt-2 text-xs' : 'text-sm'
      )}
    >
      {updatingServer && (
        <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <Clock aria-hidden="true" className="size-4 shrink-0" />
          {t('updates.updatingServer')}
        </p>
      )}
      {waiting.length > 0 && (
        <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <Clock aria-hidden="true" className="size-4 shrink-0" />
          {blockers.length
            ? t('updates.waiting', { bots: formatNames(blockers, i18n.language) })
            : t('updates.waitingNone')}
        </p>
      )}
      {summary.canUpdate && !updatingServer && (
        <div className="space-y-2">
          <p className="flex items-center gap-2 font-medium">
            <CircleArrowUp aria-hidden="true" className="size-4 shrink-0 text-primary" />
            {t('updates.available')}
          </p>
          <p className="text-muted-foreground">
            {summary.targetVersion
              ? t('updates.availableVersion', { version: summary.targetVersion })
              : t('updates.availableNoVersion')}
          </p>
          <Button size="sm" disabled={starting} onClick={() => void run()}>
            {t('updates.updateBots')}
          </Button>
        </div>
      )}
      {behind && (
        <p className="text-muted-foreground">
          {t('updates.behind', { server: host.gatewayVersion, app: installer.appVersion })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
