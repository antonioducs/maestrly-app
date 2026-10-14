import path from 'node:path'
import { FLEET_BOT_ENV, fleetEnvironmentIdSchema } from '@maestrly/bot-fleet-protocol'
import {
  type EnvironmentInstanceConfig,
  isBotMode,
  parseEnvironmentControl,
  tokenSchema,
} from '../../fleet/instance/config'
import type { GatewayConfig } from '../../fleet/instance/gateway-client'

/**
 * Server mode: this app hosts workspaces and chats in a server container and is driven from Maestrly on the owner's
 * computers (a workspaces environment of the bot gateway). A container that also has bot mode set is a bot.
 */
export const isServerMode = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[FLEET_BOT_ENV.serverMode] === '1' && !isBotMode(env)

/** Bot and server mode share a window nobody looks at: hidden, without an app menu, never quitting on close. */
export const isHeadlessInstance = (env: NodeJS.ProcessEnv = process.env): boolean => isBotMode(env) || isServerMode(env)

export type ServerModeConfig = EnvironmentInstanceConfig & {
  /** The host directory the gateway mounted for workspaces and their files; null when it mounted none. */
  workspacesRoot: string | null
}

export function parseServerModeConfig(env: NodeJS.ProcessEnv = process.env): ServerModeConfig | null {
  if (!isServerMode(env)) return null
  const root = env[FLEET_BOT_ENV.workspacesRoot]
  return { ...parseEnvironmentControl(env), workspacesRoot: root && path.isAbsolute(root) ? root : null }
}

/** Where a workspaces host publishes its chats' artifacts: the gateway that runs it, as the environment it is. */
export type HostGatewayAccess = { gateway: GatewayConfig; environmentId: string }

/**
 * Takes a workspaces host's gateway access out of the environment, so the shells and agents it starts do not inherit
 * the token. Null outside server mode, and from a gateway that predates host tokens.
 */
export function takeHostGatewayAccess(env: NodeJS.ProcessEnv = process.env): HostGatewayAccess | null {
  const token = tokenSchema.safeParse(env[FLEET_BOT_ENV.hostGatewayToken])
  delete env[FLEET_BOT_ENV.hostGatewayToken]
  if (!isServerMode(env) || !token.success) return null
  const url = env[FLEET_BOT_ENV.gatewayUrl]
  const environmentId = fleetEnvironmentIdSchema.safeParse(env[FLEET_BOT_ENV.environmentId])
  if (!url || !URL.canParse(url) || !environmentId.success) return null
  return { gateway: { url, token: token.data }, environmentId: environmentId.data }
}
