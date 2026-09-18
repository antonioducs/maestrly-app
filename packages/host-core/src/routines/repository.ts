import type { DatabaseSync } from 'node:sqlite'
import {
  ROUTINE_EVENTS_PAGE_BUDGET,
  ROUTINE_OCCURRENCE_ACTIVE,
  routineEventSchema,
  routineOccurrenceSchema,
  routineOperationSchema,
  routineProposalSchema,
  routineSchema,
  routineUsageSchema,
  type Routine,
  type RoutineEvent,
  type RoutineOccurrence,
  type RoutineOperation,
  type RoutineProposal,
  type RoutineUsage,
  type TargetRef,
} from '@maestrly/host-protocol'
import { z } from 'zod'
import { HostError } from '../errors.js'
import type { HostStore } from '../persistence/store.js'

export const now = () => new Date().toISOString()
const parseRow = <T>(schema: { parse(value: unknown): T }, row: unknown): T => schema.parse(JSON.parse((row as { body: string }).body))

/** One physical turn or team run carrying the work of an occurrence. */
export const routineExecutionSchema = z.strictObject({
  id: z.string(),
  occurrenceId: z.string(),
  routineId: z.string(),
  turnId: z.string().optional(),
  teamRunId: z.string().optional(),
  continuationOfTurnId: z.string().optional(),
  conversationId: z.string(),
  reservedActiveMs: z.number().int().nonnegative(),
  reservedActions: z.number().int().nonnegative(),
  settled: z.boolean(),
  settledAs: z.string().max(40).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RoutineExecution = z.infer<typeof routineExecutionSchema>

/**
 * Durable state of the routines domain. It shares the HostStore connection and transaction
 * so an occurrence, its execution and its budget reservation commit together or not at all.
 * Uniqueness lives in the schema, not in application code: this class never works around a
 * constraint violation, it turns it into a stable, human-readable refusal.
 */
export class RoutineRepository {
  readonly db: DatabaseSync
  constructor(readonly store: HostStore) {
    this.db = store.db
  }
  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn)
  }

  // Routines
  routines(target?: TargetRef, includeArchived = false): Routine[] {
    const rows = target
      ? this.db.prepare('SELECT body FROM routines WHERE target_kind=? AND target_id=? ORDER BY rowid').all(target.kind, target.id)
      : this.db.prepare('SELECT body FROM routines ORDER BY rowid').all()
    return rows.map((row) => parseRow(routineSchema, row)).filter((routine) => includeArchived || routine.status !== 'archived')
  }
  routine(id: string): Routine {
    const row = this.db.prepare('SELECT body FROM routines WHERE id=?').get(id)
    if (!row) throw new HostError('ROUTINE_NOT_FOUND', 'Esta rotina não existe neste Host')
    return parseRow(routineSchema, row)
  }
  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS total FROM routines WHERE status!='archived'").get() as { total: number }).total
  }
  /** Active routines whose next nominal instant has already arrived. */
  due(nowUtc: string, limit: number): Routine[] {
    return this.db
      .prepare("SELECT body FROM routines WHERE status='active' AND next_due_utc IS NOT NULL AND next_due_utc<=? ORDER BY next_due_utc LIMIT ?")
      .all(nowUtc, limit)
      .map((row) => parseRow(routineSchema, row))
  }
  saveRoutine(routine: Routine) {
    routineSchema.parse(routine)
    this.db
      .prepare(
        'INSERT INTO routines(id,host_id,target_kind,target_id,status,fingerprint,next_due_utc,watermark_utc,body) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,fingerprint=excluded.fingerprint,next_due_utc=excluded.next_due_utc,watermark_utc=excluded.watermark_utc,body=excluded.body'
      )
      .run(
        routine.id,
        routine.hostId,
        routine.spec.target.kind,
        routine.spec.target.id,
        routine.status,
        routine.fingerprint,
        routine.nextDueUtc ?? null,
        routine.watermarkUtc,
        JSON.stringify(routine)
      )
    this.store.event('routine.changed', { id: routine.id, status: routine.status, revision: routine.revision, nextDueUtc: routine.nextDueUtc })
  }

  // Occurrences
  occurrence(id: string): RoutineOccurrence {
    const row = this.db.prepare('SELECT body FROM routine_occurrences WHERE id=?').get(id)
    if (!row) throw new HostError('ROUTINE_NOT_FOUND', 'Esta execução de rotina não existe')
    return parseRow(routineOccurrenceSchema, row)
  }
  occurrenceAt(routineId: string, scheduledForUtc: string): RoutineOccurrence | undefined {
    const row = this.db.prepare("SELECT body FROM routine_occurrences WHERE routine_id=? AND scheduled_for_utc=? AND origin='schedule'").get(routineId, scheduledForUtc)
    return row ? parseRow(routineOccurrenceSchema, row) : undefined
  }
  occurrenceByManualKey(key: string): RoutineOccurrence | undefined {
    const row = this.db.prepare('SELECT body FROM routine_occurrences WHERE manual_key=?').get(key)
    return row ? parseRow(routineOccurrenceSchema, row) : undefined
  }
  /** The occurrence still holding this routine's single slot, if any. */
  activeOccurrence(routineId: string): RoutineOccurrence | undefined {
    const row = this.db
      .prepare(`SELECT body FROM routine_occurrences WHERE routine_id=? AND status IN (${[...ROUTINE_OCCURRENCE_ACTIVE].map(() => '?').join(',')})`)
      .get(routineId, ...ROUTINE_OCCURRENCE_ACTIVE)
    return row ? parseRow(routineOccurrenceSchema, row) : undefined
  }
  activeOccurrences(): RoutineOccurrence[] {
    return this.db
      .prepare(`SELECT body FROM routine_occurrences WHERE status IN (${[...ROUTINE_OCCURRENCE_ACTIVE].map(() => '?').join(',')}) ORDER BY rowid`)
      .all(...ROUTINE_OCCURRENCE_ACTIVE)
      .map((row) => parseRow(routineOccurrenceSchema, row))
  }
  /**
   * Occurrences of INDIVIDUAL bots that currently occupy a background slot. A team routine is
   * deliberately excluded: its members' tasks are already counted by the teams domain, and
   * counting the run as well would silently halve the Host's usable parallelism.
   */
  runningBotCount(): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS total FROM routine_occurrences o JOIN routines r ON r.id=o.routine_id WHERE r.target_kind='bot' AND o.status IN ('running','waiting_user','needs_attention')"
        )
        .get() as { total: number }
    ).total
  }
  occurrences(routineId: string, before: number | undefined, limit: number): RoutineOccurrence[] {
    const cursor = before ? new Date(before).toISOString() : '9999-12-31T23:59:59.999Z'
    return this.db
      .prepare('SELECT body FROM routine_occurrences WHERE routine_id=? AND scheduled_for_utc<? ORDER BY scheduled_for_utc DESC, rowid DESC LIMIT ?')
      .all(routineId, cursor, limit)
      .map((row) => parseRow(routineOccurrenceSchema, row))
  }
  saveOccurrence(occurrence: RoutineOccurrence, manualKey?: string) {
    routineOccurrenceSchema.parse(occurrence)
    try {
      this.db
        .prepare(
          'INSERT INTO routine_occurrences(id,routine_id,origin,scheduled_for_utc,status,manual_key,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body'
        )
        .run(occurrence.id, occurrence.routineId, occurrence.origin, occurrence.scheduledForUtc, occurrence.status, manualKey ?? null, JSON.stringify(occurrence))
    } catch (error) {
      const text = String(error)
      if (/routine_occurrences_active/.test(text)) throw new HostError('ROUTINE_OCCURRENCE_ACTIVE', 'Esta rotina ainda está executando o horário anterior')
      if (/UNIQUE/.test(text)) throw new HostError('IDEMPOTENCY_CONFLICT', 'Este horário desta rotina já foi registrado')
      throw error
    }
    this.store.event('routine.occurrence.changed', { id: occurrence.id, routineId: occurrence.routineId, status: occurrence.status })
  }

  // Executions
  execution(id: string): RoutineExecution {
    const row = this.db.prepare('SELECT body FROM routine_executions WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Esta execução não existe')
    return parseRow(routineExecutionSchema, row)
  }
  executionByTurn(turnId: string): RoutineExecution | undefined {
    const row = this.db.prepare('SELECT body FROM routine_executions WHERE turn_id=?').get(turnId)
    return row ? parseRow(routineExecutionSchema, row) : undefined
  }
  executionByRun(runId: string): RoutineExecution | undefined {
    const row = this.db.prepare('SELECT body FROM routine_executions WHERE team_run_id=?').get(runId)
    return row ? parseRow(routineExecutionSchema, row) : undefined
  }
  executionsOf(occurrenceId: string): RoutineExecution[] {
    return this.db
      .prepare('SELECT body FROM routine_executions WHERE occurrence_id=? ORDER BY rowid')
      .all(occurrenceId)
      .map((row) => parseRow(routineExecutionSchema, row))
  }
  saveExecution(execution: RoutineExecution) {
    routineExecutionSchema.parse(execution)
    try {
      this.db
        .prepare(
          'INSERT INTO routine_executions(id,occurrence_id,routine_id,turn_id,team_run_id,continuation_of,settled,body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET settled=excluded.settled,body=excluded.body'
        )
        .run(
          execution.id,
          execution.occurrenceId,
          execution.routineId,
          execution.turnId ?? null,
          execution.teamRunId ?? null,
          execution.continuationOfTurnId ?? null,
          execution.settled ? 1 : 0,
          JSON.stringify(execution)
        )
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new HostError('ROUTINE_OCCURRENCE_ACTIVE', 'Este trabalho já pertence a outra execução de rotina')
      throw error
    }
  }

  // Proposals
  proposal(id: string): RoutineProposal {
    const row = this.db.prepare('SELECT body FROM routine_proposals WHERE id=?').get(id)
    if (!row) throw new HostError('ROUTINE_PROPOSAL_INVALID', 'Esta sugestão de rotina não existe mais')
    return parseRow(routineProposalSchema, row)
  }
  proposals(target?: TargetRef, status: RoutineProposal['status'] = 'pending'): RoutineProposal[] {
    const rows = target
      ? this.db.prepare('SELECT body FROM routine_proposals WHERE target_kind=? AND target_id=? AND status=? ORDER BY rowid').all(target.kind, target.id, status)
      : this.db.prepare('SELECT body FROM routine_proposals WHERE status=? ORDER BY rowid').all(status)
    return rows.map((row) => parseRow(routineProposalSchema, row))
  }
  proposalsOfTurn(turnId: string): RoutineProposal[] {
    return this.db
      .prepare('SELECT body FROM routine_proposals WHERE turn_id=? ORDER BY rowid')
      .all(turnId)
      .map((row) => parseRow(routineProposalSchema, row))
  }
  saveProposal(proposal: RoutineProposal) {
    routineProposalSchema.parse(proposal)
    this.db
      .prepare(
        'INSERT INTO routine_proposals(id,target_kind,target_id,bot_id,turn_id,status,expires_at,body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body'
      )
      .run(proposal.id, proposal.target.kind, proposal.target.id, proposal.proposedByBotId, proposal.turnId, proposal.status, proposal.expiresAt, JSON.stringify(proposal))
  }
  /** Expires stale cards in one statement instead of keeping a timer per proposal. */
  expireProposals(nowUtc: string): number {
    const stale = this.db
      .prepare("SELECT body FROM routine_proposals WHERE status='pending' AND expires_at<=?")
      .all(nowUtc)
      .map((row) => parseRow(routineProposalSchema, row))
    for (const proposal of stale) this.saveProposal({ ...proposal, status: 'expired', revision: proposal.revision + 1 })
    return stale.length
  }

  // Budget window
  usage(routineId: string): RoutineUsage | undefined {
    const row = this.db.prepare('SELECT routine_id,window_start,admissions,active_ms,actions FROM routine_usage WHERE routine_id=?').get(routineId) as
      | { routine_id: string; window_start: string; admissions: number; active_ms: number; actions: number }
      | undefined
    return row
      ? routineUsageSchema.parse({ routineId: row.routine_id, windowStart: row.window_start, admissions: row.admissions, activeMs: row.active_ms, actions: row.actions })
      : undefined
  }
  saveUsage(usage: RoutineUsage) {
    routineUsageSchema.parse(usage)
    this.db
      .prepare(
        'INSERT INTO routine_usage(routine_id,window_start,admissions,active_ms,actions) VALUES(?,?,?,?,?) ON CONFLICT(routine_id) DO UPDATE SET window_start=excluded.window_start,admissions=excluded.admissions,active_ms=excluded.active_ms,actions=excluded.actions'
      )
      .run(usage.routineId, usage.windowStart, usage.admissions, usage.activeMs, usage.actions)
  }

  // Events
  appendEvent(event: Omit<RoutineEvent, 'seq'>): RoutineEvent {
    const result = this.db.prepare('INSERT INTO routine_events(routine_id,occurrence_id,body) VALUES(?,?,?)').run(event.routineId ?? null, event.occurrenceId ?? null, JSON.stringify(event))
    return routineEventSchema.parse({ seq: Number(result.lastInsertRowid), ...event })
  }
  events(after: number, limit: number, routineId?: string): { events: RoutineEvent[]; hasMore: boolean } {
    const rows = (
      routineId
        ? this.db.prepare('SELECT seq,body FROM routine_events WHERE routine_id=? AND seq>? ORDER BY seq LIMIT ?').all(routineId, after, limit + 1)
        : this.db.prepare('SELECT seq,body FROM routine_events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit + 1)
    ) as { seq: number; body: string }[]
    const events: RoutineEvent[] = []
    let bytes = 0
    for (const row of rows.slice(0, limit)) {
      bytes += Buffer.byteLength(row.body) + 32
      if (events.length && bytes > ROUTINE_EVENTS_PAGE_BUDGET) return { events, hasMore: true }
      events.push(routineEventSchema.parse({ seq: row.seq, ...JSON.parse(row.body) }))
    }
    return { events, hasMore: rows.length > limit }
  }

  // Operations and idempotency
  operation(id: string): RoutineOperation {
    const row = this.db.prepare('SELECT body FROM routine_operations WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Operação de rotina não encontrada')
    return parseRow(routineOperationSchema, row)
  }
  operationByKey(key: string): { fingerprint: string; operation: RoutineOperation } | undefined {
    const row = this.db.prepare('SELECT fingerprint,body FROM routine_operations WHERE key=?').get(key) as { fingerprint: string; body: string } | undefined
    return row ? { fingerprint: row.fingerprint, operation: routineOperationSchema.parse(JSON.parse(row.body)) } : undefined
  }
  insertOperation(operation: RoutineOperation, key: string, fingerprint: string, request: unknown) {
    routineOperationSchema.parse(operation)
    this.db
      .prepare('INSERT INTO routine_operations(id,key,fingerprint,routine_id,occurrence_id,request,body) VALUES(?,?,?,?,?,?,?)')
      .run(operation.id, key, fingerprint, operation.routineId ?? null, operation.occurrenceId ?? null, JSON.stringify(request), JSON.stringify(operation))
  }
  saveOperation(operation: RoutineOperation) {
    routineOperationSchema.parse(operation)
    this.db.prepare('UPDATE routine_operations SET body=? WHERE id=?').run(JSON.stringify(operation), operation.id)
  }

  /**
   * History compaction. Terminal occurrences older than the retention window are dropped
   * together with their executions, but the routine keeps its watermark, so compaction can
   * never make an old instant look due again.
   */
  pruneHistory(olderThanUtc: string): number {
    const stale = this.db
      .prepare(
        "SELECT id FROM routine_occurrences WHERE scheduled_for_utc<? AND status IN ('succeeded','partial','failed','cancelled','skipped')"
      )
      .all(olderThanUtc) as { id: string }[]
    for (const row of stale) {
      this.db.prepare('DELETE FROM routine_executions WHERE occurrence_id=?').run(row.id)
      this.db.prepare('DELETE FROM routine_occurrences WHERE id=?').run(row.id)
    }
    this.db.prepare('DELETE FROM routine_events WHERE occurrence_id IS NOT NULL AND occurrence_id NOT IN (SELECT id FROM routine_occurrences)').run()
    return stale.length
  }
}
