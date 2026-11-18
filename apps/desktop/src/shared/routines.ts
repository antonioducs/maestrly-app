import { z } from 'zod'
import {
  FLEET_ROUTINE_RUN_LIMITS,
  fleetRoutineScheduleSchema,
  isValidTimeZone,
  type FleetRoutineSchedule,
} from '@maestrly/bot-fleet-protocol'
import type { ChatPermMode, ChatReasoningEffort } from './chat'

export type RoutineSchedule = FleetRoutineSchedule
export type RoutineNotify = 'notable' | 'all' | 'none'
export type RoutineMissed = 'catchup' | 'skip'
export type RoutineRetentionDays = 30 | 60 | 90 | null // null = always

export interface RoutineModel {
  providerId: string
  modelId: string
  reasoning: ChatReasoningEffort
  fastMode: boolean
}

export interface RoutineOrigin {
  conversationId: string
  title: string
  via: 'proposal' | 'menu'
}

export interface LocalRoutine {
  id: string
  title: string
  instruction: string
  schedule: RoutineSchedule
  enabled: boolean
  pausedAt: number | null
  permMode: ChatPermMode
  model: RoutineModel
  notify: RoutineNotify
  missed: RoutineMissed
  retentionDays: RoutineRetentionDays
  origin: RoutineOrigin | null
  folder: string
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}

export type RoutineDraft = Pick<
  LocalRoutine,
  'title' | 'instruction' | 'schedule' | 'permMode' | 'model' | 'notify' | 'missed' | 'retentionDays'
>

export type RoutineRunStatus =
  | 'running'
  | 'waiting'
  | 'notable'
  | 'nothing_new'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'skipped_asleep'
  | 'skipped_closed'
  | 'skipped_busy'

export type RoutineRunTrigger = 'schedule' | 'manual' | 'late'

export interface RoutineRunReport {
  outcome: 'notable' | 'nothing_new' | 'done'
  summary: string
  pending: string | null
  notes: string | null
}

export interface LocalRoutineRun {
  id: string
  routineId: string
  scheduledAt: number
  startedAt: number | null
  finishedAt: number | null
  trigger: RoutineRunTrigger
  status: RoutineRunStatus
  summary: string | null
  report: RoutineRunReport | null
  error: string | null
  conversationId: string | null
  conversationDeleted: boolean
  pinned: boolean
  unread: boolean
}

export interface RoutineProposal {
  id: string
  conversationId: string
  draft: RoutineDraft
  state: 'pending' | 'created' | 'discarded'
  routineId: string | null
  createdAt: number
}

export interface RoutineSettings {
  keepRunning: boolean
  openAtLogin: boolean
}

export const ROUTINE_LIMITS = {
  titleMax: 80,
  instructionMax: 4000,
  routinesMax: 50,
  concurrentRuns: 3,
  onTimeGraceMs: 2 * 60_000,
  catchUpWindowMs: 2 * 3_600_000,
  tickMs: 15_000,
  skippedSlotsPerGap: 48,
  runRowsPerRoutine: 500,
  previousReports: 3,
  sweepMs: 10 * 60_000,
} as const

export const DEFAULT_ROUTINE_SETTINGS: RoutineSettings = {
  keepRunning: true,
  openAtLogin: false,
}

export const routineScheduleSchema = fleetRoutineScheduleSchema.superRefine((schedule, ctx) => {
  if (schedule.kind === 'weekly' && !isValidTimeZone(schedule.timezone)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid time zone',
      path: ['timezone'],
    })
  }
})

export const routinePermModeSchema = z.enum(['ask', 'auto', 'full'])
export const routineNotifySchema = z.enum(['notable', 'all', 'none'])
export const routineMissedSchema = z.enum(['catchup', 'skip'])
export const routineRetentionDaysSchema = z.union([z.literal(30), z.literal(60), z.literal(90), z.null()])

export const routineModelSchema = z
  .object({
    providerId: z.string().trim().min(1).max(120),
    modelId: z.string().trim().min(1).max(200),
    reasoning: z.string().trim().min(1).max(80) as z.ZodType<ChatReasoningEffort>,
    fastMode: z.boolean(),
  })
  .strict()

