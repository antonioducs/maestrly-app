import { createContext, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { activityLabel, gb, memorySegments } from '@/lib/fleet/format'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { FleetDigestBanner } from './FleetDigestBanner'
import { choiceClass } from '@/lib/fleet/choice'
import { ChoiceMark } from './ChoiceMark'

export const FleetOwnerMemoryNavigation = createContext<(() => void) | undefined>(undefined)

export function FleetSidebarPanel({
  fleet,
  query,
  selected,
  onOpenBotSettings,
  onOpenBot,
  onOpenServer,
  onOpenInbox,
  onOpenOwnerMemory,
}: {
  fleet: FleetController
  query: string
  selected: string | null
  onOpenBotSettings: () => void
  onOpenBot: (id: string) => void
  onOpenServer: () => void
  onOpenInbox: () => void
  onOpenOwnerMemory?: () => void
}) {
  const { t } = useTranslation('fleet')
  const inheritedOpenOwnerMemory = useContext(FleetOwnerMemoryNavigation)
  const openOwnerMemory = onOpenOwnerMemory ?? inheritedOpenOwnerMemory
  const { connection, snapshot } = fleet.state
  if (
    connection.state === 'unconfigured' ||
    connection.state === 'unauthorized' ||
    connection.state === 'incompatible'
  ) {
    return (
      <div className="px-4 py-6 text-center text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{t(`connection.${connection.state}`)}</p>
        <p className="mt-2 leading-5">{t('connection.sidebarHint')}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onOpenBotSettings}>
          {t('connection.openSettings')}
        </Button>
      </div>
    )
  }
  const bots = snapshot.bots.filter(
    (bot) =>
      bot.name.toLowerCase().includes(query.toLowerCase()) || bot.role.toLowerCase().includes(query.toLowerCase())
  )
  const segments = memorySegments(snapshot.host, snapshot.bots)
  return (
    <div className="p-2 text-xs">
      {!selected && <FleetDigestBanner fleet={fleet} onOpenBot={onOpenBot} onOpenServer={onOpenServer} compact />}
      {connection.state !== 'connected' && (
        <div role="status" className="px-2 py-2 text-muted-foreground">
          {t(connection.state === 'connecting' ? 'connection.connectingTo' : 'connection.reconnectingTo', {
            host: connection.hostname ?? connection.url ?? '',
          })}
        </div>
      )}
      {!query && (
        <button
          type="button"
          onClick={onOpenServer}
          className={`w-full rounded-lg border border-border p-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${selected === 'server' ? 'bg-accent' : ''}`}
        >
          <span className="flex items-center gap-2 font-medium">
            <Server className="size-4" />
            {connection.hostname ?? snapshot.host?.hostname ?? connection.url}
          </span>
          <span className="mt-1 block text-muted-foreground">
            ● {t(connection.state === 'connected' ? 'connection.online' : 'connection.reconnectingStatus')}
          </span>
          {snapshot.host && (
            <>
              <span
                className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-muted"
                aria-label={t('sidebar.memory', {
                  used: gb(snapshot.host.memory.usedBytes),
                  total: gb(snapshot.host.memory.totalBytes),
                })}
              >
                {segments.map((segment) => (
                  <span
                    key={segment.id}
                    style={{ width: `${Math.min(100, segment.fraction * 100)}%`, background: segment.tint }}
                  />
                ))}
              </span>
              <span className="mt-1 block text-muted-foreground">
                {t('sidebar.botMemory', {
                  count: snapshot.bots.length,
                  used: gb(snapshot.host.memory.usedBytes),
                  total: gb(snapshot.host.memory.totalBytes),
                })}
              </span>
            </>
          )}
        </button>
      )}
      {!query && snapshot.inbox.length > 0 && (
        <button
          type="button"
          onClick={onOpenInbox}
          className={`mt-2 flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-amber-500 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${selected === 'inbox' ? 'bg-accent' : ''}`}
        >
          <span>{t('sidebar.awaiting')}</span>
          <span className="rounded-full bg-amber-500/15 px-2">{snapshot.inbox.length}</span>
        </button>
      )}
      {!query && (
        <button
          type="button"
          onClick={openOwnerMemory}
          aria-current={selected === 'memory' ? 'page' : undefined}
          className={`mt-2 flex w-full items-center justify-between rounded-md border px-2 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring ${choiceClass(selected === 'memory')}`}
        >
          <span>{t('sidebar.ownerMemory')}</span>
          <ChoiceMark selected={selected === 'memory'} />
        </button>
      )}
      <div className="mt-2 space-y-0.5">
        {bots.map((bot: FleetBot) => {
          const activity = activityLabel(bot.activity, bot.status)
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => onOpenBot(bot.id)}
              aria-current={selected === bot.id ? 'page' : undefined}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${selected === bot.id ? 'bg-accent' : ''}`}
            >
              <span
                className="relative flex size-8 shrink-0 items-center justify-center rounded-lg font-semibold text-white"
                style={{ background: bot.tint }}
              >
                {bot.name.charAt(0).toUpperCase()}
                <span
                  className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-sidebar ${bot.status === 'waiting' ? 'bg-amber-400' : bot.status === 'working' ? 'bg-blue-400' : bot.status === 'idle' ? 'bg-emerald-400' : 'bg-muted-foreground'}`}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{bot.name}</span>
                <span className="block truncate text-muted-foreground">{t(activity.key, activity.values)}</span>
              </span>
              {bot.pendingCount > 0 && (
                <span className="rounded-full bg-amber-500/15 px-1.5 text-amber-500">{bot.pendingCount}</span>
              )}
            </button>
          )
        })}
        {bots.length === 0 && (
          <p className="px-2 py-4 text-center text-muted-foreground">
            {query ? t('sidebar.noResults') : t('sidebar.noBots')}
          </p>
        )}
      </div>
    </div>
  )
}
