import { environmentRequests, environmentResultSchemas } from './environments.js'
import { accountRequests, accountResultSchemas } from './accounts.js'
import { z } from 'zod'
import { id, revision } from './common.js'
import {
  BOT_INSTRUCTIONS_MAX,
  BOT_NAME_MAX,
  BOT_PURPOSE_MAX,
  MEMORY_CONTENT_MAX,
  MESSAGE_CONTENT_MAX,
  TRANSFER_CHUNK_BYTES,
  attachmentRefSchema,
  authStatusSchema,
  botConversationSchema,
  botEventSchema,
  botFileSchema,
  botInteractionSchema,
  botMemorySchema,
  botMessageSchema,
  botOperationSchema,
  botSchema,
  botSetupPreviewSchema,
  botTurnSchema,
  modelCatalogEntrySchema,
  modelSelectionSchema,
  permissionModeSchema,
  resourceSpecSchema,
  runtimeInfoSchema,
} from './bots.js'
import { networkPolicySchema, hostnameSchema } from './bot-policy.js'
import { botSessionSchema, sessionsInventorySchema } from './bot-sessions.js'

// Bot wire methods share the v1 envelope. Each method has explicit params and result schemas.
const envelope = { version: z.literal(1), id }
const request = <M extends string, S extends z.ZodType>(method: M, params: S) =>
  z.strictObject({ ...envelope, method: z.literal(method), params })
