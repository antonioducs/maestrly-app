import { z } from 'zod'
import {
  FLEET_IMAGE_LIMITS,
  FLEET_IMAGE_MEDIA_TYPES,
  FLEET_INSTRUCTIONS_MAX,
  FLEET_MESSAGE_TEXT_MAX,
  FLEET_NAME_MAX,
  FLEET_NOTE_MAX,
  FLEET_PEER_MESSAGE_MAX,
  FLEET_ROLE_MAX,
  FLEET_ROUTINE_PROMPT_MAX,
  FLEET_ROUTINE_TITLE_MAX,
  FLEET_SCREEN,
  FLEET_TOOL_OUTPUT_MAX,
} from './constants.js'

export const fleetIdSchema = z.string().min(1)
export const fleetBotIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/)
export const fleetTimestampSchema = z.iso.datetime().regex(/Z$/)
export const fleetNonNegativeIntSchema = z.number().int().nonnegative()
export const fleetNonNegativeNumberSchema = z.number().finite().nonnegative()
export const fleetNameSchema = z.string().min(1).max(FLEET_NAME_MAX)
export const fleetInstructionsSchema = z.string().max(FLEET_INSTRUCTIONS_MAX)
export const fleetRoleSchema = z.string().max(FLEET_ROLE_MAX)
export const fleetMessageTextSchema = z.string().min(1).max(FLEET_MESSAGE_TEXT_MAX)
export const fleetNoteSchema = z.string().max(FLEET_NOTE_MAX)
export const fleetPeerTextSchema = z.string().min(1).max(FLEET_PEER_MESSAGE_MAX)
export const fleetIdempotencyKeySchema = z.uuid()

export const fleetErrorCodeSchema = z.enum([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_REQUEST',
  'RATE_LIMITED',
  'PROTOCOL_INCOMPATIBLE',
  'BOT_NOT_RUNNING',
  'INSTANCE_UNAVAILABLE',
  'NEEDS_ACCOUNT',
  'IMAGE_MISSING',
  'DOCKER_UNAVAILABLE',
  'INTERNAL',
])
export type FleetErrorCode = z.infer<typeof fleetErrorCodeSchema>

export const FLEET_ERROR_STATUS: Record<FleetErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_REQUEST: 400,
  RATE_LIMITED: 429,
  PROTOCOL_INCOMPATIBLE: 426,
  BOT_NOT_RUNNING: 409,
  INSTANCE_UNAVAILABLE: 503,
  NEEDS_ACCOUNT: 409,
  IMAGE_MISSING: 503,
  DOCKER_UNAVAILABLE: 503,
  INTERNAL: 500,
}

export const fleetErrorEnvelopeSchema = z.object({
  code: fleetErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type FleetErrorEnvelope = z.infer<typeof fleetErrorEnvelopeSchema>

export const fleetCeilingSchema = z.enum(['ask', 'auto', 'full'])
export type FleetCeiling = z.infer<typeof fleetCeilingSchema>
export const fleetLifecycleSchema = z.enum([
  'creating',
  'starting',
  'running',
  'stopping',
  'stopped',
  'restarting',
  'failed',
  'archived',
])
export type FleetLifecycle = z.infer<typeof fleetLifecycleSchema>
export const fleetBotStatusSchema = z.enum([
  'offline',
  'starting',
  'setup',
  'idle',
  'working',
  'waiting',
  'human',
  'paused',
])
export type FleetBotStatus = z.infer<typeof fleetBotStatusSchema>

export const fleetSelectionSchema = z.object({
  providerId: fleetIdSchema,
  modelId: fleetIdSchema,
  reasoning: z.string().nullable(),
  fastMode: z.boolean(),
})
export type FleetSelection = z.infer<typeof fleetSelectionSchema>
export const fleetSelectionOptionSchema = z
  .object({
    id: fleetIdSchema,
    providerId: fleetIdSchema,
    providerLabel: z.string(),
    modelId: fleetIdSchema,
    modelLabel: z.string(),
    efforts: z.array(z.string()),
    fastMode: z.boolean(),
  })
  .refine((option) => option.id === option.providerId + '::' + option.modelId, 'id must match provider and model')
export type FleetSelectionOption = z.infer<typeof fleetSelectionOptionSchema>

export const fleetImageMediaTypeSchema = z.enum(FLEET_IMAGE_MEDIA_TYPES)
export type FleetImageMediaType = z.infer<typeof fleetImageMediaTypeSchema>
/** An image the bot's Maestrly can serve by id (tool screenshots, generated images, owner attachments). */
export const fleetImageRefSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  mediaType: fleetImageMediaTypeSchema,
  byteSize: fleetNonNegativeIntSchema.nullable(),
  name: z.string().max(200).nullable(),
})
export type FleetImageRef = z.infer<typeof fleetImageRefSchema>

