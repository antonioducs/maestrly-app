/**
 * Stateless MCP endpoint for external agents (Grok Bot and similar clients).
 *
 * Each POST carries its own response; no `Mcp-Session-Id` is issued or required, so a client that opens a
 * fresh session per tool call keeps working. Identity is verified from the bearer token on every request,
 * and the protocol constants come from the MCP SDK so negotiation follows the published revisions.
 */
import {
  ErrorCode,
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js'
import { CONNECTOR_MCP_PATH, type ConnectorPrincipal } from '@maestrly/protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ConnectorUnauthenticatedError, type ConnectorAuthenticator } from './auth.js'
import { ConnectorAuthorizationError } from './grants.js'

export const CONNECTOR_SERVER_INFO = { name: 'maestrly', title: 'Maestrly', version: '1' } as const
export const CONNECTOR_SERVER_INSTRUCTIONS =
  'Maestrly delegates development work to authorized executors. Discover projects, executors and the exact ' +
  'account/model selections with the listing tools, create a task with the stages you want, then follow it ' +
  'through events, evidence and delivery. Never invent a selectionId, project id or task id: read it from a ' +
  'listing tool first. Keep the taskId between messages and use idempotencyKey on every mutation retry.'

export interface ConnectorToolContext {
  principal: ConnectorPrincipal
  signal: AbortSignal
}

export interface ConnectorTool {
  name: string
  title: string
  description: string
  /** JSON Schema for the tool input; shared with the REST contracts where possible. */
  inputSchema: Record<string, unknown>
  annotations: {
    readOnlyHint: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  run(input: Record<string, unknown>, context: ConnectorToolContext): Promise<unknown>
}

export interface ConnectorToolRegistry {
  list(): ConnectorTool[]
  get(name: string): ConnectorTool | undefined
}

export function createConnectorToolRegistry(tools: ConnectorTool[]): ConnectorToolRegistry {
  const index = new Map(tools.map((tool) => [tool.name, tool]))
  if (index.size !== tools.length) throw new Error('Duplicate connector tool name in the catalog.')
  return { list: () => [...index.values()], get: (name) => index.get(name) }
}

const requestSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: z.union([z.string().max(191), z.number()]).optional(),
  method: z.string().min(1).max(191),
  params: z.record(z.string(), z.unknown()).optional(),
})

type McpRequest = z.infer<typeof requestSchema>

function negotiate(requested: unknown): string {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested
  return LATEST_PROTOCOL_VERSION
}

function errorResponse(id: McpRequest['id'] | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }
}

function okResponse(id: McpRequest['id'], result: unknown) {
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, result }
}

/** Tool output is JSON text plus structured content; agents read either representation. */
export function connectorToolResult(value: unknown) {
  const isObject = !!value && typeof value === 'object' && !Array.isArray(value)
  return {
    content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2).slice(0, 400_000) }],
    ...(isObject ? { structuredContent: value as Record<string, unknown> } : {}),
  }
}

function toolErrorResult(message: string) {
  return { content: [{ type: 'text', text: message.slice(0, 4_000) }], isError: true }
}

function toolDescriptor(tool: ConnectorTool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.title, openWorldHint: false, ...tool.annotations },
  }
}

export interface ConnectorMcpDependencies {
  authenticate: ConnectorAuthenticator
  registry: ConnectorToolRegistry
  /** Absolute URL of the protected-resource metadata advertised in the challenge. */
  resourceMetadataUrl: string
}