export const routineOriginSchema = z
  .object({
    conversationId: z.string().min(1).max(200),
    title: z.string().min(1).max(300),
    via: z.enum(['proposal', 'menu']),
  })
  .strict()

export const routineDraftSchema: z.ZodType<RoutineDraft> = z
  .object({
    title: z.string().trim().min(1).max(ROUTINE_LIMITS.titleMax),
    instruction: z.string().trim().min(1).max(ROUTINE_LIMITS.instructionMax),
    schedule: routineScheduleSchema,
    permMode: routinePermModeSchema,
    model: routineModelSchema,
    notify: routineNotifySchema,
    missed: routineMissedSchema,
    retentionDays: routineRetentionDaysSchema,
  })
  .strict()

export const routineUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(ROUTINE_LIMITS.titleMax).optional(),
    instruction: z.string().trim().min(1).max(ROUTINE_LIMITS.instructionMax).optional(),
    schedule: routineScheduleSchema.optional(),
    permMode: routinePermModeSchema.optional(),
    model: routineModelSchema.optional(),
    notify: routineNotifySchema.optional(),
    missed: routineMissedSchema.optional(),
    retentionDays: routineRetentionDaysSchema.optional(),
  })
  .strict()

export const routineRunFilterSchema = z.enum(['all', 'notable', 'issues'])

export const routineListRunsSchema = z
  .object({
    routineId: z.string().min(1).max(200),
    filter: routineRunFilterSchema.default('all'),
    limit: z.number().int().min(1).max(200).default(10),
    before: z.number().int().nonnegative().optional(),
  })
  .strict()

export const routineRunsInRangeSchema = z
  .object({
    from: z.number().int(),
    to: z.number().int(),
  })
  .strict()

export const routineRunReportSchema = z
  .object({
    outcome: z.enum(['notable', 'nothing_new', 'done']),
    summary: z.string().trim().min(1).max(FLEET_ROUTINE_RUN_LIMITS.summaryMax),
    pending: z.string().trim().max(FLEET_ROUTINE_RUN_LIMITS.pendingMax).nullable(),
    notes: z.string().trim().max(FLEET_ROUTINE_RUN_LIMITS.notesMax).nullable(),
  })
  .strict()

export const routineSettingsSchema = z
  .object({
    keepRunning: z.boolean(),
    openAtLogin: z.boolean(),
  })
  .strict()

export const routineIdSchema = z.string().min(1).max(200)

export function parseRoutineSettings(raw: unknown): RoutineSettings {
  const parsed = routineSettingsSchema.safeParse(raw)
  return parsed.success ? parsed.data : { ...DEFAULT_ROUTINE_SETTINGS }
}

export interface RoutineToastPayload {
  kind: 'started' | 'skipped-busy' | 'result'
  routine: LocalRoutine
  run: LocalRoutineRun
}

export interface RoutineSavedPermission {
  id: string
  scopeKey: string
  action: string
  resource: string
}

export type RoutineUpdatePatch = Partial<RoutineDraft>

export type RoutineRunFilter = 'all' | 'notable' | 'issues'

export interface RoutineListRunsInput {
  routineId: string
  filter: RoutineRunFilter
  limit: number
  before?: number
}

export interface RoutineListRunsResult {
  runs: LocalRoutineRun[]
  total: number
  hasMore: boolean
}

export function isRoutineRunSkipped(run: Pick<LocalRoutineRun, 'status'>): boolean {
  return run.status.startsWith('skipped_')
}

export function isRoutineRunIssue(run: Pick<LocalRoutineRun, 'status'>): boolean {
  return run.status === 'failed' || run.status === 'waiting' || run.status === 'stopped' || isRoutineRunSkipped(run)
}

/**
 * Whether a run should alert the person under `notify`:
 * `failed` and `waiting` always alert; `notable` alerts unless `notify === 'none'`;
 * `nothing_new` and `done` alert only with `notify === 'all'`.
 */
export function isAlerting(run: Pick<LocalRoutineRun, 'status'>, notify: RoutineNotify): boolean {
  if (run.status === 'failed' || run.status === 'waiting') return true
  if (run.status === 'notable') return notify !== 'none'
  if (run.status === 'nothing_new' || run.status === 'done') return notify === 'all'
  return false
}
