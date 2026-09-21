import { z } from 'zod'
import { opaqueIdSchema, utcDateTimeSchema } from './identity.js'
import { chatPartSchema, chatQuestionSchema } from './project-chat.js'

/**
 * Personal bot conversations.
 *
 * A person connects their own bot (for example a Grok bot) to the native chats that already run on their
 * own desktop. Nothing here belongs to an organization, project, board, card or runner: the owner, the bot
 * connection, the desktop and the workspace are the only scopes. The personal MCP endpoint runs inside
 * the desktop. Remote clients see opaque workspace identifiers, never local paths. The same contracts
 * remain usable by the separately deployed legacy relay.
 */
export const BOT_MCP_PATH = '/mcp/bots' as const
export const BOT_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource/mcp/bots' as const
export const BOT_OWNER_ROOT = '/api/v1/bots' as const
export const BOT_DESKTOP_ROOT = '/api/v1/bot-desktops' as const
export const BOT_DESKTOP_CAPABILITY = 'bot:conversations:v1' as const
/** Longest a wait call blocks before it must answer, so a relayed bot turn never hangs. */
export const BOT_WAIT_MAX_SECONDS = 20

/** Audience the bot MCP endpoint accepts. Separate from the REST and connector audiences on purpose. */
export function botMcpResource(canonicalUrl: string): string {
  return canonicalUrl.replace(/\/$/, '') + BOT_MCP_PATH
}
export function botProtectedResourceMetadataUrl(canonicalUrl: string): string {
  return canonicalUrl.replace(/\/$/, '') + BOT_PROTECTED_RESOURCE_PATH
}

const id = z.string().uuid()
const key = z.string().min(1).max(191)
const answerMatrix = z.array(z.array(z.string().max(8000)).max(20)).min(1).max(10)

export const botActionSchema = z.enum([
  /** List conversations the connection owns and read their transcript. */
  'chats:read',
  /** Create a conversation, send a message and change its selection. */
  'chats:write',
  /** Cancel the running turn of a conversation the connection owns. */
  'chats:control',
  /** Answer an ordinary question raised by a conversation the connection owns. */
  'chats:answer',
])
export const BOT_ACTIONS = botActionSchema.options
/** Actions that never mutate desktop state; used to pick the required OAuth scope. */
export const BOT_READ_ACTIONS: ReadonlyArray<BotAction> = ['chats:read']
export function botActionIsRead(action: BotAction): boolean {
  return BOT_READ_ACTIONS.includes(action)
}

export const botModeSchema = z.enum(['agent', 'ask', 'plan'])
export const botPermissionModeSchema = z.enum(['ask', 'auto', 'full'])

/** What a conversation runs with. Only the desktop decides which selections exist. */
export const botSelectionSchema = z
  .object({
    selectionId: key,
    reasoning: key.nullable().optional(),
    fastMode: z.boolean().optional(),
    mode: botModeSchema.optional(),
    permissionMode: botPermissionModeSchema.optional(),
  })
  .strict()
/** Partial selection change; `selectionId` is optional so a bot can switch only the effort or the mode. */
export const botSelectionPatchSchema = botSelectionSchema.partial().strict()

export const botWorkspaceSchema = z
  .object({
    /** Opaque id minted by the desktop. Never a filesystem path. */
    workspaceId: key,
    label: z.string().min(1).max(160),
    branches: z.array(z.string().max(240)).max(500).default([]),
    defaultBranch: z.string().max(240).nullable().default(null),
  })
  .strict()

export const botSelectionOptionSchema = z
  .object({
    selectionId: key,
    label: z.string().min(1).max(200),
    providerLabel: z.string().max(200).nullable().default(null),
    reasoningEfforts: z.array(key).max(20).default([]),
    fastMode: z.boolean().default(false),
    modes: z.array(botModeSchema).min(1).max(3),
    permissionModes: z.array(botPermissionModeSchema).min(1).max(3),
  })
  .strict()

export const botInventorySchema = z
  .object({
    capability: z.literal(BOT_DESKTOP_CAPABILITY),
    enabled: z.boolean(),
    workspaces: z.array(botWorkspaceSchema).max(200),
    selections: z.array(botSelectionOptionSchema).max(500),
  })
  .strict()