/** Context and cost of the bot's primary conversation, computed by the bot's own Maestrly like its composer does. */
export const fleetUsageSchema = z.object({
  contextUsedTokens: fleetNonNegativeIntSchema.nullable(),
  contextWindowTokens: fleetNonNegativeIntSchema.nullable(),
  contextQuality: z.enum(['measured', 'estimated']).nullable(),
  costUsd: fleetNonNegativeNumberSchema.nullable(),
  updatedAt: fleetTimestampSchema.nullable(),
})
export type FleetUsage = z.infer<typeof fleetUsageSchema>

export const fleetActivitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool'), tool: z.string(), target: z.string().nullable() }),
  z.object({ kind: z.literal('thinking') }),
  z.object({ kind: z.literal('permission'), title: z.string() }),
  z.object({ kind: z.literal('question') }),
  z.object({ kind: z.literal('help'), reason: z.string() }),
  z.object({ kind: z.literal('queued'), count: fleetNonNegativeIntSchema }),
  z.object({ kind: z.literal('setup') }),
  z.object({
    kind: z.literal('idle'),
    lastTurnSummary: z.string().nullable(),
    lastTurnAt: fleetTimestampSchema.nullable(),
  }),
])
export type FleetActivity = z.infer<typeof fleetActivitySchema>

export const fleetBotSetupSchema = z.object({
  step: z.enum(['container', 'desktop', 'profile', 'ready', 'failed']),
  error: fleetErrorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
})
export type FleetBotSetup = z.infer<typeof fleetBotSetupSchema>

export const fleetTakeoverStateSchema = z.object({
  state: z.enum(['none', 'acquiring', 'human', 'releasing']),
  deviceId: fleetIdSchema.nullable(),
  deviceName: z.string().nullable(),
  since: fleetTimestampSchema.nullable(),
})
export type FleetTakeoverState = z.infer<typeof fleetTakeoverStateSchema>

export const fleetBotSchema = z.object({
  id: fleetBotIdSchema,
  name: fleetNameSchema,
  role: fleetRoleSchema,
  instructions: fleetInstructionsSchema,
  tint: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  ceiling: fleetCeilingSchema,
  selection: fleetSelectionSchema.nullable(),
  talksTo: z.array(fleetBotIdSchema),
  paused: z.boolean(),
  lifecycle: fleetLifecycleSchema,
  setup: fleetBotSetupSchema,
  status: fleetBotStatusSchema,
  activity: fleetActivitySchema.nullable(),
  pendingCount: fleetNonNegativeIntSchema,
  accounts: z.object({
    connected: z.boolean(),
    providers: z.array(z.object({ id: fleetIdSchema, label: z.string() })),
  }),
  takeover: fleetTakeoverStateSchema,
  resources: z.object({
    memoryBytes: fleetNonNegativeNumberSchema.nullable(),
    memoryLimitBytes: fleetNonNegativeNumberSchema.nullable(),
    cpuPercent: fleetNonNegativeNumberSchema.nullable(),
    startedAt: fleetTimestampSchema.nullable(),
  }),
  screen: z.object({
    width: z.literal(FLEET_SCREEN.width),
    height: z.literal(FLEET_SCREEN.height),
    display: z.string(),
  }),
  appVersion: z.string().nullable(),
  usage: fleetUsageSchema.nullable().default(null),
  createdAt: fleetTimestampSchema,
  updatedAt: fleetTimestampSchema,
})
export type FleetBot = z.infer<typeof fleetBotSchema>

export const fleetQuestionSchema = z.object({
  question: z.string(),
  header: z.string().nullable(),
  options: z.array(z.object({ label: z.string(), description: z.string().nullable() })),
  multiSelect: z.boolean(),
})
export type FleetQuestion = z.infer<typeof fleetQuestionSchema>
export const fleetPermissionToolSchema = z.object({ name: z.string().min(1), target: z.string().nullable() })

const transcriptBase = { id: fleetIdSchema, at: fleetTimestampSchema }
const routineRef = z.object({ id: fleetIdSchema, title: z.string() })
const peerRef = z.object({ botId: fleetBotIdSchema, name: z.string() })

