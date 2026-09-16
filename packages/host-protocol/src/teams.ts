import { z } from 'zod'
import { id, revision, errorSchema } from './common.js'
import { isoDate, permissionModeSchema, turnStatusSchema } from './bots.js'

// Team domain. A team belongs to one Host and only links bots that already exist there.
// Nothing here carries Host paths, credentials, provider payloads or guest sockets:
// shared content is always named by identity, version and digest.
export const TEAM_NAME_MAX = 80
export const TEAM_OBJECTIVE_MAX = 4_000
export const TEAM_ROLE_MAX = 200
export const TEAM_GOAL_MAX = 8_000
export const TEAM_CRITERIA_MAX = 4_000
export const TEAM_MESSAGE_CONTENT_MAX = 64 * 1024
export const TEAM_SUMMARY_MAX = 16 * 1024
export const TEAM_MEMORY_CONTENT_MAX = 8 * 1024
export const TEAM_ARTIFACT_NAME_MAX = 255
export const TEAM_EVENTS_PAGE_BUDGET = 512 * 1024
/** Runtime capability required for any collaboration tool; an older guest simply has none. */
export const TEAM_CAPABILITY = 'bot.teams.v1'
/** Host capability advertised by host.inspect once the teams domain is available. */
export const TEAM_HOST_CAPABILITY = 'teams.v1'

/**
 * Operational safety defaults, not benchmark numbers. Every value is enforced in the Host
 * and shown under Advanced. A per-turn ceiling still applies on top of these.
 */
export const TEAM_LIMITS = {
  membersMax: 8,
  /** Bots that may work for one team at the same time. */
  concurrency: 2,
  /** Collaboration slots across every team of this Host. */
  globalConcurrency: 2,
  /** Delegation batches, including the planning round that opens the work. */
  maxRounds: 3,
  maxTasks: 12,
  /** Physical turns: planning, workers, consolidation and human continuations. */
  maxTurns: 24,
  maxToolCalls: 300,
  maxActiveMs: 60 * 60_000,
  /**
   * Largest share of a work's allowance one execution may reserve. Without it the first
   * turn would take the whole per-turn ceiling and leave nothing for the members that are
   * supposed to work in parallel.
   */
  parcelDivisor: 4,
  /** Held back so a run can always report what happened instead of dying mid-flight. */
  consolidationToolCalls: 40,
  consolidationActiveMs: 10 * 60_000,
  tasksPerBatchMax: 6,
  /** Aggregate size of shared copies kept for one team. */
  shareQuotaBytes: 256 * 1024 * 1024,
  artifactsPerTeamMax: 512,
  /** Collaboration requests in flight per guest session. */
  requestsInFlightMax: 2,
  requestTimeoutMs: 20_000,
} as const

export const teamPolicySchema = z.strictObject({
  concurrency: z.number().int().min(1).max(4).default(TEAM_LIMITS.concurrency),
  maxRounds: z.number().int().min(1).max(6).default(TEAM_LIMITS.maxRounds),
  maxTasks: z.number().int().min(1).max(24).default(TEAM_LIMITS.maxTasks),
  maxTurns: z.number().int().min(1).max(48).default(TEAM_LIMITS.maxTurns),
  maxToolCalls: z.number().int().min(1).max(600).default(TEAM_LIMITS.maxToolCalls),
  maxActiveMs: z.number().int().min(60_000).max(4 * 60 * 60_000).default(TEAM_LIMITS.maxActiveMs),
  /** Ceiling for every member of this team; the bot's own mode still applies if stricter. */
  permissionMode: permissionModeSchema.default('ask'),
  shareMemory: z.boolean().default(true),
  shareArtifacts: z.boolean().default(true),
})
export type TeamPolicy = z.infer<typeof teamPolicySchema>

