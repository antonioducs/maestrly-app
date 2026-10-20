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
  FLEET_PEER_THREAD_LIMITS,
  FLEET_DELEGATION_LIMITS,
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
/** A conversation's id on a workspaces host (a UUID today), as it appears in screen routes and tickets. */
export const fleetHostConversationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/)

/**
 * Container resources, measured per environment. Swap and out-of-memory figures are null when the server does not
 * measure them (cgroup v1, or a gateway that predates them).
 */
export const fleetResourcesSchema = z.object({
  memoryBytes: fleetNonNegativeNumberSchema.nullable(),
  memoryLimitBytes: fleetNonNegativeNumberSchema.nullable(),
  cpuPercent: fleetNonNegativeNumberSchema.nullable(),
  startedAt: fleetTimestampSchema.nullable(),
  /** The container's memory moved out to swap, which `memoryBytes` leaves out. */
  swapBytes: fleetNonNegativeNumberSchema.nullable().default(null),
  /** Processes of the container the kernel ended for lack of memory since the container started. */
  oomKills: fleetNonNegativeIntSchema.nullable().default(null),
  /** How many times since then the container's own memory limit ran out; with none, the whole server did. */
  limitOoms: fleetNonNegativeIntSchema.nullable().default(null),
})
export type FleetResources = z.infer<typeof fleetResourcesSchema>

/** The steps of a bot's move to another environment, in order. */
export const FLEET_BOT_MOVE_PHASES = [
  'prepared',
  'freezing',
  'exporting',
  'importing',
  'verifying',
  'committing',
  'releasing-source',
  'completed',
] as const
export const fleetBotMovePhaseSchema = z.enum(FLEET_BOT_MOVE_PHASES)
export type FleetBotMovePhase = z.infer<typeof fleetBotMovePhaseSchema>
/**
 * A bot's move to another environment. It is `running` until the bot runs there (`completed`), or until it failed and
 * the bot runs where it was (`failed`, with why). A completed move may still be at `releasing-source`: its former
 * environment deletes the bot's copy as soon as it can.
 */
export const fleetBotMoveSchema = z.object({
  id: fleetIdSchema,
  botId: fleetBotIdSchema,
  fromEnvironmentId: fleetEnvironmentIdSchema,
  toEnvironmentId: fleetEnvironmentIdSchema,
  /** The destination was created for this move. */
  newEnvironment: z.boolean(),
  phase: fleetBotMovePhaseSchema,
  state: z.enum(['running', 'completed', 'failed']),
  error: z.object({ code: fleetErrorCodeSchema, message: z.string().max(500) }).nullable(),
  startedAt: fleetTimestampSchema,
  updatedAt: fleetTimestampSchema,
})
export type FleetBotMove = z.infer<typeof fleetBotMoveSchema>

/**
 * How a bot keeps the conversations of its routine runs (`routine-conversations`). A finished run's conversation is
 * deleted `retentionDays` after its last activity (never with null); with `capPerRoutine`, only a routine's newest
 * `FLEET_ROUTINE_RUN_LIMITS.keepPerRoutine` runs stay; with `quietEarly`, a run that reported nothing new keeps its
 * conversation `quietRetentionDays`. Kept runs (`pinned`) are never deleted on their own. `notify` says which finished
 * runs the owner hears about: in the bot's conversation and by push.
 */
export const fleetRoutineRunSettingsSchema = z.object({
  retentionDays: z.union([z.literal(30), z.literal(60), z.literal(90)]).nullable(),
  capPerRoutine: z.boolean(),
  quietEarly: z.boolean(),
  notify: z.enum(['notable', 'all', 'none']),
})
export type FleetRoutineRunSettings = z.infer<typeof fleetRoutineRunSettingsSchema>
export const FLEET_ROUTINE_RUN_SETTINGS_DEFAULT: FleetRoutineRunSettings = {
  retentionDays: 30,
  capPerRoutine: true,
  quietEarly: true,
  notify: 'notable',
}
/**
 * How a bot keeps its conversations with other bots (`peer-conversations`): a thread's conversation is deleted
 * `retentionDays` after its last activity (never with null), unless pinned; and a thread pauses once the bots
 * exchanged `hopLimit` messages in a row without one of the owner's, until the owner writes or lets it go on.
 */
