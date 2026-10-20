import { useCallback, useEffect, useState } from 'react'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { FleetServerProvider } from '@/lib/fleet/server-context'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { FleetView } from '@/lib/use-main-panels'
import { type FleetServerId, fleetKey } from '../../../shared/fleet-servers'
import { BotView } from './BotView'

type DetachedBot = { serverId: FleetServerId; botId: string }

/**
 * The bot views kept mounted: the one the Bots tab shows, and every bot open in a window of its own, each with its
 * own server's state, so a window stays open while the Bots tab shows another server.
 */
export function PersistentBotViews({
  fleets,
  fleet,
  view,
  onView,
  onOpenBot,
}: {
  fleets: { controller(serverId: FleetServerId): FleetController }
  fleet: FleetController
  view: FleetView | null
  onView: (view: FleetView) => void
  onOpenBot: (id: string) => void
}) {
  const [detached, setDetached] = useState<ReadonlyMap<string, DetachedBot>>(() => new Map())
  const activeView = view?.kind === 'bot' ? view : null
  const listed = (controller: FleetController, botId: string): FleetBot | undefined =>
    controller.state.snapshot.bots.find((bot) => bot.id === botId && bot.lifecycle !== 'archived')

  const shown = new Map<string, { bot: FleetBot; controller: FleetController }>()
  const active = activeView ? listed(fleet, activeView.botId) : undefined
  if (active) shown.set(fleetKey(fleet.serverId, active.id), { bot: active, controller: fleet })
  for (const [key, entry] of detached) {
    if (shown.has(key)) continue
    const controller = fleets.controller(entry.serverId)
    const bot = listed(controller, entry.botId)
    if (bot) shown.set(key, { bot, controller })
  }
  const activeKey = active ? fleetKey(fleet.serverId, active.id) : null

  // A bot its server no longer lists, or a server no longer paired, takes its window along.
  const gone = [...detached.keys()].filter((key) => !shown.has(key)).join('\n')
  useEffect(() => {
    if (!gone) return
    const keys = new Set(gone.split('\n'))
    setDetached((current) => new Map([...current].filter(([key]) => !keys.has(key))))
  }, [gone])

  const handleDetachedChange = useCallback((serverId: FleetServerId, botId: string, open: boolean) => {
    const key = fleetKey(serverId, botId)
    setDetached((current) => {
      if (current.has(key) === open) return current
      const next = new Map(current)
      if (open) next.set(key, { serverId, botId })
      else next.delete(key)
      return next
    })
  }, [])

  // In a stable order: moving a view's element would move a detached window's surface with it.
  return [...shown]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, { bot, controller }]) => (
      <div
        key={key}
        className="flex min-h-0 flex-1 flex-col"
        style={key === activeKey ? undefined : { display: 'none' }}
      >
        <FleetServerProvider serverId={controller.serverId}>
          <BotView
            bot={bot}
            view={key === activeKey && activeView ? activeView : { kind: 'bot', botId: bot.id, tab: 'conversation' }}
            fleet={controller}
            onView={onView}
            onOpenBot={onOpenBot}
            active={key === activeKey}
            onDetachedChange={(open) => handleDetachedChange(controller.serverId, bot.id, open)}
          />
        </FleetServerProvider>
      </div>
    ))
}
