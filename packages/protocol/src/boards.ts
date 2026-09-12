import { personalExecutionRequestSchema } from './personal-devices.js'
import { z } from 'zod'
import { columnRoleSchema,automationLimitsSchema } from './automation.js'
import { opaqueIdSchema, utcDateTimeSchema } from './identity.js'

export const prioritySchema = z.enum(['none', 'low', 'medium', 'high', 'urgent'])

export const boardSchema = z.object({
  rolesConfigured: z.boolean().optional(),
  automationLimits: automationLimitsSchema.optional(),
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  name: z.string().min(1).max(160),
  archivedAt: utcDateTimeSchema.nullable(),
  version: z.number().int().positive().optional(),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
})

export const columnSchema = z.object({
  role: columnRoleSchema.optional(),
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  boardId: opaqueIdSchema,
  name: z.string().min(1).max(120),
  position: z.number().int().nonnegative(),
  executionPolicyId: opaqueIdSchema.nullable(),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
})

export const cardSchema = z.object({
  automationBlocked:z.boolean().optional(),
  automationDispatchCount:z.number().int().nonnegative().optional(),
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  boardId: opaqueIdSchema,
  columnId: opaqueIdSchema,
  parentCardId: opaqueIdSchema.nullable(),
  deletedAt: utcDateTimeSchema.nullable().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(100_000).default(''),
  acceptanceCriteria: z.array(z.string().min(1).max(4_000)).max(100).default([]),
  priority: prioritySchema,
  labels: z.array(z.string().min(1).max(80)).max(100).default([]),
  assigneeUserIds: z.array(opaqueIdSchema).max(100).default([]),
  position: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  archivedAt: utcDateTimeSchema.nullable(),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
})

export const cardPatchSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(100_000).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(4_000)).max(100).optional(),
    priority: prioritySchema.optional(),
    labels: z.array(z.string().min(1).max(80)).max(100).optional(),
    assigneeUserIds: z.array(opaqueIdSchema).max(100).optional(),
    archived: z.boolean().optional(),
  })
  .strict()

export const moveCardRequestSchema = z.object({
  personalExecution:personalExecutionRequestSchema.optional(),
  expectedVersion: z.number().int().positive(),
  targetColumnId: opaqueIdSchema,
  targetPosition: z.number().int().nonnegative(),
  source: z.enum(['human', 'agent', 'system']).default('human'),
  allowAutomationChain: z.boolean().default(false),
  chainDepth: z.number().int().nonnegative().max(5).default(0),
})

export const commentSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  boardId: opaqueIdSchema,
  cardId: opaqueIdSchema,
  body: z.string().min(1).max(100_000),
  author: z.object({ type: z.enum(['human', 'agent']), id: opaqueIdSchema }),
  createdAt: utcDateTimeSchema,
})

export const attachmentSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  cardId: opaqueIdSchema,
  filename: z.string().min(1).max(500),
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: utcDateTimeSchema,
})

export type Board = z.infer<typeof boardSchema>
export type BoardColumn = z.infer<typeof columnSchema>
export type Card = z.infer<typeof cardSchema>
export type CardPatch = z.infer<typeof cardPatchSchema>
export type MoveCardRequest = z.infer<typeof moveCardRequestSchema>
export type Comment = z.infer<typeof commentSchema>
export type Attachment = z.infer<typeof attachmentSchema>
