import path from 'node:path'
import { FLEET_BOT_ENV } from '@maestrly/bot-fleet-protocol'
import { type EnvironmentInstanceConfig, isBotMode, parseEnvironmentControl } from '../../fleet/instance/config'

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
