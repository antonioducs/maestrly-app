import { z } from 'zod'
import { sessionProfileSchema } from './bot-sessions.js'
import { id, revision, errorSchema } from './common.js'

// Bot domain. No secrets, administrative PIDs or Host paths ever appear here.
export const BOT_NAME_MAX = 80
export const BOT_PURPOSE_MAX = 4000
export const BOT_INSTRUCTIONS_MAX = 16_000
export const MESSAGE_CONTENT_MAX = 64 * 1024
export const MEMORY_CONTENT_MAX = 8 * 1024
export const MEMORY_ACTIVE_BUDGET = 32 * 1024
export const TRANSFER_CHUNK_BYTES = 48 * 1024
export const TRANSFER_FILE_MAX = 32 * 1024 * 1024
export const EVENTS_PAGE_BUDGET = 512 * 1024

export const isoDate = z.string().min(20).max(40)
export const botStatusSchema = z.enum(['setup', 'ready', 'needs_attention', 'archived'])
export const runtimeStateSchema = z.enum(['missing', 'preparing', 'ready', 'incompatible', 'unreachable'])
export const accountStateSchema = z.enum(['disconnected', 'connecting', 'connected', 'incompatible', 'expired'])
export const permissionModeSchema = z.enum(['ask', 'full-vm'])
export const modelSelectionSchema = z.strictObject({
  model: z.string().min(1).max(120),
  effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  source: z.enum(['recommended', 'custom']).default('recommended'),
})
export const botSchema = z.strictObject({
  id,
  name: z.string().min(1).max(BOT_NAME_MAX),
  purpose: z.string().max(BOT_PURPOSE_MAX).default(''),
  instructions: z.string().max(BOT_INSTRUCTIONS_MAX).default(''),
  status: botStatusSchema,
  vmId: id.optional(),
  conversationId: id.optional(),
  runtimeState: runtimeStateSchema.default('missing'),
  accountState: accountStateSchema.default('disconnected'),
  accountId: id.optional(),
  permissionMode: permissionModeSchema.default('ask'),
  model: modelSelectionSchema.optional(),
  activeTurnId: id.optional(),
  setupOperationId: id.optional(),
  revision,
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type Bot = z.infer<typeof botSchema>

export const botConversationSchema = z.strictObject({
  id,
  botId: id,
  title: z.string().max(200).default(''),
  activeTurnId: id.optional(),
  providerThreadId: z.string().max(200).optional(),
  contextSummary: z.string().max(16_000).optional(),
  contextRevision: revision.default(0),
  lastSequence: revision.default(0),
  revision,
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type BotConversation = z.infer<typeof botConversationSchema>

export const attachmentRefSchema = z.strictObject({
  path: z.string().min(1).max(512),
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})
export const botMessageSchema = z.strictObject({
  id,
  conversationId: id,
  clientMessageId: id,
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(MESSAGE_CONTENT_MAX),
  turnId: id.optional(),
  sequence: z.number().int().positive(),
  attachments: z.array(attachmentRefSchema).max(16).default([]),
  createdAt: isoDate,
})
export type BotMessage = z.infer<typeof botMessageSchema>

export const turnStatusSchema = z.enum([
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'waiting_input',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'needs_attention',
])
export const TURN_TERMINAL = new Set<z.infer<typeof turnStatusSchema>>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
])
export const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
})
export const botTurnSchema = z.strictObject({
  id,
  botId: id,
  conversationId: id,
  messageId: id,
  status: turnStatusSchema,
  generation: z.number().int().positive(),
  providerThreadId: z.string().max(200).optional(),
  providerTurnId: z.string().max(200).optional(),
  leaseExpiresAt: isoDate.optional(),
  cancelRequestedAt: isoDate.optional(),
  startedAt: isoDate.optional(),
  finishedAt: isoDate.optional(),
  usage: usageSchema.optional(),
  error: errorSchema.optional(),
  attention: z.string().max(1000).optional(),
  revision,
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type BotTurn = z.infer<typeof botTurnSchema>

export const interactionKindSchema = z.enum(['approval', 'question', 'grant'])
export const interactionStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'answered',
  'expired',
  'invalidated',
])
export const grantScopeSchema = z.strictObject({
  actions: z.array(z.string().min(1).max(80)).max(32),
  paths: z.array(z.string().min(1).max(512)).max(32).default([]),
  destinations: z.array(z.string().min(1).max(253)).max(32).default([]),
  expiresAt: isoDate,
})
export const botInteractionSchema = z.strictObject({
  id,
  botId: id,
  turnId: id,
  actionId: id,
  kind: interactionKindSchema,
  title: z.string().min(1).max(200),
  reason: z.string().max(2000).default(''),
  consequence: z.string().max(2000).default(''),
  parameters: z.record(z.string(), z.unknown()).default({}),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  policyRevision: revision,
  generation: z.number().int().positive(),
  scope: grantScopeSchema.optional(),
  expiresAt: isoDate,
  status: interactionStatusSchema,
  answer: z.string().max(8000).optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type BotInteraction = z.infer<typeof botInteractionSchema>

export const botMemorySchema = z.strictObject({
  id,
  botId: id,
  content: z.string().min(1).max(MEMORY_CONTENT_MAX),
  origin: z.enum(['user', 'bot']),
  sourceMessageId: id.optional(),
  turnId: id.optional(),
  active: z.boolean().default(true),
  revision,
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type BotMemory = z.infer<typeof botMemorySchema>

export const botFileSchema = z.strictObject({
  path: z.string().min(1).max(512),
  name: z.string().min(1).max(255),
  kind: z.enum(['file', 'directory']),
  size: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  modifiedAt: isoDate.optional(),
  turnId: id.optional(),
})
export type BotFile = z.infer<typeof botFileSchema>

export const botEventKindSchema = z.enum([
  'turn.status',
  'assistant.delta',
  'assistant.message',
  'tool.started',
  'tool.finished',
  'approval.requested',
  'approval.resolved',
  'question.asked',
  'question.answered',
  'file.produced',
  'memory.proposed',
  'account.changed',
  'runtime.changed',
  'network.changed',
  'attention',
  'diagnostic',
])
export const botEventSchema = z.strictObject({
  seq: z.number().int().positive(),
  botId: id,
  conversationId: id.optional(),
  turnId: id.optional(),
  kind: botEventKindSchema,
  summary: z.string().max(400),
  detail: z.record(z.string(), z.unknown()).optional(),
  runtimeEventId: z.string().max(128).optional(),
  generation: z.number().int().positive().optional(),
  createdAt: isoDate,
})
export type BotEvent = z.infer<typeof botEventSchema>

export const setupStepIdSchema = z.enum(['computer', 'runtime', 'bot', 'account', 'finish'])
export const stepStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped', 'waiting_user'])
export const botOperationSchema = z.strictObject({
  id,
  kind: z.enum(['setup', 'runtime.prepare', 'archive', 'network.update']),
  botId: id.optional(),
  status: z.enum(['queued', 'running', 'waiting_user', 'succeeded', 'failed', 'cancelled']),
  steps: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(40),
        label: z.string().min(1).max(120),
        status: stepStatusSchema,
        vmOperationId: id.optional(),
        error: errorSchema.optional(),
      })
    )
    .max(16),
  retained: z.strictObject({ vmId: id.optional(), diskRetained: z.boolean().default(false) }).optional(),
  error: errorSchema.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type BotOperation = z.infer<typeof botOperationSchema>

export const resourceSpecSchema = z.strictObject({
  cpus: z.number().int().min(1).max(128),
  memoryMiB: z.number().int().min(256).max(1_048_576),
  diskGiB: z.number().int().min(1).max(16_384),
})
export const setupDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('shared-vm'), vmId: id, displayName: z.string().min(1).max(120),
    sessionProfile: sessionProfileSchema.optional(), existingBots: z.number().int().nonnegative(),
    availableSessions: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal('new-vm'), displayName: z.string().min(1).max(120) }),
  z.strictObject({
    kind: z.literal('existing-vm'),
    vmId: id,
    displayName: z.string().min(1).max(120),
    requiresPreparation: z.boolean(),
    requiresRestart: z.boolean(),
    backupRequired: z.boolean(),
  }),
])
export const setupBlockerSchema = z.strictObject({
  code: z.enum([
    'CAPACITY_APPROVAL_REQUIRED',
    'NO_BOT_TEMPLATE',
    'RUNTIME_UNAVAILABLE',
    'HOST_UNSUPPORTED',
    'VM_INCOMPATIBLE',
    'VM_BUSY',
    'VM_ALREADY_BOUND',
    'SESSION_UPDATE_REQUIRED',
    'SESSION_CAPACITY_EXCEEDED',
    'LEGACY_BINDING_CONFLICT',
  ]),
  message: z.string().min(1).max(500),
  alternatives: z.array(z.string().min(1).max(200)).max(8).default([]),
})
export const botSetupPreviewSchema = z.strictObject({
  previewId: id,
  inventoryRevision: z.string().min(1).max(128),
  hostId: z.string().uuid(),
  destination: setupDestinationSchema,
  profile: z.strictObject({
    templateId: id,
    imageId: id,
    runtimeId: id,
    resources: resourceSpecSchema,
    source: z.enum(['recommended', 'custom']),
    requirements: z.strictObject({ minimum: resourceSpecSchema, recommended: resourceSpecSchema }),
  }),
  permissions: z.strictObject({
    mode: permissionModeSchema,
    summary: z.array(z.string().min(1).max(200)).max(8),
  }),
  network: z.strictObject({
    mode: z.enum(['offline', 'allowlist', 'blocklist']),
    domains: z.array(z.string().min(1).max(253)).max(32),
  }),
  feasible: z.boolean(),
  blockers: z.array(setupBlockerSchema).max(8),
  expiresAt: isoDate,
})
export type BotSetupPreview = z.infer<typeof botSetupPreviewSchema>

