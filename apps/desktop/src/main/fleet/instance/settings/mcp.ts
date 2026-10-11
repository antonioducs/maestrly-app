import {
  FLEET_SETTINGS_OPERATIONS,
  fleetSettingsMcpCreateSchema,
  type FleetEnvironmentSettingsService,
  type FleetSettingsInput,
  type FleetSettingsOutput,
} from '@maestrly/bot-fleet-protocol'
import {
  addMcpServer,
  connectMcpServer,
  listMcpServers,
  removeMcpServer,
  updateMcpServer,
  type McpConnection,
  type McpServer,
} from '../../../chat/mcp'
import { InstanceHttpError } from '../server'
import { settingsRevision, withSettingsRevision } from './revisions'

const TEST_TIMEOUT_MS = 10_000
const MAX_CONCURRENT_TESTS = 4
const connectionTests = new Map<string, Promise<FleetSettingsOutput<'testMcpServer'>>>()
function findServer(id: string): McpServer {
  const server = listMcpServers().find((item) => item.id === id)
  if (!server) throw new InstanceHttpError(404, 'NOT_FOUND', 'MCP server does not exist.')
  return server
}
function safeHost(server: McpServer): string | null {
  if (server.transport !== 'http' || !server.url) return null
  try {
    return new URL(server.url).host
  } catch {
    return null
  }
}
function summary(server: McpServer): FleetSettingsOutput<'mcpServer'> {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    revision: settingsRevision('mcp:' + server.id),
    hasCommand: Boolean(server.command),
    hasArgs: Boolean(server.args?.length),
    hasUrl: Boolean(server.url),
    host: safeHost(server),
    envKeys: Object.keys(server.env ?? {}),
    headerKeys: Object.keys(server.headers ?? {}),
    unavailable: server.unavailable ?? false,
  }
}
function invalidConfig(): never {
  throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid MCP server configuration.')
}
function validate(server: Omit<McpServer, 'id'>): FleetSettingsInput<'createMcpServer'> {
  const { name, transport, enabled, url, command, args, headers, env } = server
  const parsed = fleetSettingsMcpCreateSchema.safeParse({ name, transport, enabled, url, command, args, headers, env })
  if (!parsed.success || (transport === 'stdio' && !command?.trim())) invalidConfig()
  return parsed.data
}
function mergeSecrets(
  existing: Record<string, string> | undefined,
  changes: FleetSettingsInput<'patchMcpServer'>['env']
): Record<string, string> | undefined {
  if (!changes) return existing
  const result = { ...existing }
  for (const [key, value] of Object.entries(changes.set ?? {})) {
    // Empty secret editors preserve the stored value; deletion is explicit.
    if (value !== '')
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true })
  }
  for (const key of changes.remove ?? []) delete result[key]
  return result
}

async function testConnection(server: McpServer): Promise<FleetSettingsOutput<'testMcpServer'>> {
  if (server.unavailable) return { code: 'unavailable', toolCount: 0 }
  try {
    validate(server)
  } catch {
    return { code: 'invalid-config', toolCount: 0 }
  }
  const controller = new AbortController()
  let connection: McpConnection | undefined
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      controller.abort()
      reject(new Error('timeout'))
    }, TEST_TIMEOUT_MS)
  })
  const work = (async () => {
    const connected = await connectMcpServer(server, { signal: controller.signal, timeout: TEST_TIMEOUT_MS })
    // A transport ignoring cancellation may connect after the timeout; never leak it.
    if (expired) {
      await connected.close().catch(() => {})
      return 0
    }
    connection = connected
    const tools = await connected.listTools({ signal: controller.signal, timeout: TEST_TIMEOUT_MS })
    return tools.length
  })()
  try {
    return { code: 'ok', toolCount: await Promise.race([work, timeout]) }
  } catch {
    return { code: expired ? 'timeout' : 'connection-failed', toolCount: 0 }
  } finally {
    clearTimeout(timer)
    controller.abort()
    // Initiate cleanup even when a broken transport never resolves close().
    if (connection) void connection.close().catch(() => {})
  }
}

type McpOperations =
  | 'mcpServers'
  | 'mcpServer'
  | 'createMcpServer'
  | 'patchMcpServer'
  | 'removeMcpServer'
  | 'testMcpServer'
export const mcpSettingsService: Pick<FleetEnvironmentSettingsService, McpOperations> = {
  async mcpServers() {
    const servers = listMcpServers().map(summary)
    return { revision: settingsRevision('mcp'), servers }
  },
  async mcpServer(input) {
    return summary(findServer(input.id))
  },
  async createMcpServer(input) {
    const parsed = FLEET_SETTINGS_OPERATIONS.createMcpServer.input.safeParse(input)
    if (!parsed.success) invalidConfig()
    return summary(addMcpServer(validate(parsed.data), { requireSecure: true }))
  },
  async patchMcpServer(input) {
    const replacement =
      input.replace &&
      Object.fromEntries(
        Object.entries(input.replace).filter(([key, value]) => !(['url', 'command'].includes(key) && value === ''))
      )
    const parsed = FLEET_SETTINGS_OPERATIONS.patchMcpServer.input.safeParse({ ...input, replace: replacement })
    if (!parsed.success) invalidConfig()
    const patch = parsed.data
    await withSettingsRevision('mcp:' + patch.id, patch.expectedRevision, () => {
      const previous = findServer(patch.id)
      if (previous.unavailable)
        throw new InstanceHttpError(409, 'INSTANCE_UNAVAILABLE', 'MCP connection details are unavailable.')
      const transport = patch.transport ?? previous.transport
      const switching = transport !== previous.transport
      // Switching must supply new destination details, even if obsolete fields were stored before.
      if (switching && !(transport === 'http' ? patch.replace?.url : patch.replace?.command?.trim())) invalidConfig()
      const details: Partial<McpServer> = switching ? {} : previous
      const next = {
        ...details,
        ...patch.replace,
        transport,
        name: patch.name ?? previous.name,
        enabled: patch.enabled ?? previous.enabled,
        env: mergeSecrets(details.env, patch.env),
        headers: mergeSecrets(details.headers, patch.headers),
      }
      // Explicit undefined values clear fields in updateMcpServer's partial merge.
      if (transport === 'http') {
        next.command = undefined
        next.args = undefined
        next.env = undefined
      } else {
        next.url = undefined
        next.headers = undefined
      }
      updateMcpServer(patch.id, validate(next), { requireSecure: true })
    })
    return summary(findServer(patch.id))
  },
  async removeMcpServer(input) {
    await withSettingsRevision('mcp:' + input.id, input.expectedRevision, () => {
      findServer(input.id)
      removeMcpServer(input.id)
    })
    return { removed: true }
  },
  async testMcpServer(input) {
    const server = findServer(input.id)
    const key = input.id + ':' + settingsRevision('mcp:' + input.id)
    const existing = connectionTests.get(key)
    if (existing) return existing
    if (connectionTests.size >= MAX_CONCURRENT_TESTS)
      throw new InstanceHttpError(409, 'CONFLICT', 'Connection tests are busy. Try again shortly.')
    const pending = testConnection(server)
    connectionTests.set(key, pending)
    try {
      return await pending
    } finally {
      connectionTests.delete(key)
    }
  },
}