const byBot = z.strictObject({ botId: id })
const chunkBase64 = z.string().max(Math.ceil((TRANSFER_CHUNK_BYTES * 4) / 3) + 4)
export const botRequests = [
  ...accountRequests,
  ...environmentRequests,
  request('bot.list', z.strictObject({ includeArchived: z.boolean().default(false) })),
  request(
    'bot.create',
    z.strictObject({
      idempotencyKey: id,
      name: z.string().min(1).max(BOT_NAME_MAX),
      purpose: z.string().max(BOT_PURPOSE_MAX).default(''),
      instructions: z.string().max(BOT_INSTRUCTIONS_MAX).default(''),
    })
  ),
  request('bot.inspect', byBot),
  request('bot.session.inspect', byBot),
  request('bot.sessions.list', z.strictObject({ vmId: id })),
  request(
    'bot.update',
    z.strictObject({
      botId: id,
      expectedRevision: revision,
      name: z.string().min(1).max(BOT_NAME_MAX).optional(),
      purpose: z.string().max(BOT_PURPOSE_MAX).optional(),
      instructions: z.string().max(BOT_INSTRUCTIONS_MAX).optional(),
      model: modelSelectionSchema.optional(),
      accountId: id.optional(),
      permissionMode: permissionModeSchema.optional(),
      confirmFullVm: z.boolean().default(false),
    })
  ),
  request('bot.archive', z.strictObject({ botId: id, expectedRevision: revision, idempotencyKey: id })),
  request(
    'bot.setup.preview',
    z.strictObject({
      destination: z
        .discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('new-vm') }),
          z.strictObject({ kind: z.literal('existing-vm'), vmId: id }),
          z.strictObject({ kind: z.literal('shared-vm'), vmId: id }),
        ])
        .default({ kind: 'new-vm' }),
      resources: resourceSpecSchema.optional(),
    })
  ),
  request(
    'bot.setup.start',
    z.strictObject({
      idempotencyKey: id,
      previewId: id,
      inventoryRevision: z.string().min(1).max(128),
      name: z.string().min(1).max(BOT_NAME_MAX),
      purpose: z.string().max(BOT_PURPOSE_MAX).default(''),
      instructions: z.string().max(BOT_INSTRUCTIONS_MAX).default(''),
      accountId: id.optional(),
      model: modelSelectionSchema.optional(),
      confirmations: z.strictObject({
        destination: z.literal(true),
        permissions: z.literal(true),
        prepareExisting: z.boolean().default(false),
        restartExisting: z.boolean().default(false),
      }),
    })
  ),
  request('bot.setup.inspect', z.strictObject({ operationId: id })),
  request('bot.setup.cancel', z.strictObject({ operationId: id })),
  request('bot.runtime.inspect', byBot),
  request(
    'bot.runtime.prepare',
    z.strictObject({ botId: id, idempotencyKey: id, confirmBackup: z.literal(true), confirmRestart: z.literal(true) })
  ),
  request('bot.models.list', byBot),
  request('bot.auth.status', byBot),
  request('bot.auth.start', z.strictObject({ botId: id, method: z.literal('device') })),
  request('bot.auth.cancel', byBot),
  request('bot.auth.logout', byBot),
  request('bot.auth.setApiKey', z.strictObject({ botId: id, apiKey: z.string().min(8).max(512) })),
  request(
    'bot.messages.list',
    z.strictObject({ botId: id, before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).default(50) })
  ),
  request(
    'bot.messages.send',
    z.strictObject({
      botId: id,
      clientMessageId: id,
      content: z.string().min(1).max(MESSAGE_CONTENT_MAX),
      attachments: z.array(attachmentRefSchema).max(16).default([]),
    })
  ),
  request('bot.messages.lookup', z.strictObject({ botId: id, clientMessageId: id })),
  request('bot.turn.get', z.strictObject({ turnId: id })),
  request('bot.turn.cancel', z.strictObject({ turnId: id, expectedRevision: revision })),
  request('bot.interactions.list', z.strictObject({ botId: id, pendingOnly: z.boolean().default(true) })),
  request(
    'bot.interactions.resolve',
    z.strictObject({
      interactionId: id,
      expectedGeneration: z.number().int().positive(),
      decision: z.enum(['approve', 'deny', 'answer']),
      answer: z.string().max(8000).optional(),
    })
  ),
  request('bot.memory.list', z.strictObject({ botId: id, includeInactive: z.boolean().default(false) })),
  request(
    'bot.memory.upsert',
    z.strictObject({
      botId: id,
      memoryId: id.optional(),
      expectedRevision: revision.optional(),
      content: z.string().min(1).max(MEMORY_CONTENT_MAX),
      active: z.boolean().default(true),
    })
  ),
  request('bot.memory.delete', z.strictObject({ botId: id, memoryId: id, expectedRevision: revision })),
  request(
    'bot.events.list',
    z.strictObject({
      botId: id,
      after: revision.default(0),
      limit: z.number().int().min(1).max(500).default(100),
    })
  ),
  request('bot.network.inspect', byBot),
  request(
    'bot.network.update',
    z.strictObject({
      botId: id,
      expectedRevision: revision,
      idempotencyKey: id,
      mode: z.enum(['offline', 'allowlist', 'blocklist']),
      domains: z.array(hostnameSchema).max(64),
    })
  ),
  request('bot.files.list', z.strictObject({ botId: id, path: z.string().max(512).default('') })),
  request(
    'bot.files.transferBegin',
    z.strictObject({
      botId: id,
      direction: z.enum(['upload', 'download']),
      path: z.string().min(1).max(512),
      size: z.number().int().nonnegative().optional(),
      digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      overwrite: z.boolean().default(false),
    })
  ),
  request(
    'bot.files.transferChunk',
    z.strictObject({ transferId: id, offset: z.number().int().nonnegative(), dataBase64: chunkBase64.optional() })
  ),
  request('bot.files.transferFinish', z.strictObject({ transferId: id })),
  request('bot.files.transferAbort', z.strictObject({ transferId: id })),
  request('bot.operation.get', z.strictObject({ operationId: id })),
  request('bot.operation.lookup', z.strictObject({ idempotencyKey: id })),
] as const
export const botRequestSchema = z.discriminatedUnion('method', [...botRequests])
export type BotRequest = z.infer<typeof botRequestSchema>
export type BotMethod = BotRequest['method']
export const botMethods = botRequests.map((schema) => schema.shape.method.value) as readonly BotMethod[]

