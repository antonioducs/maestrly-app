import { z } from 'zod'
import { id } from './common.js'
import {
  TEAM_CRITERIA_MAX,
  TEAM_GOAL_MAX,
  TEAM_LIMITS,
  TEAM_MEMORY_CONTENT_MAX,
  TEAM_NAME_MAX,
  TEAM_ROLE_MAX,
  TEAM_SUMMARY_MAX,
  teamArtifactRefSchema,
  teamTaskStatusSchema,
} from './teams.js'

/**
 * Private collaboration lane between a working guest and the Host, carried on the same
 * authenticated control channel as turns and account renewal but discriminated apart from
 * them. The Host derives the acting bot, team and run from the session it authenticated
 * and the turn it registered: a model-supplied source, role or team never selects anything.
 */
export const COLLABORATION_METHODS = [
  'team_members',
  'team_delegate',
  'team_status',
  'team_publish_file',
  'team_memory_propose',
  'team_operation',
] as const
export type CollaborationMethod = (typeof COLLABORATION_METHODS)[number]

const localKey = z.string().min(1).max(60).regex(/^[A-Za-z0-9._-]+$/)
export const delegatedTaskSchema = z.strictObject({
  localKey,
  assigneeBotId: id,
  goal: z.string().min(1).max(TEAM_GOAL_MAX),
  acceptanceCriteria: z.string().max(TEAM_CRITERIA_MAX).default(''),
  /** Local keys of sibling tasks in the same batch; cycles are rejected before anything starts. */
  dependsOn: z.array(localKey).max(8).default([]),
  inputArtifactIds: z.array(id).max(8).default([]),
  useDependencyOutputs: z.boolean().default(true),
})
export type DelegatedTask = z.infer<typeof delegatedTaskSchema>

export const collaborationParamSchemas = {
  team_members: z.strictObject({}),
  team_delegate: z.strictObject({ tasks: z.array(delegatedTaskSchema).min(1).max(TEAM_LIMITS.tasksPerBatchMax) }),
  team_status: z.strictObject({}),
  team_publish_file: z.strictObject({
    path: z.string().min(1).max(512),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).default(''),
  }),
  team_memory_propose: z.strictObject({ content: z.string().min(1).max(TEAM_MEMORY_CONTENT_MAX) }),
  team_operation: z.strictObject({ operationId: id }),
} satisfies Record<CollaborationMethod, z.ZodType>

/**
 * The frame keeps one discriminator so it can live beside hello/event/response on the
 * control channel. Parameters are re-parsed strictly per method by the Host, which is the
 * only side that decides what the acting bot is allowed to ask for.
 */
export const collaborationRequestSchema = z.strictObject({
  type: z.literal('collaboration.request'),
  id,
  turnId: id,
  generation: z.number().int().positive(),
  method: z.enum(COLLABORATION_METHODS),
  params: z.record(z.string(), z.unknown()).default({}),
})
export type CollaborationRequest = z.infer<typeof collaborationRequestSchema>

