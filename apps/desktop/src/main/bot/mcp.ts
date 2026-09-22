/**
 * MCP surface of the bot endpoint this desktop serves itself.
 *
 * The catalog is the one the bridge publishes in `apps/server/src/modules/bot-conversations/mcp.ts`:
 * identical names, titles, descriptions and input schemas, so a bot reaches the same tools whether it is
 * relayed or talking straight to this computer. Only execution differs, because a call runs here, against
 * the bot connection the owner chose when approving the authorization. One tool is served here alone,
 * and `bot_read_chat` names it: `bot_read_chat_history` reads the chat kept on this computer, which is
 * the only place it exists and which a relay never holds.
 *
 * Like the relayed endpoint this one is stateless: every POST carries its own reply and no session id is
 * issued, so a bot that opens a fresh session per tool call keeps working.
 */
import {
  ErrorCode,
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js'
import { BOT_WAIT_MAX_SECONDS } from '@maestrly/protocol'
import { z } from 'zod'

export const BOT_SERVER_INFO = { name: 'maestrly-bots', title: 'Maestrly personal chats', version: '1' } as const
export const BOT_SERVER_INSTRUCTIONS =
  'These are the personal chats of the person who connected you, running on their own computer. Read the ' +
  'workspaces and selections first and never invent a workspaceId or selectionId. Create a chat, send a ' +
  'message, then follow it with bot_wait_events from the cursor you last saw; it answers within 20 ' +
  'seconds. Keep the conversationId between messages and reuse the same idempotencyKey when you retry a ' +
  'mutation. You can answer an ordinary question the chat asks, but permission prompts and plan ' +
  'approvals belong to the person at their computer and are never shown to you. The person may also ' +
  'write in a chat themselves without telling you; when they say they did, read it with ' +
  'bot_read_chat_history before you continue.'

/** Scope a mutating tool requires; a read only needs a usable token. */
export const BOT_WRITE_SCOPE = 'api:write'
/** Longest batch accepted in a single POST, matching the relayed endpoint. */
export const BOT_MCP_MAX_BATCH = 50

export interface BotToolDescriptor {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  write: boolean
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

export const BOT_TOOLS: readonly BotToolDescriptor[] = [
  {
    name: 'bot_list_workspaces',
    title: 'List workspaces',
    description:
      'The computer this connection reaches, the workspaces the person authorized, the actions allowed on ' +
      'each one, and the account/model selections available. Read ids from here.',
    inputSchema: object({}),
    write: false,
  },
  {
    name: 'bot_list_selections',
    title: 'List selections',
    description: 'Account and model selections the computer offers, with their efforts and modes.',
    inputSchema: object({}),
    write: false,
  },
  {
    name: 'bot_list_chats',
    title: 'List chats',
    description: 'Chats this connection created. Chats of the person or of another bot are never listed.',
    inputSchema: object({}),
    write: false,
  },
  {
    name: 'bot_read_chat',
    title: 'Read a chat',
    description:
      'Open questions, the command still running and the event cursor to wait from, with the first 500 ' +
      'messages your own commands produced. It does not grow past that and does not carry what the ' +
      'person wrote in the chat; bot_read_chat_history does.',
    inputSchema: object({ conversationId: string('Chat id from bot_create_chat or bot_list_chats.') }, [
      'conversationId',
    ]),
    write: false,
  },
  {
    name: 'bot_read_chat_history',
    title: 'Read the whole chat',
    description:
      'The chat as the person sees it, oldest first: what you sent, what they sent themselves, and the ' +
      'answers to both. Read it when the person tells you they wrote in the chat, since events only ' +
      'carry what your own commands produced. Pass back the cursor it returns for the next page.',
    inputSchema: object(
      {
        conversationId: string('Chat id from bot_create_chat or bot_list_chats.'),
        cursor: string('Cursor from the previous page; omit to start at the oldest message.'),
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Messages per page, 100 by default.' },
      },
      ['conversationId']
    ),
    write: false,
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
  },
  {
    name: 'bot_cancel_turn',
    title: 'Cancel the running turn',
    description: 'Ask the computer to stop what the chat is doing now. Already produced work is kept.',
    inputSchema: object({ conversationId: string('Chat id.'), ...idempotency }, ['conversationId', 'idempotencyKey']),
    write: true,
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
  },
]

const index = new Map(BOT_TOOLS.map((tool) => [tool.name, tool]))
if (index.size !== BOT_TOOLS.length) throw new Error('Duplicate bot tool name in the catalog.')

export const botTool = (name: string): BotToolDescriptor | undefined => index.get(name)

export const botToolDescriptor = (tool: BotToolDescriptor) => ({
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

export class BotMcpUnauthenticatedError extends Error {
  readonly status = 401
  constructor(message: string) {
    super(message)
    this.name = 'BotMcpUnauthenticatedError'
  }
}
export class BotMcpForbiddenError extends Error {
  readonly status = 403
  constructor(message: string) {
    super(message)
    this.name = 'BotMcpForbiddenError'
  }
}

export interface BotMcpPrincipal {
  connectionId: string
  scopes: string[]
}

export interface BotMcpContext {
  /** Resolve the bearer token of this request; throws `BotMcpUnauthenticatedError` when it is not usable. */
  authenticate(): BotMcpPrincipal
  callTool(connectionId: string, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  signal: AbortSignal
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

async function handleRequest(message: McpRequest, context: BotMcpContext): Promise<unknown | undefined> {
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
      // The catalog is not a secret, but an unauthorized bot must be told to authorize first.
      context.authenticate()
      return okResponse(message.id, { tools: BOT_TOOLS.map(botToolDescriptor) })
    }
    case 'tools/call': {
      const principal = context.authenticate()
      const name = typeof message.params?.name === 'string' ? message.params.name : ''
      const tool = botTool(name)
      if (!tool) return notification ? undefined : errorResponse(message.id, ErrorCode.InvalidParams, 'Unknown tool.')
      if (tool.write && !principal.scopes.includes(BOT_WRITE_SCOPE))
        throw new BotMcpForbiddenError('The access token does not carry the api:write scope.')
      const rawArguments = message.params?.arguments
      const input =
        rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
          ? (rawArguments as Record<string, unknown>)
          : {}
      try {
        const value = await context.callTool(principal.connectionId, name, input, context.signal)
        return notification ? undefined : okResponse(message.id, botToolResult(value))
      } catch (error) {
        if (error instanceof BotMcpUnauthenticatedError || error instanceof BotMcpForbiddenError) throw error
        const detail = error instanceof Error ? error.message : 'The tool call failed.'
        return notification ? undefined : okResponse(message.id, toolErrorResult(detail))
      }
    }
    default:
      return notification ? undefined : errorResponse(message.id, ErrorCode.MethodNotFound, 'Unsupported method.')
  }
}

/**
 * Run one JSON-RPC payload, single message or batch, and describe the HTTP reply it deserves.
 * Authentication failures are thrown so the transport can answer them with the right challenge.
 */
export async function dispatchBotMcpPayload(
  payload: unknown,
  context: BotMcpContext
): Promise<{ status: number; body?: unknown }> {
  // Challenge on the initial handshake so clients can discover OAuth before opening a session.
  context.authenticate()
  const batch = Array.isArray(payload)
  const messages = batch ? payload : [payload]
  if (messages.length === 0 || messages.length > BOT_MCP_MAX_BATCH)
    return { status: 400, body: errorResponse(null, ErrorCode.InvalidRequest, 'Unsupported batch size.') }
  const responses: unknown[] = []
  for (const raw of messages) {
    const parsed = requestSchema.safeParse(raw)
    if (!parsed.success) {
      responses.push(errorResponse(null, ErrorCode.InvalidRequest, 'Invalid JSON-RPC message.'))
      continue
    }
    try {
      const response = await handleRequest(parsed.data, context)
      if (response !== undefined) responses.push(response)
    } catch (error) {
      if (error instanceof BotMcpUnauthenticatedError || error instanceof BotMcpForbiddenError) throw error
      responses.push(errorResponse(parsed.data.id, ErrorCode.InternalError, 'The server could not complete the call.'))
    }
  }
  if (responses.length === 0) return { status: 202 }
  return { status: 200, body: batch ? responses : responses[0] }
}
