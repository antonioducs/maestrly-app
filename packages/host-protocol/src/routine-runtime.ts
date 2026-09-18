import { z } from 'zod'
import { id } from './common.js'
import { isoDate } from './bots.js'
import { ROUTINE_LIMITS, ROUTINE_NAME_MAX, ROUTINE_REQUEST_MAX, routineProposalStatusSchema, scheduleSpecSchema, timeZoneSchema } from './routines.js'

/**
 * Private routine lane between a working guest and the Host. It rides the same control
 * channel as turns and collaboration but is discriminated apart from them, so a proposal
 * can never be mistaken for a delegation or an account frame.
 *
 * The lane can only create inert proposals. There is no method here that activates,
 * approves, edits or runs anything, and no field that lets a model pick a different bot,
 * team, Host or author: the Host derives all of that from the authenticated session and the
 * turn it registered.
 */
export const ROUTINE_METHODS = ['routine_propose', 'routine_proposal_status'] as const
export type RoutineMethodName = (typeof ROUTINE_METHODS)[number]

export const routineParamSchemas = {
  routine_propose: z.strictObject({
    name: z.string().min(1).max(ROUTINE_NAME_MAX),
    request: z.string().min(1).max(ROUTINE_REQUEST_MAX),
    /** Omitted when the phrasing was ambiguous: the person then chooses the calendar. */
    schedule: scheduleSpecSchema.optional(),
    /** What is still unclear; shown to the person instead of being guessed. */
    clarification: z.string().max(400).optional(),
  }),
  routine_proposal_status: z.strictObject({ proposalId: id }),
} satisfies Record<RoutineMethodName, z.ZodType>

export const routineRuntimeRequestSchema = z.strictObject({
  type: z.literal('routine.request'),
  id,
  turnId: id,
  generation: z.number().int().positive(),
  method: z.enum(ROUTINE_METHODS),
  params: z.record(z.string(), z.unknown()).default({}),
})
export type RoutineRuntimeRequest = z.infer<typeof routineRuntimeRequestSchema>

export const routineResultSchemasRuntime = {
  routine_propose: z.strictObject({
    proposalId: id,
    status: routineProposalStatusSchema,
    /** Always true: the card is inert until the person confirms a preview. */
    requiresHumanConfirmation: z.literal(true),
    guidance: z.string().max(400),
  }),
  routine_proposal_status: z.strictObject({
    proposalId: id,
    status: routineProposalStatusSchema,
    routineId: id.optional(),
    guidance: z.string().max(400),
  }),
} satisfies Record<RoutineMethodName, z.ZodType>
export type RoutineRuntimeResult<M extends RoutineMethodName> = z.infer<(typeof routineResultSchemasRuntime)[M]>

export const routineRuntimeResponseSchema = z.strictObject({
  type: z.literal('routine.response'),
  id,
  result: z.unknown().optional(),
  error: z.strictObject({ code: z.string().min(1).max(64), message: z.string().max(400) }).optional(),
})
export type RoutineRuntimeResponse = z.infer<typeof routineRuntimeResponseSchema>

/**
 * Routine context added to a turn snapshot when the runtime announced the capability and
 * the person is talking to the bot directly. It gives the model the reference time and the
 * person's zone so "tomorrow at nine" can become a real instant instead of a guess — and it
 * says plainly that a scheduled execution may not propose anything at all.
 */
export const routineTurnContextSchema = z.strictObject({
  /** The moment this message was received, so relative phrasing has an anchor. */
  nowUtc: isoDate,
  /**
   * The person's own zone, present only when the Host actually knows it — from a routine they
   * already created. It is never inferred from an IP address or taken from the machine the
   * Host happens to run on: with no zone, the model must ask instead of assuming one.
   */
  nowLocal: z.string().min(1).max(40).optional(),
  timeZone: timeZoneSchema.optional(),
  /** false inside a scheduled occurrence, a delegated worker turn or a continuation. */
  canPropose: z.boolean(),
  proposalsRemaining: z.number().int().nonnegative().max(ROUTINE_LIMITS.proposalsPerTurnMax),
  tools: z.array(z.enum(ROUTINE_METHODS)).max(ROUTINE_METHODS.length),
  /** Routines already active for this target, by name and human reading of the calendar. */
  existing: z
    .array(z.strictObject({ routineId: id, name: z.string().min(1).max(ROUTINE_NAME_MAX), schedule: z.string().max(120) }))
    .max(20)
    .default([]),
})
export type RoutineTurnContext = z.infer<typeof routineTurnContextSchema>