export const fleetPeerThreadSettingsSchema = z.object({
  retentionDays: z
    .union([z.literal(30), z.literal(60), z.literal(90)])
    .nullable()
    .default(30),
  hopLimit: z.union([z.literal(4), z.literal(8), z.literal(16)]).default(8),
})
export type FleetPeerThreadSettings = z.infer<typeof fleetPeerThreadSettingsSchema>
export const FLEET_PEER_THREAD_SETTINGS_DEFAULT: FleetPeerThreadSettings = { retentionDays: 30, hopLimit: 8 }
export const FLEET_DELEGATION_TIERS = ['fast', 'balanced', 'strong'] as const
export type FleetDelegationTier = (typeof FLEET_DELEGATION_TIERS)[number]
export const FLEET_TASK_COMPLEXITIES = ['simple', 'medium', 'complex'] as const
export type FleetTaskComplexity = (typeof FLEET_TASK_COMPLEXITIES)[number]
/** The model class a task of each difficulty asks for. */
export const FLEET_TASK_COMPLEXITY_TIER: Record<FleetTaskComplexity, FleetDelegationTier> = {
  simple: 'fast',
  medium: 'balanced',
  complex: 'strong',
}
/** A model the owner allows for delegated tasks, on every connected account of its provider. */
export const fleetDelegationModelSchema = z.object({
  /** The provider without an account suffix: `builtin_claude_subscription`, or an API-key provider's id. */
  providerId: fleetIdSchema,
  modelId: fleetIdSchema,
  tier: z.enum(FLEET_DELEGATION_TIERS),
})
export type FleetDelegationModel = z.infer<typeof fleetDelegationModelSchema>
/**
 * How a bot splits its work into tasks (`bot-delegation`). In `normal` mode its tasks run on its conversation's model;
 * in `delegate` mode it hands long work to tasks, each on an allowed model of the class its difficulty asks for.
 */
export const fleetBotDelegationSchema = z.object({
  mode: z.enum(['normal', 'delegate']).default('normal'),
  maxTasks: z.number().int().min(FLEET_DELEGATION_LIMITS.tasksMin).max(FLEET_DELEGATION_LIMITS.tasksMax).default(4),
  models: z
    .array(fleetDelegationModelSchema)
    .max(FLEET_DELEGATION_LIMITS.modelsMax)
    .refine(
      (models) => new Set(models.map((model) => `${model.providerId}::${model.modelId}`)).size === models.length,
      'models must be unique'
    )
    .default([]),
  retryStronger: z.boolean().default(true),
  spreadAccounts: z.boolean().default(true),
  sideConversations: z.boolean().default(false),
})
export type FleetBotDelegation = z.infer<typeof fleetBotDelegationSchema>
export const FLEET_BOT_DELEGATION_DEFAULT: FleetBotDelegation = {
  mode: 'normal',
  maxTasks: 4,
  models: [],
  retryStronger: true,
  spreadAccounts: true,
  sideConversations: false,
}
/** The class of allowed model a task runs on: the one its difficulty asks for, else the next stronger one. */
export function fleetDelegationTierFor(
  models: readonly Pick<FleetDelegationModel, 'tier'>[],
  complexity: FleetTaskComplexity
): { tier: FleetDelegationTier; upgraded: boolean } | null {
  const start = FLEET_DELEGATION_TIERS.indexOf(FLEET_TASK_COMPLEXITY_TIER[complexity])
  for (let index = start; index < FLEET_DELEGATION_TIERS.length; index++) {
    const tier = FLEET_DELEGATION_TIERS[index]!
    if (models.some((model) => model.tier === tier)) return { tier, upgraded: index > start }
  }
  return null
}
/** A `task` tool call as the owner sees it (`bot-delegation`). */
export const fleetTranscriptTaskSchema = z.object({
  agent: z.string().max(80),
  prompt: z.string().max(FLEET_DELEGATION_LIMITS.taskPromptMax),
  /** The model that runs it; null before its profile resolves. */
  model: z.string().max(200).nullable(),
  /** Set when the bot's delegation routed it. */
  delegation: z
    .object({
      complexity: z.enum(FLEET_TASK_COMPLEXITIES),
      declared: z.boolean(),
      tier: z.enum(FLEET_DELEGATION_TIERS).nullable(),
      upgraded: z.boolean(),
    })
    .optional(),
  /** What it is doing now, while it runs. */
  activity: z.string().max(200).nullable(),
})
export type FleetTranscriptTask = z.infer<typeof fleetTranscriptTaskSchema>
/** The routine run a bot is working on now, in its own conversation. */
export const fleetRunningRoutineRunSchema = z.object({
  id: fleetIdSchema,
  routineId: fleetIdSchema,
  title: z.string(),
  startedAt: fleetTimestampSchema.nullable(),
})
export type FleetRunningRoutineRun = z.infer<typeof fleetRunningRoutineRunSchema>
/** A turn a bot runs now in one of its conversations (`parallel-turns`). */
export const fleetBotTurnSchema = z.object({
  /** Its own conversation, a routine run's or a conversation with another bot. */
  kind: z.enum(['primary', 'routine', 'peer']),
  /** The run or thread id; null for the bot's own conversation. */
  id: fleetIdSchema.nullable(),
  /** The routine's title or the thread's subject; empty for the bot's own conversation. */
  title: z.string(),
  startedAt: fleetTimestampSchema,
  /** The tool it uses now, if any. */
  tool: z.string().nullable(),
  cancelling: z.boolean(),
  /** Its conversation's context is being compacted; absent from older gateways and instances. */
  compacting: z.boolean().optional(),
})
export type FleetBotTurn = z.infer<typeof fleetBotTurnSchema>

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
  capabilities: z.array(z.string().max(40)).max(40).default([]),
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
  /** Its move to another environment while one runs; null otherwise, and from gateways without `bot-move`. */
  move: fleetBotMoveSchema.nullable().default(null),
  /** How it keeps its routine runs' conversations; null from gateways without `routine-conversations`. */
  runSettings: fleetRoutineRunSettingsSchema.nullable().default(null),
  /** How it keeps its conversations with other bots; null from gateways without `peer-conversations`. */
  peerSettings: fleetPeerThreadSettingsSchema.nullable().default(null),
  /** How the bot splits its work into tasks; null from gateways without `bot-delegation` or until the owner sets it. */
  delegation: fleetBotDelegationSchema.nullable().default(null),
  /** The routine run its turn works on now, in the run's own conversation; null otherwise. */
  runningRun: fleetRunningRoutineRunSchema.nullable().default(null),
  /**
   * Every turn it runs now, one per conversation (`parallel-turns`); null from gateways that predate them, whose
   * `status` and `runningRun` tell the same for one turn at a time. Read with `fleetPrimaryWorking`/`fleetLaneTurn`.
   */
  turns: z.array(fleetBotTurnSchema).nullable().default(null),
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

