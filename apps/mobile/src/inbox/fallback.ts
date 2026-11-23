import {
  fleetAttentionKey,
  type FleetBot,
  type FleetEnvironment,
  type FleetInboxItem,
  type MobileLists,
} from '@maestrly/bot-fleet-protocol'
import {
  botRequestKind,
  botRequestSummary,
  conversationKind,
  type InboxObservation,
} from '@maestrly/bot-fleet-protocol/inbox'
import { allConversations } from '../chats/state'
import { inboxItemKey, mobileInboxPlace } from './types'

export interface FallbackSourceInput {
  serverId: string
  serverName: string
  bots: readonly FleetBot[]
  environments: readonly FleetEnvironment[]
  inbox: readonly FleetInboxItem[]
  /** Active workspaces environment id whose `chatLists` are loaded, if any. */
  environmentId: string | null
  chatLists: MobileLists | null
}

/**
 * Fallback observations for the active server when its gateway does not advertise `FLEET_ATTENTION_FEATURE`:
 * derives pending bot requests from `fleet.inbox` (mirroring desktop `botObservations`) and waiting/asking chats
 * from the active environment's bridge lists. Non-active servers without the feature contribute nothing.
 */
export function fallbackObservations(input: FallbackSourceInput): InboxObservation<string>[] {
  const observations: InboxObservation<string>[] = []
  const botsById = new Map(input.bots.map((bot) => [bot.id, bot]))
  const envNames = new Map(input.environments.map((env) => [env.id, env.name]))
  const envCount = input.environments.length

  for (const item of input.inbox) {
    const bot = botsById.get(item.botId)
    const name = bot?.name ?? item.botId
    const envId = bot?.environmentId ?? null
    const envName = envId ? (envNames.get(envId) ?? null) : null
    const at = Date.parse(item.interaction.at)
    const runId = item.interaction.runId
    observations.push({
      key: inboxItemKey(input.serverId, fleetAttentionKey.request(item.botId, item.interaction.id)),
      view: {
        source: 'bot',
        title: name,
        bot: { name, tint: bot?.tint ?? null, lane: runId ? 'routine' : 'main' },
        summary: botRequestSummary(item),
        place: mobileInboxPlace(input.serverId, input.serverName, envId, envName, envCount),
        target: {
          kind: 'bot',
          serverId: input.serverId,
          botId: item.botId,
          requestId: item.interaction.id,
          ...(runId ? { runId } : {}),
        },
      },
      active: { kind: botRequestKind(item), unread: true },
      at: Number.isFinite(at) ? at : null,
      ownRead: true,
      transient: true,
    })
  }

  if (input.chatLists && input.environmentId) {
    const envName = envNames.get(input.environmentId) ?? null
    const place = mobileInboxPlace(input.serverId, input.serverName, input.environmentId, envName, envCount)
    for (const conversation of allConversations(input.chatLists)) {
      const kind = conversationKind(conversation.status, false, false)
      const at = Date.parse(conversation.lastActivityAt)
      observations.push({
        key: inboxItemKey(input.serverId, fleetAttentionKey.chat(input.environmentId, conversation.id)),
        view: {
          source: conversation.workspaceId ? 'workspace' : 'chat',
          title: conversation.name,
          ...(conversation.workspaceName ? { project: conversation.workspaceName } : {}),
          summary: null,
          place,
          target: { kind: 'conversation', conversationId: conversation.id },
        },
        active: kind ? { kind, unread: true } : null,
        at: Number.isFinite(at) ? at : null,
        ownRead: true,
        status: conversation.status,
      })
    }
  }

  return observations
}