async function handleRequest(
  message: McpRequest,
  dependencies: ConnectorMcpDependencies,
  request: FastifyRequest,
  signal: AbortSignal
): Promise<unknown | undefined> {
  const notification = message.id === undefined
  switch (message.method) {
    case 'initialize':
      return notification
        ? undefined
        : okResponse(message.id, {
            protocolVersion: negotiate(message.params?.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: CONNECTOR_SERVER_INFO,
            instructions: CONNECTOR_SERVER_INSTRUCTIONS,
          })
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return undefined
    case 'ping':
      return notification ? undefined : okResponse(message.id, {})
    case 'tools/list': {
      if (notification) return undefined
      // Listing the catalog still requires a verified identity; the catalog itself is not a secret,
      // but an unauthenticated client must be told to authorize instead of receiving tool names.
      await dependencies.authenticate(request)
      return okResponse(message.id, { tools: dependencies.registry.list().map(toolDescriptor) })
    }
    case 'tools/call': {
      const principal = await dependencies.authenticate(request)
      const name = typeof message.params?.name === 'string' ? message.params.name : ''
      const tool = dependencies.registry.get(name)
      if (!tool)
        return notification ? undefined : errorResponse(message.id, ErrorCode.InvalidParams, 'Unknown tool.')
      const rawArguments = message.params?.arguments
      const input =
        rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
          ? (rawArguments as Record<string, unknown>)
          : {}
      try {
        const value = await tool.run(input, { principal, signal })
        return notification ? undefined : okResponse(message.id, connectorToolResult(value))
      } catch (error) {
        if (error instanceof ConnectorUnauthenticatedError) throw error
        const statusCode = (error as { statusCode?: unknown }).statusCode
        const detail = error instanceof Error ? error.message : 'The tool call failed.'
        if (typeof statusCode === 'number' && statusCode >= 500)
          request.log.error({ err: error, tool: name }, 'connector tool failed')
        return notification ? undefined : okResponse(message.id, toolErrorResult(detail))
      }
    }
    default:
      return notification ? undefined : errorResponse(message.id, ErrorCode.MethodNotFound, 'Unsupported method.')
  }
}

export function registerConnectorMcp(app: FastifyInstance, dependencies: ConnectorMcpDependencies): void {
  app.route({
    method: ['GET', 'DELETE'],
    url: CONNECTOR_MCP_PATH,
    handler: async (_request, reply) =>
      reply
        .status(405)
        .header('allow', 'POST')
        .send({ error: 'method_not_allowed', detail: 'This MCP endpoint is stateless: each POST carries its reply.' }),
  })

  app.post(CONNECTOR_MCP_PATH, { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const controller = new AbortController()
    request.raw.once('close', () => controller.abort())
    const payload = request.body
    const batch = Array.isArray(payload)
    const messages = batch ? payload : [payload]
    if (messages.length === 0 || messages.length > 50)
      return reply.status(400).send(errorResponse(null, ErrorCode.InvalidRequest, 'Unsupported batch size.'))
    const responses: unknown[] = []
    for (const raw of messages) {
      const parsed = requestSchema.safeParse(raw)
      if (!parsed.success) {
        responses.push(errorResponse(null, ErrorCode.InvalidRequest, 'Invalid JSON-RPC message.'))
        continue
      }
      try {
        const response = await handleRequest(parsed.data, dependencies, request, controller.signal)
        if (response !== undefined) responses.push(response)
      } catch (error) {
        if (error instanceof ConnectorUnauthenticatedError)
          return reply
            .status(401)
            .header('www-authenticate', error.challenge)
            .send({ error: 'invalid_token', error_description: error.message })
        if (error instanceof ConnectorAuthorizationError)
          return reply.status(error.statusCode).send({ error: 'insufficient_scope', error_description: error.message })
        const statusCode = (error as { statusCode?: unknown }).statusCode
        if (typeof statusCode === 'number' && statusCode < 500)
          return reply
            .status(statusCode)
            .send({ error: 'invalid_request', error_description: (error as Error).message })
        request.log.error({ err: error }, 'connector mcp request failed')
        responses.push(errorResponse(parsed.data.id, ErrorCode.InternalError, 'The server could not complete the call.'))
      }
    }
    if (responses.length === 0) return reply.status(202).send()
    return reply.status(200).send(batch ? responses : responses[0])
  })
}