/** What an environment runs: bots, or the owner's chats and workspaces driven from their computers. */
export const fleetEnvironmentKindSchema = z.enum(['bots', 'workspaces'])
export type FleetEnvironmentKind = z.infer<typeof fleetEnvironmentKindSchema>

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

export const fleetTintSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)
/** The CPU limit the owner may set for an environment's container, in CPUs (Docker's `--cpus`). */
export const fleetCpuLimitSchema = z
  .number()
  .finite()
  .min(FLEET_ENVIRONMENT_LIMITS.cpuLimitMin)
  .max(FLEET_ENVIRONMENT_LIMITS.cpuLimitMax)
  .refine((value) => Number.isInteger(value * 4), 'CPU limits go by quarters of a CPU')
/** How long a workspaces environment stays idle before it stops itself, in minutes. */
export const fleetIdleStopMinutesSchema = z
  .number()
  .int()
  .min(FLEET_ENVIRONMENT_LIMITS.idleStopMinutesMin)
  .max(FLEET_ENVIRONMENT_LIMITS.idleStopMinutesMax)
/**
 * Which server folder a workspaces environment mounts: one of its own under the server's workspaces folder, or that whole
 * folder, shared with whatever else is in it (environments from before folders of their own).
 */
export const fleetHostFolderModeSchema = z.enum(['own', 'shared'])
export type FleetHostFolderMode = z.infer<typeof fleetHostFolderModeSchema>
/** What a workspaces environment shares with the rest of its server. */
export const fleetEnvironmentIsolationSchema = z.object({
  /** `own`: a Docker network shared only with the gateway; `shared`: the network of the server's bots. */
  network: z.enum(['own', 'shared']),
  /** The server folder it mounts; `none` (path null) when the server has no workspaces folder. */
  folder: z.object({
    mode: z.enum(['own', 'shared', 'none']),
    path: z.string().max(4096).nullable(),
  }),
  /** Its container was created with another network or folder than these: restarting it applies them. */
  restartRequired: z.boolean(),
})
export type FleetEnvironmentIsolation = z.infer<typeof fleetEnvironmentIsolationSchema>

