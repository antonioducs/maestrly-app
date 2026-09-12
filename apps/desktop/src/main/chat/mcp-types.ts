import type { McpToolAnnotations } from './tool-policy'

export type McpTransport = 'http' | 'stdio'

export interface McpServer {
  id: string
  name: string
  transport: McpTransport
  enabled: boolean
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
}

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