export const botDesktopSchema = z
  .object({
    id,
    ownerUserId: opaqueIdSchema,
    name: z.string().min(1).max(160),
    online: z.boolean(),
    lastSeenAt: utcDateTimeSchema.nullable(),
    revokedAt: utcDateTimeSchema.nullable(),
    inventory: botInventorySchema.nullable(),
    createdAt: utcDateTimeSchema,
  })
  .strict()
export const botDesktopCreateSchema = z.object({ name: z.string().trim().min(1).max(160) }).strict()
/** The device credential is returned once and is only ever stored by the desktop main process. */
export const botDesktopRegistrationSchema = z
  .object({ desktop: botDesktopSchema, credential: z.string().min(32).max(191) })
  .strict()

export const botGrantSchema = z
  .object({ workspaceId: key, actions: z.array(botActionSchema).min(1).max(BOT_ACTIONS.length) })
  .strict()

export const botConnectionSchema = z
  .object({
    id,
    name: z.string().min(1).max(160),
    ownerUserId: opaqueIdSchema,
    desktopId: id,
    clientId: key,
    grants: z.array(botGrantSchema).max(200),
    revokedAt: utcDateTimeSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict()

export const botConnectionCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    desktopId: id,
    grants: z.array(botGrantSchema).min(1).max(200),
    /** Reuse an OAuth client the owner already registered; omit to have one registered automatically. */
    clientId: z.string().trim().min(1).max(191).optional(),
  })
  .strict()

export const botConnectionPatchSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(160).optional(),
    grants: z.array(botGrantSchema).max(200).optional(),
    revoked: z.boolean().optional(),
  })
  .strict()

/** Everything the owner must give the bot so it can authorize against this instance. */
export const botMcpConfigSchema = z
  .object({
    url: z.string().url(),
    resource: z.string().url(),
    authorizationServer: z.string().url(),
    protectedResourceMetadataUrl: z.string().url(),
    clientId: key,
    scopes: z.array(key).min(1).max(20),
  })
  .strict()
export const botConnectionRegistrationSchema = z
  .object({ connection: botConnectionSchema, mcp: botMcpConfigSchema })
  .strict()

export const botManagementStateSchema = z.enum(['active', 'paused', 'revoked'])
export const botConversationSchema = z
  .object({
    id,
    connectionId: id,
    desktopId: id,
    workspaceId: key,
    name: z.string().min(1).max(160),
    baseBranch: z.string().min(1).max(240),
    selection: botSelectionSchema,
    /** Owner-controlled. A bot may read it but can never move a conversation out of `paused`. */
    managementState: botManagementStateSchema,
    version: z.number().int().positive(),
  })
  .strict()

export const botCommandKindSchema = z.enum(['create', 'send', 'configure', 'cancel', 'answer'])
export const botCommandStatusSchema = z.enum(['queued', 'leased', 'succeeded', 'failed', 'cancelled'])
export const botCommandSchema = z
  .object({
    id,
    conversationId: id,
    kind: botCommandKindSchema,
    payload: z.record(z.string(), z.unknown()),
    status: botCommandStatusSchema,
    /** Present only on the claim answered to the desktop that holds the lease; never sent to a bot. */
    leaseToken: id.nullable().optional(),
    version: z.number().int().positive(),
  })
  .strict()

export const botCreatePayloadSchema = z
  .object({
    workspaceId: key,
    name: z.string().trim().min(1).max(160),
    baseBranch: z.string().trim().min(1).max(240),
    selection: botSelectionSchema,
    message: z.string().trim().min(1).max(200000).nullable().default(null),
  })
  .strict()
export const botSendPayloadSchema = z.object({ text: z.string().trim().min(1).max(200000) }).strict()
export const botConfigurePayloadSchema = z
  .object({ selection: botSelectionPatchSchema.optional(), name: z.string().trim().min(1).max(160).optional() })
  .strict()
  .refine((value) => value.selection !== undefined || value.name !== undefined, 'Nothing to configure.')
export const botCancelPayloadSchema = z.object({}).strict()
export const botAnswerPayloadSchema = z.object({ questionId: id, answers: answerMatrix }).strict()

