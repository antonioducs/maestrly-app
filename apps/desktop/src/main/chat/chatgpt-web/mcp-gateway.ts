import type { ChatGptWebCapabilityScope } from '../../../shared/chat'
import {
  connectMcpServer,
  type ListedMcpTool,
  type McpCallToolResult,
  type McpConnection,
  type McpServer,
} from '../mcp'
import { externalMcpToolReadOnly } from '../tool-policy'
import { MAX_EPHEMERAL_IMAGE_BYTES, MAX_TOOL_IMAGES_PER_RESULT, toolImageOmissionNote } from '../tool-output'

export const CHATGPT_WEB_MCP_SEARCH_MAX_RESULTS = 20
export const CHATGPT_WEB_MCP_RESULT_MAX_CHARS = 50_000
export const CHATGPT_WEB_MCP_QUERY_MAX_CHARS = 200

const MAX_VALUE_DEPTH = 8
const MAX_COLLECTION_ITEMS = 100
const TRUNCATION_MARKER = '… (truncated)'

export interface ChatGptWebMcpToolRef {
  serverId: string
  serverName: string
  toolName: string
  title?: string
  description?: string
  inputSchema?: unknown
  access: 'read' | 'write'
}

export interface ChatGptWebMcpCall {
  serverId: string
  toolName: string
  arguments?: Record<string, unknown>
}

export interface ChatGptWebMcpGateway {
  searchTools: (
    input?: { query?: string; serverId?: string; limit?: number },
    signal?: AbortSignal
  ) => Promise<{ tools: ChatGptWebMcpToolRef[]; truncated: boolean }>
  callReadTool: (input: ChatGptWebMcpCall, signal?: AbortSignal) => Promise<McpCallToolResult>
  callWriteTool: (input: ChatGptWebMcpCall, signal?: AbortSignal) => Promise<McpCallToolResult>
  close: () => Promise<void>
}

export class ChatGptWebMcpGatewayError extends Error {
  constructor(
    readonly code: 'aborted' | 'closed' | 'server_not_allowed' | 'tool_not_found' | 'scope_denied' | 'unavailable',
    message: string
  ) {
    super(message)
    this.name = 'ChatGptWebMcpGatewayError'
  }
}

export interface CreateChatGptWebMcpGatewayOptions {
  servers: readonly McpServer[]
  scopes: Readonly<Record<string, ChatGptWebCapabilityScope>>
  signal?: AbortSignal
  /** Test seam; production always uses the credential-hiding low-level connector. */
  connect?: (server: McpServer) => Promise<McpConnection>
}

