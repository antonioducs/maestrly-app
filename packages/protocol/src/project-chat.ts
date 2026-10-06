import { z } from 'zod'
import { utcDateTimeSchema } from './identity.js'

export const CHAT_CAPABILITY = 'chat:interactive:v1' as const
const id = z.string().uuid()
const key = z.string().min(1).max(191)
const text = z.string().max(1_000_000)
export const projectChatModeSchema = z.enum(['agent', 'plan', 'design', 'ask', 'chat'])
export const projectChatPermissionModeSchema = z.enum(['ask', 'auto', 'full'])
export const projectChatSettingsSchema = z
  .object({
    model: key,
    mode: projectChatModeSchema,
    reasoning: key.nullable().default(null),
    fastMode: z.boolean().default(false),
    permMode: projectChatPermissionModeSchema.default('ask'),
  })
  .strict()
export const chatPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), id: key, text }).strict(),
  z.object({ type: z.literal('reasoning'), id: key, text }).strict(),
  z
    .object({
      type: z.literal('tool'),
      id: key,
      name: key,
      state: key,
      input: z.string().max(32768).optional(),
      output: z.string().max(65536).optional(),
    })
    .strict(),
])
export const projectChatMessageSchema = z
  .object({
    id,
    sessionId: id,
    turnId: id.nullable(),
    role: z.enum(['user', 'assistant']),
    parts: z.array(chatPartSchema).max(1000),
    createdAt: utcDateTimeSchema,
  })
  .strict()
export const chatTurnStateSchema = z.enum([
  'queued',
  'running',
  'waiting_input',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
])
export const CHAT_ACTIVE_STATES = ['queued', 'running', 'waiting_input', 'cancelling'] as const
export const projectChatTurnSchema = z
  .object({
    id,
    sessionId: id,
    messageId: id,
    state: chatTurnStateSchema,
    leaseId: id.nullable(),
    leaseExpiresAt: utcDateTimeSchema.nullable(),
    createdAt: utcDateTimeSchema,
    error: z.string().nullable(),
  })
  .strict()
export const chatQuestionSchema = z.object({
  header: z.string().optional(),
  question: z.string().min(1).max(8000),
  options: z
    .array(z.object({ label: z.string(), description: z.string().optional() }))
    .max(20)
    .default([]),
  multiple: z.boolean().optional(),
})
export const chatInteractionPayloadSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('permission'),
      requestId: key,
      title: z.string().max(8000),
      action: key,
      resources: z.array(z.string().max(8000)).max(100),
    })
    .strict(),
  z
    .object({ type: z.literal('question'), requestId: key, questions: z.array(chatQuestionSchema).min(1).max(10) })
    .strict(),
  z
    .object({ type: z.literal('plan'), requestId: key, title: z.string().max(500), plan: z.string().max(200000) })
    .strict(),
])
export const chatDecisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('permission'), reply: z.enum(['once', 'reject']) }).strict(),
  z.object({ type: z.literal('question'), answers: z.array(z.array(z.string().max(8000)).max(20)).max(10) }).strict(),
  z
    .object({
      type: z.literal('plan'),
      action: z.enum(['approve', 'revise', 'discard']),
      editedPlan: z.string().max(200000).optional(),
      feedback: z.string().max(32000).optional(),
    })
    .strict(),
])
export const projectChatInteractionSchema = z
  .object({
    id,
    sessionId: id,
    turnId: id,
    version: z.number().int().positive(),
    payload: chatInteractionPayloadSchema,
    state: z.enum(['pending', 'decided', 'expired']),
    decision: chatDecisionSchema.nullable(),
  })
  .strict()
export const projectChatSessionSchema = projectChatSettingsSchema
  .extend({
    id,
    organizationId: id,
    projectId: id,
    ownerUserId: key,
    runnerId: id,
    workspaceKey: key,
    title: z.string().min(1).max(160),
    baseBranch: z.string().min(1).max(240),
    boardId: id.nullable(),
    cardId: id.nullable(),
    version: z.number().int().positive(),
    archivedAt: utcDateTimeSchema.nullable(),
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
  })
  .strict()
export const projectChatModelSchema = z
  .object({
    id: key,
    label: z.string().min(1).max(200),
    providerLabel: z.string().min(1).max(200).optional(),
    efforts: z.array(key).max(20).default([]),
    fastMode: z.boolean().default(false),
  })
  .strict()
