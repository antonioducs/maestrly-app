import { z } from 'zod'
import {
  FLEET_OWNER_MEMORY_LIMITS,
  FLEET_ROUTINE_RUN_LIMITS,
  FLEET_BOT_MEMORY_LIMITS,
  FLEET_IMAGE_LIMITS,
  FLEET_FILE_LIMITS,
  FLEET_IMAGE_MEDIA_TYPES,
  FLEET_INSTRUCTIONS_MAX,
  FLEET_MESSAGE_TEXT_MAX,
  FLEET_NAME_MAX,
  FLEET_NOTE_MAX,
  FLEET_PEER_MESSAGE_MAX,
  FLEET_ROLE_MAX,
  FLEET_COMPACTION_LIMITS,
  FLEET_COMPACTION_SUMMARY_MAX,
  FLEET_ENVIRONMENT_LIMITS,
  FLEET_ROUTINE_LIMITS,
  FLEET_ROUTINE_PROMPT_MAX,
  FLEET_ROUTINE_TITLE_MAX,
  FLEET_SCREEN,
  FLEET_TODO_LIMITS,
  FLEET_TOOL_OUTPUT_MAX,
  FLEET_REASONING_TEXT_MAX,
  FLEET_RUNTIME_IDS,
  FLEET_RUNTIME_STATES,
  FLEET_DESKTOP_BRIDGE_LIMITS,
} from './constants.js'

export const fleetIdSchema = z.string().min(1)
export const fleetBotIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/)
/** Environment ids are slugs like bot ids: an existing bot became the environment with its own id. */
export const fleetEnvironmentIdSchema = fleetBotIdSchema
export type FleetEnvironmentId = z.infer<typeof fleetEnvironmentIdSchema>
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

export const fleetFileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/)
export const fleetFileNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => {
    try {
      encodeURIComponent(value)
      return true
    } catch {
      return false
    }
  }, 'File names must be well-formed Unicode')
/** A private, bot-scoped file reference. It never exposes a filesystem path or credentials. */
export const fleetFileRefSchema = z.object({
  id: fleetFileIdSchema,
  name: fleetFileNameSchema,
  mediaType: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  byteSize: z.number().int().nonnegative().max(FLEET_FILE_LIMITS.downloadMaxBytes),
})
export type FleetFileRef = z.infer<typeof fleetFileRefSchema>

/** Context and cost of the bot's primary conversation, computed by the bot's own Maestrly like its composer does. */
export const fleetUsageSchema = z.object({
  contextUsedTokens: fleetNonNegativeIntSchema.nullable(),
  contextWindowTokens: fleetNonNegativeIntSchema.nullable(),
  contextQuality: z.enum(['measured', 'estimated']).nullable(),
  costUsd: fleetNonNegativeNumberSchema.nullable(),
  updatedAt: fleetTimestampSchema.nullable(),
})
export type FleetUsage = z.infer<typeof fleetUsageSchema>

/**
 * The model a bot compacts its conversation with, chosen by the owner: it prepares summaries in the background and,
 * when none fits at 90%, compacts on the spot. A bot without one (or whose model is no longer available) stays in
 * setup and starts no turn; its conversation model never compacts.
 */
