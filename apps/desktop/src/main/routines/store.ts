import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { isValidTimeZone, nextRun } from '@maestrly/bot-fleet-protocol'
import {
  parseRoutineSettings,
  ROUTINE_LIMITS,
  routineDraftSchema,
  routineSettingsSchema,
  type LocalRoutine,
  type LocalRoutineRun,
  type RoutineDraft,
  type RoutineOrigin,
  type RoutinePlace,
  type RoutineProposal,
  type RoutineRunReport,
  type RoutineRunStatus,
  type RoutineRunTrigger,
  type RoutineSchedule,
  type RoutineSettings,
} from '../../shared/routines'
import type { ChatPermMode, ChatReasoningEffort } from '../../shared/chat'
import { getAppSetting, setAppSetting } from '../store/app-settings'
import { getDb, transaction } from '../store/db'

const SETTINGS_KEY = 'routines.settings'
const OWNER_TIME_ZONE_KEY = 'routines.ownerTimeZone'

const changeListeners = new Set<() => void>()

export function subscribeRoutinesChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function emitRoutinesChanged(): void {
  for (const listener of changeListeners) {
    try {
      listener()
    } catch {
      /* Listeners handle their own errors so one failing window does not block others. */
    }
  }
}

interface RoutineRow {
  id: string
  title: string
  instruction: string
  schedule_json: string
  enabled: number
  paused_at: number | null
  perm_mode: string
  provider_id: string
  model_id: string
  reasoning: string
  fast_mode: number
  notify: string
  missed: string
  retention_days: number | null
  origin_conversation_id: string | null
  origin_title: string | null
  origin_via: string | null
  origin_host_id: string | null
  origin_device_id: string | null
  folder: string
  next_run_at: number | null
  created_at: number
  updated_at: number
}

interface RoutineRunRow {
  id: string
  routine_id: string
  scheduled_at: number
  started_at: number | null
  finished_at: number | null
  trigger: string
  status: string
  summary: string | null
  report_json: string | null
  error: string | null
  conversation_id: string | null
  conversation_deleted: number
  pinned: number
  unread: number
  waiting_kind: string | null
  waiting_prompt: string | null
}

interface ProposalRow {
  id: string
  conversation_id: string
  draft_json: string
  state: string
  routine_id: string | null
  routine_host_id: string | null
  routine_device_id: string | null
  created_at: number
  updated_at: number
}

