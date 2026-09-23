/**
 * Loopback MCP server that hosts Maestrly's delegation tools (`task` / `delegate`) for root Codex threads.
 *
 * Why MCP instead of a dynamic tool: Codex runs every dynamic tool under its turn-wide write lock, so
 * independent `task` calls emitted in one response executed one after another. Tools from an MCP server
 * configured with `supports_parallel_tool_calls` take the shared read lock and overlap (verified against the
 * pinned 0.155.1 runtime; 0.153.4 still ran these MCP calls serially, with otherwise identical results).
 *
 * Security: binds 127.0.0.1, rejects non-loopback `Host` headers (DNS rebinding), bounds the body and requires a
 * per-process bearer token. Codex reads the token from its own environment (`bearer_token_env_var`), so the
 * secret never enters thread config, rollouts or argv.
 *
 * Cancellation is deliberately NOT tied to the HTTP request: Maestrly owns the task lifecycle (turn abort,
 * pending-request cancellation, and quota failover that must let in-flight subagents settle).
 */
import http from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { listenOnFreePort } from '../../net-port'
import type { CodexToolContentItem } from '../tool-output'

export const CODEX_HOST_MCP_SERVER_NAME = 'maestrly'
export const CODEX_HOST_MCP_TOKEN_ENV = 'MAESTRLY_CODEX_HOST_MCP_TOKEN'
/** Host-owned tools that must overlap when the model emits several of them in one response. */
export const CODEX_HOST_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(['task', 'delegate'])

const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_TOOLSETS = 256
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
/** Subagents may legitimately run for hours; Maestrly, not the Codex MCP client, bounds their lifetime. */
const TOOL_TIMEOUT_SEC = 7 * 24 * 60 * 60
const STARTUP_TIMEOUT_SEC = 30

export interface CodexHostMcpToolSpec {
  name: string
  description: string
  inputSchema: unknown
}

export interface CodexHostMcpCall {
  name: string
  arguments: unknown
  /** `_meta.threadId` sent by Codex; routes the call to the active Maestrly turn. */
  threadId: string
  /** `_meta.callId` sent by Codex; equals the `mcpToolCall` item id shown in the transcript. */
  callId: string
}

export type CodexHostMcpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface CodexHostMcpCallResult {
  content: CodexHostMcpContent[]
  isError?: boolean
}

export type CodexHostMcpCallHandler = (call: CodexHostMcpCall) => Promise<CodexHostMcpCallResult>

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

const token = randomBytes(32).toString('hex')
const toolsets = new Map<string, CodexHostMcpToolSpec[]>()
let callHandler: CodexHostMcpCallHandler | null = null
let listening: Promise<{ server: http.Server; port: number }> | null = null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Environment for every Codex app-server process spawned by this Maestrly process. */
export function codexHostMcpProcessEnv(): Record<string, string> {
  return { [CODEX_HOST_MCP_TOKEN_ENV]: token }
}

export function setCodexHostMcpCallHandler(handler: CodexHostMcpCallHandler | null): void {
  callHandler = handler
}

/** Projects the dynamic-tool response items Maestrly already builds onto MCP `CallToolResult` content. */
export function codexContentItemsToHostMcpContent(items: readonly CodexToolContentItem[]): CodexHostMcpContent[] {
  const content = items.flatMap((item): CodexHostMcpContent[] => {
    if (item.type === 'inputText') return [{ type: 'text', text: item.text }]
    const image = /^data:([^;,]+);base64,(.*)$/s.exec(item.imageUrl)
    return image ? [{ type: 'image', mimeType: image[1], data: image[2] }] : []
  })
  return content.length ? content : [{ type: 'text', text: '(no output)' }]
}