export const fleetTranscriptItemSchema = z.discriminatedUnion('kind', [
  z.object({
    ...transcriptBase,
    kind: z.literal('user'),
    // Empty when the owner sent only images.
    text: z.string().max(FLEET_MESSAGE_TEXT_MAX),
    source: z.enum(['owner', 'routine', 'peer', 'continuation']),
    routine: routineRef.optional(),
    peer: peerRef.optional(),
    queued: z.boolean(),
    images: z.array(fleetImageRefSchema).max(FLEET_IMAGE_LIMITS.attachmentsMax).default([]),
  }),
  z.object({ ...transcriptBase, kind: z.literal('assistant'), text: z.string(), streaming: z.boolean() }),
  z.object({
    ...transcriptBase,
    kind: z.literal('tool'),
    name: z.string(),
    target: z.string().nullable(),
    state: z.enum(['running', 'done', 'error', 'interrupted']),
    output: z.string().max(FLEET_TOOL_OUTPUT_MAX).nullable(),
    // Screenshots and generated images the tool returned, viewable by the owner.
    images: z.array(fleetImageRefSchema).max(FLEET_IMAGE_LIMITS.imagesPerItemMax).default([]),
  }),
  z.object({
    ...transcriptBase,
    kind: z.literal('permission'),
    requestId: fleetIdSchema,
    title: z.string(),
    detail: z.string().nullable(),
    tool: fleetPermissionToolSchema.nullable().default(null),
    state: z.enum(['pending', 'approved', 'denied', 'expired']),
    resolvedAt: fleetTimestampSchema.nullable(),
  }),
  z.object({
    ...transcriptBase,
    kind: z.literal('question'),
    toolCallId: fleetIdSchema,
    questions: z.array(fleetQuestionSchema),
    state: z.enum(['pending', 'answered', 'dismissed']),
    answers: z.array(z.array(z.string())).nullable(),
  }),
  z.object({
    ...transcriptBase,
    kind: z.literal('help'),
    helpId: fleetIdSchema,
    reason: z.string(),
    state: z.enum(['pending', 'resolved']),
    resolvedAt: fleetTimestampSchema.nullable(),
    note: fleetNoteSchema.nullable(),
  }),
  z.object({
    ...transcriptBase,
    kind: z.literal('peer_out'),
    to: peerRef,
    text: fleetPeerTextSchema,
    delivered: z.boolean(),
  }),
  z.object({
    ...transcriptBase,
    kind: z.literal('system'),
    code: z.enum(['created', 'takeover', 'paused', 'resumed', 'restarted', 'turn_failed', 'turn_cancelled']),
    text: z.string().nullable(),
    durationMs: fleetNonNegativeNumberSchema.nullable(),
  }),
])
export type FleetTranscriptItem = z.infer<typeof fleetTranscriptItemSchema>

export const fleetTranscriptPageSchema = z.object({
  items: z.array(fleetTranscriptItemSchema),
  before: z.string().nullable(),
})
export type FleetTranscriptPage = z.infer<typeof fleetTranscriptPageSchema>

export const fleetPendingInteractionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permission'),
    id: fleetIdSchema,
    at: fleetTimestampSchema,
    title: z.string(),
    detail: z.string().nullable(),
    tool: fleetPermissionToolSchema.nullable().default(null),
    itemId: fleetIdSchema,
  }),
  z.object({
    kind: z.literal('question'),
    id: fleetIdSchema,
    at: fleetTimestampSchema,
    questions: z.array(fleetQuestionSchema),
    itemId: fleetIdSchema,
  }),
  z.object({
    kind: z.literal('help'),
    id: fleetIdSchema,
    at: fleetTimestampSchema,
    reason: z.string(),
    itemId: fleetIdSchema,
  }),
])
export type FleetPendingInteraction = z.infer<typeof fleetPendingInteractionSchema>

export const fleetInteractionResolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('permission'), reply: z.enum(['once', 'always', 'reject']) }),
  z.object({ kind: z.literal('question'), answers: z.array(z.array(z.string())) }),
  z.object({ kind: z.literal('question_dismiss') }),
  z.object({ kind: z.literal('help'), note: fleetNoteSchema.nullable() }),
])
export type FleetInteractionResolution = z.infer<typeof fleetInteractionResolutionSchema>

export const fleetInboxItemSchema = z.object({ botId: fleetBotIdSchema, interaction: fleetPendingInteractionSchema })
export type FleetInboxItem = z.infer<typeof fleetInboxItemSchema>