export const botMessageSchema = z
  .object({
    id,
    conversationId: id,
    commandId: id.nullable(),
    role: z.enum(['user', 'assistant']),
    parts: z.array(chatPartSchema).max(1000),
    createdAt: utcDateTimeSchema,
  })
  .strict()

/**
 * An ordinary question raised by the conversation. Permission prompts, plan approvals and escalations are
 * deliberately absent: those stay with the person at the desktop and a bot can never decide them.
 */
export const botQuestionSchema = z
  .object({
    id,
    conversationId: id,
    commandId: id,
    questions: z.array(chatQuestionSchema).min(1).max(10),
    state: z.enum(['pending', 'answered', 'expired']),
    answers: answerMatrix.nullable(),
    createdAt: utcDateTimeSchema,
  })
  .strict()

export const botEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('owner-attention'), attention: z.object({ kind: z.enum(['permission', 'plan']), title: z.string().max(500) }).strict().nullable() }).strict(),
  z.object({ type: z.literal('message'), message: botMessageSchema }).strict(),
  z
    .object({
      type: z.literal('delta'),
      messageId: id,
      partId: key,
      kind: z.enum(['text', 'reasoning']),
      delta: z.string().max(32768),
    })
    .strict(),
  z.object({ type: z.literal('tool'), messageId: id, part: chatPartSchema.options[2] }).strict(),
  z.object({ type: z.literal('question'), question: botQuestionSchema }).strict(),
  z.object({ type: z.literal('command'), command: botCommandSchema }).strict(),
  z.object({ type: z.literal('conversation'), conversation: botConversationSchema }).strict(),
])
export const botConversationEventSchema = z
  .object({
    version: z.literal(1),
    conversationId: id,
    sequence: z.number().int().positive(),
    eventId: key,
    payload: botEventPayloadSchema,
  })
  .strict()
export const botEventUploadSchema = z.object({ eventId: key, payload: botEventPayloadSchema }).strict()

/** One unit of work handed to the desktop, with the trusted owner identity the server resolved. */
export const botClaimSchema = z
  .object({
    owner: z.object({ userId: opaqueIdSchema }).strict(),
    connection: botConnectionSchema,
    conversation: botConversationSchema,
    command: botCommandSchema,
    leaseExpiresAt: utcDateTimeSchema,
    /** Monotonic per conversation. A reply carrying an older fence is refused. */
    fence: z.number().int().positive(),
  })
  .strict()

export const botControlsSchema = z
  .object({
    cancellationRequested: z.boolean(),
    managementState: botManagementStateSchema,
    leaseExpiresAt: utcDateTimeSchema,
  })
  .strict()
export const botCompletionSchema = z
  .object({
    leaseToken: id,
    fence: z.number().int().positive(),
    status: z.enum(['succeeded', 'failed', 'cancelled']),
    error: z.string().max(8000).nullable().default(null),
  })
  .strict()

export const botConversationSnapshotSchema = z
  .object({
    conversation: botConversationSchema,
    messages: z.array(botMessageSchema).max(500),
    questions: z.array(botQuestionSchema).max(100),
    pendingCommand: botCommandSchema.nullable(),
    cursor: z.number().int().nonnegative(),
    ownerAttention: z.object({ kind: z.enum(['permission', 'plan']), title: z.string().max(500) }).strict().nullable().optional(),
  })
  .strict()

export const botWaitResultSchema = z
  .object({
    conversationId: id,
    cursor: z.number().int().nonnegative(),
    events: z.array(botConversationEventSchema).max(500),
    timedOut: z.boolean(),
  })
  .strict()