function rememberToolset(key: string, tools: CodexHostMcpToolSpec[]): void {
  // Codex caches `tools/list` for as long as a thread stays loaded, so keys outlive the turn that created them.
  toolsets.delete(key)
  toolsets.set(key, tools)
  while (toolsets.size > MAX_TOOLSETS) {
    const oldest = toolsets.keys().next().value
    if (oldest === undefined) break
    toolsets.delete(oldest)
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

function authorized(header: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${token}`)
  const actual = Buffer.from(header ?? '')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function errorResult(text: string): CodexHostMcpCallResult {
  return { content: [{ type: 'text', text }], isError: true }
}

async function callTool(params: Record<string, unknown>): Promise<CodexHostMcpCallResult> {
  const name = typeof params.name === 'string' ? params.name : ''
  // Not keyed on the published catalog: a thread Codex keeps loaded must keep working even if its catalog entry
  // was evicted. The active route for `_meta.threadId` decides which runtime (if any) executes the call.
  if (!CODEX_HOST_MCP_TOOL_NAMES.has(name)) {
    return errorResult(`Maestrly tool "${name || '(missing)'}" is not available in this Codex thread.`)
  }
  const meta = isRecord(params._meta) ? params._meta : {}
  const threadId = typeof meta.threadId === 'string' ? meta.threadId : ''
  const callId = typeof meta.callId === 'string' ? meta.callId : ''
  if (!threadId) return errorResult('Maestrly could not identify the Codex thread for this tool call.')
  if (!callHandler) return errorResult('Maestrly is not ready to run this tool.')
  try {
    return await callHandler({ name, arguments: params.arguments ?? {}, threadId, callId })
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

async function handleMessage(key: string, message: JsonRpcMessage): Promise<Record<string, unknown> | undefined> {
  const id = message.id
  const method = typeof message.method === 'string' ? message.method : ''
  const params = isRecord(message.params) ? message.params : {}
  // Notifications (`notifications/initialized`, `notifications/cancelled`, ...) carry no id and get no response.
  if (id === undefined || id === null) return undefined
  const respond = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  switch (method) {
    case 'initialize':
      return respond({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: CODEX_HOST_MCP_SERVER_NAME, version: '1.0.0' },
      })
    case 'ping':
      return respond({})
    case 'tools/list':
      return respond({
        tools: (toolsets.get(key) ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
    case 'tools/call':
      return respond(await callTool(params))
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } }
  }
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  void (async () => {
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end()
      return
    }
    const match = /^\/mcp\/([0-9a-f]{32})$/.exec((req.url ?? '').split('?')[0])
    if (!match) {
      writeJson(res, 404, { error: 'not_found' })
      return
    }
    if (!authorized(req.headers.authorization)) {
      writeJson(res, 401, { error: 'unauthorized' })
      return
    }
    if (req.method !== 'POST') {
      // Stateless server: every POST carries its own response; there is no standalone SSE stream or session.
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    let payload: unknown
    try {
      const body = await readBody(req)
      if (body === null) {
        writeJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Payload too large' } })
        return
      }
      payload = JSON.parse(body)
    } catch {
      writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } })
      return
    }
    const key = match[1]
    const messages = Array.isArray(payload) ? payload : [payload]
    const responses: Record<string, unknown>[] = []
    for (const message of messages) {
      if (!isRecord(message)) continue
      const response = await handleMessage(key, message)
      if (response) responses.push(response)
    }
    if (!responses.length) {
      if (!res.writableEnded && !res.destroyed) res.writeHead(202).end()
      return
    }
    writeJson(res, 200, Array.isArray(payload) ? responses : responses[0])
  })().catch((error) => {
    writeJson(res, 500, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    })
  })
}

async function ensureServer(): Promise<number> {
  listening ??= (async () => {
    const server = http.createServer(handleRequest)
    // Subagents run for minutes; Node would otherwise close idle or slow requests after its defaults.
    server.keepAliveTimeout = 0
    server.headersTimeout = 0
    server.requestTimeout = 0
    server.setTimeout(0)
    server.unref()
    try {
      return { server, port: await listenOnFreePort(server, 0) }
    } catch (error) {
      listening = null
      throw error
    }
  })()
  return (await listening).port
}

/**
 * Publishes `tools` for one conversation and returns the dotted thread-config overrides that attach the host MCP
 * server. Keys are content-addressed so a thread kept loaded by Codex keeps resolving its original catalog.
 */
export async function codexHostMcpThreadConfig(args: {
  conversationId: string
  tools: readonly CodexHostMcpToolSpec[]
}): Promise<Record<string, unknown>> {
  return {
    [`mcp_servers.${CODEX_HOST_MCP_SERVER_NAME}`]: await codexHostMcpServerConfig(args),
    // Codex shells inherit the app-server environment by default; blank the token for commands the model runs.
    // A keyed `set` entry merges with user policy, unlike `exclude`/`filters` which replace or conflict.
    [`shell_environment_policy.set.${CODEX_HOST_MCP_TOKEN_ENV}`]: '',
  }
}

async function codexHostMcpServerConfig(args: {
  conversationId: string
  tools: readonly CodexHostMcpToolSpec[]
}): Promise<Record<string, unknown>> {
  const tools = args.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
  const key = createHash('sha256')
    .update(JSON.stringify([args.conversationId, tools]))
    .digest('hex')
    .slice(0, 32)
  rememberToolset(key, tools)
  const port = await ensureServer()
  return {
    url: `http://127.0.0.1:${port}/mcp/${key}`,
    bearer_token_env_var: CODEX_HOST_MCP_TOKEN_ENV,
    required: true,
    supports_parallel_tool_calls: true,
    // Maestrly gates the subagent's own actions; the delegation call itself needs no Codex prompt.
    default_tools_approval_mode: 'approve',
    // Codex defers every MCP tool behind tool search when the model supports it; delegation must stay visible.
    omit_tools_from: ['deferred'],
    startup_timeout_sec: STARTUP_TIMEOUT_SEC,
    tool_timeout_sec: TOOL_TIMEOUT_SEC,
  }
}

/** Test/shutdown helper. */
export async function closeCodexHostMcpServer(): Promise<void> {
  const current = listening
  listening = null
  toolsets.clear()
  if (!current) return
  const { server } = await current.catch(() => ({ server: null }))
  if (!server) return
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}
