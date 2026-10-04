import { useCallback, useEffect, useState } from 'react'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { FleetView } from '@/lib/use-main-panels'
import { BotView } from './BotView'

export function PersistentBotViews({
  fleet,
  view,
  onView,
  onOpenBot,
}: {
  fleet: FleetController
  view: FleetView | null
  onView: (view: FleetView) => void
  onOpenBot: (id: string) => void
}) {
  const [detachedIds, setDetachedIds] = useState<ReadonlySet<string>>(() => new Set())
  const bots = fleet.state.snapshot.bots
  const activeView = view?.kind === 'bot' ? view : null

  useEffect(() => {
    setDetachedIds((current) => {
      const retained = new Set(
        bots.filter((bot) => bot.lifecycle !== 'archived' && current.has(bot.id)).map((bot) => bot.id)
      )
      return retained.size === current.size ? current : retained
    })
  }, [bots])

  const handleDetachedChange = useCallback((id: string, detached: boolean) => {
    setDetachedIds((current) => {
      if (current.has(id) === detached) return current
      const next = new Set(current)
      if (detached) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  return bots
    .filter((bot) => bot.lifecycle !== 'archived' && (bot.id === activeView?.botId || detachedIds.has(bot.id)))
    .map((bot) => (
      <div
        key={bot.id}
        className="flex min-h-0 flex-1 flex-col"
        style={bot.id === activeView?.botId ? undefined : { display: 'none' }}
      >
        <BotView
          bot={bot}
          view={
            activeView && activeView.botId === bot.id ? activeView : { kind: 'bot', botId: bot.id, tab: 'conversation' }
          }
          fleet={fleet}
          onView={onView}
          onOpenBot={onOpenBot}
          active={bot.id === activeView?.botId}
          onDetachedChange={(detached) => handleDetachedChange(bot.id, detached)}
        />
      </div>
    ))
}
