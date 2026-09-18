import { z } from 'zod'
import { id, revision, errorSchema } from './common.js'
import { isoDate, permissionModeSchema } from './bots.js'

/**
 * Routine domain: a durable, inspectable calendar entry that admits work into the engines
 * that already exist (one turn per bot, one run per team). Nothing here carries Host paths,
 * credentials, cron expressions, shell commands or provider payloads: a routine is a request
 * in plain words plus a calendar, and it never grants a permission the target did not have.
 */
export const ROUTINE_NAME_MAX = 80
export const ROUTINE_REQUEST_MAX = 16_000
export const ROUTINE_SUMMARY_MAX = 16 * 1024
export const ROUTINE_EVENTS_PAGE_BUDGET = 512 * 1024
/** Host capability advertised by host.inspect once the routines domain is available. */
export const ROUTINE_HOST_CAPABILITY = 'routines.v1'
/** Runtime capability required before a guest is offered the routine proposal tools. */
export const ROUTINE_CAPABILITY = 'bot.routines.v1'

/**
 * Operational safety defaults for this version, enforced in the Host and shown under
 * Advanced. They are product decisions, not measurements of what the machine can take.
 */
export const ROUTINE_LIMITS = {
  /** How often the Host looks for due occurrences. Not a real-time guarantee. */
  tickMs: 5_000,
  /** A firing later than this is treated as missed instead of "on time". */
  misfireToleranceMs: 60_000,
  /** How long one occurrence may wait for a busy or paused target before it is skipped. */
  queueDeadlineMs: 60 * 60_000,
  /** With the `latest` policy, only a missed firing inside this window is recovered. */
  latestWindowMs: 24 * 60 * 60_000,
  routinesPerHostMax: 100,
  /** Admissions per routine in a moving 24 h window, "Run now" included. */
  admissionsPer24h: 24,
  activeMsPer24h: 120 * 60_000,
  actionsPer24h: 600,
  previewTtlMs: 15 * 60_000,
  proposalTtlMs: 15 * 60_000,
  minIntervalMinutes: 15,
  maxIntervalMinutes: 60 * 24 * 30,
  historyDays: 90,
  proposalsPerTurnMax: 5,
  pendingProposalsPerTargetMax: 30,
  resourcesMax: 8,
  /** Background work slots shared by scheduled team runs and routine occurrences. */
  backgroundConcurrency: 2,
} as const

/** A known IANA zone, checked against the platform database instead of a loose regex. */
export function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_.-]+)*$/.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}
export const timeZoneSchema = z.string().min(1).max(64).refine(isTimeZone, { message: 'Fuso horário desconhecido' })

/** What a routine drives. The Host comes from the authenticated connection, never from a payload. */
export const targetRefSchema = z.strictObject({ kind: z.enum(['bot', 'team']), id })
export type TargetRef = z.infer<typeof targetRefSchema>

const hour = z.number().int().min(0).max(23)
const minute = z.number().int().min(0).max(59)
/**
 * Closed union of calendars. No cron, no RRULE, no free expression: every shape here can be
 * previewed as real instants and explained to a person before anything is activated.
 */
export const scheduleSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), atUtc: isoDate, timeZone: timeZoneSchema }),
  z.strictObject({ kind: z.literal('daily'), hour, minute, timeZone: timeZoneSchema }),
  z.strictObject({
    kind: z.literal('weekly'),
    /** ISO weekdays, Monday = 1. */
    daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    hour,
    minute,
    timeZone: timeZoneSchema,
  }),
  z.strictObject({ kind: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(31), hour, minute, timeZone: timeZoneSchema }),
  z.strictObject({
    kind: z.literal('interval'),
    anchorUtc: isoDate,
    everyMinutes: z.number().int().min(ROUTINE_LIMITS.minIntervalMinutes).max(ROUTINE_LIMITS.maxIntervalMinutes),
    timeZone: timeZoneSchema,
  }),
])
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>

/** What the Host does with a firing whose moment already passed while it was off. */
export const misfirePolicySchema = z.enum(['skip', 'latest'])
export type MisfirePolicy = z.infer<typeof misfirePolicySchema>

/** Ceiling for one occurrence. It is intersected with the target's own limits, never added to them. */
export const routineCeilingSchema = z.strictObject({
  activeMs: z.number().int().min(60_000).max(4 * 60 * 60_000).default(30 * 60_000),
  maxTools: z.number().int().min(1).max(600).default(80),
  permissionMode: permissionModeSchema.default('ask'),
})
export type RoutineCeiling = z.infer<typeof routineCeilingSchema>

