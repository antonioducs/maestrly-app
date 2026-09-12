import { z } from 'zod'
import { actorSchema, opaqueIdSchema, utcDateTimeSchema } from './identity.js'

export const domainEventSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequence: z.number().int().positive(),
  type: z.string().min(1).max(160),
  aggregateType: z.string().min(1).max(80),
  aggregateId: opaqueIdSchema,
  actor: actorSchema,
  reason: z.string().max(1_000).optional(),
  data: z.record(z.string(), z.unknown()),
  createdAt: utcDateTimeSchema,
})

export const eventPageSchema = z.object({
  events: z.array(domainEventSchema),
  nextCursor: z.number().int().nonnegative(),
})

export type DomainEvent = z.infer<typeof domainEventSchema>
export type EventPage = z.infer<typeof eventPageSchema>
