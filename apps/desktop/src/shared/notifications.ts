import type { FleetServerId } from './fleet-servers'

/** What a clicked system notification is about: the window shows it. */
export type NotificationTarget =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'bot'; serverId: FleetServerId; botId: string; runId?: string; threadId?: string }

/** A bot with something new for the owner on this computer. */
export type FleetBotAttentionEntry = { serverId: FleetServerId; botId: string }
export type FleetBotAttentionChange = FleetBotAttentionEntry & { attention: boolean }