export const teamStatusSchema = z.enum(['active', 'archived'])
export const teamSchema = z.strictObject({
  id,
  hostId: z.string().uuid(),
  name: z.string().min(1).max(TEAM_NAME_MAX),
  objective: z.string().max(TEAM_OBJECTIVE_MAX).default(''),
  coordinatorBotId: id,
  conversationId: id,
  status: teamStatusSchema,
  policy: teamPolicySchema,
  revision,
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type Team = z.infer<typeof teamSchema>

export const teamMemberSchema = z.strictObject({
  id,
  teamId: id,
  botId: id,
  role: z.string().max(TEAM_ROLE_MAX).default(''),
  coordinator: z.boolean().default(false),
  active: z.boolean().default(true),
  /** The person accepted that this bot receives the team's shared context. */
  consentedAt: isoDate,
  /** Bumped on every membership change; an authorization never survives it. */
  grantRevision: revision,
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type TeamMember = z.infer<typeof teamMemberSchema>

export const teamConversationSchema = z.strictObject({
  id,
  teamId: id,
  title: z.string().max(200).default(''),
  activeRunId: id.optional(),
  lastSequence: revision.default(0),
  revision,
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type TeamConversation = z.infer<typeof teamConversationSchema>

/** A delegation is never presented as if a person had written it. */
export const teamAuthorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human') }),
  z.strictObject({ kind: z.literal('bot'), botId: id, name: z.string().min(1).max(TEAM_NAME_MAX) }),
  z.strictObject({ kind: z.literal('system') }),
])
export type TeamAuthor = z.infer<typeof teamAuthorSchema>

export const teamArtifactRefSchema = z.strictObject({
  artifactId: id,
  name: z.string().min(1).max(TEAM_ARTIFACT_NAME_MAX),
  size: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(),
})
export type TeamArtifactRef = z.infer<typeof teamArtifactRefSchema>

export const teamMessageSchema = z.strictObject({
  id,
  conversationId: id,
  clientMessageId: id,
  author: teamAuthorSchema,
  kind: z.enum(['request', 'answer', 'progress', 'notice']),
  content: z.string().max(TEAM_MESSAGE_CONTENT_MAX),
  runId: id.optional(),
  taskId: id.optional(),
  sequence: z.number().int().positive(),
  artifacts: z.array(teamArtifactRefSchema).max(16).default([]),
  createdAt: isoDate,
})
export type TeamMessage = z.infer<typeof teamMessageSchema>

export const teamRunStatusSchema = z.enum([
  'queued',
  'planning',
  'working',
  'reviewing',
  'waiting_user',
  'paused',
  'needs_attention',
  'cancelling',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
])
export type TeamRunStatus = z.infer<typeof teamRunStatusSchema>
export const TEAM_RUN_TERMINAL: ReadonlySet<TeamRunStatus> = new Set<TeamRunStatus>(['succeeded', 'partial', 'failed', 'cancelled'])

export const teamRosterEntrySchema = z.strictObject({
  memberId: id,
  botId: id,
  name: z.string().min(1).max(TEAM_NAME_MAX),
  role: z.string().max(TEAM_ROLE_MAX).default(''),
  coordinator: z.boolean().default(false),
})
export type TeamRosterEntry = z.infer<typeof teamRosterEntrySchema>

/**
 * Budget parcels reserved before each turn and settled only against evidence of an
 * ending. Token usage stays optional: unknown consumption is reported as unknown.
 */
export const teamBudgetSchema = z.strictObject({
  rounds: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  toolCallsReserved: z.number().int().nonnegative(),
  toolCallsSettled: z.number().int().nonnegative(),
  activeMsReserved: z.number().int().nonnegative(),
  activeMsSettled: z.number().int().nonnegative(),
  consolidationHeld: z.boolean(),
  tokensObserved: z.boolean(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
})
export type TeamBudget = z.infer<typeof teamBudgetSchema>

export const teamRunSchema = z.strictObject({
  id,
  teamId: id,
  conversationId: id,
  messageId: id,
  coordinatorBotId: id,
  roster: z.array(teamRosterEntrySchema).max(TEAM_LIMITS.membersMax),
  resources: z.array(teamArtifactRefSchema).max(16).default([]),
  memberGrantRevision: revision,
  limits: teamPolicySchema,
  budget: teamBudgetSchema,
  round: z.number().int().nonnegative(),
  status: teamRunStatusSchema,
  generation: z.number().int().positive(),
  /** Consolidated answer, written once by the Host from the recorded results. */
  summary: z.string().max(TEAM_SUMMARY_MAX).optional(),
  attention: z.string().max(1000).optional(),
  error: errorSchema.optional(),
  revision,
  createdAt: isoDate,
  updatedAt: isoDate,
  finishedAt: isoDate.optional(),
})
export type TeamRun = z.infer<typeof teamRunSchema>

export const teamTaskStatusSchema = z.enum([
  'planned',
  'waiting_bot',
  'staging',
  'running',
  'waiting_approval',
  'waiting_input',
  'paused_human',
  'needs_attention',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
])
export type TeamTaskStatus = z.infer<typeof teamTaskStatusSchema>
export const TEAM_TASK_TERMINAL: ReadonlySet<TeamTaskStatus> = new Set<TeamTaskStatus>(['succeeded', 'failed', 'cancelled', 'skipped'])
/** States in which the task occupies its bot and no sibling may reuse that slot. */
export const TEAM_TASK_ACTIVE: ReadonlySet<TeamTaskStatus> = new Set<TeamTaskStatus>([
  'waiting_bot',
  'staging',
  'running',
  'waiting_approval',
  'waiting_input',
  'paused_human',
  'needs_attention',
])

export const teamTaskResultSchema = z.strictObject({
  summary: z.string().max(TEAM_SUMMARY_MAX),
  artifacts: z.array(teamArtifactRefSchema).max(16).default([]),
  turnId: id,
  completedAt: isoDate,
})
export type TeamTaskResult = z.infer<typeof teamTaskResultSchema>

export const teamTaskSchema = z.strictObject({
  id,
  runId: id,
  teamId: id,
  round: z.number().int().nonnegative(),
  /** Coordinator-chosen key, unique inside one round; never a Host identifier. */
  localKey: z.string().min(1).max(60).regex(/^[A-Za-z0-9._-]+$/),
  kind: z.enum(['planning', 'work', 'consolidation']),
  assigneeBotId: id,
  memberId: id,
  goal: z.string().min(1).max(TEAM_GOAL_MAX),
  acceptanceCriteria: z.string().max(TEAM_CRITERIA_MAX).default(''),
  dependsOn: z.array(id).max(8).default([]),
  inputArtifactIds: z.array(id).max(8).default([]),
  useDependencyOutputs: z.boolean().default(true),
  origin: z.enum(['human', 'coordinator', 'system']),
  status: teamTaskStatusSchema,
  attempts: z.number().int().nonnegative().default(0),
  result: teamTaskResultSchema.optional(),
  error: errorSchema.optional(),
  attention: z.string().max(1000).optional(),
  revision,
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type TeamTask = z.infer<typeof teamTaskSchema>

/** One logical task maps to many physical turns; a resume never creates new work. */
export const teamTaskAttemptSchema = z.strictObject({
  id,
  taskId: id,
  runId: id,
  botId: id,
  turnId: id,
  conversationId: id,
  generation: z.number().int().positive(),
  continuationOfTurnId: id.optional(),
  handoffOperationId: id.optional(),
  reservedToolCalls: z.number().int().nonnegative(),
  reservedActiveMs: z.number().int().nonnegative(),
  settled: z.boolean(),
  settledAs: turnStatusSchema.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type TeamTaskAttempt = z.infer<typeof teamTaskAttemptSchema>

export const teamEventKindSchema = z.enum([
  'run.status',
  'task.status',
  'delegation.submitted',
  'member.message',
  'approval.requested',
  'approval.resolved',
  'question.asked',
  'question.answered',
  'artifact.shared',
  'artifact.revoked',
  'memory.proposed',
  'memory.changed',
  'membership.changed',
  'attention',
])
export const teamEventSchema = z.strictObject({
  seq: z.number().int().positive(),
  teamId: id,
  runId: id.optional(),
  taskId: id.optional(),
  botId: id.optional(),
  kind: teamEventKindSchema,
  summary: z.string().max(400),
  detail: z.record(z.string(), z.unknown()).optional(),
  createdAt: isoDate,
})
export type TeamEvent = z.infer<typeof teamEventSchema>

export const teamMemorySchema = z.strictObject({
  id,
  teamId: id,
  content: z.string().min(1).max(TEAM_MEMORY_CONTENT_MAX),
  origin: z.enum(['user', 'bot']),
  proposedByBotId: id.optional(),
  /** A bot proposal is inert until a person approves it. */
  status: z.enum(['proposed', 'active', 'removed']),
  version: z.number().int().positive(),
  revision,
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type TeamMemory = z.infer<typeof teamMemorySchema>

export const teamArtifactOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human') }),
  z.strictObject({ kind: z.literal('bot'), botId: id, runId: id, taskId: id.optional() }),
])
export const teamArtifactSchema = z.strictObject({
  id,
  teamId: id,
  name: z.string().min(1).max(TEAM_ARTIFACT_NAME_MAX),
  size: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(),
  origin: teamArtifactOriginSchema,
  /** Staged copies only become shareable after size and digest are verified. */
  state: z.enum(['staging', 'available', 'revoked']),
  runId: id.optional(),
  taskId: id.optional(),
  revokedAt: isoDate.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type TeamArtifact = z.infer<typeof teamArtifactSchema>

export const teamArtifactGrantSchema = z.strictObject({
  id,
  artifactId: id,
  teamId: id,
  botId: id,
  runId: id,
  taskId: id.optional(),
  /** Generated workspace-relative path in the recipient's own workspace. */
  path: z.string().min(1).max(512),
  state: z.enum(['pending', 'delivered', 'revoked']),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type TeamArtifactGrant = z.infer<typeof teamArtifactGrantSchema>

export const teamOperationSchema = z.strictObject({
  id,
  kind: z.enum([
    'team.create',
    'team.update',
    'team.archive',
    'team.members.set',
    'team.message',
    'team.run.cancel',
    'team.memory',
    'team.artifact.share',
    'team.artifact.revoke',
    'team.collaboration',
  ]),
  teamId: id.optional(),
  runId: id.optional(),
  taskId: id.optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  /** Stable references only; never bytes, credentials or provider payloads. */
  detail: z.record(z.string(), z.unknown()).optional(),
  error: errorSchema.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type TeamOperation = z.infer<typeof teamOperationSchema>

/** Public, stable error codes for the team domain; free text never crosses the sanitizer. */
export const TEAM_ERROR_CODES = [
  'TEAM_NOT_FOUND',
  'TEAM_ARCHIVED',
  'TEAM_BUSY',
  'TEAM_RUN_ACTIVE',
  'TEAM_MEMBER_INVALID',
  'TEAM_COORDINATOR_REQUIRED',
  'TEAM_NOT_MEMBER',
  'TEAM_FOREIGN_HOST',
  'TEAM_DELEGATION_INVALID',
  'TEAM_DEPENDENCY_INVALID',
  'TEAM_ROUND_LIMIT',
  'TEAM_TASK_LIMIT',
  'TEAM_TURN_LIMIT',
  'TEAM_BUDGET_EXHAUSTED',
  'TEAM_STAGE_INVALID',
  'TEAM_GRANT_REVOKED',
  'TEAM_QUOTA_EXCEEDED',
  'TEAM_UPDATE_REQUIRED',
  'TEAM_WORK_IN_PROGRESS',
] as const
export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number]