export const fleetRoutineScheduleSchema = z.object({
  kind: z.literal('weekly'),
  time: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
  days: z
    .array(z.number().int().min(1).max(7))
    .max(7)
    .refine((days) => new Set(days).size === days.length, 'days must be unique'),
  timezone: z.string().min(1).max(64),
})
export type FleetRoutineSchedule = z.infer<typeof fleetRoutineScheduleSchema>

export const fleetRoutineSchema = z.object({
  id: fleetIdSchema,
  botId: fleetBotIdSchema,
  title: z.string().min(1).max(FLEET_ROUTINE_TITLE_MAX),
  prompt: z.string().min(1).max(FLEET_ROUTINE_PROMPT_MAX),
  schedule: fleetRoutineScheduleSchema,
  enabled: z.boolean(),
  nextRunAt: fleetTimestampSchema.nullable(),
  lastRunAt: fleetTimestampSchema.nullable(),
  lastOutcome: z.enum(['sent', 'skipped_paused', 'skipped_offline', 'skipped_missed', 'failed']).nullable(),
  createdAt: fleetTimestampSchema,
  updatedAt: fleetTimestampSchema,
})
export type FleetRoutine = z.infer<typeof fleetRoutineSchema>

export const fleetHostInfoSchema = z.object({
  hostname: z.string(),
  os: z.string(),
  kernel: z.string(),
  arch: z.string(),
  cpus: fleetNonNegativeIntSchema,
  cpuPercent: fleetNonNegativeNumberSchema.nullable(),
  memory: z.object({
    totalBytes: fleetNonNegativeNumberSchema,
    usedBytes: fleetNonNegativeNumberSchema,
    botsBytes: fleetNonNegativeNumberSchema,
  }),
  disk: z.object({ totalBytes: fleetNonNegativeNumberSchema, usedBytes: fleetNonNegativeNumberSchema }),
  uptimeSeconds: fleetNonNegativeNumberSchema,
  gatewayVersion: z.string(),
  botImage: z.string(),
  botImageVersion: z.string().nullable(),
  dockerVersion: z.string().nullable(),
})
export type FleetHostInfo = z.infer<typeof fleetHostInfoSchema>

export const fleetPeerMessageSchema = z.object({
  id: fleetIdSchema,
  at: fleetTimestampSchema,
  from: fleetBotIdSchema,
  to: fleetBotIdSchema,
  text: fleetPeerTextSchema,
  delivered: z.boolean(),
})
export type FleetPeerMessage = z.infer<typeof fleetPeerMessageSchema>

export const fleetActivityKindSchema = z.enum([
  'bot_created',
  'bot_started',
  'bot_stopped',
  'bot_restarted',
  'bot_failed',
  'bot_archived',
  'turn_completed',
  'turn_failed',
  'needs_you',
  'routine_ran',
  'routine_skipped',
  'peer_message',
  'takeover_started',
  'takeover_ended',
  'paused',
  'resumed',
])
export type FleetActivityKind = z.infer<typeof fleetActivityKindSchema>
export const fleetActivityEntrySchema = z.object({
  seq: fleetNonNegativeIntSchema,
  at: fleetTimestampSchema,
  botId: fleetBotIdSchema.nullable(),
  kind: fleetActivityKindSchema,
  summary: z.string().nullable(),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
})
export type FleetActivityEntry = z.infer<typeof fleetActivityEntrySchema>

export const fleetGatewayEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), at: fleetTimestampSchema, lastActivitySeq: fleetNonNegativeIntSchema }),
  z.object({ type: z.literal('bot.updated'), at: fleetTimestampSchema, bot: fleetBotSchema }),
  z.object({ type: z.literal('bot.removed'), at: fleetTimestampSchema, botId: fleetBotIdSchema }),
  z.object({ type: z.literal('host.updated'), at: fleetTimestampSchema, host: fleetHostInfoSchema }),
  z.object({ type: z.literal('inbox.updated'), at: fleetTimestampSchema, items: z.array(fleetInboxItemSchema) }),
  z.object({
    type: z.literal('transcript.upsert'),
    at: fleetTimestampSchema,
    botId: fleetBotIdSchema,
    item: fleetTranscriptItemSchema,
  }),
  z.object({ type: z.literal('transcript.reset'), at: fleetTimestampSchema, botId: fleetBotIdSchema }),
  z.object({ type: z.literal('activity'), at: fleetTimestampSchema, entry: fleetActivityEntrySchema }),
  z.object({ type: z.literal('peer.message'), at: fleetTimestampSchema, message: fleetPeerMessageSchema }),
])
export type FleetGatewayEvent = z.infer<typeof fleetGatewayEventSchema>
