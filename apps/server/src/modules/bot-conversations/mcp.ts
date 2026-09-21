/**
 * Stateless MCP endpoint for a person's own bot.
 *
 * Each POST carries its own response; no `Mcp-Session-Id` is issued, so a bot that opens a fresh session
 * per tool call keeps working. Identity is verified from the bearer token on every request and the
 * audience is `/mcp/bots`, so neither a REST token nor an organization connector token is accepted here.
 */
import {
  ErrorCode,
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js'
import { BOT_MCP_PATH, BOT_WAIT_MAX_SECONDS } from '@maestrly/protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { DatabasePool } from '../../db/pool.js'
import { BotUnauthenticatedError, assertBotWriteScope, type BotAuthenticator } from './auth.js'
import {
  BotAuthorizationError,
  botActorOf,
  assertBotGrant,
  authorizeBotConversationAction,
  botDesktopView,
  createBotConversation,
  enqueueBotCommand,
  executeBotIdempotent,
  listBotConversations,
  readBotConversation,
  waitBotEvents,
  type BotPrincipal,
} from './service.js'

export const BOT_SERVER_INFO = { name: 'maestrly-bots', title: 'Maestrly personal chats', version: '1' } as const
export const BOT_SERVER_INSTRUCTIONS =
  'These are the personal chats of the person who connected you, running on their own computer. Read the ' +
  'workspaces and selections first and never invent a workspaceId or selectionId. Create a chat, send a ' +
  'message, then follow it with bot_wait_events from the cursor you last saw; it answers within 20 ' +
  'seconds. Keep the conversationId between messages and reuse the same idempotencyKey when you retry a ' +
  'mutation. You can answer an ordinary question the chat asks, but permission prompts and plan ' +
  'approvals belong to the person at their computer and are never shown to you.'

export interface BotToolContext {
  principal: BotPrincipal
  signal: AbortSignal
}

export interface BotTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  write: boolean
  run(input: Record<string, unknown>, context: BotToolContext): Promise<unknown>
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const string = (description: string) => ({ type: 'string', description })
const idempotency = { idempotencyKey: string('Reuse the same key when retrying; a retry replays the first result.') }
const selectionSchema = {
  type: 'object',
  description: 'Account and model selection, from bot_list_selections.',
  properties: {
    selectionId: { type: 'string' },
    reasoning: { type: ['string', 'null'] },
    fastMode: { type: 'boolean' },
    mode: { type: 'string', enum: ['agent', 'ask', 'plan'] },
    permissionMode: { type: 'string', enum: ['ask', 'auto', 'full'] },
  },
  required: ['selectionId'],
  additionalProperties: false,
}

const conversationInput = z.object({ conversationId: z.string().uuid() })
const keyInput = z.object({ idempotencyKey: z.string().min(1).max(191) })

/** Every mutation is idempotent and keyed to this connection, so a relay retry never duplicates work. */
async function mutate<T>(
  pool: DatabasePool,
  context: BotToolContext,
  tool: string,
  input: Record<string, unknown>,
  operation: Parameters<typeof executeBotIdempotent<T>>[2]
): Promise<T> {
  assertBotWriteScope(context.principal)
  const { idempotencyKey } = keyInput.parse(input)
  const { body } = await executeBotIdempotent<T>(
    pool,
    {
      actor: botActorOf(context.principal),
      ownerUserId: context.principal.userId,
      actorId: context.principal.connectionId,
      key: idempotencyKey,
      method: 'TOOL',
      path: tool,
      body: { ...input, idempotencyKey: undefined },
    },
    operation,
    async (client) => {
      if (tool === 'bot_create_chat') {
        await assertBotGrant(client, context.principal, z.string().min(1).max(191).parse(input.workspaceId), 'chats:write')
      } else {
        const action = tool === 'bot_answer_question' ? 'chats:answer' : tool === 'bot_cancel_turn' ? 'chats:control' : 'chats:write'
        await authorizeBotConversationAction(client, context.principal, conversationInput.parse(input).conversationId, action)
      }
    }
  )
  return body
}

export function botToolCatalog(pool: DatabasePool): BotTool[] {
  return [
    {
      name: 'bot_list_workspaces',
      title: 'List workspaces',
      description:
        'The computer this connection reaches, the workspaces the person authorized, the actions allowed on ' +
        'each one, and the account/model selections available. Read ids from here.',
      inputSchema: object({}),
      write: false,
      run: (_input, context) => botDesktopView(pool, context.principal),
    },
    {
      name: 'bot_list_selections',
      title: 'List selections',
      description: 'Account and model selections the computer offers, with their efforts and modes.',
      inputSchema: object({}),
      write: false,
      run: async (_input, context) => ({ selections: (await botDesktopView(pool, context.principal)).selections }),
    },
    {
      name: 'bot_list_chats',
      title: 'List chats',
      description: 'Chats this connection created. Chats of the person or of another bot are never listed.',
      inputSchema: object({}),
      write: false,
      run: async (_input, context) => ({ conversations: await listBotConversations(pool, context.principal) }),
    },
    {
      name: 'bot_read_chat',
      title: 'Read a chat',
      description: 'Transcript, open questions, the command still running and the event cursor to wait from.',
      inputSchema: object({ conversationId: string('Chat id from bot_create_chat or bot_list_chats.') }, [
        'conversationId',
      ]),
      write: false,
      run: (input, context) =>
        readBotConversation(pool, context.principal, conversationInput.parse(input).conversationId),
    },
    {
      name: 'bot_create_chat',
      title: 'Create a chat',
      description:
        'Start a chat in one authorized workspace. The computer creates it and answers through events; ' +
        'follow it with bot_wait_events.',
      inputSchema: object(
        {
          workspaceId: string('Workspace id from bot_list_workspaces.'),
          name: string('Short title for the chat.'),
          baseBranch: string('Branch the chat starts from, from bot_list_workspaces.'),
          selection: selectionSchema,
          message: string('Optional first message to send once the chat exists.'),
          ...idempotency,
        },
        ['workspaceId', 'name', 'baseBranch', 'selection', 'idempotencyKey']
      ),
      write: true,
      run: (input, context) =>
        mutate(pool, context, 'bot_create_chat', input, async (client) => ({
          status: 201,
          body: await createBotConversation(client, context.principal, {
            workspaceId: input.workspaceId,
            name: input.name,
            baseBranch: input.baseBranch,
            selection: input.selection,
            message: input.message ?? null,
          } as Record<string, unknown>),
        })),
    },
    {
      name: 'bot_send_message',
      title: 'Send a message',
      description: 'Queue a message for a chat this connection owns. Messages of one chat run in order.',
      inputSchema: object({ conversationId: string('Chat id.'), text: string('What to say.'), ...idempotency }, [
        'conversationId',
        'text',
        'idempotencyKey',
      ]),
      write: true,
      run: (input, context) =>
        mutate(pool, context, 'bot_send_message', input, async (client) => ({
          status: 202,
          body: await enqueueBotCommand(client, context.principal, {
            conversationId: conversationInput.parse(input).conversationId,
            kind: 'send',
            payload: { text: input.text },
          }),
        })),
    },
    {
      name: 'bot_configure_chat',
      title: 'Configure a chat',
      description: 'Change the account, model, effort, mode or title of a chat. Applies to the next turn.',
      inputSchema: object(
        {
          conversationId: string('Chat id.'),
          selection: { ...selectionSchema, required: [] },
          name: string('New title.'),
          ...idempotency,
        },
        ['conversationId', 'idempotencyKey']
      ),
      write: true,
      run: (input, context) =>
        mutate(pool, context, 'bot_configure_chat', input, async (client) => ({
          status: 202,
          body: await enqueueBotCommand(client, context.principal, {
            conversationId: conversationInput.parse(input).conversationId,
            kind: 'configure',
            payload: {
              ...(input.selection === undefined ? {} : { selection: input.selection }),
              ...(input.name === undefined ? {} : { name: input.name }),
            },
          }),
        })),
    },
    {
      name: 'bot_cancel_turn',
      title: 'Cancel the running turn',
      description: 'Ask the computer to stop what the chat is doing now. Already produced work is kept.',
      inputSchema: object({ conversationId: string('Chat id.'), ...idempotency }, [
        'conversationId',
        'idempotencyKey',
      ]),
      write: true,
      run: (input, context) =>
        mutate(pool, context, 'bot_cancel_turn', input, async (client) => ({
          status: 202,
          body: await enqueueBotCommand(client, context.principal, {
            conversationId: conversationInput.parse(input).conversationId,
            kind: 'cancel',
            payload: {},
          }),
        })),
    },
    {
      name: 'bot_answer_question',
      title: 'Answer a question',
      description:
        'Answer an ordinary question the chat asked, listed by bot_read_chat. Permission prompts and plan ' +
        'approvals are not questions and can never be answered here.',
      inputSchema: object(
        {
          conversationId: string('Chat id.'),
          questionId: string('Question id from bot_read_chat.'),
          answers: {
            type: 'array',
            description: 'One array of answers per question asked, in the order they were asked.',
            items: { type: 'array', items: { type: 'string' } },
          },
          ...idempotency,
        },
        ['conversationId', 'questionId', 'answers', 'idempotencyKey']
      ),
      write: true,
      run: (input, context) =>
        mutate(pool, context, 'bot_answer_question', input, async (client) => ({
          status: 202,
          body: await enqueueBotCommand(client, context.principal, {
            conversationId: conversationInput.parse(input).conversationId,
            kind: 'answer',
            payload: { questionId: input.questionId, answers: input.answers },
          }),
        })),
    },
    {
      name: 'bot_wait_events',
      title: 'Wait for events',
      description:
        'Block until the chat produces events after the cursor, for at most 20 seconds, then answer. Call ' +
        'it again with the cursor it returns instead of polling in a tight loop.',
      inputSchema: object(
        {
          conversationId: string('Chat id.'),
          cursor: { type: 'integer', minimum: 0, description: 'Last sequence you already saw.' },
          timeoutSeconds: { type: 'integer', minimum: 0, maximum: BOT_WAIT_MAX_SECONDS },
        },
        ['conversationId', 'cursor']
      ),
      write: false,
      run: (input, context) => {
        const parsed = z
          .object({
            conversationId: z.string().uuid(),
            cursor: z.number().int().nonnegative(),
            timeoutSeconds: z.number().int().min(0).max(BOT_WAIT_MAX_SECONDS).default(BOT_WAIT_MAX_SECONDS),
          })
          .parse(input)
        return waitBotEvents(pool, context.principal, { ...parsed, signal: context.signal })
      },
    },
  ]
}

export interface BotToolRegistry {
  list(): BotTool[]
  get(name: string): BotTool | undefined
}

export function createBotToolRegistry(tools: BotTool[]): BotToolRegistry {
  const index = new Map(tools.map((tool) => [tool.name, tool]))
  if (index.size !== tools.length) throw new Error('Duplicate bot tool name in the catalog.')
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
const errorResponse = (id: McpRequest['id'] | null, code: number, message: string) => ({
  jsonrpc: JSONRPC_VERSION,
  id: id ?? null,
  error: { code, message },
})
const okResponse = (id: McpRequest['id'], result: unknown) => ({ jsonrpc: JSONRPC_VERSION, id: id ?? null, result })

/** Tool output is JSON text plus structured content; bots read either representation. */
export function botToolResult(value: unknown) {
  const isObject = !!value && typeof value === 'object' && !Array.isArray(value)
  return {
    content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2).slice(0, 400_000) }],
    ...(isObject ? { structuredContent: value as Record<string, unknown> } : {}),
  }
}
const toolErrorResult = (message: string) => ({
  content: [{ type: 'text', text: message.slice(0, 4_000) }],
  isError: true,
})
const toolDescriptor = (tool: BotTool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: {
    title: tool.title,
    readOnlyHint: !tool.write,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
})

