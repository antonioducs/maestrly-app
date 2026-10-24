import type { FleetActivityEntry, FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'
import { type FleetServerId, fleetKey } from '../../shared/fleet-servers'
import type { NotificationTarget } from '../../shared/notifications'
import { fleetBotEventFor } from '../fleet/client/alerts'
import { tMain } from '../i18n'
import type { FleetBotAttention } from './bot-attention'
import type { SystemNotices } from './system-notices'

export interface FleetBotNoticesDeps {
  notices: Pick<SystemNotices, 'show' | 'dismiss' | 'dismissPrefix'>
  attention: Pick<FleetBotAttention, 'mark' | 'clear' | 'seenLane'>
  /** Whether the owner looks at this bot now. */
  sees(serverId: FleetServerId, botId: string): boolean
  botName(serverId: FleetServerId, botId: string): string | null
  /** The server's name when the owner pairs several, to tell their bots apart; null otherwise. */
  serverName(serverId: FleetServerId): string | null
  open(target: NotificationTarget): void
}

/** A run or a thread as its server tells every device of the owner's, with what they have seen of it. */
export type FleetSideConversationEvent = Extract<
  FleetGatewayEvent,
  { type: 'routine_run.updated' | 'peer_thread.updated' }
>

const noticePrefix = (serverId: FleetServerId, botId: string) => `bot:${fleetKey(serverId, botId)}:`
/** Runs remembered as seen, so that one seen before it ended marks nothing when it ends. */
const SEEN_RUNS_MAX = 500

/**
 * System notifications and sidebar marks of bots, from the live activity of their servers (see fleetBotEventFor). A
 * bot has one notification per conversation (its own, a routine run's, a thread's), and opening the bot removes them
 * all with its mark. A run or a thread the owner sees on another device (`owner-seen`) takes its own away.
 */
export class FleetBotNotices {
  private readonly seenRuns = new Set<string>()

  constructor(private readonly deps: FleetBotNoticesDeps) {}

  live(serverId: FleetServerId, entry: FleetActivityEntry): void {
    const event = fleetBotEventFor(entry)
    if (!event || this.deps.sees(serverId, event.botId)) return
    const { botId, runId, threadId, lane } = event
    if (event.mark && !(lane && this.seenRuns.has(`${fleetKey(serverId, botId)}:${lane}`)))
      this.deps.attention.mark(serverId, botId, lane)
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

  /**
   * A run or a thread changed on its server. Once the owner has seen it, on any device, it no longer marks its bot
   * here, and its notification goes: a run once opened (later changes to it are the owner's own, told apart), a thread
   * up to its last activity.
   */
  sideConversation(serverId: FleetServerId, event: FleetSideConversationEvent): void {
    let lane: string
    if (event.type === 'routine_run.updated') {
      if (event.run.seenAt === null) return
      lane = `run:${event.run.id}`
      const key = `${fleetKey(serverId, event.botId)}:${lane}`
      if (this.seenRuns.has(key)) return
      this.seenRuns.add(key)
      for (const oldest of this.seenRuns) {
        if (this.seenRuns.size <= SEEN_RUNS_MAX) break
        this.seenRuns.delete(oldest)
      }
    } else {
      const { thread } = event
      if (thread.seenActivityAt === null || thread.seenActivityAt !== thread.lastActivityAt) return
      lane = `thread:${thread.id}`
    }
    this.deps.attention.seenLane(serverId, event.botId, lane)
    this.deps.notices.dismiss(noticePrefix(serverId, event.botId) + lane)
  }

  /** The owner sees the bot: its mark and notifications go. */
  seen(serverId: FleetServerId, botId: string): void {
    this.deps.attention.clear(serverId, botId)
    this.deps.notices.dismissPrefix(noticePrefix(serverId, botId))
  }
}