function abortError(): ChatGptWebMcpGatewayError {
  return new ChatGptWebMcpGatewayError('aborted', 'MCP request aborted.')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

async function withSignals<T>(
  lifecycle: AbortSignal | undefined,
  request: AbortSignal | undefined,
  run: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  throwIfAborted(lifecycle)
  throwIfAborted(request)
  if (!lifecycle) return run(request)
  if (!request || request === lifecycle) return run(lifecycle)
  const controller = new AbortController()
  const abort = () => controller.abort()
  lifecycle.addEventListener('abort', abort, { once: true })
  request.addEventListener('abort', abort, { once: true })
  try {
    return await run(controller.signal)
  } finally {
    lifecycle.removeEventListener('abort', abort)
    request.removeEventListener('abort', abort)
  }
}

function serializedLength(value: unknown): number {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? 0 : serialized.length
}

function takeSerializedBudget(budget: { remaining: number }, size: number): boolean {
  if (size > budget.remaining) return false
  budget.remaining -= size
  return true
}

function truncatedValue(budget: { remaining: number }): string {
  const size = serializedLength(TRUNCATION_MARKER)
  if (size <= budget.remaining) budget.remaining -= size
  else budget.remaining = 0
  return TRUNCATION_MARKER
}

function truncatedString(value: string, budget: { remaining: number }): string {
  const marker = `\n${TRUNCATION_MARKER}`
  const markerSize = serializedLength(marker)
  if (markerSize > budget.remaining) return truncatedValue(budget)

  let low = 0
  let high = value.length
  let end = 0
  while (low <= high) {
    const candidateEnd = Math.floor((low + high) / 2)
    if (serializedLength(value.slice(0, candidateEnd) + marker) <= budget.remaining) {
      end = candidateEnd
      low = candidateEnd + 1
    } else {
      high = candidateEnd - 1
    }
  }
  const clipped = value.slice(0, end) + marker
  budget.remaining -= serializedLength(clipped)
  return clipped
}

function normalizedPrimitive(value: unknown, budget: { remaining: number }): unknown {
  const normalized =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value
        : String(value)
      : typeof value === 'bigint'
        ? value.toString()
        : value
  if (takeSerializedBudget(budget, serializedLength(normalized))) return normalized
  return typeof normalized === 'string' ? truncatedString(normalized, budget) : truncatedValue(budget)
}

function normalizedValue(value: unknown, budget: { remaining: number }, depth = 0): unknown {
  if (value === undefined) return undefined
  if (
    value == null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
  )
    return normalizedPrimitive(value, budget)
  if (depth >= MAX_VALUE_DEPTH || budget.remaining <= 0) return truncatedValue(budget)
  if (Array.isArray(value)) {
    if (!takeSerializedBudget(budget, 2)) return truncatedValue(budget)
    const out: unknown[] = []
    for (const item of value.slice(0, MAX_COLLECTION_ITEMS)) {
      const checkpoint = budget.remaining
      if (out.length && !takeSerializedBudget(budget, 1)) break
      const normalized = normalizedValue(item, budget, depth + 1)
      if (normalized === undefined) {
        if (!takeSerializedBudget(budget, 4)) {
          budget.remaining = checkpoint
          break
        }
        out.push(null)
      } else {
        out.push(normalized)
      }
      if (budget.remaining <= 0) break
    }
    return out
  }
  if (typeof value !== 'object') return normalizedPrimitive(String(value), budget)
  if (!takeSerializedBudget(budget, 2)) return truncatedValue(budget)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_COLLECTION_ITEMS)) {
    const checkpoint = budget.remaining
    const entrySize = serializedLength(key) + 1 + (Object.keys(out).length ? 1 : 0)
    if (!takeSerializedBudget(budget, entrySize)) break
    const normalized = normalizedValue(item, budget, depth + 1)
    if (normalized !== undefined) out[key] = normalized
    else budget.remaining = checkpoint
    if (budget.remaining <= 0) break
  }
  return out
}

/** Keeps downstream JSON/text output bounded before it reaches the remote bridge; images use their own byte/count caps. */
export function normalizeChatGptWebMcpResult(result: McpCallToolResult): McpCallToolResult {
  const hasContent = result.content !== undefined
  const hasStructuredContent = result.structuredContent !== undefined
  const hasIsError = result.isError !== undefined
  const fields = [
    ...(hasContent ? ['content'] : []),
    ...(hasStructuredContent ? ['structuredContent'] : []),
    ...(hasIsError ? ['isError'] : []),
  ]
  let fixedSerializedSize = 2
  fields.forEach((key, index) => {
    fixedSerializedSize += serializedLength(key) + 1 + (index ? 1 : 0)
  })
  if (hasContent) fixedSerializedSize += 2
  if (hasIsError) fixedSerializedSize += serializedLength(result.isError === true)
  const budget = { remaining: Math.max(0, CHATGPT_WEB_MCP_RESULT_MAX_CHARS - fixedSerializedSize) }
  const content: unknown[] = []
  let imageCount = 0
  let imageBytes = 0
  let omittedImages = 0

  const appendContentValue = (value: unknown): void => {
    const checkpoint = budget.remaining
    if (content.length && !takeSerializedBudget(budget, 1)) return
    const normalized = normalizedValue(value, budget)
    if (normalized === undefined) {
      if (!takeSerializedBudget(budget, 4)) budget.remaining = checkpoint
      else content.push(null)
    } else {
      content.push(normalized)
    }
  }

  for (const raw of Array.isArray(result.content) ? result.content : []) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const entry = raw as Record<string, unknown>
      if (entry.type === 'image' && typeof entry.data === 'string') {
        const bytes = Math.floor((entry.data.length * 3) / 4)
        if (
          imageCount < MAX_TOOL_IMAGES_PER_RESULT &&
          bytes <= MAX_EPHEMERAL_IMAGE_BYTES &&
          imageBytes + bytes <= MAX_EPHEMERAL_IMAGE_BYTES
        ) {
          imageCount++
          imageBytes += bytes
          content.push({ type: 'image', data: entry.data, mimeType: entry.mimeType })
        } else {
          omittedImages++
        }
        continue
      }
    }
    appendContentValue(raw)
  }
  if (omittedImages) appendContentValue({ type: 'text', text: toolImageOmissionNote(omittedImages) })
  return {
    ...(result.content === undefined ? {} : { content }),
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: normalizedValue(result.structuredContent, budget) }),
    ...(result.isError === undefined ? {} : { isError: result.isError === true }),
  }
}

