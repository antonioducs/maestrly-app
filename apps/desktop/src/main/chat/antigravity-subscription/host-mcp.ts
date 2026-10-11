/**
 * Loopback MCP server that hosts Maestrly's tools for Antigravity ACP sessions.
 *
 * Each registered toolset (one per ACP session) gets its own URL key and bearer token, so a session can only list
 * and call its own tools. The server binds 127.0.0.1, rejects non-loopback `Host` headers (DNS rebinding), bounds
 * the body, and answers stateless JSON (no SSE stream or MCP session).
 *
 * The server, not the ACP stream, is the source of tool events: it knows the exact input it validated and the
 * canonical output it produced. Execution belongs to the Maestrly turn set with `setActiveTurn`; the HTTP request
 * never cancels a tool.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { asSchema } from '@ai-sdk/provider-utils'
import type { Tool, ToolSet } from 'ai'
import type { ToolOutput } from '../../../shared/chat'
import { listenOnFreePort } from '../../net-port'
import type { AcpMcpServerHttp } from '../acp/protocol'
import {
  modelOutputToChatToolOutput,
  stripToolOutputMetadata,
  toolOutputIsError,
  toolOutputToMcpCallResult,
} from '../tool-output'
import { ANTIGRAVITY_HOST_MCP_SERVER_NAME } from './permissions'
import { antigravityToolSignature, type HostToolSpec, hostToolSpecs } from './tool-catalog'

export interface AntigravityActiveTurn {
  tools: ToolSet
  signal: AbortSignal
  onToolStart(event: { toolCallId: string; toolName: string; input: unknown }): void
  onToolResult(event: { toolCallId: string; toolName: string; output: ToolOutput; isError: boolean }): void
}

export interface AntigravityHostToolset {
  readonly key: string
  readonly specs: readonly HostToolSpec[]
  readonly toolSignature: string
  readonly mcpServer: AcpMcpServerHttp
  setActiveTurn(turn: AntigravityActiveTurn | null): void
  wasInitialized(): boolean
  dispose(): void
}

interface ToolsetState {
  readonly token: Buffer
  readonly specs: readonly HostToolSpec[]
  activeTurn: AntigravityActiveTurn | null
  initialized: boolean
}

type McpContent = Array<Record<string, unknown>>
interface McpCallResult {
  content: McpContent
  isError?: boolean
  structuredContent?: unknown
}

const MAX_BODY_BYTES = 4 * 1024 * 1024
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
const IMAGE_OMITTED = '[image omitted: not visible to this model]'
const toolsets = new Map<string, ToolsetState>()
let listening: Promise<{ server: http.Server; port: number }> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

function authorized(state: ToolsetState, header: string | undefined): boolean {
  const expected = Buffer.concat([Buffer.from('Bearer '), state.token])
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

function errorResult(text: string): McpCallResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Antigravity offloads MCP images to files the model cannot open; images are described before reaching here. */
function withoutImages(result: McpCallResult): McpCallResult {
  const content = result.content.map((item) => (item.type === 'image' ? { type: 'text', text: IMAGE_OMITTED } : item))
  return { ...result, content: content.length ? content : [{ type: 'text', text: '(no output)' }] }
}

