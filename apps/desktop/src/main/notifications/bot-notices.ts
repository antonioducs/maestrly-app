import type { FleetActivityEntry, FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'
import { type FleetServerId, fleetKey } from '../../shared/fleet-servers'
import type { NotificationTarget } from '../../shared/notifications'
import { fleetBotEventFor } from '../fleet/client/alerts'
import { tMain } from '../i18n'
import type { FleetBotAttention } from './bot-attention'
import type { SystemNotices } from './system-notices'

export interface FleetBotNoticesDeps {
  notices: Pick<SystemNotices, 'show' | 'dismiss' | 'dismissPrefix'>
  attention: Pick<FleetBotAttention, 'mark' | 'clear' | 'seenLane' | 'lanesOf'>
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

/** Reads a run or a thread from its server as an event of it would tell it. */
export type FleetSideConversationRead = (
  botId: string,
  side: { kind: 'run' | 'thread'; id: string }
) => Promise<FleetSideConversationEvent>

const noticePrefix = (serverId: FleetServerId, botId: string) => `bot:${fleetKey(serverId, botId)}:`
/** Runs remembered as seen, so that one seen before it ended marks nothing when it ends. */
const SEEN_RUNS_MAX = 500
/** Side conversations one reconnection reads at most to settle the marks. */
const RECONCILE_MAX = 100

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

  /**
   * The server is reachable again: the side conversations that still mark a bot are read, since the owner may have
   * seen them on another device while no event could reach this computer.
   */
  async reconcile(serverId: FleetServerId, read: FleetSideConversationRead): Promise<void> {
    for (const { botId, lane } of this.deps.attention.lanesOf(serverId).slice(0, RECONCILE_MAX)) {
      const at = lane.indexOf(':')
      const kind = lane.slice(0, at)
      if (kind !== 'run' && kind !== 'thread') continue
      try {
        this.sideConversation(serverId, await read(botId, { kind, id: lane.slice(at + 1) }))
      } catch {
        /* Gone or out of reach: the mark stays until the owner opens the bot. */
      }
    }
  }

  /** The owner sees the bot: its mark and notifications go. */
  seen(serverId: FleetServerId, botId: string): void {
    this.deps.attention.clear(serverId, botId)
    this.deps.notices.dismissPrefix(noticePrefix(serverId, botId))
  }
}
