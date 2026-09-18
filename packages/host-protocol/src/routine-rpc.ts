import { z } from 'zod'
import { id, revision } from './common.js'
import {
  ROUTINE_LIMITS,
  routineEventSchema,
  routineOccurrenceSchema,
  routineOperationSchema,
  routinePreviewSchema,
  routineProposalSchema,
  routineSchema,
  routineSpecSchema,
  targetRefSchema,
} from './routines.js'

/**
 * Public routine methods on the shared v1 envelope. There is deliberately no endpoint that
 * activates without a preview: every path that makes a routine executable goes through
 * `routine.preview` and then `routine.activate` with the exact fingerprint that was shown.
 */
const envelope = { version: z.literal(1), id }
const request = <M extends string, S extends z.ZodType>(method: M, params: S) =>
  z.strictObject({ ...envelope, method: z.literal(method), params })
const byRoutine = z.strictObject({ routineId: id })

export const routineRequests = [
  request(
    'routine.list',
    z.strictObject({ target: targetRefSchema.optional(), includeArchived: z.boolean().default(false) })
  ),
  request('routine.inspect', byRoutine),
  request(
    'routine.preview',
    z.strictObject({
      spec: routineSpecSchema,
      /** Present when editing: the revision the person believes they are changing. */
      routineId: id.optional(),
      expectedRevision: revision.optional(),
      /** Resolves an ambiguous single instant instead of the Host guessing one. */
      disambiguation: z.enum(['earlier', 'later']).optional(),
      /** Consumes a bot proposal so the card can be closed with the routine it became. */
      proposalId: id.optional(),
    })
  ),
  request(
    'routine.activate',
    z.strictObject({
      previewId: id,
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      idempotencyKey: id,
      /** The person saw the ceiling and the calendar of this exact preview. */
      confirmSchedule: z.literal(true),
    })
  ),
  request(
    'routine.pause',
    z.strictObject({ routineId: id, expectedRevision: revision, idempotencyKey: id, resume: z.boolean().default(false) })
  ),
  request('routine.archive', z.strictObject({ routineId: id, expectedRevision: revision, idempotencyKey: id })),
  request('routine.runNow', z.strictObject({ routineId: id, expectedRevision: revision, idempotencyKey: id })),
  request('routine.proposals.list', z.strictObject({ target: targetRefSchema.optional() })),
  request('routine.proposals.dismiss', z.strictObject({ proposalId: id, expectedRevision: revision })),
  request(
    'routine.occurrences.list',
    z.strictObject({ routineId: id, before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).default(50) })
  ),
  request('routine.occurrence.inspect', z.strictObject({ occurrenceId: id })),
  request('routine.occurrence.cancel', z.strictObject({ occurrenceId: id, expectedRevision: revision, idempotencyKey: id })),
  request(
    'routine.events.list',
    z.strictObject({ after: revision.default(0), limit: z.number().int().min(1).max(500).default(100), routineId: id.optional() })
  ),
  request('routine.operation.lookup', z.strictObject({ idempotencyKey: id })),
] as const
export const routineRequestSchema = z.discriminatedUnion('method', [...routineRequests])
export type RoutineRequest = z.infer<typeof routineRequestSchema>
export type RoutineMethod = RoutineRequest['method']
export const routineMethods = routineRequests.map((schema) => schema.shape.method.value) as readonly RoutineMethod[]

export const routineDetailsSchema = z.strictObject({
  routine: routineSchema,
  /** Occurrence that still holds the routine's slot, if any. */
  active: routineOccurrenceSchema.nullable(),
  recent: z.array(routineOccurrenceSchema).max(10),
})
export type RoutineDetails = z.infer<typeof routineDetailsSchema>

export const routineOccurrencesPageSchema = z.strictObject({
  routine: routineSchema,
  occurrences: z.array(routineOccurrenceSchema).max(200),
  hasMore: z.boolean(),
})
export const routineEventsPageSchema = z.strictObject({
  events: z.array(routineEventSchema),
  cursor: revision,
  hasMore: z.boolean(),
})

export const routineResultSchemas = {
  'routine.list': z.array(routineSchema).max(ROUTINE_LIMITS.routinesPerHostMax),
  'routine.inspect': routineDetailsSchema,
  'routine.preview': routinePreviewSchema,
  'routine.activate': routineDetailsSchema,
  'routine.pause': routineDetailsSchema,
  'routine.archive': routineDetailsSchema,
  'routine.runNow': routineOccurrenceSchema,
  'routine.proposals.list': z.array(routineProposalSchema).max(ROUTINE_LIMITS.pendingProposalsPerTargetMax * 4),
  'routine.proposals.dismiss': routineProposalSchema,
  'routine.occurrences.list': routineOccurrencesPageSchema,
  'routine.occurrence.inspect': routineOccurrenceSchema,
  'routine.occurrence.cancel': routineOccurrenceSchema,
  'routine.events.list': routineEventsPageSchema,
  'routine.operation.lookup': routineOperationSchema.nullable(),
} satisfies Record<RoutineMethod, z.ZodType>
export type RoutineResult<M extends RoutineMethod> = z.infer<(typeof routineResultSchemas)[M]>

export const ROUTINE_MUTATIONS: readonly RoutineMethod[] = [
  'routine.activate',
  'routine.pause',
  'routine.archive',
  'routine.runNow',
  'routine.occurrence.cancel',
  'routine.proposals.dismiss',
]
