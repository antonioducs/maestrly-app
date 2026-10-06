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

/** One fleet bot's access to computers, as this computer sees it. */
export interface FleetDesktopAccessView {
  /**
   * `ready`: this computer can give the bot access. Otherwise what is missing: a bot server with the desktop bridge, a bot
   * restarted on an image that has it, or this computer's connection to the server.
   */
  availability: 'ready' | 'gateway-update' | 'bot-update' | 'disconnected'
  /** What this computer gave the bot; null when it gave it nothing. */
  access: FleetDesktopAccessInput | null
  /** Every computer linked to the bot, this one marked `self`; null when the server could not be asked. */
  links: FleetDesktopLinkView[] | null
  /** The name this computer shows unless the owner picks another: its pairing name. */
  defaultName: string
}
