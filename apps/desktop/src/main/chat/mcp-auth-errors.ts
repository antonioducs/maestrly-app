import { isBotMode } from '../fleet/instance/config'
import type { McpServer } from './mcp-types'

/**
 * Where the person fixes a server's sign-in, for the model to repeat: a bot's servers live in its environment, whose
 * settings are on the person's computer; a plugin's are managed with the plugin.
 */
function signInPlace(server: Pick<McpServer, 'origin'>): string {
  const tab = server.origin?.kind === 'plugin' ? 'Plugins' : 'Tools'
  return isBotMode()
    ? `this bot's environment settings in the Maestrly app (open the environment, choose the gear icon, then ${tab})`
    : `Settings → Maestrly Chat → ${tab}`
}

const hasAuthorizationHeader = (server: Pick<McpServer, 'headers'>): boolean =>
  Object.keys(server.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')

/**
 * A remote MCP server that needs an interactive OAuth sign-in, or whose access token was rejected. Background turns
 * never open a browser, so its tools fail with this message until someone signs in or replaces the token.
 */
export class McpNeedsAuthError extends Error {
  readonly serverId: string

  constructor(server: Pick<McpServer, 'id' | 'name' | 'headers' | 'origin'>, accountLabel?: string) {
    const place = signInPlace(server)
    super(
      hasAuthorizationHeader(server)
        ? `Access token rejected: "${server.name}" did not accept its token. Replace it in ${place}, then try again.`
        : `Sign-in required: connect "${server.name}"${accountLabel ? ` (account "${accountLabel}")` : ''} in ${place}, then try again.`
    )
    this.serverId = server.id
    this.name = 'McpNeedsAuthError'
  }
}

export const isMcpNeedsAuthError = (error: unknown): error is McpNeedsAuthError =>
  error instanceof Error && error.name === 'McpNeedsAuthError'
