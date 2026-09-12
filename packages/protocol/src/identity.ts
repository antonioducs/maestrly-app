import { z } from 'zod'

export const opaqueIdSchema = z.string().min(1).max(191)
export const utcDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith('Z'), 'date-time must be normalized to UTC')

export const actorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('human'), userId: opaqueIdSchema }),
  z.object({ type: z.literal('runner'), runnerId: opaqueIdSchema }),
  z.object({
    type: z.literal('execution_agent'),
    runId: opaqueIdSchema,
    runnerId: opaqueIdSchema,
    requestedByUserId: opaqueIdSchema,
  }),
  z.object({
    type: z.literal('desktop_agent'),
    userId: opaqueIdSchema,
    conversationId: opaqueIdSchema,
  }),
  z.object({ type: z.literal('system'), service: z.string().min(1).max(100) }),
])

export const organizationRoleSchema = z.enum(['owner', 'admin', 'member'])
export const projectRoleSchema = z.enum(['maintainer', 'contributor', 'viewer'])

export const organizationSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1).max(160),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
})

export const memberSchema = z.object({
  organizationId: opaqueIdSchema,
  userId: opaqueIdSchema,
  role: organizationRoleSchema,
  createdAt: utcDateTimeSchema,
})

export const invitationSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  email: z.string().email(),
  role: organizationRoleSchema,
  expiresAt: utcDateTimeSchema,
  usedAt: utcDateTimeSchema.nullable(),
  createdAt: utcDateTimeSchema,
})

export type Actor = z.infer<typeof actorSchema>
export type OrganizationRole = z.infer<typeof organizationRoleSchema>
export type ProjectRole = z.infer<typeof projectRoleSchema>
export type Organization = z.infer<typeof organizationSchema>
export type Member = z.infer<typeof memberSchema>
export type Invitation = z.infer<typeof invitationSchema>