function rowToRoutine(row: RoutineRow): LocalRoutine {
  const schedule = JSON.parse(row.schedule_json) as RoutineSchedule
  const origin: RoutineOrigin | null =
    row.origin_conversation_id && row.origin_title && (row.origin_via === 'proposal' || row.origin_via === 'menu')
      ? {
          conversationId: row.origin_conversation_id,
          title: row.origin_title,
          via: row.origin_via,
          ...(row.origin_host_id ? { hostId: row.origin_host_id } : {}),
          ...(row.origin_device_id ? { deviceId: row.origin_device_id } : {}),
        }
      : null
  return {
    id: row.id,
    title: row.title,
    instruction: row.instruction,
    schedule,
    enabled: row.enabled === 1,
    pausedAt: row.paused_at,
    permMode: row.perm_mode as ChatPermMode,
    model: {
      providerId: row.provider_id,
      modelId: row.model_id,
      reasoning: row.reasoning as ChatReasoningEffort,
      fastMode: row.fast_mode === 1,
    },
    notify: row.notify as LocalRoutine['notify'],
    missed: row.missed as LocalRoutine['missed'],
    retentionDays: row.retention_days as LocalRoutine['retentionDays'],
    origin,
    folder: row.folder,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToRun(row: RoutineRunRow): LocalRoutineRun {
  return {
    id: row.id,
    routineId: row.routine_id,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    trigger: row.trigger as RoutineRunTrigger,
    status: row.status as RoutineRunStatus,
    summary: row.summary,
    report: row.report_json ? (JSON.parse(row.report_json) as RoutineRunReport) : null,
    error: row.error,
    conversationId: row.conversation_id,
    conversationDeleted: row.conversation_deleted === 1,
    pinned: row.pinned === 1,
    unread: row.unread === 1,
    waiting:
      row.waiting_kind === 'approval' || row.waiting_kind === 'question'
        ? { kind: row.waiting_kind, prompt: row.waiting_prompt ?? null }
        : null,
  }
}

function rowToProposal(row: ProposalRow): RoutineProposal {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    draft: JSON.parse(row.draft_json) as RoutineDraft,
    state: row.state as RoutineProposal['state'],
    routineId: row.routine_id,
    ...(row.routine_host_id || row.routine_device_id
      ? {
          routinePlace: {
            ...(row.routine_host_id ? { hostId: row.routine_host_id } : {}),
            ...(row.routine_device_id ? { deviceId: row.routine_device_id } : {}),
          },
        }
      : {}),
    createdAt: row.created_at,
  }
}

export function routineFolderPath(routineId: string): string {
  return path.join(app.getPath('userData'), 'routines', routineId)
}

function computeNextRunAt(schedule: RoutineSchedule, afterMs: number): number {
  return Date.parse(nextRun(schedule, new Date(afterMs)))
}

export function createRoutine(
  draftInput: RoutineDraft,
  origin: RoutineOrigin | null = null,
  now = Date.now()
): LocalRoutine {
  const draft = routineDraftSchema.parse(draftInput)
  const count = (getDb().prepare('SELECT COUNT(*) AS count FROM local_routines').get() as { count: number }).count
  if (count >= ROUTINE_LIMITS.routinesMax) {
    throw new Error(`Routine limit reached (${ROUTINE_LIMITS.routinesMax}).`)
  }
  const id = randomUUID()
  const folder = routineFolderPath(id)
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  const nextRunAt = computeNextRunAt(draft.schedule, now)
  getDb()
    .prepare(
      `INSERT INTO local_routines (
        id, title, instruction, schedule_json, enabled, paused_at, perm_mode,
        provider_id, model_id, reasoning, fast_mode, notify, missed, retention_days,
        origin_conversation_id, origin_title, origin_via, origin_host_id, origin_device_id, folder, next_run_at, created_at, updated_at
      ) VALUES (
        @id, @title, @instruction, @scheduleJson, 1, NULL, @permMode,
        @providerId, @modelId, @reasoning, @fastMode, @notify, @missed, @retentionDays,
        @originConversationId, @originTitle, @originVia, @originHostId, @originDeviceId, @folder, @nextRunAt, @createdAt, @updatedAt
      )`
    )
    .run({
      id,
      title: draft.title,
      instruction: draft.instruction,
      scheduleJson: JSON.stringify(draft.schedule),
      permMode: draft.permMode,
      providerId: draft.model.providerId,
      modelId: draft.model.modelId,
      reasoning: draft.model.reasoning,
      fastMode: draft.model.fastMode ? 1 : 0,
      notify: draft.notify,
      missed: draft.missed,
      retentionDays: draft.retentionDays,
      originConversationId: origin?.conversationId ?? null,
      originTitle: origin?.title ?? null,
      originVia: origin?.via ?? null,
      originHostId: origin?.hostId ?? null,
      originDeviceId: origin?.deviceId ?? null,
      folder,
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    })
  emitRoutinesChanged()
  return getRoutine(id)!
}

export function getRoutine(id: string): LocalRoutine | null {
  const row = getDb().prepare('SELECT * FROM local_routines WHERE id = ?').get(id) as RoutineRow | undefined
  return row ? rowToRoutine(row) : null
}

export function listRoutines(): LocalRoutine[] {
  const rows = getDb()
    .prepare('SELECT * FROM local_routines ORDER BY enabled DESC, created_at ASC')
    .all() as unknown as RoutineRow[]
  return rows.map(rowToRoutine)
}

export function updateRoutine(id: string, patch: Partial<RoutineDraft>, now = Date.now()): LocalRoutine {
  const existing = getRoutine(id)
  if (!existing) throw new Error('Routine not found.')
  const merged = routineDraftSchema.parse({
    title: patch.title ?? existing.title,
    instruction: patch.instruction ?? existing.instruction,
    schedule: patch.schedule ?? existing.schedule,
    permMode: patch.permMode ?? existing.permMode,
    model: patch.model ?? existing.model,
    notify: patch.notify ?? existing.notify,
    missed: patch.missed ?? existing.missed,
    retentionDays: patch.retentionDays === undefined ? existing.retentionDays : patch.retentionDays,
  })
  const scheduleChanged = JSON.stringify(merged.schedule) !== JSON.stringify(existing.schedule)
  const nextRunAt = existing.enabled
    ? scheduleChanged
      ? computeNextRunAt(merged.schedule, now)
      : existing.nextRunAt
    : null
  getDb()
    .prepare(
      `UPDATE local_routines SET
        title = @title,
        instruction = @instruction,
        schedule_json = @scheduleJson,
        perm_mode = @permMode,
        provider_id = @providerId,
        model_id = @modelId,
        reasoning = @reasoning,
        fast_mode = @fastMode,
        notify = @notify,
        missed = @missed,
        retention_days = @retentionDays,
        next_run_at = @nextRunAt,
        updated_at = @updatedAt
      WHERE id = @id`
    )
    .run({
      id,
      title: merged.title,
      instruction: merged.instruction,
      scheduleJson: JSON.stringify(merged.schedule),
      permMode: merged.permMode,
      providerId: merged.model.providerId,
      modelId: merged.model.modelId,
      reasoning: merged.model.reasoning,
      fastMode: merged.model.fastMode ? 1 : 0,
      notify: merged.notify,
      missed: merged.missed,
      retentionDays: merged.retentionDays,
      nextRunAt,
      updatedAt: now,
    })
  emitRoutinesChanged()
  return getRoutine(id)!
}

export function deleteRoutine(id: string): boolean {
  const changed = getDb().prepare('DELETE FROM local_routines WHERE id = ?').run(id).changes === 1
  if (changed) emitRoutinesChanged()
  return changed
}

export function setRoutineEnabled(id: string, enabled: boolean, now = Date.now()): LocalRoutine {
  const existing = getRoutine(id)
  if (!existing) throw new Error('Routine not found.')
  const pausedAt = enabled ? null : now
  const nextRunAt = enabled ? computeNextRunAt(existing.schedule, now) : null
  getDb()
    .prepare('UPDATE local_routines SET enabled = ?, paused_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, pausedAt, nextRunAt, now, id)
  emitRoutinesChanged()
  return getRoutine(id)!
}

export function duplicateRoutine(id: string, title: string, now = Date.now()): LocalRoutine {
  const existing = getRoutine(id)
  if (!existing) throw new Error('Routine not found.')
  const count = (getDb().prepare('SELECT COUNT(*) AS count FROM local_routines').get() as { count: number }).count
  if (count >= ROUTINE_LIMITS.routinesMax) {
    throw new Error(`Routine limit reached (${ROUTINE_LIMITS.routinesMax}).`)
  }
  const cleanTitle = title.trim().slice(0, ROUTINE_LIMITS.titleMax)
  const draft = routineDraftSchema.parse({
    title: cleanTitle || existing.title,
    instruction: existing.instruction,
    schedule: existing.schedule,
    permMode: existing.permMode,
    model: existing.model,
    notify: existing.notify,
    missed: existing.missed,
    retentionDays: existing.retentionDays,
  })
  const copyId = randomUUID()
  const folder = routineFolderPath(copyId)
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  getDb()
    .prepare(
      `INSERT INTO local_routines (
        id, title, instruction, schedule_json, enabled, paused_at, perm_mode,
        provider_id, model_id, reasoning, fast_mode, notify, missed, retention_days,
        origin_conversation_id, origin_title, origin_via, folder, next_run_at, created_at, updated_at
      ) VALUES (
        @id, @title, @instruction, @scheduleJson, 0, @pausedAt, @permMode,
        @providerId, @modelId, @reasoning, @fastMode, @notify, @missed, @retentionDays,
        NULL, NULL, NULL, @folder, NULL, @createdAt, @updatedAt
      )`
    )
    .run({
      id: copyId,
      title: draft.title,
      instruction: draft.instruction,
      scheduleJson: JSON.stringify(draft.schedule),
      pausedAt: now,
      permMode: draft.permMode,
      providerId: draft.model.providerId,
      modelId: draft.model.modelId,
      reasoning: draft.model.reasoning,
      fastMode: draft.model.fastMode ? 1 : 0,
      notify: draft.notify,
      missed: draft.missed,
      retentionDays: draft.retentionDays,
      folder,
      createdAt: now,
      updatedAt: now,
    })
  emitRoutinesChanged()
  return getRoutine(copyId)!
}

export function setNextRunAt(id: string, nextRunAt: number | null): void {
  const changes = getDb().prepare('UPDATE local_routines SET next_run_at = ? WHERE id = ?').run(nextRunAt, id).changes
  if (changes > 0) emitRoutinesChanged()
}

export function insertRun(input: Omit<LocalRoutineRun, 'id'> & { id?: string }): LocalRoutineRun {
  const id = input.id ?? randomUUID()
  getDb()
    .prepare(
      `INSERT INTO local_routine_runs (
        id, routine_id, scheduled_at, started_at, finished_at, trigger, status,
        summary, report_json, error, conversation_id, conversation_deleted, pinned, unread,
        waiting_kind, waiting_prompt
      ) VALUES (
        @id, @routineId, @scheduledAt, @startedAt, @finishedAt, @trigger, @status,
        @summary, @reportJson, @error, @conversationId, @conversationDeleted, @pinned, @unread,
        @waitingKind, @waitingPrompt
      )`
    )
    .run({
      id,
      routineId: input.routineId,
      scheduledAt: input.scheduledAt,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      trigger: input.trigger,
      status: input.status,
      summary: input.summary,
      reportJson: input.report ? JSON.stringify(input.report) : null,
      error: input.error,
      conversationId: input.conversationId,
      conversationDeleted: input.conversationDeleted ? 1 : 0,
      pinned: input.pinned ? 1 : 0,
      unread: input.unread ? 1 : 0,
      waitingKind: input.waiting?.kind ?? null,
      waitingPrompt: input.waiting?.prompt ?? null,
    })
  emitRoutinesChanged()
  return getRun(id)!
}

export function updateRun(id: string, patch: Partial<Omit<LocalRoutineRun, 'id' | 'routineId'>>): LocalRoutineRun | null {
  const existing = getRun(id)
  if (!existing) return null
  const next: LocalRoutineRun = { ...existing, ...patch }
  getDb()
    .prepare(
      `UPDATE local_routine_runs SET
        scheduled_at = @scheduledAt,
        started_at = @startedAt,
        finished_at = @finishedAt,
        trigger = @trigger,
        status = @status,
        summary = @summary,
        report_json = @reportJson,
        error = @error,
        conversation_id = @conversationId,
        conversation_deleted = @conversationDeleted,
        pinned = @pinned,
        unread = @unread,
        waiting_kind = @waitingKind,
        waiting_prompt = @waitingPrompt
      WHERE id = @id`
    )
    .run({
      id,
      scheduledAt: next.scheduledAt,
      startedAt: next.startedAt,
      finishedAt: next.finishedAt,
      trigger: next.trigger,
      status: next.status,
      summary: next.summary,
      reportJson: next.report ? JSON.stringify(next.report) : null,
      error: next.error,
      conversationId: next.conversationId,
      conversationDeleted: next.conversationDeleted ? 1 : 0,
      pinned: next.pinned ? 1 : 0,
      unread: next.unread ? 1 : 0,
      waitingKind: next.waiting?.kind ?? null,
      waitingPrompt: next.waiting?.prompt ?? null,
    })
  emitRoutinesChanged()
  return getRun(id)
}

export function getRun(id: string): LocalRoutineRun | null {
  const row = getDb().prepare('SELECT * FROM local_routine_runs WHERE id = ?').get(id) as RoutineRunRow | undefined
  return row ? rowToRun(row) : null
}

const ISSUE_STATUSES = "('failed', 'waiting', 'stopped', 'skipped_asleep', 'skipped_closed', 'skipped_busy')"

export function listRuns(input: {
  routineId: string
  filter: 'all' | 'notable' | 'issues'
  limit: number
  before?: number
}): { runs: LocalRoutineRun[]; total: number; hasMore: boolean } {
  const conditions = ['routine_id = @routineId']
  if (input.filter === 'notable') conditions.push("status = 'notable'")
  if (input.filter === 'issues') conditions.push(`status IN ${ISSUE_STATUSES}`)
  const baseWhere = conditions.join(' AND ')
  const total = (
    getDb()
      .prepare(`SELECT COUNT(*) AS count FROM local_routine_runs WHERE ${baseWhere}`)
      .get({ routineId: input.routineId }) as { count: number }
  ).count

  const pagedConditions = [...conditions]
  if (input.before !== undefined) pagedConditions.push('scheduled_at < @before')
  const pagedWhere = pagedConditions.join(' AND ')
  const rows = getDb()
    .prepare(
      `SELECT * FROM local_routine_runs WHERE ${pagedWhere} ORDER BY scheduled_at DESC, rowid DESC LIMIT @limitPlusOne`
    )
    .all({
      routineId: input.routineId,
      ...(input.before !== undefined ? { before: input.before } : {}),
      limitPlusOne: input.limit + 1,
    }) as unknown as RoutineRunRow[]

  const hasMore = rows.length > input.limit
  return {
    runs: (hasMore ? rows.slice(0, input.limit) : rows).map(rowToRun),
    total,
    hasMore,
  }
}

export function runsInRange(from: number, to: number): LocalRoutineRun[] {
  const rows = getDb()
    .prepare('SELECT * FROM local_routine_runs WHERE scheduled_at >= ? AND scheduled_at < ? ORDER BY scheduled_at ASC')
    .all(from, to) as unknown as RoutineRunRow[]
  return rows.map(rowToRun)
}

export function latestReports(routineId: string, n: number): Array<{ run: LocalRoutineRun; report: RoutineRunReport }> {
  const rows = getDb()
    .prepare(
      `SELECT * FROM local_routine_runs
       WHERE routine_id = ? AND report_json IS NOT NULL
       ORDER BY COALESCE(started_at, scheduled_at) DESC, rowid DESC
       LIMIT ?`
    )
    .all(routineId, n) as unknown as RoutineRunRow[]
  return rows.map((row) => {
    const run = rowToRun(row)
    return { run, report: run.report! }
  })
}

export function runByConversation(conversationId: string): LocalRoutineRun | null {
  const row = getDb()
    .prepare('SELECT * FROM local_routine_runs WHERE conversation_id = ?')
    .get(conversationId) as RoutineRunRow | undefined
  return row ? rowToRun(row) : null
}

export function listActiveRuns(): LocalRoutineRun[] {
  const rows = getDb()
    .prepare("SELECT * FROM local_routine_runs WHERE status IN ('running', 'waiting') ORDER BY scheduled_at ASC")
    .all() as unknown as RoutineRunRow[]
  return rows.map(rowToRun)
}

export function listAllRunsForRetention(routineId: string): LocalRoutineRun[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM local_routine_runs
       WHERE routine_id = ?
         AND pinned = 0
         AND conversation_deleted = 0
         AND conversation_id IS NOT NULL
         AND status NOT IN ('running', 'waiting')
       ORDER BY scheduled_at ASC`
    )
    .all(routineId) as unknown as RoutineRunRow[]
  return rows.map(rowToRun)
}

export function pruneRuns(routineId: string, keep: number): number {
  let deleted = 0
  transaction(() => {
    const keepIds = (
      getDb()
        .prepare(
          `SELECT id FROM local_routine_runs
           WHERE routine_id = ?
             AND pinned = 0
             AND status NOT IN ('running', 'waiting')
             AND (conversation_id IS NULL OR conversation_deleted = 1)
           ORDER BY scheduled_at DESC, rowid DESC
           LIMIT ?`
        )
        .all(routineId, Math.max(0, keep)) as Array<{ id: string }>
    ).map((r) => r.id)
    if (keepIds.length === 0) {
      deleted = Number(
        getDb()
          .prepare(
            `DELETE FROM local_routine_runs
             WHERE routine_id = ?
               AND pinned = 0
               AND status NOT IN ('running', 'waiting')
               AND (conversation_id IS NULL OR conversation_deleted = 1)`
          )
          .run(routineId).changes
      )
      return
    }
    const placeholders = keepIds.map(() => '?').join(', ')
    deleted = Number(
      getDb()
        .prepare(
          `DELETE FROM local_routine_runs
           WHERE routine_id = ?
             AND pinned = 0
             AND status NOT IN ('running', 'waiting')
             AND (conversation_id IS NULL OR conversation_deleted = 1)
             AND id NOT IN (${placeholders})`
        )
        .run(routineId, ...keepIds).changes
    )
  })
  if (deleted > 0) emitRoutinesChanged()
  return deleted
}

export function createProposal(
  conversationId: string,
  draftInput: RoutineDraft,
  now = Date.now(),
  id = randomUUID()
): RoutineProposal {
  const draft = routineDraftSchema.parse(draftInput)
  getDb()
    .prepare(
      `INSERT INTO local_routine_proposals (id, conversation_id, draft_json, state, routine_id, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', NULL, ?, ?)`
    )
    .run(id, conversationId, JSON.stringify(draft), now, now)
  emitRoutinesChanged()
  return getProposal(id)!
}

export function getProposal(id: string): RoutineProposal | null {
  const row = getDb().prepare('SELECT * FROM local_routine_proposals WHERE id = ?').get(id) as ProposalRow | undefined
  return row ? rowToProposal(row) : null
}

export function listProposalsByConversation(conversationId: string): RoutineProposal[] {
  const rows = getDb()
    .prepare('SELECT * FROM local_routine_proposals WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as unknown as ProposalRow[]
  return rows.map(rowToProposal)
}

export function setProposalState(
  id: string,
  state: RoutineProposal['state'],
  routineId: string | null = null,
  now = Date.now(),
  routinePlace: RoutinePlace | null = null
): RoutineProposal | null {
  const existing = getProposal(id)
  if (!existing) return null
  getDb()
    .prepare('UPDATE local_routine_proposals SET state = ?, routine_id = ?, routine_host_id = ?, routine_device_id = ?, updated_at = ? WHERE id = ?')
    .run(state, routineId, routinePlace?.hostId ?? null, routinePlace?.deviceId ?? null, now, id)
  emitRoutinesChanged()
  return getProposal(id)
}

/** Summary reported on a workspaces host's `/v1/health` so the gateway keeps environments with active routines running. */
export function getRoutineHealthSummary(): { enabled: number; nextRunAt: number | null } {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS enabled, MIN(next_run_at) AS nextRunAt FROM local_routines WHERE enabled = 1')
    .get() as { enabled: number; nextRunAt: number | null } | undefined
  return {
    enabled: Number(row?.enabled ?? 0),
    nextRunAt: row?.nextRunAt != null ? Number(row.nextRunAt) : null,
  }
}

/**
 * The time zone of the computer that connected to this host last. A server's clock runs in the server's zone, so the
 * routines its chats propose default to the owner's instead.
 */
export function getRoutineOwnerTimeZone(): string | null {
  const value = getAppSetting(OWNER_TIME_ZONE_KEY)
  return value && isValidTimeZone(value) ? value : null
}

export function setRoutineOwnerTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone) || getAppSetting(OWNER_TIME_ZONE_KEY) === timeZone) return
  setAppSetting(OWNER_TIME_ZONE_KEY, timeZone)
}

export function getRoutineSettings(): RoutineSettings {
  const raw = getAppSetting(SETTINGS_KEY)
  if (raw == null) return parseRoutineSettings(undefined)
  try {
    return parseRoutineSettings(JSON.parse(raw))
  } catch {
    return parseRoutineSettings(undefined)
  }
}

export function setRoutineSettings(settings: RoutineSettings): RoutineSettings {
  const parsed = routineSettingsSchema.parse(settings)
  setAppSetting(SETTINGS_KEY, JSON.stringify(parsed))
  emitRoutinesChanged()
  return parsed
}