export type BotAction = z.infer<typeof botActionSchema>
export type BotMode = z.infer<typeof botModeSchema>
export type BotPermissionMode = z.infer<typeof botPermissionModeSchema>
export type BotSelection = z.infer<typeof botSelectionSchema>
export type BotSelectionPatch = z.infer<typeof botSelectionPatchSchema>
export type BotWorkspace = z.infer<typeof botWorkspaceSchema>
export type BotSelectionOption = z.infer<typeof botSelectionOptionSchema>
export type BotInventory = z.infer<typeof botInventorySchema>
export type BotDesktop = z.infer<typeof botDesktopSchema>
export type BotDesktopCreate = z.infer<typeof botDesktopCreateSchema>
export type BotDesktopRegistration = z.infer<typeof botDesktopRegistrationSchema>
export type BotGrant = z.infer<typeof botGrantSchema>
export type BotConnection = z.infer<typeof botConnectionSchema>
export type BotConnectionCreate = z.infer<typeof botConnectionCreateSchema>
export type BotConnectionPatch = z.infer<typeof botConnectionPatchSchema>
export type BotMcpConfig = z.infer<typeof botMcpConfigSchema>
export type BotConnectionRegistration = z.infer<typeof botConnectionRegistrationSchema>
export type BotManagementState = z.infer<typeof botManagementStateSchema>
export type BotConversation = z.infer<typeof botConversationSchema>
export type BotCommandKind = z.infer<typeof botCommandKindSchema>
export type BotCommandStatus = z.infer<typeof botCommandStatusSchema>
export type BotCommand = z.infer<typeof botCommandSchema>
export type BotCreatePayload = z.infer<typeof botCreatePayloadSchema>
export type BotSendPayload = z.infer<typeof botSendPayloadSchema>
export type BotConfigurePayload = z.infer<typeof botConfigurePayloadSchema>
export type BotAnswerPayload = z.infer<typeof botAnswerPayloadSchema>
export type BotMessage = z.infer<typeof botMessageSchema>
export type BotQuestion = z.infer<typeof botQuestionSchema>
export type BotEventPayload = z.infer<typeof botEventPayloadSchema>
export type BotConversationEvent = z.infer<typeof botConversationEventSchema>
export type BotEventUpload = z.infer<typeof botEventUploadSchema>
export type BotClaim = z.infer<typeof botClaimSchema>
export type BotControls = z.infer<typeof botControlsSchema>
export type BotCompletion = z.infer<typeof botCompletionSchema>
export type BotConversationSnapshot = z.infer<typeof botConversationSnapshotSchema>
export type BotWaitResult = z.infer<typeof botWaitResultSchema>

/** Payload contract for each command kind, so the desktop and the server validate the same shapes. */
export const botCommandPayloadSchemas = {
  create: botCreatePayloadSchema,
  send: botSendPayloadSchema,
  configure: botConfigurePayloadSchema,
  cancel: botCancelPayloadSchema,
  answer: botAnswerPayloadSchema,
} as const

export function parseBotCommandPayload(kind: BotCommandKind, payload: unknown): Record<string, unknown> {
  return botCommandPayloadSchemas[kind].parse(payload) as Record<string, unknown>
}

/** Applies one relayed event to a snapshot. Shared by the server projection and any bot-side cache. */
export function applyBotConversationEvent(
  state: BotConversationSnapshot,
  event: BotConversationEvent
): BotConversationSnapshot {
  if (event.conversationId !== state.conversation.id || event.sequence <= state.cursor) return state
  if (event.sequence !== state.cursor + 1) throw new Error('Bot conversation event gap; reload the snapshot.')
  const next = { ...state, cursor: event.sequence }
  const payload = event.payload
  if (payload.type === 'owner-attention') next.ownerAttention = payload.attention
  else if (payload.type === 'conversation') next.conversation = payload.conversation
  else if (payload.type === 'command')
    next.pendingCommand = ['queued', 'leased'].includes(payload.command.status) ? payload.command : null
  else if (payload.type === 'question')
    next.questions = [...state.questions.filter((item) => item.id !== payload.question.id), payload.question]
  else if (payload.type === 'message')
    next.messages = [...state.messages.filter((item) => item.id !== payload.message.id), payload.message].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    )
  else
    next.messages = state.messages.map((message) => {
      if (message.id !== payload.messageId) return message
      if (payload.type === 'tool')
        return { ...message, parts: [...message.parts.filter((part) => part.id !== payload.part.id), payload.part] }
      const previous = message.parts.find((part) => part.id === payload.partId)
      const part = {
        id: payload.partId,
        type: payload.kind,
        text: (previous && previous.type !== 'tool' ? previous.text : '') + payload.delta,
      }
      return {
        ...message,
        parts: previous ? message.parts.map((item) => (item.id === part.id ? part : item)) : [...message.parts, part],
      }
    })
  return next
}