export const fleetCompactionConfigSchema = fleetSelectionSchema.extend({
  intervalTokens: z
    .number()
    .int()
    .min(FLEET_COMPACTION_LIMITS.intervalTokensMin)
    .max(FLEET_COMPACTION_LIMITS.intervalTokensMax),
  /**
   * The most context the bot's conversation may use, whatever its model: it compacts at 90% of this or of its model's
   * window, whichever is smaller. Absent or null: its model's window. Configs from before the limit have none.
   */
  contextLimitTokens: z
    .number()
    .int()
    .min(FLEET_COMPACTION_LIMITS.contextLimitTokensMin)
    .max(FLEET_COMPACTION_LIMITS.contextLimitTokensMax)
    .nullable()
    .optional(),
})
export type FleetCompactionConfig = z.infer<typeof fleetCompactionConfigSchema>
/** A compaction in progress or just finished, as the desktop composer shows it next to the context meter. */
export const fleetCompactionProgressSchema = z.object({
  id: fleetIdSchema,
  status: z.enum(['running', 'retrying', 'completed', 'failed', 'cancelled']),
  phase: z.enum(['chunk', 'consolidate', 'native']).nullable(),
  completed: fleetNonNegativeIntSchema.nullable(),
  total: fleetNonNegativeIntSchema.nullable(),
  attempt: fleetNonNegativeIntSchema.nullable(),
  beforeTokens: fleetNonNegativeIntSchema.nullable(),
  afterTokens: fleetNonNegativeIntSchema.nullable(),
  afterQuality: z.enum(['measured', 'estimated']).nullable(),
  error: z.string().max(500).nullable(),
  updatedAt: fleetTimestampSchema,
})
export type FleetCompactionProgress = z.infer<typeof fleetCompactionProgressSchema>
export const fleetCompactionStateSchema = z.object({
  /** A valid compaction model is set and its account is connected: the bot may start turns. */
  configured: z.boolean(),
  /** Why not: no model chosen, its model/account is gone, or the bot's Maestrly refused its parameters. */
  problem: z.enum(['missing', 'unavailable', 'invalid']).nullable(),
  /** Background preparation, as the desktop's own status (`BackgroundCompactionStatus`); error is a desktop code. */
  background: z.object({
    status: z.enum(['idle', 'queued', 'running', 'ready', 'failed', 'paused']),
    error: z.string().max(200).nullable(),
  }),
  progress: fleetCompactionProgressSchema.nullable(),
})
export type FleetCompactionState = z.infer<typeof fleetCompactionStateSchema>

export const fleetActivitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool'), tool: z.string(), target: z.string().nullable() }),
  z.object({ kind: z.literal('thinking') }),
  z.object({ kind: z.literal('permission'), title: z.string() }),
  z.object({ kind: z.literal('question') }),
  z.object({ kind: z.literal('help'), reason: z.string() }),
  z.object({ kind: z.literal('queued'), count: fleetNonNegativeIntSchema }),
  /** The bot needs a model account, or (once it has one) a compaction model, before it starts any turn. */
  z.object({ kind: z.literal('setup'), need: z.enum(['account', 'compaction']).default('account') }),
  z.object({ kind: z.literal('compacting') }),
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

/** A bot's screen areas: its browser window (a tile of the environment display) and its own apps display. */
export const fleetScreenSurfaceSchema = z.enum(['browser', 'apps'])
export type FleetScreenSurface = z.infer<typeof fleetScreenSurfaceSchema>

/** Container resources, measured per environment. */
export const fleetResourcesSchema = z.object({
  memoryBytes: fleetNonNegativeNumberSchema.nullable(),
  memoryLimitBytes: fleetNonNegativeNumberSchema.nullable(),
  cpuPercent: fleetNonNegativeNumberSchema.nullable(),
  startedAt: fleetTimestampSchema.nullable(),
})
export type FleetResources = z.infer<typeof fleetResourcesSchema>

export const fleetBotSchema = z.object({
  id: fleetBotIdSchema,
  name: fleetNameSchema,
  role: fleetRoleSchema,
  instructions: fleetInstructionsSchema,
  tint: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  ceiling: fleetCeilingSchema,
  selection: fleetSelectionSchema.nullable(),
  talksTo: z.array(fleetBotIdSchema),
  publishArtifacts: z.boolean().default(false),
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
  resources: fleetResourcesSchema,
  screen: z.object({
    width: z.literal(FLEET_SCREEN.width),
    height: z.literal(FLEET_SCREEN.height),
    display: z.string(),
  }),
  appVersion: z.string().nullable(),
  capabilities: z.array(z.string().max(40)).max(20).default([]),
  usage: fleetUsageSchema.nullable().default(null),
  /**
   * The model the bot compacts with: its own, or else its environment's default. Stored by the gateway, like
   * `selection`.
   */
  compaction: fleetCompactionConfigSchema.nullable().default(null),
  /**
   * Where `compaction` comes from: the bot's own choice or its environment's default. Null when no model is set, or
   * from gateways that predate environment defaults (a set `compaction` is then the bot's own).
   */
  compactionSource: z.enum(['bot', 'environment']).nullable().default(null),
  /** Reported by the running bot; null when it is not running or predates bot compaction. */
  compactionState: fleetCompactionStateSchema.nullable().default(null),
  /** The environment the bot runs in; null from gateways that predate environments. */
  environmentId: fleetEnvironmentIdSchema.nullable().default(null),
  createdAt: fleetTimestampSchema,
  updatedAt: fleetTimestampSchema,
})
export type FleetBot = z.infer<typeof fleetBotSchema>