export const modelCatalogEntrySchema = z.strictObject({
  id: z.string().min(1).max(120),
  displayName: z.string().min(1).max(120),
  efforts: z.array(z.enum(['minimal', 'low', 'medium', 'high', 'xhigh'])).max(5),
  defaultEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  recommended: z.boolean().default(false),
})
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>

export const authStatusSchema = z.strictObject({
  state: accountStateSchema,
  provider: z.literal('codex'),
  method: z.enum(['device', 'apiKey']).optional(),
  account: z.strictObject({ email: z.string().max(200).nullable(), plan: z.string().max(60).nullable() }).optional(),
  pending: z
    .strictObject({
      loginId: z.string().min(1).max(128),
      verificationUrl: z.string().url().max(500),
      userCode: z.string().min(1).max(64),
      expiresAt: isoDate,
    })
    .optional(),
  incompatibleReason: z.string().max(400).optional(),
})
export type AuthStatus = z.infer<typeof authStatusSchema>

export const runtimeInfoSchema = z.strictObject({
  state: runtimeStateSchema,
  version: z.string().max(60).optional(),
  bootId: z.string().uuid().optional(),
  generation: z.number().int().nonnegative().optional(),
  capabilities: z.array(z.string().min(1).max(60)).max(32).default([]),
  reason: z.string().max(400).optional(),
})
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>