export const projectChatConversationSettingsCapabilitySchema = z
  .object({
    version: z.literal(1),
    modes: z
      .array(projectChatModeSchema.exclude(['chat']))
      .min(1)
      .max(4),
    permissionModes: z.array(projectChatPermissionModeSchema).min(1).max(3),
    operatorLimits: z
      .object({
        commands: z.boolean(),
        web: z.boolean(),
        appTools: z.boolean(),
        mcp: z.boolean(),
        push: z.boolean(),
      })
      .strict(),
  })
  .strict()
export const chatInventorySchema = z
  .object({
    capability: z.literal(CHAT_CAPABILITY),
    enabled: z.boolean(),
    workspaces: z
      .array(
        z
          .object({ projectId: id, key, label: z.string().max(160), branches: z.array(z.string().max(240)).max(500) })
          .strict()
      )
      .max(100),
    models: z.array(projectChatModelSchema).max(1000),
    conversationSettings: projectChatConversationSettingsCapabilitySchema.optional(),
    integrations: z.object({ skills: z.boolean(), mcp: z.boolean(), memory: z.boolean() }).strict(),
  })
  .strict()
export const projectChatDestinationSchema = z.object({
  runnerId: id,
  name: z.string(),
  online: z.boolean(),
  personal: z.boolean(),
  inventory: chatInventorySchema,
})
export const chatPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: projectChatMessageSchema }).strict(),
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
  z.object({ type: z.literal('interaction'), interaction: projectChatInteractionSchema }).strict(),
  z.object({ type: z.literal('turn'), turn: projectChatTurnSchema }).strict(),
])
export const projectChatEventSchema = z
  .object({
    version: z.literal(1),
    sessionId: id,
    sequence: z.number().int().positive(),
    eventId: key,
    payload: chatPayloadSchema,
  })
  .strict()
export const chatUploadSchema = z.object({ eventId: key, payload: chatPayloadSchema }).strict()
export const chatCreateSchema = projectChatSessionSchema
  .pick({
    runnerId: true,
    workspaceKey: true,
    model: true,
    baseBranch: true,
    mode: true,
    reasoning: true,
    fastMode: true,
    permMode: true,
  })
  .extend({
    title: z.string().trim().min(1).max(160).default('New conversation'),
    boardId: id.nullable().default(null),
    cardId: id.nullable().default(null),
  })
  .strict()
export const chatUpdateSchema = projectChatSettingsSchema
  .partial()
  .extend({
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(160).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
export type ChatCreate = z.infer<typeof chatCreateSchema>
export type ChatUpdate = z.infer<typeof chatUpdateSchema>
export type ProjectChatSettings = z.infer<typeof projectChatSettingsSchema>
export type ProjectChatMode = z.infer<typeof projectChatModeSchema>
export type ProjectChatPermissionMode = z.infer<typeof projectChatPermissionModeSchema>
export type ProjectChatModel = z.infer<typeof projectChatModelSchema>
export type ChatInventory = z.infer<typeof chatInventorySchema>
export type ChatPart = z.infer<typeof chatPartSchema>
export type ChatPayload = z.infer<typeof chatPayloadSchema>
export type ChatUpload = z.infer<typeof chatUploadSchema>
export type ChatDecision = z.infer<typeof chatDecisionSchema>
export type ProjectChatSession = z.infer<typeof projectChatSessionSchema>
export type ProjectChatTurn = z.infer<typeof projectChatTurnSchema>
export type ProjectChatMessage = z.infer<typeof projectChatMessageSchema>
export type ProjectChatEvent = z.infer<typeof projectChatEventSchema>
export type ProjectChatInteraction = z.infer<typeof projectChatInteractionSchema>
export type ProjectChatDestination = z.infer<typeof projectChatDestinationSchema>
export interface ProjectChatSnapshot {
  session: ProjectChatSession
  messages: ProjectChatMessage[]
  turn: ProjectChatTurn | null
  interactions: ProjectChatInteraction[]
  cursor: number
  more: boolean
}
export interface ProjectChatClaim {
  session: ProjectChatSession
  turn: ProjectChatTurn
  message: ProjectChatMessage
  token: string
  decision?: { interaction: ProjectChatInteraction; decision: ChatDecision }
}