export interface BotMcpDependencies {
  authenticate: BotAuthenticator
  registry: BotToolRegistry
  resourceMetadataUrl: string
}

async function handleRequest(
  message: McpRequest,
  dependencies: BotMcpDependencies,
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
            serverInfo: BOT_SERVER_INFO,
            instructions: BOT_SERVER_INSTRUCTIONS,
          })
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return undefined
    case 'ping':
      return notification ? undefined : okResponse(message.id, {})
    case 'tools/list': {
      if (notification) return undefined
      // The catalog is not a secret, but an unauthenticated bot must be told to authorize first.
      await dependencies.authenticate(request)
      return okResponse(message.id, { tools: dependencies.registry.list().map(toolDescriptor) })
    }
    case 'tools/call': {
      const principal = await dependencies.authenticate(request)
      const name = typeof message.params?.name === 'string' ? message.params.name : ''
      const tool = dependencies.registry.get(name)
      if (!tool) return notification ? undefined : errorResponse(message.id, ErrorCode.InvalidParams, 'Unknown tool.')
      const rawArguments = message.params?.arguments
      const input =
        rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
          ? (rawArguments as Record<string, unknown>)
          : {}
      try {
        const value = await tool.run(input, { principal, signal })
        return notification ? undefined : okResponse(message.id, botToolResult(value))
      } catch (error) {
        if (error instanceof BotUnauthenticatedError) throw error
        const statusCode = (error as { statusCode?: unknown }).statusCode
        const detail = error instanceof Error ? error.message : 'The tool call failed.'
        if (typeof statusCode === 'number' && statusCode >= 500)
          request.log.error({ err: error, tool: name }, 'bot tool failed')
        return notification ? undefined : okResponse(message.id, toolErrorResult(detail))
      }
    }
    default:
      return notification ? undefined : errorResponse(message.id, ErrorCode.MethodNotFound, 'Unsupported method.')
  }
}

