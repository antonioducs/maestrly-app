import type { FleetScreenSurface } from '@maestrly/bot-fleet-protocol'

/**
 * Where the Mac sends accounts, skills, MCP servers and sign-ins: an environment, shared by its bots, or a bot. On
 * gateways with environments a bot's routes act on its environment; older gateways only know bots.
 */
export type FleetProvisioningTarget = { environmentId: string } | { botId: string }
/** A bare string is a bot id, as the views from before environments pass it. */
export type FleetProvisioningTargetInput = FleetProvisioningTarget | string

/** A screen: a bot's browser or apps area, or an environment's own screen (its Maestrly settings window). */
export type FleetScreenTarget = { botId: string; surface: FleetScreenSurface } | { environmentId: string }
/** A bare string is a bot's browser area, as the views from before environments open it. */
export type FleetScreenTargetInput = FleetScreenTarget | string

/** Environments and bots can share an id (an existing bot became the environment with its id): keys name the kind. */
export function fleetTargetKey(target: FleetProvisioningTargetInput): string {
  if (typeof target === 'string') return 'bot:' + target
  return 'environmentId' in target ? 'environment:' + target.environmentId : 'bot:' + target.botId
}

/** Raised by the main process when the gateway predates environments; IPC keeps only an error's message. */
export const FLEET_ENVIRONMENTS_UNSUPPORTED = 'FLEET_ENVIRONMENTS_UNSUPPORTED'
/** Raised when another control session holds the environment display that browser areas and its screen share. */
export const FLEET_SCREEN_CONFLICT = 'FLEET_SCREEN_CONFLICT'
