import { useEffect, useState } from 'react'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { type FleetServerId, fleetKey } from '../../../shared/fleet-servers'
import type { FleetBotAttentionChange, NotificationTarget } from '../../../shared/notifications'

/** The marks after a change, by fleetKey; the same set when nothing changed. */
export function applyBotAttention(marks: ReadonlySet<string>, change: FleetBotAttentionChange): ReadonlySet<string> {
  const key = fleetKey(change.serverId, change.botId)
  if (marks.has(key) === change.attention) return marks
  const next = new Set(marks)
  if (change.attention) next.add(key)
  else next.delete(key)
  return next
}

/** The ids of the marked bots among those a server lists: the marks of bots it no longer has count for nothing. */
export function markedBots(
  marks: ReadonlySet<string>,
  serverId: FleetServerId,
  bots: readonly Pick<FleetBot, 'id'>[]
): Set<string> {
  return new Set(bots.filter((bot) => marks.has(fleetKey(serverId, bot.id))).map((bot) => bot.id))
}

/** What the Bots tab counts on each server: the requests waiting for the owner, and the bots with something new. */
export function botsTabCounts(
  marks: ReadonlySet<string>,
  servers: readonly { serverId: FleetServerId; inbox: number; bots: readonly Pick<FleetBot, 'id'>[] }[]
): Record<FleetServerId, number> {
  return Object.fromEntries(
    servers.map(({ serverId, inbox, bots }) => [serverId, inbox + markedBots(marks, serverId, bots).size])
  ) as Record<FleetServerId, number>
}

/**
 * The bot view (a FleetView) a clicked notification opens: the bot, at the routine run or conversation between bots
 * it names.
 */
export function notificationFleetView(
  target: Pick<Extract<NotificationTarget, { kind: 'bot' }>, 'botId' | 'runId' | 'threadId'>
): { kind: 'bot'; botId: string; tab: 'conversation' | 'runs'; runId?: string; threadId?: string } {
  if (target.runId) return { kind: 'bot', botId: target.botId, tab: 'runs', runId: target.runId }
  return {
    kind: 'bot',
    botId: target.botId,
    tab: 'conversation',
    ...(target.threadId ? { threadId: target.threadId } : {}),
  }
}

/** The bots marked for the owner on this computer, by fleetKey, as the main process keeps them. */
export function useBotAttention(): ReadonlySet<string> {
  const [marks, setMarks] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    let alive = true
    const off = window.api.onFleetBotAttention((change) => setMarks((current) => applyBotAttention(current, change)))
    // Changes main sent before it listed the marks are in the list; those after it arrive after the list.
    void window.api.fleetBotAttention().then(
      (list) => {
        if (alive) setMarks(new Set(list.map(({ serverId, botId }) => fleetKey(serverId, botId))))
      },
      () => undefined
    )
    return () => {
      alive = false
      off()
    }
  }, [])
  return marks
}