/** An archived bot: no container, its home volume (files, accounts, conversation) and its record kept on the server. */
export const fleetArchivedBotSchema = z.object({
  id: fleetBotIdSchema,
  name: fleetNameSchema,
  role: fleetRoleSchema,
  tint: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  createdAt: fleetTimestampSchema,
  archivedAt: fleetTimestampSchema,
  /** `missing` when the home volume was removed outside Maestrly: a restored bot then starts with an empty home. */
  files: z.enum(['kept', 'missing']),
  /** The environment it was archived from; null from gateways that predate environments. */
  environmentId: fleetEnvironmentIdSchema.nullable().default(null),
})
export type FleetArchivedBot = z.infer<typeof fleetArchivedBotSchema>

/** An environment has no profile step: each bot sets up its own profile once the environment is ready. */
export const fleetEnvironmentSetupSchema = z.object({
  step: z.enum(['container', 'desktop', 'ready', 'failed']),
  error: fleetErrorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
})
export type FleetEnvironmentSetup = z.infer<typeof fleetEnvironmentSetupSchema>

/** Whether an environment can move to the configured bot image, and whether that move waits for its bots. */
export const fleetEnvironmentUpdateSchema = z.object({
  /** The environment's container runs an image other than the configured bot image. */
  available: z.boolean(),
  /** When the owner scheduled the update; null when none is waiting. */
  pendingSince: fleetTimestampSchema.nullable(),
})
export type FleetEnvironmentUpdate = z.infer<typeof fleetEnvironmentUpdateSchema>

/** One runtime of an environment (Claude Code or Codex): the version in use and its release channel. */
export const fleetRuntimeInfoSchema = z.object({
  id: z.enum(FLEET_RUNTIME_IDS),
  /**
   * The version the bots run now, which work in progress may keep after another was installed. Null when the runtime
   * is neither shipped by the image nor installed.
   */
  version: z.string().max(40).nullable(),
  /** `image`: the version the bot image ships; `managed`: a newer release the environment installed on its own. */
  source: z.enum(['image', 'managed']),
  /**
   * The version the bots switch to once their work in progress ends (Codex: once none of them is working); null
   * when they already run the selected version, or for an image that predates it.
   */
  pendingVersion: z.string().max(40).nullable().default(null),
  automatic: z.boolean(),
  state: z.enum(FLEET_RUNTIME_STATES),
  availableVersion: z.string().max(40).nullable(),
  lastCheckedAt: fleetTimestampSchema.nullable(),
  /** A desktop error code of the last check or update. */
  error: z.string().max(40).nullable(),
})
export type FleetRuntimeInfo = z.infer<typeof fleetRuntimeInfoSchema>
export const fleetRuntimesSchema = z.array(fleetRuntimeInfoSchema).max(4)

/**
 * An environment: one container with one Maestrly, one home folder and one set of accounts, skills, MCP servers and
 * site logins, shared by its bots. Its lifecycle (start, stop, restart, update) acts on all of them.
 */
export const fleetEnvironmentSchema = z.object({
  id: fleetEnvironmentIdSchema,
  name: fleetNameSchema,
  lifecycle: fleetLifecycleSchema,
  setup: fleetEnvironmentSetupSchema,
  resources: fleetResourcesSchema,
  /** The limit the owner set for the container; null when it uses the gateway's default. */
  memoryLimitBytes: fleetNonNegativeNumberSchema.nullable(),
  /** The compaction model of its bots that have none of their own; null when none is set or the gateway predates it. */
  compaction: fleetCompactionConfigSchema.nullable().default(null),
  appVersion: z.string().nullable(),
  capabilities: z.array(z.string().max(40)).max(20).default([]),
  /** Null when the gateway predates environment updates. */
  update: fleetEnvironmentUpdateSchema.nullable().default(null),
  /** Null when the gateway or the environment's image predates runtime reports. */
  runtimes: fleetRuntimesSchema.nullable().default(null),
  /** Additional runtime IDs, kept separate so older readers can still parse the legacy runtimes. */
  additionalRuntimes: fleetRuntimesSchema.optional(),
  botIds: z.array(fleetBotIdSchema).max(FLEET_ENVIRONMENT_LIMITS.botsMax),
  createdAt: fleetTimestampSchema,
  updatedAt: fleetTimestampSchema,
})
export type FleetEnvironment = z.infer<typeof fleetEnvironmentSchema>

