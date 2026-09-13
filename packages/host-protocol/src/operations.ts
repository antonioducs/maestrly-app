import { z } from 'zod'
import { id, errorSchema } from './common.js'
export const operationSchema = z.strictObject({
  id,
  vmId: id,
  method: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: errorSchema.optional(),
})
export type Operation = z.infer<typeof operationSchema>
