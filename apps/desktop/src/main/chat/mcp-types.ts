import type { McpToolAnnotations } from './tool-policy'

/** Transports of servers the user adds. */
export type UserMcpTransport = 'http' | 'stdio'
/** `sse` (legacy HTTP+SSE) is reachable only through plugins. */
export type McpTransport = UserMcpTransport | 'sse'

export interface McpServer {
  id: string
  name: string
  transport: McpTransport
  enabled: boolean
  unavailable?: boolean
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Set for servers an installed plugin provides; they are managed in Settings → Plugins, never edited here. */
  origin?: { kind: 'plugin'; pluginKey: string; pluginName: string; serverKey: string }
  /** Set for plugin servers that declare OAuth sign-in, with the scopes and resource indicator they ask for. */
  oauth?: { scopes?: string[]; resource?: string }
  cwd?: string
  startupTimeoutMs?: number
  toolTimeoutMs?: number
  toolFilter?: { allow?: string[]; deny?: string[] }
  /**
   * Set only on a per-account connection of a server with several signed-in accounts: the account whose tokens this
   * connection uses. Each account gets its own connection.
   */
  oauthAccountId?: string
}

/** Pool key of a connection: one per server, or one per signed-in account of the server. */
export const mcpConnectionKey = (server: Pick<McpServer, 'id' | 'oauthAccountId'>): string =>
  server.oauthAccountId ? `${server.id}#${server.oauthAccountId}` : server.id

/** A server from the user's own MCP settings (`chat.mcpServers`). */
export type UserMcpServer = McpServer & { transport: UserMcpTransport }

export interface ListedMcpTool {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
  annotations?: McpToolAnnotations
}

export interface McpCallToolResult {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
}

export interface McpRequestOptions {
  signal?: AbortSignal
  timeout?: number
}

/** Low-level MCP connection shared by the lazy pool and in-process adapters. */
export interface McpConnection {
  listTools: (options?: McpRequestOptions) => Promise<ListedMcpTool[]>
  callTool: (name: string, args?: Record<string, unknown>, options?: McpRequestOptions) => Promise<McpCallToolResult>
  close: () => Promise<void>
}
