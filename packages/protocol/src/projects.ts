import { z } from 'zod'
import { opaqueIdSchema, projectRoleSchema, utcDateTimeSchema } from './identity.js'

export const projectSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  name: z.string().min(1).max(160),
  description: z.string().max(20_000).default(''),
  archivedAt: utcDateTimeSchema.nullable(),
  defaultRepositoryBindingId: opaqueIdSchema.nullable().optional(),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
})

export const projectMemberSchema = z.object({
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  userId: opaqueIdSchema,
  role: projectRoleSchema,
  createdAt: utcDateTimeSchema,
})

export const repositoryBindingSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  name: z.string().min(1).max(160),
  cloneUrl: z.string().optional(),
  baseBranch: z.string().min(1).max(250).optional(),
  disabledAt: utcDateTimeSchema.nullable().optional(),
  version: z.number().int().positive().optional(),
  deliveryMode: z.enum(['patch', 'commit', 'push']).default('patch'),
  createdAt: utcDateTimeSchema,
})

export type Project = z.infer<typeof projectSchema>
export type ProjectMember = z.infer<typeof projectMemberSchema>
export type RepositoryBinding = z.infer<typeof repositoryBindingSchema>
