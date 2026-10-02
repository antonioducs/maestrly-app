import {
  fleetMcpServerImportSchema,
  type FleetBotMcpServers,
  type FleetImportResults,
  type FleetMcpServerImport,
} from '@maestrly/bot-fleet-protocol'
import { listMcpServers, removeMcpServer, upsertMcpServerByName } from '../../../chat/mcp'
import { apiKeyStorageMode } from '../../../chat/credentials'
import { InstanceHttpError } from '../server'

export function listBotMcpServers(): FleetBotMcpServers {
  return {
    servers: listMcpServers().map((server) => ({
      id: server.id,
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      command: null,
      host: server.transport === 'http' && server.url ? safeHost(server.url) : null,
      envKeys: Object.keys(server.env ?? {}),
      headerKeys: Object.keys(server.headers ?? {}),
      unavailable: server.unavailable ?? false,
    })),
  }
}
export function importBotMcpServers(servers: readonly FleetMcpServerImport[]): FleetImportResults {
  return {
    results: servers.map((server, index) => {
      try {
        if (apiKeyStorageMode() !== 'secure')
          return { index, target: null, outcome: 'failed' as const, error: 'Secure credential storage is unavailable.' }
        const parsed = fleetMcpServerImportSchema.safeParse(server)
        if (!parsed.success) throw new Error('Invalid MCP server configuration.')
        const result = upsertMcpServerByName(parsed.data, { requireSecure: true })
        return { index, target: result.server.id, outcome: result.outcome, error: null }
      } catch (error) {
        return {
          index,
          target: null,
          outcome: 'failed' as const,
          error:
            error instanceof Error && error.message === 'Secure credential storage is unavailable.'
              ? error.message
              : 'The MCP server could not be imported.',
        }
      }
    }),
  }
}
export function removeBotMcpServer(id: string): void {
  if (!listMcpServers().some((server) => server.id === id))
    throw new InstanceHttpError(404, 'NOT_FOUND', 'MCP server does not exist.')
  removeMcpServer(id)
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