/** An archived environment: no container; its home volume and the records of its bots kept on the server. */
export const fleetArchivedEnvironmentSchema = z.object({
  id: fleetEnvironmentIdSchema,
  name: fleetNameSchema,
  createdAt: fleetTimestampSchema,
  archivedAt: fleetTimestampSchema,
  /** `missing` when the home volume was removed outside Maestrly: a restored environment starts with an empty home. */
  files: z.enum(['kept', 'missing']),
  bots: z.array(z.object({ id: fleetBotIdSchema, name: fleetNameSchema, role: fleetRoleSchema, tint: z.string() })),
})
export type FleetArchivedEnvironment = z.infer<typeof fleetArchivedEnvironmentSchema>

export const fleetQuestionSchema = z.object({
  question: z.string(),
  header: z.string().nullable(),
  options: z.array(z.object({ label: z.string(), description: z.string().nullable() })),
  multiSelect: z.boolean(),
})
export type FleetQuestion = z.infer<typeof fleetQuestionSchema>
export const fleetPermissionToolSchema = z.object({ name: z.string().min(1), target: z.string().nullable() })

// domain.ts (import the three limits)
export const fleetOwnerMemoryOriginSchema = z.enum(['owner', 'routine', 'peer', 'continuation', 'auto'])
export type FleetOwnerMemoryOrigin = z.infer<typeof fleetOwnerMemoryOriginSchema>
export const fleetOwnerMemoryEntrySchema = z.object({
  id: fleetIdSchema,
  content: z.string().min(1).max(FLEET_OWNER_MEMORY_LIMITS.entryMax),
  status: z.enum(['active', 'superseded', 'archived']),
  author: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('owner') }),
    z.object({ kind: z.literal('bot'), botId: fleetBotIdSchema, name: z.string() }),
  ]),
  origin: fleetOwnerMemoryOriginSchema.nullable(),
  replacesId: fleetIdSchema.nullable(),
  replacedById: fleetIdSchema.nullable(),
  /** Null for a global entry (every bot sees it); otherwise only the bots of that environment see it. */
  environmentId: fleetEnvironmentIdSchema.nullable().default(null),
  createdAt: fleetTimestampSchema,
  updatedAt: fleetTimestampSchema,
})
export type FleetOwnerMemoryEntry = z.infer<typeof fleetOwnerMemoryEntrySchema>
export const fleetOwnerMemorySchema = z.object({
  revision: fleetNonNegativeIntSchema,
  activeChars: fleetNonNegativeIntSchema,
  entries: z.array(fleetOwnerMemoryEntrySchema),
})
export type FleetOwnerMemory = z.infer<typeof fleetOwnerMemorySchema>
export const fleetRoutineRunStatusSchema = z.enum(['delivered', 'completed', 'failed', 'cancelled', 'unknown'])
export const fleetRoutineRunReportSchema = z.object({
  summary: z.string().trim().min(1).max(FLEET_ROUTINE_RUN_LIMITS.summaryMax),
  pending: z.string().trim().max(FLEET_ROUTINE_RUN_LIMITS.pendingMax).nullable(),
  notes: z.string().trim().max(FLEET_ROUTINE_RUN_LIMITS.notesMax).nullable(),
})
export type FleetRoutineRunReport = z.infer<typeof fleetRoutineRunReportSchema>
export const fleetRoutineRunSchema = z.object({
  id: fleetIdSchema,
  routineId: fleetIdSchema,
  botId: fleetBotIdSchema,
  trigger: z.enum(['schedule', 'manual']),
  status: fleetRoutineRunStatusSchema,
  deliveredAt: fleetTimestampSchema,
  finishedAt: fleetTimestampSchema.nullable(),
  report: fleetRoutineRunReportSchema.nullable(),
  finalText: z.string().max(FLEET_ROUTINE_RUN_LIMITS.finalTextMax).nullable(),
})
export type FleetRoutineRun = z.infer<typeof fleetRoutineRunSchema>
export const fleetRoutinePreviousRunSchema = z.object({
  at: fleetTimestampSchema,
  status: fleetRoutineRunStatusSchema,
  summary: z.string().max(FLEET_ROUTINE_RUN_LIMITS.summaryMax).nullable(),
  pending: z.string().max(FLEET_ROUTINE_RUN_LIMITS.pendingMax).nullable(),
  notes: z.string().max(FLEET_ROUTINE_RUN_LIMITS.notesMax).nullable(),
})
export type FleetRoutinePreviousRun = z.infer<typeof fleetRoutinePreviousRunSchema>
export const fleetBotMemorySchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string(),
  content: z.string().max(FLEET_BOT_MEMORY_LIMITS.contentMax),
  truncated: z.boolean(),
  type: z.enum(['decision', 'constraint', 'preference', 'procedure', 'lesson', 'reference']),
  status: z.enum(['active', 'superseded', 'archived']),
  pinned: z.boolean(),
  source: z.enum(['user', 'agent', 'auto', 'legacy-import']),
  useCount: fleetNonNegativeIntSchema,
  createdAt: fleetTimestampSchema,
  updatedAt: fleetTimestampSchema,
})
export type FleetBotMemory = z.infer<typeof fleetBotMemorySchema>

