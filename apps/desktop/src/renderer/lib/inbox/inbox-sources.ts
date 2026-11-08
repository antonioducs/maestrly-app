import type { FleetBot, FleetInboxItem } from '@maestrly/bot-fleet-protocol'
import type { Conversation, ConversationStatus } from '../../../shared/conversation'
import { type FleetServerId, fleetKey } from '../../../shared/fleet-servers'
import type { FleetBotAttentionEvent, FleetBotAttentionKind } from '../../../shared/notifications'
import type { InboxKind, InboxLane, InboxObservation, InboxPlace } from './inbox-model'
import { botRequestKind, botRequestSummary, conversationKind } from '../../../shared/inbox-kind'

export interface InboxConversationInput {
  conversation: Conversation
  /** Its workspace's name; none for a chat. */
  project?: string
  place: InboxPlace
}

export interface InboxConversationState {
  /** Live statuses, by the window's conversation id; a conversation without one has its listed status. */
  statuses: Readonly<Record<string, ConversationStatus>>
  /** The conversations marked for the owner: what ended or asked while they looked elsewhere. */
  attention: ReadonlySet<string>
  pendingPlanIds: ReadonlySet<string>
  /** When this window last saw each conversation's status change. */
  liveAt: Readonly<Record<string, number>>
}

export const conversationInboxKey = (conversationId: string): string => `conversation:${conversationId}`
export const botInboxKey = (serverId: FleetServerId, botId: string): string => `bot:${fleetKey(serverId, botId)}`
export const botRequestInboxKey = (serverId: FleetServerId, botId: string, requestId: string): string =>
  `request:${fleetKey(serverId, botId)}/${requestId}`

/** Every listed conversation, active or not: one that is not lets the center show it as read. */
export function conversationObservations(
  conversations: readonly InboxConversationInput[],
  state: InboxConversationState
): InboxObservation[] {
  const observations: InboxObservation[] = []
  for (const { conversation, project, place } of conversations) {
    if (conversation.archived === 1) continue
    const status = state.statuses[conversation.id] ?? conversation.status
    const marked = state.attention.has(conversation.id)
    const kind = conversationKind(status, state.pendingPlanIds.has(conversation.id), marked)
    const at = Math.max(conversation.lastActivityAt || 0, state.liveAt[conversation.id] ?? 0)
    observations.push({
      key: conversationInboxKey(conversation.id),
      view: {
        source: conversation.scope === 'standalone' ? 'chat' : 'workspace',
        title: conversation.name,
        ...(project ? { project } : {}),
        summary: null,
        place,
        target: { kind: 'conversation', conversationId: conversation.id },
      },
      active: kind ? { kind, unread: marked } : null,
      at: at || null,
      status,
    })
  }
  return observations
}

type InboxBot = Pick<FleetBot, 'id' | 'name' | 'tint' | 'environmentId'>

export interface InboxBotServerInput {
  serverId: FleetServerId
  bots: readonly InboxBot[]
  /** The requests waiting for the owner. */
  inbox: readonly FleetInboxItem[]
  /** Where a bot of this server runs, for the place filter. */
  place: (environmentId: string | null) => InboxPlace
}

const EVENT_KIND: Record<FleetBotAttentionKind, InboxKind> = {
  finished: 'finished',
  routineFinished: 'finished',
  activity: 'activity',
  failed: 'error',
  routineFailed: 'error',
  threadPaused: 'help',
}

function laneOf(event: FleetBotAttentionEvent | undefined): InboxLane {
  if (!event) return 'main'
  if (event.runId || event.kind === 'routineFinished' || event.kind === 'routineFailed') return 'routine'
  return event.threadId || event.kind === 'threadPaused' ? 'thread' : 'main'
}

const requestKind = botRequestKind
const requestSummary = botRequestSummary

/**
 * Each bot of each paired server, marked or not, and each request of theirs that waits for the owner. A mark says why
 * it was made when this run of the app saw it happen; one read back after a restart does not.
 */
export function botObservations(
  servers: readonly InboxBotServerInput[],
  marks: ReadonlySet<string>,
  events: ReadonlyMap<string, FleetBotAttentionEvent>
): InboxObservation[] {
  const observations: InboxObservation[] = []
  for (const { serverId, bots, inbox, place } of servers) {
    const byId = new Map(bots.map((bot) => [bot.id, bot]))
    for (const bot of bots) {
      const markKey = fleetKey(serverId, bot.id)
      const marked = marks.has(markKey)
      const event = marked ? events.get(markKey) : undefined
      const at = event && Number.isFinite(event.at) ? event.at : null
      observations.push({
        key: botInboxKey(serverId, bot.id),
        view: {
          source: 'bot',
          title: bot.name,
          bot: { name: bot.name, tint: bot.tint, lane: laneOf(event) },
          summary: event?.summary ?? null,
          place: place(bot.environmentId),
          target: {
            kind: 'bot',
            serverId,
            botId: bot.id,
            ...(event?.runId ? { runId: event.runId } : {}),
            ...(event?.threadId ? { threadId: event.threadId } : {}),
          },
        },
        active: marked ? { kind: event ? EVENT_KIND[event.kind] : 'activity', unread: true } : null,
        at,
        known: event !== undefined,
      })
    }
    for (const item of inbox) {
      const bot = byId.get(item.botId)
      const name = bot?.name ?? item.botId
      const at = Date.parse(item.interaction.at)
      const runId = item.interaction.runId
      observations.push({
        key: botRequestInboxKey(serverId, item.botId, item.interaction.id),
        view: {
          source: 'bot',
          title: name,
          bot: { name, tint: bot?.tint ?? null, lane: runId ? 'routine' : 'main' },
          summary: requestSummary(item),
          place: place(bot?.environmentId ?? null),
          target: {
            kind: 'bot',
            serverId,
            botId: item.botId,
            requestId: item.interaction.id,
            ...(runId ? { runId } : {}),
          },
        },
        active: { kind: requestKind(item), unread: true },
        at: Number.isFinite(at) ? at : null,
        ownRead: true,
        transient: true,
      })
    }
  }
  return observations
}