/**
 * An environment: one container with one Maestrly, one home folder and one set of accounts, skills, MCP servers and
 * site logins, shared by its bots. Its lifecycle (start, stop, restart, update) acts on all of them.
 */
export const fleetEnvironmentSchema = z.object({
  id: fleetEnvironmentIdSchema,
  name: fleetNameSchema,
  /** `bots` from gateways that predate workspaces environments. */
  kind: fleetEnvironmentKindSchema.default('bots'),
  lifecycle: fleetLifecycleSchema,
  setup: fleetEnvironmentSetupSchema,
  resources: fleetResourcesSchema,
  /** The limit the owner set for the container; null when it uses the gateway's default. */
  memoryLimitBytes: fleetNonNegativeNumberSchema.nullable(),
  /** The CPU limit the owner set, in CPUs; null when the container may use every CPU of the server. */
  cpuLimit: fleetCpuLimitSchema.nullable().default(null),
  /** A workspaces environment stops itself after this many idle minutes; null when it never does. */
  idleStopMinutes: fleetIdleStopMinutesSchema.nullable().default(null),
  /** The color the owner chose for it; null when it has none, or the gateway predates colors. */
  tint: fleetTintSchema.nullable().default(null),
  /** A workspaces environment's network and folder; null for bots, or from gateways that predate them. */
  isolation: fleetEnvironmentIsolationSchema.nullable().default(null),
  /** The compaction model of its bots that have none of their own; null when none is set or the gateway predates it. */
  compaction: fleetCompactionConfigSchema.nullable().default(null),
  appVersion: z.string().nullable(),
  capabilities: z.array(z.string().max(40)).max(40).default([]),
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
  /** The run found nothing new: its history groups it with the others like it, and the owner is not alerted. */
  quiet: z.boolean().optional(),
})
export type FleetRoutineRunReport = z.infer<typeof fleetRoutineRunReportSchema>
/** What a run's conversation produced that the owner sees: images, videos and other files. */
export const fleetRoutineRunMediaSchema = z.object({
  images: fleetNonNegativeIntSchema,
  videos: fleetNonNegativeIntSchema,
  files: fleetNonNegativeIntSchema,
})
export type FleetRoutineRunMedia = z.infer<typeof fleetRoutineRunMediaSchema>
/**
 * What stays of a run whose conversation was deleted, besides its report: the images and attachments copied to
 * `folder` (relative to the bot's conversation folder) and the files the run had shared, which were already there.
 */
export const fleetRoutineRunKeptSchema = z.object({
  folder: z.string().max(400),
  files: z
    .array(
      z.object({
        name: z.string().max(200),
        kind: z.enum(['image', 'video', 'file']),
        byteSize: fleetNonNegativeIntSchema.nullable(),
      })
    )
    .max(FLEET_ROUTINE_RUN_LIMITS.keptFilesMax),
})
export type FleetRoutineRunKept = z.infer<typeof fleetRoutineRunKeptSchema>
/**
 * A conversation between two bots (`peer-conversations`), as one of them (`botId`) sees it: its own conversation
 * of the thread, apart from its conversation with its owner.
 */
