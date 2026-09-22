import type { BotActionName, BotPermissionCeiling, BotServerView, BotSettingsView } from '../../../shared/bot'

/** The saved half of the embedded server: exactly what the connection form edits before sending it back. */
export type ServerDraft = Pick<BotServerView, 'enabled' | 'host' | 'port' | 'publicUrl'>

export type BotWorkspaceOption = Awaited<ReturnType<typeof window.api.listWorkspaces>>[number]
export type BotProviderOption = Awaited<ReturnType<typeof window.api.platformExecutorProviders>>[number]

export const BOT_ACTION_NAMES: readonly BotActionName[] = ['chats:read', 'chats:write', 'chats:control', 'chats:answer']

/** Offered in the order they widen, so the person reads the strictest choice first. */
export const BOT_PERMISSION_CEILING_NAMES: readonly BotPermissionCeiling[] = ['ask', 'auto', 'full']

/** What a bot the person just approved starts with: routine work runs, commands still ask. */
export const SUGGESTED_BOT_PERMISSION_CEILING: BotPermissionCeiling = 'auto'

export const defaultServer: BotServerView = {
  enabled: false,
  host: '127.0.0.1',
  port: 14310,
  publicUrl: '',
  state: 'stopped',
}

export const emptyBotSettings: BotSettingsView = {
  connections: [],
  server: defaultServer,
  pendingAuthorizations: [],
  state: 'stopped',
}

/** Mirrors BOT_MCP_PATH in the protocol: a bot talks to this path, never to the bare address. */
export const MCP_PATH = '/mcp/bots'

export const inputClass =
  'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring'

/** What a bot is actually pointed at, which is the endpoint and not the address that hosts it. */
export function endpointOf(config: ServerDraft): string {
  const base = config.publicUrl.trim().replace(/\/+$/, '')
  return `${base || `http://${config.host.trim() || defaultServer.host}:${config.port}`}${MCP_PATH}`
}

/** A bot that runs on the internet only reaches a public HTTPS address; anything else stays here. */
export function localOnly(address: string): boolean {
  try {
    const { protocol, hostname } = new URL(address)
    return protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(hostname)
  } catch {
    return true
  }
}