export const teamRemainingSchema = z.strictObject({
  rounds: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  activeMs: z.number().int().nonnegative(),
})
export const collaborationMemberSchema = z.strictObject({
  botId: id,
  name: z.string().min(1).max(TEAM_NAME_MAX),
  role: z.string().max(TEAM_ROLE_MAX).default(''),
  coordinator: z.boolean(),
  /** Whether this member may receive work in the current stage. */
  assignable: z.boolean(),
})
export const collaborationResultSchemas = {
  team_members: z.strictObject({
    runId: id,
    round: z.number().int().nonnegative(),
    stage: z.enum(['planning', 'working', 'consolidation']),
    role: z.enum(['coordinator', 'member']),
    members: z.array(collaborationMemberSchema).max(TEAM_LIMITS.membersMax),
    remaining: teamRemainingSchema,
  }),
  team_delegate: z.strictObject({
    receiptId: id,
    round: z.number().int().nonnegative(),
    accepted: z.array(z.strictObject({ localKey, taskId: id, assigneeBotId: id })).max(TEAM_LIMITS.tasksPerBatchMax),
    /** The Host starts the batch only after this turn ends; holding the slot would deadlock. */
    finishTurn: z.literal(true),
    guidance: z.string().max(1000),
  }),
  team_status: z.strictObject({
    runId: id,
    round: z.number().int().nonnegative(),
    status: z.string().max(40),
    tasks: z
      .array(
        z.strictObject({
          taskId: id,
          localKey,
          assigneeBotId: id,
          status: teamTaskStatusSchema,
          summary: z.string().max(TEAM_SUMMARY_MAX).optional(),
          artifacts: z.array(teamArtifactRefSchema).max(16).default([]),
          error: z.string().max(400).optional(),
        })
      )
      .max(TEAM_LIMITS.maxTasks),
    remaining: teamRemainingSchema,
  }),
  team_publish_file: z.strictObject({
    operationId: id,
    status: z.enum(['accepted', 'succeeded', 'failed']),
    artifact: teamArtifactRefSchema.optional(),
    error: z.string().max(400).optional(),
  }),
  team_memory_propose: z.strictObject({
    proposalId: id,
    status: z.literal('proposed'),
    guidance: z.string().max(400),
  }),
  team_operation: z.strictObject({
    operationId: id,
    status: z.enum(['accepted', 'succeeded', 'failed']),
    artifact: teamArtifactRefSchema.optional(),
    error: z.string().max(400).optional(),
  }),
} satisfies Record<CollaborationMethod, z.ZodType>
export type CollaborationResult<M extends CollaborationMethod> = z.infer<(typeof collaborationResultSchemas)[M]>

export const collaborationResponseSchema = z.strictObject({
  type: z.literal('collaboration.response'),
  id,
  result: z.unknown().optional(),
  error: z.strictObject({ code: z.string().min(1).max(64), message: z.string().max(400) }).optional(),
})
export type CollaborationResponse = z.infer<typeof collaborationResponseSchema>

/**
 * Team context added to the turn snapshot of a collaborating bot. It carries only what the
 * person authorized: the request, consented roles, approved team memory, verified resource
 * references and the results this task depends on. Private conversations and private memory
 * of any bot are never injected here.
 */
export const teamTurnContextSchema = z.strictObject({
  teamId: id,
  teamName: z.string().min(1).max(TEAM_NAME_MAX),
  runId: id,
  taskId: id,
  round: z.number().int().nonnegative(),
  stage: z.enum(['planning', 'working', 'consolidation']),
  role: z.enum(['coordinator', 'member']),
  objective: z.string().max(4_000).default(''),
  members: z.array(collaborationMemberSchema).max(TEAM_LIMITS.membersMax),
  memory: z.array(z.strictObject({ id, content: z.string().max(TEAM_MEMORY_CONTENT_MAX) })).max(64).default([]),
  /** Copies already delivered to this bot's own workspace, by relative path. */
  resources: z
    .array(
      z.strictObject({
        artifactId: id,
        name: z.string().min(1).max(255),
        path: z.string().min(1).max(512),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().nonnegative(),
        origin: z.string().max(200),
      })
    )
    .max(16)
    .default([]),
  dependencyResults: z
    .array(
      z.strictObject({
        taskId: id,
        localKey,
        botName: z.string().min(1).max(TEAM_NAME_MAX),
        status: teamTaskStatusSchema,
        summary: z.string().max(TEAM_SUMMARY_MAX).default(''),
      })
    )
    .max(TEAM_LIMITS.maxTasks)
    .default([]),
  remaining: teamRemainingSchema,
  /** Collaboration tools offered for this exact turn; anything else is refused by the Host. */
  tools: z.array(z.enum(COLLABORATION_METHODS)).max(COLLABORATION_METHODS.length),
})
export type TeamTurnContext = z.infer<typeof teamTurnContextSchema>
