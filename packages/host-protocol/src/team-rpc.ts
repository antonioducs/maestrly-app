import { z } from 'zod'
import { id, revision } from './common.js'
import { TRANSFER_CHUNK_BYTES, botTurnSchema } from './bots.js'
import {
  TEAM_LIMITS,
  TEAM_MEMORY_CONTENT_MAX,
  TEAM_MESSAGE_CONTENT_MAX,
  TEAM_NAME_MAX,
  TEAM_OBJECTIVE_MAX,
  TEAM_ROLE_MAX,
  teamArtifactSchema,
  teamConversationSchema,
  teamEventSchema,
  teamMemberSchema,
  teamMemorySchema,
  teamMessageSchema,
  teamOperationSchema,
  teamPolicySchema,
  teamRunSchema,
  teamSchema,
  teamTaskSchema,
} from './teams.js'

// Public team methods share the v1 envelope. Mutations carry an idempotency key and, when
// they change an existing resource, the revision the caller believes it is changing.
const envelope = { version: z.literal(1), id }
const request = <M extends string, S extends z.ZodType>(method: M, params: S) =>
  z.strictObject({ ...envelope, method: z.literal(method), params })
const byTeam = z.strictObject({ teamId: id })
const chunkBase64 = z.string().max(Math.ceil((TRANSFER_CHUNK_BYTES * 4) / 3) + 4)
const memberInput = z.strictObject({
  botId: id,
  role: z.string().max(TEAM_ROLE_MAX).default(''),
  coordinator: z.boolean().default(false),
})
const policyInput = teamPolicySchema.partial()

export const teamRequests = [
  request('team.list', z.strictObject({ includeArchived: z.boolean().default(false) })),
  request('team.inspect', byTeam),
  request(
    'team.create',
    z.strictObject({
      idempotencyKey: id,
      name: z.string().min(1).max(TEAM_NAME_MAX),
      objective: z.string().max(TEAM_OBJECTIVE_MAX).default(''),
      members: z.array(memberInput).min(2).max(TEAM_LIMITS.membersMax),
      policy: policyInput.optional(),
      /** The person saw what this team shares between its bots before it was created. */
      confirmSharing: z.literal(true),
    })
  ),
  request(
    'team.update',
    z.strictObject({
      teamId: id,
      expectedRevision: revision,
      name: z.string().min(1).max(TEAM_NAME_MAX).optional(),
      objective: z.string().max(TEAM_OBJECTIVE_MAX).optional(),
      coordinatorBotId: id.optional(),
      policy: policyInput.optional(),
      confirmFullVm: z.boolean().default(false),
    })
  ),
  request('team.archive', z.strictObject({ teamId: id, expectedRevision: revision, idempotencyKey: id })),
  request(
    'team.members.set',
    z.strictObject({
      teamId: id,
      expectedRevision: revision,
      idempotencyKey: id,
      members: z.array(memberInput).min(2).max(TEAM_LIMITS.membersMax),
      confirmSharing: z.literal(true),
      /** Required when the change would affect work that is already running. */
      confirmStopActiveWork: z.boolean().default(false),
    })
  ),
  request(
    'team.messages.list',
    z.strictObject({ teamId: id, before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).default(50) })
  ),
  request(
    'team.messages.send',
    z.strictObject({
      teamId: id,
      clientMessageId: id,
      content: z.string().min(1).max(TEAM_MESSAGE_CONTENT_MAX),
      artifactIds: z.array(id).max(16).default([]),
    })
  ),
  request('team.messages.lookup', z.strictObject({ teamId: id, clientMessageId: id })),
  request('team.run.get', z.strictObject({ runId: id })),
  request('team.run.cancel', z.strictObject({ runId: id, expectedRevision: revision, idempotencyKey: id })),
  request('team.tasks.list', z.strictObject({ runId: id })),
  request(
    'team.events.list',
    z.strictObject({ teamId: id, after: revision.default(0), limit: z.number().int().min(1).max(500).default(100) })
  ),
  request('team.memory.list', z.strictObject({ teamId: id, includeInactive: z.boolean().default(false) })),
  request(
    'team.memory.upsert',
    z.strictObject({
      teamId: id,
      memoryId: id.optional(),
      expectedRevision: revision.optional(),
      content: z.string().min(1).max(TEAM_MEMORY_CONTENT_MAX),
    })
  ),
  request('team.memory.remove', z.strictObject({ teamId: id, memoryId: id, expectedRevision: revision })),
  request('team.memory.proposals', byTeam),
  request(
    'team.memory.decide',
    z.strictObject({ teamId: id, memoryId: id, expectedRevision: revision, decision: z.enum(['approve', 'discard']) })
  ),
  request('team.artifacts.list', z.strictObject({ teamId: id, includeRevoked: z.boolean().default(false) })),
  request(
    'team.artifacts.share',
    z.strictObject({
      teamId: id,
      idempotencyKey: id,
      /** A file the person picked from one bot's workspace; copies are verified, never mounted. */
      botId: id,
      path: z.string().min(1).max(512),
      name: z.string().min(1).max(255).optional(),
    })
  ),
  request('team.artifacts.revoke', z.strictObject({ teamId: id, artifactId: id, idempotencyKey: id })),
  request(
    'team.artifacts.transferBegin',
    z.strictObject({
      teamId: id,
      direction: z.enum(['upload', 'download']),
      artifactId: id.optional(),
      name: z.string().min(1).max(255).optional(),
      size: z.number().int().nonnegative().optional(),
      digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })
  ),
  request(
    'team.artifacts.transferChunk',
    z.strictObject({ transferId: id, offset: z.number().int().nonnegative(), dataBase64: chunkBase64.optional() })
  ),
  request('team.artifacts.transferFinish', z.strictObject({ transferId: id })),
  request('team.artifacts.transferAbort', z.strictObject({ transferId: id })),
  request('team.operation.get', z.strictObject({ operationId: id })),
  request('team.operation.lookup', z.strictObject({ idempotencyKey: id })),
] as const
export const teamRequestSchema = z.discriminatedUnion('method', [...teamRequests])
export type TeamRequest = z.infer<typeof teamRequestSchema>
export type TeamMethod = TeamRequest['method']
export const teamMethods = teamRequests.map((schema) => schema.shape.method.value) as readonly TeamMethod[]

