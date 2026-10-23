import { type FleetServerId, fleetKey, isFleetServerId } from './fleet-servers'

/** A conversation of this computer, or a bot of one of the paired servers: bots of two servers may share an id. */
export type ChatWindowTarget =
  | { kind: 'conversation'; id: string }
  | { kind: 'bot'; serverId: FleetServerId; id: string }
export type ChatWindowRequest = ChatWindowTarget & { title: string }

export function chatWindowKey(target: ChatWindowTarget): string {
  return target.kind === 'bot' ? `bot:${fleetKey(target.serverId, target.id)}` : `conversation:${target.id}`
}

/** The target a chat window key names, or null for a key no chat window has. */
export function parseChatWindowKey(key: string): ChatWindowTarget | null {
  if (key.startsWith('conversation:')) {
    const id = key.slice('conversation:'.length)
    return id ? { kind: 'conversation', id } : null
  }
  if (!key.startsWith('bot:')) return null
  const rest = key.slice('bot:'.length)
  const at = rest.indexOf('/')
  const serverId = rest.slice(0, at)
  const id = rest.slice(at + 1)
  return at > 0 && id && isFleetServerId(serverId) ? { kind: 'bot', serverId, id } : null
}