export const routineSpecSchema = z.strictObject({
  name: z.string().min(1).max(ROUTINE_NAME_MAX),
  /** The recurring request, in the person's own words. Attachments are never implied. */
  request: z.string().min(1).max(ROUTINE_REQUEST_MAX),
  target: targetRefSchema,
  schedule: scheduleSpecSchema,
  misfirePolicy: misfirePolicySchema.default('skip'),
  queueDeadlineMs: z.number().int().min(60_000).max(ROUTINE_LIMITS.queueDeadlineMs).default(ROUTINE_LIMITS.queueDeadlineMs),
  ceiling: routineCeilingSchema.default(routineCeilingSchema.parse({})),
  /** Shared team files chosen explicitly by identity; a revoked one blocks the next firing. */
  resourceIds: z.array(id).max(ROUTINE_LIMITS.resourcesMax).default([]),
})
export type RoutineSpec = z.infer<typeof routineSpecSchema>

export const routineStatusSchema = z.enum(['active', 'paused', 'archived'])
export type RoutineStatus = z.infer<typeof routineStatusSchema>

export const routineSchema = z.strictObject({
  id,
  hostId: z.string().uuid(),
  spec: routineSpecSchema,
  status: routineStatusSchema,
  /** Digest of exactly what the person approved; activation re-checks it. */
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  /** Identity of the target as approved: account, model, permissions, roster. */
  targetVersion: z.string().regex(/^[a-f0-9]{64}$/),
  targetName: z.string().min(1).max(ROUTINE_NAME_MAX),
  nextDueUtc: isoDate.optional(),
  /** Everything before this instant has already been materialised or deliberately skipped. */
  watermarkUtc: isoDate,
  lastOccurrenceId: id.optional(),
  lastOutcome: z.string().max(40).optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  revision,
})
export type Routine = z.infer<typeof routineSchema>

export const routineOccurrenceStatusSchema = z.enum([
  'pending',
  'waiting_resource',
  'running',
  'waiting_user',
  'needs_attention',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'skipped',
])
export type RoutineOccurrenceStatus = z.infer<typeof routineOccurrenceStatusSchema>
export const ROUTINE_OCCURRENCE_TERMINAL: ReadonlySet<RoutineOccurrenceStatus> = new Set<RoutineOccurrenceStatus>([
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'skipped',
])
/** States in which the occurrence still holds the routine's single slot. */
export const ROUTINE_OCCURRENCE_ACTIVE: ReadonlySet<RoutineOccurrenceStatus> = new Set<RoutineOccurrenceStatus>([
  'pending',
  'waiting_resource',
  'running',
  'waiting_user',
  'needs_attention',
])

/**
 * Stable machine-readable reason. It travels in its own typed field so the public error
 * sanitiser cannot strip the only thing that tells a person what to do next.
 */
export const routineCauseCodeSchema = z.enum([
  'ON_TIME',
  'MISSED_WINDOW',
  'OVERLAP',
  'ROUTINE_PAUSED',
  'ROUTINE_EDITED',
  'TARGET_BUSY',
  'TARGET_PAUSED_BY_USER',
  'COMPUTER_OFF',
  'ACCOUNT_REQUIRED',
  'ACCESS_REVOKED',
  'TARGET_CHANGED',
  'BUDGET_EXHAUSTED',
  'QUEUE_DEADLINE',
  'HUMAN_TAKEOVER',
  'UNCERTAIN_RESULT',
  'STOPPED_BY_USER',
])
export type RoutineCauseCode = z.infer<typeof routineCauseCodeSchema>

/** Where the work of one occurrence actually lives; exactly one shape per execution. */
export const routineExecutionRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bot'), turnId: id, conversationId: id, continuationOfTurnId: id.optional() }),
  z.strictObject({ kind: z.literal('team'), runId: id, conversationId: id }),
])
export type RoutineExecutionRef = z.infer<typeof routineExecutionRefSchema>

export const routineOccurrenceSchema = z.strictObject({
  id,
  routineId: id,
  target: targetRefSchema,
  origin: z.enum(['schedule', 'manual']),
  /** Nominal moment, in UTC, plus the local reading the person was shown. */
  scheduledForUtc: isoDate,
  scheduledForLocal: z.string().min(1).max(40),
  timeZone: timeZoneSchema,
  /** Queue deadline: waiting for a busy target never grows the work allowance. */
  deadlineAt: isoDate,
  status: routineOccurrenceStatusSchema,
  causeCode: routineCauseCodeSchema.optional(),
  attention: z.string().max(400).optional(),
  execution: routineExecutionRefSchema.optional(),
  summary: z.string().max(ROUTINE_SUMMARY_MAX).optional(),
  error: errorSchema.optional(),
  usedActiveMs: z.number().int().nonnegative().default(0),
  usedActions: z.number().int().nonnegative().default(0),
  startedAt: isoDate.optional(),
  finishedAt: isoDate.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  revision,
})
export type RoutineOccurrence = z.infer<typeof routineOccurrenceSchema>

