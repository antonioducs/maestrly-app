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

/** A personal bot is connected on this computer alone: no account, bridge or remote instance. */
export interface BotSetupInput {
  name: string
  /** Reuse the OAuth client id a bot already holds; when omitted one is minted for this connection. */
  clientId?: string
  workspaceIds: string[]
  providerIds: string[]
  actions?: BotActionName[]
  selections?: Array<{ providerId: string; modelId: string }>
  permissionCeiling?: BotPermissionCeiling
}

export interface BotServerInput {
  enabled?: boolean
  host?: string
  port?: number
  publicUrl?: string
}

export interface BotServerView {
  enabled: boolean
  host: string
  port: number
  /** Public HTTPS address a bot reaches this computer at. Empty until the person publishes one. */
  publicUrl: string
  state: 'stopped' | 'starting' | 'listening' | 'error'
  error?: string
}

/** A bot waiting for the person at this computer to approve it and pick the connection it acts as. */
export interface BotPendingAuthorization {
  id: string
  clientName: string
  redirectUri: string
}

export interface BotConnectionView {
  id: string
  name: string
  clientId: string
  desktopId: string
  workspaceIds: string[]
  revokedAt: string | null
  mcpConfig: string
  actions: BotActionName[]
  /** The furthest this bot's conversations may go on their own before they ask the person. */
  permissionCeiling: BotPermissionCeiling
  /** Saved by a release that relayed through a server; kept read-only until reconnected here. */
  legacy: boolean
}

export interface BotSettingsView {
  connections: BotConnectionView[]
  server: BotServerView
  pendingAuthorizations: BotPendingAuthorization[]
  state: 'stopped' | 'connecting' | 'connected' | 'offline' | 'error'
  error?: string
}