async function callTool(state: ToolsetState, params: Record<string, unknown>): Promise<McpCallResult> {
  const turn = state.activeTurn
  if (!turn) return errorResult('No active Maestrly turn for this session.')
  const name = typeof params.name === 'string' ? params.name : ''
  const tool = turn.tools[name] as Tool | undefined
  if (!tool || typeof tool.execute !== 'function' || !state.specs.some((spec) => spec.name === name)) {
    return errorResult(`Maestrly tool "${name || '(missing)'}" is not available in this session.`)
  }
  const toolCallId = `agy_${randomUUID()}`
  const args = params.arguments ?? {}
  turn.onToolStart({ toolCallId, toolName: name, input: args })
  const fail = (message: string): McpCallResult => {
    turn.onToolResult({ toolCallId, toolName: name, output: message, isError: true })
    return errorResult(message)
  }
  try {
    turn.signal.throwIfAborted()
    const schema = asSchema(tool.inputSchema)
    let parsed: unknown = args
    if (schema.validate) {
      const validation = await schema.validate(args)
      if (!validation.success) {
        const detail = validation.error instanceof Error ? validation.error.message : String(validation.error)
        return fail(`Invalid arguments for "${name}": ${detail}`)
      }
      parsed = validation.value
    }
    const output = await (tool.execute as unknown as (input: unknown, options: Record<string, unknown>) => unknown)(
      parsed,
      {
        toolCallId,
        messages: [],
        abortSignal: turn.signal,
      }
    )
    const canonical = modelOutputToChatToolOutput(output)
    const isError = toolOutputIsError(canonical)
    const modelOutput = tool.toModelOutput
      ? await (tool.toModelOutput as (options: Record<string, unknown>) => unknown)({
          toolCallId,
          input: parsed,
          output,
        })
      : output
    turn.onToolResult({ toolCallId, toolName: name, output: canonical, isError })
    return withoutImages(toolOutputToMcpCallResult(stripToolOutputMetadata(modelOutput), { isError }) as McpCallResult)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

async function handleMessage(state: ToolsetState, message: Record<string, unknown>) {
  const id = message.id
  const method = typeof message.method === 'string' ? message.method : ''
  const params = isRecord(message.params) ? message.params : {}
  // Notifications (`notifications/initialized`, ...) carry no id and get no response.
  if (id === undefined || id === null) return undefined
  const respond = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  switch (method) {
    case 'initialize':
      state.initialized = true
      return respond({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: ANTIGRAVITY_HOST_MCP_SERVER_NAME, version: '1.0.0' },
      })
    case 'ping':
      return respond({})
    case 'tools/list':
      return respond({ tools: state.specs })
    case 'tools/call':
      return respond(await callTool(state, params))
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
    const match = /^\/mcp\/([0-9a-f-]{36})$/.exec((req.url ?? '').split('?')[0])
    const state = match ? toolsets.get(match[1]) : undefined
    if (!state) {
      writeJson(res, 404, { error: 'not_found' })
      return
    }
    if (!authorized(state, req.headers.authorization)) {
      writeJson(res, 401, { error: 'unauthorized' })
      return
    }
    if (req.method !== 'POST') {
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
    const messages = Array.isArray(payload) ? payload : [payload]
    const responses: Record<string, unknown>[] = []
    for (const message of messages) {
      if (!isRecord(message)) continue
      const response = await handleMessage(state, message)
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
    // Subagents and long commands run for minutes; Maestrly, not Node's defaults, bounds their lifetime.
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

export async function registerAntigravityHostToolset(tools: ToolSet): Promise<AntigravityHostToolset> {
  const specs = await hostToolSpecs(tools)
  const port = await ensureServer()
  const key = randomUUID()
  const token = Buffer.from(randomBytes(32).toString('hex'))
  const state: ToolsetState = { token, specs, activeTurn: null, initialized: false }
  toolsets.set(key, state)
  return {
    key,
    specs,
    toolSignature: antigravityToolSignature(specs),
    mcpServer: {
      type: 'http',
      name: ANTIGRAVITY_HOST_MCP_SERVER_NAME,
      url: `http://127.0.0.1:${port}/mcp/${key}`,
      headers: [{ name: 'Authorization', value: `Bearer ${token.toString()}` }],
    },
    setActiveTurn(turn) {
      state.activeTurn = turn
    },
    wasInitialized: () => state.initialized,
    dispose() {
      state.activeTurn = null
      toolsets.delete(key)
    },
  }
}

export async function closeAntigravityHostMcpServer(): Promise<void> {
  toolsets.clear()
  const current = listening
  listening = null
  if (!current) return
  const { server } = await current.catch(() => ({ server: null }))
  if (!server) return
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}
