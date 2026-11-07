import type { FleetServerId } from './fleet-servers'

/** What a clicked system notification is about: the window shows it. */
export type NotificationTarget =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'bot'; serverId: FleetServerId; botId: string; runId?: string; threadId?: string }

/**
 * What last marked a bot, as the notifications center shows it: a turn of the bot's own conversation that ended or
 * failed, a routine run that ended or failed, a conversation between bots that paused for the owner, or a turn
 * answering another bot (`activity`).
 */
export type FleetBotAttentionKind =
  | 'finished'
  | 'failed'
  | 'routineFinished'
  | 'routineFailed'
  | 'threadPaused'
  | 'activity'

export interface FleetBotAttentionEvent {
  kind: FleetBotAttentionKind
  /** When it happened, in milliseconds. */
  at: number
  /** What the bot said last, or what waits for the owner. */
  summary: string | null
  runId?: string
  threadId?: string
}

/**
 * A bot with something new for the owner on this computer, and what marked it last when this run of the app saw it
 * (absent for a mark kept from before a restart).
 */
export type FleetBotAttentionEntry = { serverId: FleetServerId; botId: string; last?: FleetBotAttentionEvent }
export type FleetBotAttentionChange = FleetBotAttentionEntry & { attention: boolean }
