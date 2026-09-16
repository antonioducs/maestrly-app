import { z } from 'zod'

// Public wire API: every method requires params (including empty params).
// Mutations return Operation; retry with the same idempotencyKey and parameters.
// expectedRevision is mandatory except on create. Events use an exclusive cursor.
import { id, revision, errorSchema } from './common.js'
import { botRequests } from './bot-rpc.js'
import { teamRequests } from './team-rpc.js'
const empty = z.strictObject({})
const mutation = { vmId: id, expectedRevision: revision, idempotencyKey: id }
const envelope = { version: z.literal(1), id }
const request = <M extends string, S extends z.ZodType>(method: M, params: S) =>
  z.strictObject({ ...envelope, method: z.literal(method), params })
export const requestSchema = z.discriminatedUnion('method', [
  request('host.inspect', empty),
  request('vm.list', z.strictObject({ includeRetained: z.boolean().default(false) })),
  request('image.list', empty),
  request(
    'vm.create',
    z.strictObject({
      name: z.string().min(1).max(80),
      imageId: id,
      runtimeId: id,
      cpus: z.number().int().min(1).max(128),
      memoryMiB: z.number().int().min(256).max(1048576),
      diskGiB: z.number().int().min(1).max(16384),
      idempotencyKey: id,
      startupPolicy: z.enum(['manual', 'always']).default('manual'),
    })
  ),
  request('vm.inspect', z.strictObject({ vmId: id })),
  request('vm.logs', z.strictObject({ vmId: id })),
  request('vm.start', z.strictObject(mutation)),
  request('vm.shutdown', z.strictObject(mutation)),
  request('vm.restart', z.strictObject(mutation)),
  request('vm.remove', z.strictObject({ ...mutation, deleteData: z.boolean().default(false) })),
  request('vm.verify', z.strictObject({ vmId: id, mode: z.enum(['write-marker', 'read-marker']) })),
  request('operation.lookup', z.strictObject({ idempotencyKey: id })),
  request('operation.get', z.strictObject({ operationId: id })),
  request('operation.cancel', z.strictObject({ operationId: id })),
  request(
    'events.list',
    z.strictObject({
      after: revision.default(0),
      limit: z.number().int().min(1).max(500).default(100),
    })
  ),
  ...botRequests,
  ...teamRequests,
])
export const responseSchema = z
  .strictObject({
    ...envelope,
    result: z.unknown().optional(),
    error: errorSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if ((Object.hasOwn(value, 'result') ? 1 : 0) + (value.error === undefined ? 0 : 1) !== 1)
      ctx.addIssue({
        code: 'custom',
        message: 'Exactly one result or error is required',
      })
  })
export type Request = z.infer<typeof requestSchema>
export type Response = z.infer<typeof responseSchema>
