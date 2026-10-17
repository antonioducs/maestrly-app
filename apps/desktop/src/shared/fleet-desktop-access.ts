import type { FleetDesktopLinkView } from '@maestrly/bot-fleet-protocol'
import type { BotActionName, BotPermissionCeiling } from './bot'

/** What this computer gives one fleet bot: its projects, models, actions and ceiling, and the name it shows the bot. */
export interface FleetDesktopAccessInput {
  /** The name this computer shows to the bot, its pairing name by default. */
  macName: string
  workspaceIds: string[]
  actions: BotActionName[]
  selections: Array<{ providerId: string; modelId: string }>
  permissionCeiling: BotPermissionCeiling
}

/**
 * What a workspaces host gives one fleet bot, as the owner's computer sends it over the bridge: the access itself
 * (`macName` is the name the bot sees the environment by), and the bot's name for the host's own record.
 */
export interface EnvironmentBotAccessInput extends FleetDesktopAccessInput {
  botName: string
}

/** One fleet bot's access to computers, as this computer sees it. */
export interface FleetDesktopAccessView {
  /**
   * `ready`: this computer can give the bot access. Otherwise what is missing: a bot server with the desktop bridge, a bot
   * restarted on an image that has it, or this computer's connection to the server; for a workspaces environment, a
   * host restarted on an image that takes bots' calls (`host-update`).
   */
  availability: 'ready' | 'gateway-update' | 'bot-update' | 'host-update' | 'disconnected'
  /** What this computer gave the bot; null when it gave it nothing. */
  access: FleetDesktopAccessInput | null
  /** Every computer linked to the bot, this one marked `self`; null when the server could not be asked. */
  links: FleetDesktopLinkView[] | null
  /** The name this computer shows unless the owner picks another: its pairing name. */
  defaultName: string
}