export const fleetTodoSchema = z.object({
  content: z.string().min(1).max(FLEET_TODO_LIMITS.contentMax),
  status: z.enum(['pending', 'in_progress', 'completed']),
})
export type FleetTodo = z.infer<typeof fleetTodoSchema>

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
    attachmentError: z.enum(['invalid-attachment', 'pdf-unreadable']).optional(),
    memories: z
      .array(z.object({ id: z.string(), title: z.string() }))
      .max(10)
      .default([]),
    images: z.array(fleetImageRefSchema).max(FLEET_IMAGE_LIMITS.attachmentsMax).default([]),
    files: z.array(fleetFileRefSchema).max(FLEET_FILE_LIMITS.attachmentsMax).optional(),
  }),
  z.object({ ...transcriptBase, kind: z.literal('assistant'), text: z.string(), streaming: z.boolean() }),
  /**
   * The model's reasoning (`transcript-reasoning`): sent only to readers that ask for it, cut at
   * `FLEET_REASONING_TEXT_MAX` (`truncated`).
   */
  z.object({
    ...transcriptBase,
    kind: z.literal('reasoning'),
    text: z.string().max(FLEET_REASONING_TEXT_MAX),
    truncated: z.boolean(),
    streaming: z.boolean(),
  }),
  z.object({
    ...transcriptBase,
    kind: z.literal('tool'),
    name: z.string(),
    target: z.string().nullable(),
    state: z.enum(['running', 'done', 'error', 'interrupted']),
    output: z.string().max(FLEET_TOOL_OUTPUT_MAX).nullable(),
    // Screenshots and generated images the tool returned, viewable by the owner.
    images: z.array(fleetImageRefSchema).max(FLEET_IMAGE_LIMITS.imagesPerItemMax).default([]),
    // Whether the images are for the owner to see in the conversation (the bot asked to share them) or only in the
    // tool's details. Absent from instances that predate it, whose images the owner always saw in the conversation.
    shared: z.boolean().optional(),
    files: z.array(fleetFileRefSchema).max(FLEET_FILE_LIMITS.attachmentsMax).optional(),
    // todo_write only: the list it recorded. Absent from other tools and from instances that predate it.
    todos: z.array(fleetTodoSchema).max(FLEET_TODO_LIMITS.itemsMax).optional(),
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
  /**
   * The conversation was compacted here. `prepared`: a summary prepared in the background; `immediate`: none was
   * ready or fit, so the compaction model summarized on the spot; `manual`: the owner asked (/compact); `runtime`:
   * the model's own runtime compacted inside a turn (no readable summary).
   */
  z.object({
    ...transcriptBase,
    kind: z.literal('compaction'),
    origin: z.enum(['prepared', 'immediate', 'manual', 'runtime']),
    summary: z.string().max(FLEET_COMPACTION_SUMMARY_MAX).nullable(),
    truncated: z.boolean(),
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

export const fleetWeeklyScheduleSchema = z.object({
  kind: z.literal('weekly'),
  time: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
  days: z
    .array(z.number().int().min(1).max(7))
    .max(7)
    .refine((days) => new Set(days).size === days.length, 'days must be unique'),
  timezone: z.string().min(1).max(64),
})
export type FleetWeeklySchedule = z.infer<typeof fleetWeeklyScheduleSchema>
/** Runs every `everyMinutes` from when it is created, enabled or rescheduled. */
export const fleetIntervalScheduleSchema = z.object({
  kind: z.literal('interval'),
  everyMinutes: z
    .number()
    .int()
    .min(FLEET_ROUTINE_LIMITS.intervalMinMinutes)
    .max(FLEET_ROUTINE_LIMITS.intervalMaxMinutes),
})
export type FleetIntervalSchedule = z.infer<typeof fleetIntervalScheduleSchema>
export const fleetRoutineScheduleSchema = z.discriminatedUnion('kind', [
  fleetWeeklyScheduleSchema,
  fleetIntervalScheduleSchema,
])
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
  /** `skipped_busy`: the routine's previous run was still queued or running, so this one was not sent. */
  lastOutcome: z
    .enum(['sent', 'skipped_paused', 'skipped_offline', 'skipped_missed', 'skipped_busy', 'failed'])
    .nullable(),
  /** Who created it. A bot may change or delete only the routines it created; the owner may change any. */
  createdBy: z.enum(['owner', 'bot']).default('owner'),
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
  // A bot changed the owner memory (summary: the entry; data: entryId).
  'owner_memory_saved',
  'owner_memory_forgotten',
  'bot_created',
  // The owner's device sent accounts, skills or MCP servers to the bot, or removed them (summary: device name).
  'bot_configured',
  'bot_started',
  'bot_stopped',
  'bot_restarted',
  'bot_failed',
  'bot_archived',
  'bot_restored',
  // botId is null (the bot no longer exists); the summary carries its name.
  'bot_deleted',
  // An environment's lifecycle (botId is null; environmentId names it and the summary carries its name).
  'environment_created',
  'environment_started',
  'environment_stopped',
  'environment_restarted',
  'environment_archived',
  'environment_restored',
  'environment_deleted',
  'turn_completed',
  'turn_failed',
  'needs_you',
  'routine_ran',
  'routine_skipped',
  // A bot changed its own routines (summary: the routine title; data: routineId).
  'routine_created',
  'routine_updated',
  'routine_deleted',
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
  /** The environment it happened in; null for fleet-wide entries and from gateways that predate environments. */
  environmentId: fleetEnvironmentIdSchema.nullable().default(null),
  kind: fleetActivityKindSchema,
  summary: z.string().nullable(),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
})
export type FleetActivityEntry = z.infer<typeof fleetActivityEntrySchema>

const fleetArtifactIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/)

/**
 * A Mac as one bot sees it: an opaque id minted by the gateway for that bot and that Mac, never the device id the Mac
 * paired with. Workspace, conversation and selection ids a Mac hands out are only valid together with its `desktopId`.
 */
export const fleetDesktopIdSchema = z.string().regex(/^dsk_[A-Za-z0-9_-]{16,64}$/)
export type FleetDesktopId = z.infer<typeof fleetDesktopIdSchema>
/** The name a Mac shows to the bots it links, chosen on that Mac (its pairing name by default). */
export const fleetDesktopNameSchema = z.string().trim().min(1).max(FLEET_DESKTOP_BRIDGE_LIMITS.nameMax)
/** A Mac that gave a bot access to its workspaces. `online`: its Maestrly is connected to this server right now. */
export const fleetDesktopLinkSchema = z.object({
  desktopId: fleetDesktopIdSchema,
  name: fleetDesktopNameSchema,
  online: z.boolean(),
  lastSeenAt: fleetTimestampSchema.nullable(),
  linkedAt: fleetTimestampSchema,
})
export type FleetDesktopLink = z.infer<typeof fleetDesktopLinkSchema>
/** The same link as the owner's Macs see it: `self` marks the link of the Mac asking. */
export const fleetDesktopLinkViewSchema = fleetDesktopLinkSchema.extend({ self: z.boolean() })
export type FleetDesktopLinkView = z.infer<typeof fleetDesktopLinkViewSchema>
/**
 * What a bot may ask a Mac, by its own name: each one is a conversation tool of that Mac's Maestrly, run under the
 * grants, approval ceiling and idempotency that Mac keeps for the bot. Nothing here approves a permission or a plan.
 */
export const FLEET_DESKTOP_OPS = [
  'listWorkspaces',
  'listSelections',
  'listChats',
  'readChat',
  'readChatHistory',
  'waitEvents',
  'createChat',
  'sendMessage',
  'configureChat',
  'cancelTurn',
  'answerQuestion',
] as const
export const fleetDesktopOpSchema = z.enum(FLEET_DESKTOP_OPS)
export type FleetDesktopOp = z.infer<typeof fleetDesktopOpSchema>
/** The ops that change something on the Mac; the others only read. */
export const FLEET_DESKTOP_WRITE_OPS: readonly FleetDesktopOp[] = [
  'createChat',
  'sendMessage',
  'configureChat',
  'cancelTurn',
  'answerQuestion',
]
/** UTF-8 size of a value as JSON, the way it crosses the gateway. */
export function fleetJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength
}
export const fleetDesktopInputSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => fleetJsonBytes(value) <= FLEET_DESKTOP_BRIDGE_LIMITS.inputBytesMax, 'The call input is too large')
/** One call of a bot for one Mac, sent only on that Mac's event stream. */
export const fleetDesktopCallEventSchema = z.object({
  type: z.literal('desktop.call'),
  at: fleetTimestampSchema,
  callId: z.uuid(),
  botId: fleetBotIdSchema,
  desktopId: fleetDesktopIdSchema,
  op: fleetDesktopOpSchema,
  input: fleetDesktopInputSchema,
  /** After this the gateway no longer waits for the result: a Mac that sees it late does not run it. */
  expiresAt: fleetTimestampSchema,
})
export type FleetDesktopCallEvent = z.infer<typeof fleetDesktopCallEventSchema>

