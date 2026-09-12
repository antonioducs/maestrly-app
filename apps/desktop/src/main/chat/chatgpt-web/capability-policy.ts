import { createHash } from 'node:crypto'
import type {
  ChatGptWebCapabilities,
  ChatGptWebCapabilitiesInfo,
  ChatGptWebCapabilityScope,
} from '../../../shared/chat'
import type { McpServer } from '../mcp'

export interface ChatGptWebRemoteMcpServerCapability {
  serverId: string
  name: string
  scope: Exclude<ChatGptWebCapabilityScope, 'off'>
}

function validMcpScope(value: unknown): value is ChatGptWebCapabilityScope {
  return value === 'off' || value === 'read' || value === 'write'
}

/** Resolve persisted preferences against the current global MCP catalog. Disabled/removed servers fail closed. */
export function resolveChatGptWebCapabilities(
  stored: ChatGptWebCapabilities | null | undefined,
  servers: readonly McpServer[]
): ChatGptWebCapabilities {
  const mcp: Record<string, ChatGptWebCapabilityScope> = {}
  for (const server of servers) {
    const requested = stored?.mcp?.[server.id]
    mcp[server.id] = server.enabled ? (validMcpScope(requested) ? requested : 'read') : 'off'
  }
  return {
    git: stored?.git === 'off' ? 'off' : 'read',
    gh: stored?.gh === 'off' ? 'off' : 'read',
    conversation: stored?.conversation === 'read' ? 'read' : 'off',
    memory: stored?.memory === 'read' ? 'read' : 'off',
    browser: stored?.browser === 'inspect' || stored?.browser === 'interact' ? stored.browser : 'off',
    mcp,
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)])
  )
}

/** Includes a one-way digest of local MCP config so URL/command/auth changes rotate the remote capability. */
export function chatGptWebCapabilityFingerprint(
  capabilities: ChatGptWebCapabilities,
  servers: readonly McpServer[]
): string {
  const serverById = new Map(servers.map((server) => [server.id, server]))
  const mcp = Object.keys(capabilities.mcp)
    .sort()
    .map((id) => {
      const server = serverById.get(id)
      const configDigest = server
        ? createHash('sha256').update(JSON.stringify(canonical(server))).digest('hex')
        : 'removed'
      return [id, capabilities.mcp[id], configDigest]
    })
  return createHash('sha256')
    .update(
      JSON.stringify([
        'chatgpt-web-capabilities',
        6,
        capabilities.git,
        capabilities.gh,
        capabilities.conversation,
        capabilities.memory,
        capabilities.browser,
        mcp,
      ])
    )
    .digest('hex')
}

export function chatGptWebCapabilitiesInfo(
  stored: ChatGptWebCapabilities | null | undefined,
  servers: readonly McpServer[],
  editable: boolean
): ChatGptWebCapabilitiesInfo {
  const capabilities = resolveChatGptWebCapabilities(stored, servers)
  return {
    capabilities,
    mcpServers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      scope: capabilities.mcp[server.id] ?? 'off',
    })),
    editable,
    fingerprint: chatGptWebCapabilityFingerprint(capabilities, servers),
  }
}

/** Only capabilities authorized for the remote companion are disclosed; local UI data stays richer. */
export function remoteMcpServerCapabilities(
  capabilities: ChatGptWebCapabilities,
  servers: readonly McpServer[]
): ChatGptWebRemoteMcpServerCapability[] {
  return servers.flatMap((server) => {
    const scope = capabilities.mcp[server.id]
    return scope === 'read' || scope === 'write' ? [{ serverId: server.id, name: server.name, scope }] : []
  })
}
