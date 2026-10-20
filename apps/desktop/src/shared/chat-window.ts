import { type FleetServerId, fleetKey } from './fleet-servers'

/** A conversation of this computer, or a bot of one of the paired servers: bots of two servers may share an id. */
export type ChatWindowTarget =
  | { kind: 'conversation'; id: string }
  | { kind: 'bot'; serverId: FleetServerId; id: string }
export type ChatWindowRequest = ChatWindowTarget & { title: string }

export function chatWindowKey(target: ChatWindowTarget): string {
  return target.kind === 'bot' ? `bot:${fleetKey(target.serverId, target.id)}` : `conversation:${target.id}`
}
