export interface BotIdentity {
  instanceId: string
  ownerUserId: string
  desktopId: string
  connectionId: string
  botName: string
}

export interface BotConversationOrigin {
  kind: 'bot'
  connectionId: string
  botName: string
}

export type BotManagementState = 'active' | 'paused' | 'revoked'

export type BotActionName = 'chats:read' | 'chats:write' | 'chats:control' | 'chats:answer'

/**
 * How far a bot's conversations may go before the person at this computer is asked.
 *
 * `ask` gates every protected operation, `auto` runs routine work and still asks for commands and
 * directories outside the project, `full` asks for nothing. It is a ceiling, not a setting the bot
 * applies: a bot may request any mode up to it and never past it.
 */
export type BotPermissionCeiling = 'ask' | 'auto' | 'full'

export const BOT_PERMISSION_CEILINGS: readonly BotPermissionCeiling[] = ['ask', 'auto', 'full']

/** Only the person decides this, so a saved record that predates the choice keeps the strictest one. */
export const DEFAULT_BOT_PERMISSION_CEILING: BotPermissionCeiling = 'ask'

/** Rank in the order the person reads them, used to compare a requested mode against the ceiling. */
export function botPermissionRank(ceiling: BotPermissionCeiling): number {
  return BOT_PERMISSION_CEILINGS.indexOf(ceiling)
}