export function createChatGptWebMcpGateway(options: CreateChatGptWebMcpGatewayOptions): ChatGptWebMcpGateway {
  const connect = options.connect ?? connectMcpServer
  const serverById = new Map(options.servers.map((server) => [server.id, server]))
  const connections = new Map<string, Promise<McpConnection>>()
  let closed = false

  const serverNotAllowedError = (): ChatGptWebMcpGatewayError => {
    const authorizedServerIds = options.servers
      .filter(
        (server) => server.enabled && (options.scopes[server.id] === 'read' || options.scopes[server.id] === 'write')
      )
      .map((server) => server.id)
    const authorized = authorizedServerIds.length ? authorizedServerIds.join(', ') : '(none)'
    return new ChatGptWebMcpGatewayError(
      'server_not_allowed',
      `MCP server is not available to this session. Use the exact serverId returned by list_external_capabilities. Currently authorized server IDs: ${authorized}.`
    )
  }

  const toolNotFoundError = (): ChatGptWebMcpGatewayError =>
    new ChatGptWebMcpGatewayError(
      'tool_not_found',
      'MCP tool was not found. Use the exact toolName returned by search_mcp_tools.'
    )

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    const pending = [...connections.values()]
    connections.clear()
    await Promise.all(
      pending.map(async (connection) => {
        const resolved = await connection.catch(() => null)
        await resolved?.close().catch(() => {})
      })
    )
  }

  options.signal?.addEventListener('abort', () => void close(), { once: true })

  const allowedServer = (serverId: string): { server: McpServer; scope: ChatGptWebCapabilityScope } => {
    if (closed) throw new ChatGptWebMcpGatewayError('closed', 'MCP gateway is closed.')
    const server = serverById.get(serverId)
    const scope = options.scopes[serverId] ?? 'off'
    if (!server?.enabled || scope === 'off') throw serverNotAllowedError()
    return { server, scope }
  }

  const connectionFor = async (serverId: string): Promise<McpConnection> => {
    const { server } = allowedServer(serverId)
    let pending = connections.get(serverId)
    if (!pending) {
      pending = connect(server)
      connections.set(serverId, pending)
      pending.catch(() => connections.delete(serverId))
    }
    try {
      const connection = await pending
      if (closed || options.signal?.aborted) {
        await connection.close().catch(() => {})
        throw abortError()
      }
      return connection
    } catch (error) {
      if (error instanceof ChatGptWebMcpGatewayError) throw error
      throw new ChatGptWebMcpGatewayError('unavailable', 'MCP server is unavailable.')
    }
  }

  const catalog = async (serverId: string, signal?: AbortSignal): Promise<ListedMcpTool[]> => {
    const connection = await connectionFor(serverId)
    try {
      return await withSignals(options.signal, signal, (merged) => connection.listTools({ signal: merged }))
    } catch (error) {
      if (options.signal?.aborted || signal?.aborted) throw abortError()
      if (error instanceof ChatGptWebMcpGatewayError) throw error
      throw new ChatGptWebMcpGatewayError('unavailable', 'MCP server catalog is unavailable.')
    }
  }

  const call = async (
    expected: 'read' | 'write',
    input: ChatGptWebMcpCall,
    signal?: AbortSignal
  ): Promise<McpCallToolResult> => {
    if (!input || typeof input.serverId !== 'string') throw serverNotAllowedError()
    if (typeof input.toolName !== 'string') throw toolNotFoundError()
    const { scope } = allowedServer(input.serverId)
    if (expected === 'write' && scope !== 'write')
      throw new ChatGptWebMcpGatewayError('scope_denied', 'MCP write access is not enabled for this server.')
    const tools = await catalog(input.serverId, signal)
    const tool = tools.find((candidate) => candidate.name === input.toolName)
    if (!tool) throw toolNotFoundError()
    const actual = externalMcpToolReadOnly(tool.annotations) ? 'read' : 'write'
    if (actual !== expected)
      throw new ChatGptWebMcpGatewayError('scope_denied', `MCP tool is not classified as ${expected}.`)
    const connection = await connectionFor(input.serverId)
    try {
      const result = await withSignals(options.signal, signal, (merged) =>
        connection.callTool(input.toolName, input.arguments ?? {}, { signal: merged })
      )
      return normalizeChatGptWebMcpResult(result)
    } catch (error) {
      if (options.signal?.aborted || signal?.aborted) throw abortError()
      if (error instanceof ChatGptWebMcpGatewayError) throw error
      throw new ChatGptWebMcpGatewayError('unavailable', 'MCP tool call failed.')
    }
  }

  return {
    searchTools: async (input = {}, signal) => {
      if (closed) throw new ChatGptWebMcpGatewayError('closed', 'MCP gateway is closed.')
      if (input.serverId !== undefined) {
        if (typeof input.serverId !== 'string') throw serverNotAllowedError()
        allowedServer(input.serverId)
      }
      const query =
        typeof input.query === 'string'
          ? input.query.trim().slice(0, CHATGPT_WEB_MCP_QUERY_MAX_CHARS).toLowerCase()
          : ''
      const requestedLimit = Number.isFinite(input.limit) ? Math.floor(input.limit as number) : 10
      const limit = Math.max(1, Math.min(CHATGPT_WEB_MCP_SEARCH_MAX_RESULTS, requestedLimit))
      const visible = options.servers.filter(
        (server) =>
          server.enabled &&
          (!input.serverId || server.id === input.serverId) &&
          (options.scopes[server.id] === 'read' || options.scopes[server.id] === 'write')
      )
      const catalogs = await Promise.all(
        visible.map(async (server) => {
          try {
            return { server, tools: await catalog(server.id, signal) }
          } catch (error) {
            if (error instanceof ChatGptWebMcpGatewayError && error.code === 'aborted') throw error
            return { server, tools: [] }
          }
        })
      )
      const matches: ChatGptWebMcpToolRef[] = []
      collect: for (const { server, tools } of catalogs) {
        const scope = options.scopes[server.id]
        for (const tool of tools) {
          const access = externalMcpToolReadOnly(tool.annotations) ? 'read' : 'write'
          if (scope === 'read' && access === 'write') continue
          const haystack =
            `${server.name}\n${tool.name}\n${tool.title ?? ''}\n${(tool.description ?? '').slice(0, 10_000)}`.toLowerCase()
          if (query && !haystack.includes(query)) continue
          matches.push({
            serverId: server.id,
            serverName: server.name,
            toolName: tool.name,
            ...(tool.title ? { title: tool.title.slice(0, 500) } : {}),
            ...(tool.description ? { description: tool.description.slice(0, 2_000) } : {}),
            ...(tool.inputSchema === undefined
              ? {}
              : { inputSchema: normalizedValue(tool.inputSchema, { remaining: 12_000 }) }),
            access,
          })
          if (matches.length > limit) break collect
        }
      }
      return { tools: matches.slice(0, limit), truncated: matches.length > limit }
    },
    callReadTool: (input, signal) => call('read', input, signal),
    callWriteTool: (input, signal) => call('write', input, signal),
    close,
  }
}