export const fleetPeerThreadSchema = z.object({
  id: fleetIdSchema,
  botId: fleetBotIdSchema,
  peer: z.object({ botId: fleetBotIdSchema, name: z.string() }),
  title: z.string().max(FLEET_PEER_THREAD_LIMITS.titleMax),
  /** `primary`: this bot opened it from its own conversation; `side`: from another side conversation; `peer`: the other bot did. */
  origin: z.enum(['primary', 'side', 'peer']),
  /** `paused` once the bots reached `hopLimit` messages in a row without the owner. */
  status: z.enum(['open', 'paused']),
  /** Messages between the bots in a row without one of the owner's. */
  hops: fleetNonNegativeIntSchema,
  hopLimit: z.number().int().min(1),
  messages: fleetNonNegativeIntSchema,
  pinned: z.boolean(),
  conversation: z.enum(['own', 'deleted']),
  /** What this bot brought back to its owner's conversation, for a thread it opened there. */
  report: z.string().max(FLEET_PEER_THREAD_LIMITS.reportMax).nullable(),
  reportAt: fleetTimestampSchema.nullable(),
  /** Whether this bot, or the other one, has a turn running in its conversation of the thread. */
  working: z.boolean(),
  peerWorking: z.boolean(),
  createdAt: fleetTimestampSchema,
  lastActivityAt: fleetTimestampSchema,
  /** When its conversation is deleted on its own; null when never (pinned, or kept until deleted). */
  expiresAt: fleetTimestampSchema.nullable(),
  conversationDeletedAt: fleetTimestampSchema.nullable(),
  kept: fleetRoutineRunKeptSchema.nullable(),
})
export type FleetPeerThread = z.infer<typeof fleetPeerThreadSchema>
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
  // From gateways with `routine-conversations`; the defaults describe a run in the bot's conversation.
  /** The routine's title when it ran: a run outlives its routine. */
  routineTitle: z.string().max(FLEET_ROUTINE_TITLE_MAX).nullable().default(null),
  /**
   * Where it ran: `primary`, the bot's conversation (runs before `routine-conversations`); `own`, a conversation of its
   * own that the owner may read and continue; `deleted`, one that was deleted, its report and files kept.
   */
  conversation: z.enum(['primary', 'own', 'deleted']).default('primary'),
  quiet: z.boolean().default(false),
  /** The owner keeps it: its conversation is never deleted on its own. */
  pinned: z.boolean().default(false),
  /** The last turn in its conversation, or the owner's last message there; retention counts from it. */
  lastActivityAt: fleetTimestampSchema.nullable().default(null),
  /** When retention deletes its conversation; null while it runs, kept, deleted or kept forever. */
  expiresAt: fleetTimestampSchema.nullable().default(null),
  conversationDeletedAt: fleetTimestampSchema.nullable().default(null),
  media: fleetRoutineRunMediaSchema.nullable().default(null),
  kept: fleetRoutineRunKeptSchema.nullable().default(null),
  /** Messages the owner sent in its conversation after it started. */
  adjustments: fleetNonNegativeIntSchema.default(0),
})
export type FleetRoutineRun = z.infer<typeof fleetRoutineRunSchema>
/** A routine run an owner's message refers to, as the bot's conversation shows it. */
export const fleetRoutineRunCitationSchema = z.object({
  runId: fleetIdSchema,
  routineTitle: z.string().max(FLEET_ROUTINE_TITLE_MAX),
  at: fleetTimestampSchema,
})
export type FleetRoutineRunCitation = z.infer<typeof fleetRoutineRunCitationSchema>
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

export const fleetUserTranscriptItemSchema = z.object({
  ...transcriptBase,
  kind: z.literal('user'),
  // Empty when the owner sent only images.
  text: z.string().max(FLEET_MESSAGE_TEXT_MAX),
  source: z.enum(['owner', 'routine', 'peer', 'continuation']),
  routine: routineRef.optional(),
  peer: peerRef.optional(),
  queued: z.boolean(),
  /** A queued message whose conversation the owner stopped: it waits until they write there or remove it. */
  stopped: z.boolean().optional(),
  attachmentError: z.enum(['invalid-attachment', 'pdf-unreadable']).optional(),
  memories: z
    .array(z.object({ id: z.string(), title: z.string() }))
    .max(10)
    .default([]),
  images: z.array(fleetImageRefSchema).max(FLEET_IMAGE_LIMITS.attachmentsMax).default([]),
  files: z.array(fleetFileRefSchema).max(FLEET_FILE_LIMITS.attachmentsMax).optional(),
  /** The routine run the owner's message refers to (`routine-conversations`). */
  citation: fleetRoutineRunCitationSchema.optional(),
})