export function registerBotMcp(app: FastifyInstance, dependencies: BotMcpDependencies): void {
  app.route({
    method: ['GET', 'DELETE'],
    url: BOT_MCP_PATH,
    handler: async (_request, reply) =>
      reply
        .status(405)
        .header('allow', 'POST')
        .send({ error: 'method_not_allowed', detail: 'This MCP endpoint is stateless: each POST carries its reply.' }),
  })

  app.post(BOT_MCP_PATH, { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const controller = new AbortController()
    request.raw.once('aborted', () => controller.abort())
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) controller.abort() })
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
        if (error instanceof BotUnauthenticatedError)
          return reply
            .status(401)
            .header('www-authenticate', error.challenge)
            .send({ error: 'invalid_token', error_description: error.message })
        if (error instanceof BotAuthorizationError)
          return reply.status(error.statusCode).send({ error: 'insufficient_scope', error_description: error.message })
        const statusCode = (error as { statusCode?: unknown }).statusCode
        if (typeof statusCode === 'number' && statusCode < 500)
          return reply.status(statusCode).send({ error: 'invalid_request', error_description: (error as Error).message })
        request.log.error({ err: error }, 'bot mcp request failed')
        responses.push(errorResponse(parsed.data.id, ErrorCode.InternalError, 'The server could not complete the call.'))
      }
    }
    if (responses.length === 0) return reply.status(202).send()
    return reply.status(200).send(batch ? responses : responses[0])
  })
}