export const transferStateSchema = z.strictObject({
  transferId: id,
  direction: z.enum(['upload', 'download']),
  path: z.string().min(1).max(512),
  size: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  chunkBytes: z.literal(TRANSFER_CHUNK_BYTES),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  dataBase64: chunkBase64.optional(),
  done: z.boolean(),
  expiresAt: z.string().min(20).max(40),
})
export type TransferState = z.infer<typeof transferStateSchema>
export const messagesPageSchema = z.strictObject({
  conversation: botConversationSchema.optional(),
  messages: z.array(botMessageSchema),
  turns: z.array(botTurnSchema),
  hasMore: z.boolean(),
})
export const eventsPageSchema = z.strictObject({
  events: z.array(botEventSchema),
  cursor: revision,
  hasMore: z.boolean(),
})
export const sendReceiptSchema = z.strictObject({ message: botMessageSchema, turn: botTurnSchema })
export const networkStateSchema = z.strictObject({
  policy: networkPolicySchema,
  mediated: z.boolean(),
  activeStreams: z.number().int().nonnegative(),
})
export const botResultSchemas = {
  ...accountResultSchemas,
  ...environmentResultSchemas,
  'bot.list': z.array(botSchema),
  'bot.create': botSchema,
  'bot.inspect': botSchema,
  'bot.session.inspect': botSessionSchema.nullable(),
  'bot.sessions.list': sessionsInventorySchema,
  'bot.update': botSchema,
  'bot.archive': botOperationSchema,
  'bot.setup.preview': botSetupPreviewSchema,
  'bot.setup.start': botOperationSchema,
  'bot.setup.inspect': botOperationSchema,
  'bot.setup.cancel': botOperationSchema,
  'bot.runtime.inspect': runtimeInfoSchema,
  'bot.runtime.prepare': botOperationSchema,
  'bot.models.list': z.array(modelCatalogEntrySchema),
  'bot.auth.status': authStatusSchema,
  'bot.auth.start': authStatusSchema,
  'bot.auth.cancel': authStatusSchema,
  'bot.auth.logout': authStatusSchema,
  'bot.auth.setApiKey': authStatusSchema,
  'bot.messages.list': messagesPageSchema,
  'bot.messages.send': sendReceiptSchema,
  'bot.messages.lookup': sendReceiptSchema.nullable(),
  'bot.turn.get': botTurnSchema,
  'bot.turn.cancel': botTurnSchema,
  'bot.interactions.list': z.array(botInteractionSchema),
  'bot.interactions.resolve': botInteractionSchema,
  'bot.memory.list': z.array(botMemorySchema),
  'bot.memory.upsert': botMemorySchema,
  'bot.memory.delete': botMemorySchema,
  'bot.events.list': eventsPageSchema,
  'bot.network.inspect': networkStateSchema,
  'bot.network.update': networkStateSchema,
  'bot.files.list': z.array(botFileSchema),
  'bot.files.transferBegin': transferStateSchema,
  'bot.files.transferChunk': transferStateSchema,
  'bot.files.transferFinish': transferStateSchema,
  'bot.files.transferAbort': transferStateSchema,
  'bot.operation.get': botOperationSchema,
  'bot.operation.lookup': botOperationSchema.nullable(),
} satisfies Record<BotMethod, z.ZodType>
export type BotResult<M extends BotMethod> = z.infer<(typeof botResultSchemas)[M]>
export const BOT_MUTATIONS: readonly BotMethod[] = [
  'environment.create', 'environment.prepare',
  'account.create', 'account.default', 'account.start', 'account.cancel', 'account.logout', 'account.setApiKey', 'account.migrate',
  'account.peer.grant', 'account.peer.link', 'account.peer.revoke',
  'bot.create',
  'bot.update',
  'bot.archive',
  'bot.setup.start',
  'bot.setup.cancel',
  'bot.runtime.prepare',
  'bot.auth.start',
  'bot.auth.cancel',
  'bot.auth.logout',
  'bot.auth.setApiKey',
  'bot.messages.send',
  'bot.turn.cancel',
  'bot.interactions.resolve',
  'bot.memory.upsert',
  'bot.memory.delete',
  'bot.network.update',
  'bot.files.transferBegin',
  'bot.files.transferChunk',
  'bot.files.transferFinish',
  'bot.files.transferAbort',
]
/** Methods whose params carry secrets that must never be journaled or logged. */
export const BOT_SECRET_METHODS: readonly BotMethod[] = ['bot.auth.setApiKey', 'account.setApiKey']
