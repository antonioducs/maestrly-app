import { z } from 'zod'
import {
  FLEET_ENVIRONMENT_UPDATES_FEATURE,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_RUNTIME_UPDATES_FEATURE,
  type FLEET_GATEWAY_ROUTES,
  fleetBotIdSchema,
  fleetEnvironmentIdSchema,
  fleetScreenSurfaceSchema,
} from '@maestrly/bot-fleet-protocol'
import {
  FLEET_ENVIRONMENTS_UNSUPPORTED,
  FLEET_UPDATES_UNSUPPORTED,
  FLEET_RUNTIME_UPDATES_UNSUPPORTED,
  FLEET_SCREEN_CONFLICT,
  FLEET_SCREEN_OFFLINE,
  FLEET_SCREEN_RESTART_REQUIRED,
  type FleetProvisioningTarget,
  type FleetScreenTarget,
} from '../../../shared/fleet-targets'
import { FleetClientError } from './api'

/** What the Mac knows about the connected gateway's features. */
export type FleetFeatures = { hasFeature(feature: string): boolean }

/** Environment routes exist only on gateways with the feature: older ones would answer 404 or drop the field. */
export function requireEnvironments(fleet: FleetFeatures): void {
  if (!fleet.hasFeature(FLEET_ENVIRONMENTS_FEATURE))
    throw new FleetClientError('INVALID_REQUEST', 400, FLEET_ENVIRONMENTS_UNSUPPORTED)
}
/** Update routes exist only on gateways that schedule environment updates. */
export function requireEnvironmentUpdates(fleet: FleetFeatures): void {
  if (!fleet.hasFeature(FLEET_ENVIRONMENT_UPDATES_FEATURE))
    throw new FleetClientError('INVALID_REQUEST', 400, FLEET_UPDATES_UNSUPPORTED)
}
/** Runtime checks exist only on gateways that relay the environments' runtimes. */
export function requireRuntimeUpdates(fleet: FleetFeatures): void {
  if (!fleet.hasFeature(FLEET_RUNTIME_UPDATES_FEATURE))
    throw new FleetClientError('INVALID_REQUEST', 400, FLEET_RUNTIME_UPDATES_UNSUPPORTED)
}

// A bare string is a bot id, as the views from before environments send it.
const provisioningTargetSchema = z.union([
  fleetBotIdSchema.transform((botId): FleetProvisioningTarget => ({ botId })),
  z.object({ botId: fleetBotIdSchema }).strict(),
  z.object({ environmentId: fleetEnvironmentIdSchema }).strict(),
])

/**
 * Validates a renderer's provisioning target. An environment target needs a gateway with environments; a bot
 * target always uses the bot routes, which such gateways keep as aliases that act on the bot's environment. An
 * environment target never falls back to a bot route: a bot may carry the id of another environment.
 */
export function resolveProvisioningTarget(fleet: FleetFeatures, raw: unknown): FleetProvisioningTarget {
  const target = provisioningTargetSchema.parse(raw)
  if ('environmentId' in target) requireEnvironments(fleet)
  return target
}

type GatewayRouteKey = keyof typeof FLEET_GATEWAY_ROUTES
/** Each provisioning operation's route on a bot and on an environment. */
const PROVISIONING_ROUTES = {
  accountsList: ['botAccountsList', 'environmentAccountsList'],
  accountsImport: ['botAccountsImport', 'environmentAccountsImport'],
  apiKeyAccountAdd: ['botApiKeyAccountAdd', 'environmentApiKeyAccountAdd'],
  accountRemove: ['botAccountRemove', 'environmentAccountRemove'],
  subscriptionRemove: ['botSubscriptionRemove', 'environmentSubscriptionRemove'],
  loginStart: ['botLoginStart', 'environmentLoginStart'],
  loginGet: ['botLoginGet', 'environmentLoginGet'],
  loginCallback: ['botLoginCallback', 'environmentLoginCallback'],
  loginCode: ['botLoginCode', 'environmentLoginCode'],
  loginCancel: ['botLoginCancel', 'environmentLoginCancel'],
  skillsList: ['botSkillsList', 'environmentSkillsList'],
  skillInstall: ['botSkillInstall', 'environmentSkillInstall'],
  skillRemove: ['botSkillRemove', 'environmentSkillRemove'],
  mcpServersList: ['botMcpServersList', 'environmentMcpServersList'],
  mcpServersImport: ['botMcpServersImport', 'environmentMcpServersImport'],
  mcpServerRemove: ['botMcpServerRemove', 'environmentMcpServerRemove'],
} as const satisfies Record<string, readonly [GatewayRouteKey, GatewayRouteKey]>
export type FleetProvisioningOp = keyof typeof PROVISIONING_ROUTES

/** The gateway route and path parameters of a provisioning operation on a validated target. */
export function provisioningRoute<Op extends FleetProvisioningOp>(
  target: FleetProvisioningTarget,
  op: Op,
  params: Record<string, string> = {}
): { key: (typeof PROVISIONING_ROUTES)[Op][number]; params: Record<string, string> } {
  const [bot, environment] = PROVISIONING_ROUTES[op]
  return 'environmentId' in target
    ? { key: environment, params: { ...params, eid: target.environmentId } }
    : { key: bot, params: { ...params, id: target.botId } }
}

// A bare string is a bot's browser area, as the views from before environments open it.
const screenTargetSchema = z.union([
  fleetBotIdSchema.transform((botId): FleetScreenTarget => ({ botId, surface: 'browser' })),
  z.object({ botId: fleetBotIdSchema, surface: fleetScreenSurfaceSchema }).strict(),
  z.object({ environmentId: fleetEnvironmentIdSchema }).strict(),
])

/**
 * Validates a renderer's screen target. Older gateways ignore the surface and serve the browser area, so the apps
 * area and the environment screen need a gateway with environments: never show one screen as another.
 */
export function resolveScreenTarget(fleet: FleetFeatures, raw: unknown): FleetScreenTarget {
  const target = screenTargetSchema.parse(raw)
  if ('environmentId' in target || target.surface !== 'browser') requireEnvironments(fleet)
  return target
}

/**
 * The gateway's two `CONFLICT` refusals of a screen ticket, told apart by their exact messages: another control
 * session holds the display that browser areas and the environment screen share, or the environment runs an image
 * from before environments, which has neither apps screens nor an environment screen.
 */
export const GATEWAY_SCREEN_CONTROLLED = 'Another screen in this environment is being controlled.'
export const GATEWAY_RESTART_TO_OPEN_SCREEN = 'Restart this environment to update it before opening this screen.'

/**
 * The error a refused screen ticket crosses IPC as, which keeps only its message: a stable marker for the refusals
 * the screen handles itself, the gateway's own error otherwise.
 */
export function screenTicketError(error: unknown): unknown {
  if (!(error instanceof FleetClientError)) return error
  if (error.code === 'BOT_NOT_RUNNING') return new Error(FLEET_SCREEN_OFFLINE)
  if (error.code !== 'CONFLICT') return error
  if (error.message === GATEWAY_SCREEN_CONTROLLED) return new Error(FLEET_SCREEN_CONFLICT)
  if (error.message === GATEWAY_RESTART_TO_OPEN_SCREEN) return new Error(FLEET_SCREEN_RESTART_REQUIRED)
  return error
}