export const routinePreviewOccurrenceSchema = z.strictObject({
  scheduledForUtc: isoDate,
  scheduledForLocal: z.string().min(1).max(40),
})
export const routineWarningSchema = z.strictObject({
  code: z.enum([
    'DST_GAP_SKIPPED',
    'DST_OVERLAP_FIRST',
    'MONTH_WITHOUT_DAY',
    'AMBIGUOUS_INSTANT',
    'NONEXISTENT_INSTANT',
    'TARGET_OFFLINE',
    'ACCOUNT_DISCONNECTED',
    'RESOURCE_REVOKED',
    'PERMISSION_NARROWED',
    'PAST_INSTANT',
  ]),
  message: z.string().min(1).max(400),
})
export type RoutineWarning = z.infer<typeof routineWarningSchema>

/**
 * What a person reviews before anything becomes executable. Activation replays the exact
 * fingerprint shown here; a preview that expired can only be reviewed again, never reused.
 */
export const routinePreviewSchema = z.strictObject({
  previewId: id,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  hostId: z.string().uuid(),
  spec: routineSpecSchema,
  targetName: z.string().min(1).max(ROUTINE_NAME_MAX),
  targetVersion: z.string().regex(/^[a-f0-9]{64}$/),
  /** Editing an existing routine: the revision this preview was computed against. */
  routineId: id.optional(),
  expectedRevision: revision.optional(),
  occurrences: z.array(routinePreviewOccurrenceSchema).max(3),
  /** Effective ceiling after intersecting with what the target may already do. */
  effectiveCeiling: routineCeilingSchema,
  permissionSummary: z.array(z.string().min(1).max(200)).max(8).default([]),
  warnings: z.array(routineWarningSchema).max(8).default([]),
  feasible: z.boolean(),
  expiresAt: isoDate,
})
export type RoutinePreview = z.infer<typeof routinePreviewSchema>

export const routineProposalStatusSchema = z.enum(['pending', 'activated', 'dismissed', 'expired'])
/**
 * A model's suggestion. It is inert data: it holds no schedule slot, consumes no budget and
 * cannot become a routine without a person confirming a preview built from it.
 */
export const routineProposalSchema = z.strictObject({
  id,
  target: targetRefSchema,
  proposedByBotId: id,
  turnId: id,
  name: z.string().min(1).max(ROUTINE_NAME_MAX),
  request: z.string().min(1).max(ROUTINE_REQUEST_MAX),
  schedule: scheduleSpecSchema.optional(),
  /** Set when the phrasing was ambiguous; the person answers before a preview exists. */
  clarification: z.string().max(400).optional(),
  status: routineProposalStatusSchema,
  routineId: id.optional(),
  createdAt: isoDate,
  expiresAt: isoDate,
  revision,
})
export type RoutineProposal = z.infer<typeof routineProposalSchema>

export const routineEventKindSchema = z.enum([
  'routine.changed',
  'occurrence.status',
  'proposal.created',
  'proposal.resolved',
  'attention',
])
export const routineEventSchema = z.strictObject({
  seq: z.number().int().positive(),
  routineId: id.optional(),
  occurrenceId: id.optional(),
  target: targetRefSchema.optional(),
  kind: routineEventKindSchema,
  summary: z.string().max(400),
  causeCode: routineCauseCodeSchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  createdAt: isoDate,
})
export type RoutineEvent = z.infer<typeof routineEventSchema>

export const routineOperationSchema = z.strictObject({
  id,
  kind: z.enum(['routine.activate', 'routine.pause', 'routine.resume', 'routine.archive', 'routine.runNow', 'routine.occurrence.cancel']),
  routineId: id.optional(),
  occurrenceId: id.optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  detail: z.record(z.string(), z.unknown()).optional(),
  error: errorSchema.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type RoutineOperation = z.infer<typeof routineOperationSchema>

/** Aggregate consumption of one routine in the moving 24 h window. */
export const routineUsageSchema = z.strictObject({
  routineId: id,
  windowStart: isoDate,
  admissions: z.number().int().nonnegative(),
  activeMs: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
})
export type RoutineUsage = z.infer<typeof routineUsageSchema>

/** Public, stable error codes for the routine domain; free text never carries the reason. */
export const ROUTINE_ERROR_CODES = [
  'ROUTINE_NOT_FOUND',
  'ROUTINE_ARCHIVED',
  'ROUTINE_TARGET_INVALID',
  'ROUTINE_FOREIGN_HOST',
  'ROUTINE_PREVIEW_EXPIRED',
  'ROUTINE_PREVIEW_MISMATCH',
  'ROUTINE_SCHEDULE_INVALID',
  'ROUTINE_SCHEDULE_AMBIGUOUS',
  'ROUTINE_LIMIT',
  'ROUTINE_BUDGET_EXHAUSTED',
  'ROUTINE_OCCURRENCE_ACTIVE',
  'ROUTINE_PROPOSAL_INVALID',
  'ROUTINE_PROPOSAL_FORBIDDEN',
  'ROUTINE_UPDATE_REQUIRED',
] as const
export type RoutineErrorCode = (typeof ROUTINE_ERROR_CODES)[number]
