import { z } from 'zod'
import { id, errorSchema } from './common.js'
import { vmSchema } from './vm.js'
import { isoDate } from './bots.js'
import { sessionsInventorySchema } from './bot-sessions.js'
export const environmentSchema = z.strictObject({
  vm: vmSchema,
  status: z.enum(['ready', 'stopped', 'full', 'needs-preparation', 'needs-update', 'needs-migration', 'preparing', 'unavailable']),
  inventory: sessionsInventorySchema,
  reason: z.string().max(500).optional(),
  operationId: id.optional(),
  /** Optional update: the environment works, but the Host has a runtime with the live screen. */
  updateAvailable: z.enum(['desktop']).optional(),
})
export type BotEnvironment = z.infer<typeof environmentSchema>
export const environmentOperationSchema = z.strictObject({
  id, kind: z.enum(['create', 'prepare']), vmId: id.optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  steps: z.array(z.strictObject({ id, label: z.string().max(120), status: z.enum(['pending', 'running', 'succeeded', 'failed']) })).max(8),
  error: errorSchema.optional(), createdAt: isoDate, updatedAt: isoDate,
})
export type EnvironmentOperation = z.infer<typeof environmentOperationSchema>
const request = <M extends string, S extends z.ZodType>(method: M, params: S) => z.strictObject({ version: z.literal(1), id, method: z.literal(method), params })
export const environmentRequests = [
  request('environment.list', z.strictObject({})),
  request('environment.operations', z.strictObject({})),
  request('environment.create', z.strictObject({ idempotencyKey: id, name: z.string().min(1).max(80) })),
  request('environment.prepare', z.strictObject({ vmId: id, idempotencyKey: id, confirmBackup: z.literal(true), confirmRestart: z.literal(true) })),
  request('environment.operation', z.strictObject({ operationId: id })),
  request('environment.lookup', z.strictObject({ idempotencyKey: id })),
] as const
export const environmentResultSchemas = { 'environment.operations': z.array(environmentOperationSchema).max(100), 'environment.list': z.array(environmentSchema), 'environment.create': environmentOperationSchema,
  'environment.prepare': environmentOperationSchema, 'environment.operation': environmentOperationSchema, 'environment.lookup': environmentOperationSchema.nullable() }