export const fleetGatewayEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('artifact.changed'), at: fleetTimestampSchema, artifactId: fleetArtifactIdSchema }),
  z.object({
    type: z.literal('artifact.activity'),
    at: fleetTimestampSchema,
    artifactId: fleetArtifactIdSchema,
    kind: z.enum(['device_added', 'access_requested', 'invite_declined', 'comment_added']),
  }),
  z.object({ type: z.literal('owner_memory.updated'), at: fleetTimestampSchema, revision: fleetNonNegativeIntSchema }),
  z.object({ type: z.literal('hello'), at: fleetTimestampSchema, lastActivitySeq: fleetNonNegativeIntSchema }),
  z.object({ type: z.literal('bot.updated'), at: fleetTimestampSchema, bot: fleetBotSchema }),
  z.object({ type: z.literal('bot.removed'), at: fleetTimestampSchema, botId: fleetBotIdSchema }),
  z.object({ type: z.literal('environment.updated'), at: fleetTimestampSchema, environment: fleetEnvironmentSchema }),
  z.object({
    type: z.literal('environment.removed'),
    at: fleetTimestampSchema,
    environmentId: fleetEnvironmentIdSchema,
  }),
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
  // Sent only to the streams of Macs that asked for desktop calls (`desktopBridge=1`): older Macs never see them.
  fleetDesktopCallEventSchema,
  /** The Macs linked to a bot changed; empty once the bot was deleted. Each Mac reads its own link as `self`. */
  z.object({
    type: z.literal('desktop_link.updated'),
    at: fleetTimestampSchema,
    botId: fleetBotIdSchema,
    links: z.array(fleetDesktopLinkViewSchema).max(FLEET_DESKTOP_BRIDGE_LIMITS.linksPerBotMax),
  }),
])
export type FleetGatewayEvent = z.infer<typeof fleetGatewayEventSchema>