export const fleetTranscriptItemSchema = z.discriminatedUnion('kind', [
  fleetUserTranscriptItemSchema,
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
    // task only (`bot-delegation`): absent from instances that predate it.
    task: fleetTranscriptTaskSchema.optional(),
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
    /** The thread the message went to (`peer-conversations`), which goes on in a conversation of its own. */
    thread: z.object({ id: fleetIdSchema }).optional(),
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

/** The routine run whose conversation an interaction belongs to (`routine-conversations`); absent for the bot's own. */
const interactionRun = { runId: fleetIdSchema.optional() }
export const fleetPendingInteractionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permission'),
    id: fleetIdSchema,
    at: fleetTimestampSchema,
    title: z.string(),
    detail: z.string().nullable(),
    tool: fleetPermissionToolSchema.nullable().default(null),
    itemId: fleetIdSchema,
    ...interactionRun,
  }),
  z.object({
    kind: z.literal('question'),
    id: fleetIdSchema,
    at: fleetTimestampSchema,
    questions: z.array(fleetQuestionSchema),
    itemId: fleetIdSchema,
    ...interactionRun,
  }),
  z.object({
    kind: z.literal('help'),
    id: fleetIdSchema,
    at: fleetTimestampSchema,
    reason: z.string(),
    itemId: fleetIdSchema,
    ...interactionRun,
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
    /** The server's swap; null from gateways that predate it. */
    swap: z
      .object({
        totalBytes: fleetNonNegativeNumberSchema,
        usedBytes: fleetNonNegativeNumberSchema,
        /** Memory that swap compressed in memory (zram) takes, part of `usedBytes` above it and of no container. */
        compressedBytes: fleetNonNegativeNumberSchema,
      })
      .nullable()
      .default(null),
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
/**
 * What gave a bot access: one of the owner's computers, or a workspaces environment of the server (`host-desktop-calls`),
 * which is there whether or not any computer is on. A link without it, from an older gateway, is a computer.
 */
export const fleetDesktopKindSchema = z.enum(['computer', 'environment'])
export type FleetDesktopKind = z.infer<typeof fleetDesktopKindSchema>
/**
 * A Mac (or a workspaces environment, `kind`) that gave a bot access to its workspaces. `online`: its Maestrly is
 * connected to this server right now; for an environment, it runs and takes calls.
 */
export const fleetDesktopLinkSchema = z.object({
  desktopId: fleetDesktopIdSchema,
  name: fleetDesktopNameSchema,
  kind: fleetDesktopKindSchema.optional(),
  online: z.boolean(),
  lastSeenAt: fleetTimestampSchema.nullable(),
  linkedAt: fleetTimestampSchema,
})
export type FleetDesktopLink = z.infer<typeof fleetDesktopLinkSchema>
/**
 * The same link as the owner's Macs see it: `self` marks the link of the Mac asking, and the link of a workspaces
 * environment names it (`environmentId`), which a bot never reads.
 */
export const fleetDesktopLinkViewSchema = fleetDesktopLinkSchema.extend({
  self: z.boolean(),
  environmentId: fleetEnvironmentIdSchema.optional(),
})
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
/** One call as whoever runs it reads it: from a Mac's event stream, or posted to a workspaces host's control server. */
export const fleetDesktopCallSchema = fleetDesktopCallEventSchema.omit({ type: true, at: true })
export type FleetDesktopCall = z.infer<typeof fleetDesktopCallSchema>

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
  // Routine runs (`routine-conversations`): sent only to the streams that asked for them (`routineRuns=1`).
  z.object({
    type: z.literal('routine_run.updated'),
    at: fleetTimestampSchema,
    botId: fleetBotIdSchema,
    run: fleetRoutineRunSchema,
  }),
  z.object({
    type: z.literal('routine_run.removed'),
    at: fleetTimestampSchema,
    botId: fleetBotIdSchema,
    runId: fleetIdSchema,
  }),
  z.object({
    type: z.literal('routine_run.transcript.upsert'),
    at: fleetTimestampSchema,
    botId: fleetBotIdSchema,
    runId: fleetIdSchema,
    item: fleetTranscriptItemSchema,
  }),
  z.object({
    type: z.literal('routine_run.transcript.reset'),
    at: fleetTimestampSchema,
    botId: fleetBotIdSchema,
    runId: fleetIdSchema,
  }),
  // Threads between bots (`peer-conversations`): sent only to the streams that asked for them (`peerThreads=1`).
  z.object({
    type: z.literal('peer_thread.updated'),
    at: fleetTimestampSchema,
    botId: fleetBotIdSchema,
    thread: fleetPeerThreadSchema,
  }),
  z.object({
    type: z.literal('peer_thread.removed'),
    at: fleetTimestampSchema,
    botId: fleetBotIdSchema,
    threadId: fleetIdSchema,
  }),
  z.object({
    type: z.literal('peer_thread.transcript.upsert'),
    at: fleetTimestampSchema,
    botId: fleetBotIdSchema,
    threadId: fleetIdSchema,
    item: fleetTranscriptItemSchema,
  }),
  z.object({
    type: z.literal('peer_thread.transcript.reset'),
    at: fleetTimestampSchema,
    botId: fleetBotIdSchema,
    threadId: fleetIdSchema,
  }),
])
export type FleetGatewayEvent = z.infer<typeof fleetGatewayEventSchema>
