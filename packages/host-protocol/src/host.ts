import { z } from 'zod'
import { id } from './common.js'
export const hostSchema = z.strictObject({
  id: z.string().uuid(),
  serviceVersion: z.string().min(1),
  protocolVersion: z.literal(1),
  capabilities: z.array(z.string().min(1)),
  health: z.enum(['ready', 'degraded', 'unavailable']),
  observedMemoryMiB: z.number().nonnegative(),
  platform: z.string(),
  arch: z.string(),
  supported: z.boolean(),
  capacity: z.strictObject({
    cpus: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
    diskGiB: z.number().int().positive(),
  }),
  allocated: z.strictObject({
    cpus: z.number().int().nonnegative(),
    memoryMiB: z.number().int().nonnegative(),
    diskGiB: z.number().int().nonnegative(),
  }),
  runtimes: z.array(
    z.strictObject({
      id,
      available: z.boolean(),
      reason: z.string().optional(),
    })
  ),
})
export type Host = z.infer<typeof hostSchema>
