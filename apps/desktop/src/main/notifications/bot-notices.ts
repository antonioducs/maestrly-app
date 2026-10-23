import type { FleetActivityEntry } from '@maestrly/bot-fleet-protocol'
import { type FleetServerId, fleetKey } from '../../shared/fleet-servers'
import type { NotificationTarget } from '../../shared/notifications'
import { fleetBotEventFor } from '../fleet/client/alerts'
import { tMain } from '../i18n'
import type { FleetBotAttention } from './bot-attention'
import type { SystemNotices } from './system-notices'

export interface FleetBotNoticesDeps {
  notices: Pick<SystemNotices, 'show' | 'dismissPrefix'>
  attention: Pick<FleetBotAttention, 'mark' | 'clear'>
  /** Whether the owner looks at this bot now. */
  sees(serverId: FleetServerId, botId: string): boolean
  botName(serverId: FleetServerId, botId: string): string | null
  /** The server's name when the owner pairs several, to tell their bots apart; null otherwise. */
  serverName(serverId: FleetServerId): string | null
  open(target: NotificationTarget): void
}

const noticePrefix = (serverId: FleetServerId, botId: string) => `bot:${fleetKey(serverId, botId)}:`

/**
 * System notifications and sidebar marks of bots, from the live activity of their servers (see fleetBotEventFor). A
 * bot has one notification per conversation (its own, a routine run's, a thread's), and opening the bot removes them
 * all with its mark.
 */
export class FleetBotNotices {
  constructor(private readonly deps: FleetBotNoticesDeps) {}

  live(serverId: FleetServerId, entry: FleetActivityEntry): void {
    const event = fleetBotEventFor(entry)
    if (!event || this.deps.sees(serverId, event.botId)) return
    const { botId, runId, threadId } = event
    if (event.mark) this.deps.attention.mark(serverId, botId)
    if (!event.notice) return
    const t = tMain('main')
    const phrase = t(`notices.bot.${event.notice}`)
    // What the bot said last reads well after an end of turn; what waits for the owner is named by the inbox.
    const said = (event.notice === 'finished' || event.notice === 'routineFinished') && event.summary
    const subtitle = this.deps.serverName(serverId)
    this.deps.notices.show({
      key: noticePrefix(serverId, botId) + (runId ? `run:${runId}` : threadId ? `thread:${threadId}` : 'main'),
      title: this.deps.botName(serverId, botId) || t('notices.bot.untitled'),
      ...(subtitle ? { subtitle } : {}),
      body: said ? `${phrase} — ${said}` : phrase,
      onClick: () =>
        this.deps.open({
          kind: 'bot',
          serverId,
          botId,
          ...(runId ? { runId } : {}),
          ...(threadId ? { threadId } : {}),
        }),
    })
  }

  /** The owner sees the bot: its mark and notifications go. */
  seen(serverId: FleetServerId, botId: string): void {
    this.deps.attention.clear(serverId, botId)
    this.deps.notices.dismissPrefix(noticePrefix(serverId, botId))
  }
}