export const teamDetailsSchema = z.strictObject({
  team: teamSchema,
  members: z.array(teamMemberSchema).max(TEAM_LIMITS.membersMax),
  conversation: teamConversationSchema,
  activeRun: teamRunSchema.nullable(),
})
export const teamMessagesPageSchema = z.strictObject({
  conversation: teamConversationSchema,
  messages: z.array(teamMessageSchema),
  runs: z.array(teamRunSchema),
  hasMore: z.boolean(),
})
export const teamSendReceiptSchema = z.strictObject({ message: teamMessageSchema, run: teamRunSchema })
export const teamEventsPageSchema = z.strictObject({
  events: z.array(teamEventSchema),
  cursor: revision,
  hasMore: z.boolean(),
})
export const teamTasksPageSchema = z.strictObject({
  run: teamRunSchema,
  tasks: z.array(teamTaskSchema).max(TEAM_LIMITS.maxTasks * 2),
  turns: z.array(botTurnSchema).max(TEAM_LIMITS.maxTurns * 2),
})
export const teamTransferStateSchema = z.strictObject({
  transferId: id,
  teamId: id,
  direction: z.enum(['upload', 'download']),
  /** Identity of the copy being written or read; a name is never enough to resolve one. */
  artifactId: id,
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  chunkBytes: z.literal(TRANSFER_CHUNK_BYTES),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  dataBase64: chunkBase64.optional(),
  done: z.boolean(),
  artifact: teamArtifactSchema.optional(),
  expiresAt: z.string().min(20).max(40),
})
export type TeamTransferState = z.infer<typeof teamTransferStateSchema>

export const teamResultSchemas = {
  'team.list': z.array(teamSchema),
  'team.inspect': teamDetailsSchema,
  'team.create': teamDetailsSchema,
  'team.update': teamDetailsSchema,
  'team.archive': teamOperationSchema,
  'team.members.set': teamDetailsSchema,
  'team.messages.list': teamMessagesPageSchema,
  'team.messages.send': teamSendReceiptSchema,
  'team.messages.lookup': teamSendReceiptSchema.nullable(),
  'team.run.get': teamRunSchema,
  'team.run.cancel': teamRunSchema,
  'team.tasks.list': teamTasksPageSchema,
  'team.events.list': teamEventsPageSchema,
  'team.memory.list': z.array(teamMemorySchema),
  'team.memory.upsert': teamMemorySchema,
  'team.memory.remove': teamMemorySchema,
  'team.memory.proposals': z.array(teamMemorySchema),
  'team.memory.decide': teamMemorySchema,
  'team.artifacts.list': z.array(teamArtifactSchema),
  'team.artifacts.share': teamOperationSchema,
  'team.artifacts.revoke': teamArtifactSchema,
  'team.artifacts.transferBegin': teamTransferStateSchema,
  'team.artifacts.transferChunk': teamTransferStateSchema,
  'team.artifacts.transferFinish': teamTransferStateSchema,
  'team.artifacts.transferAbort': teamTransferStateSchema,
  'team.operation.get': teamOperationSchema,
  'team.operation.lookup': teamOperationSchema.nullable(),
} satisfies Record<TeamMethod, z.ZodType>
export type TeamResult<M extends TeamMethod> = z.infer<(typeof teamResultSchemas)[M]>

export const TEAM_MUTATIONS: readonly TeamMethod[] = [
  'team.create',
  'team.update',
  'team.archive',
  'team.members.set',
  'team.messages.send',
  'team.run.cancel',
  'team.memory.upsert',
  'team.memory.remove',
  'team.memory.decide',
  'team.artifacts.share',
  'team.artifacts.revoke',
  'team.artifacts.transferBegin',
  'team.artifacts.transferChunk',
  'team.artifacts.transferFinish',
  'team.artifacts.transferAbort',
]
/** Team results are never routed through the bot.operation lookups; the namespaces differ. */
export const TEAM_OPERATION_METHODS: readonly TeamMethod[] = ['team.operation.get', 'team.operation.lookup']
