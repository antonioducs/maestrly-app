import { randomUUID } from 'node:crypto'
import {
  ROUTINE_LIMITS,
  ROUTINE_OCCURRENCE_TERMINAL,
  type Routine,
  type RoutineCauseCode,
  type RoutineOccurrence,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { RuntimeCoordinator } from '../bots/runtime-coordinator.js'
import type { RoutineAuthority } from './authority.js'
import { enumerate, latestDue, localReading, type Clock, systemClock } from './calendar.js'
import type { RoutineExecutionAdapter } from './execution-adapter.js'
import { type RoutineRepository, now } from './repository.js'

export interface RoutineSchedulerDeps {
  routines: RoutineRepository
  authority: RoutineAuthority
  adapter: RoutineExecutionAdapter
  coordinator: RuntimeCoordinator
  /** Shared with team work: background slots are one pool, not one per scheduler. */
  backgroundAvailable: () => boolean
  event: (input: { routineId?: string; occurrenceId?: string; kind: 'occurrence.status' | 'attention' | 'routine.changed'; summary: string; causeCode?: RoutineCauseCode; detail?: Record<string, unknown> }) => void
  pauseForReview: (routine: Routine, message: string) => void
  clock?: Clock
  tickMs?: number
  /** Routines examined per tick, so a Host with a hundred of them keeps short transactions. */
  batch?: number
}

/**
 * Turns the passage of time into durable occurrences, and durable occurrences into admitted
 * work. It never calls a model, never opens a session and never decides that work finished:
 * materialising and admitting are all it does.
 *
 * Two properties matter more than anything else here. A nominal instant becomes at most one
 * occurrence, guaranteed by a unique index rather than by careful code — so a crash between
 * materialising and dispatching cannot double-fire. And waiting is never failing: a busy bot,
 * a sleeping computer or a person holding the screen keep the occurrence queued until its own
 * deadline, without ever interrupting whatever is already running.
 */
export class RoutineScheduler {
  private timer?: ReturnType<typeof setInterval>
  private ticking = false
  private again = false
  private closed = false
  private lastPrune = 0
  private readonly clock: Clock
  constructor(private readonly deps: RoutineSchedulerDeps) {
    this.clock = deps.clock ?? systemClock
  }

  start() {
    this.timer ??= setInterval(() => void this.tick().catch(() => {}), this.deps.tickMs ?? ROUTINE_LIMITS.tickMs)
    this.timer.unref?.()
    void this.tick().catch(() => {})
  }
  async close() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
  kick() {
    void this.tick().catch(() => {})
  }

  async tick(nowMs = this.clock.now()) {
    if (this.closed) return
    if (this.ticking) {
      this.again = true
      return
    }
    this.ticking = true
    try {
      do {
        this.again = false
        this.deps.routines.expireProposals(new Date(nowMs).toISOString())
        for (const routine of this.deps.routines.due(new Date(nowMs).toISOString(), this.deps.batch ?? 50)) this.materialise(routine, nowMs)
        for (const occurrence of this.deps.routines.activeOccurrences()) await this.advance(occurrence, nowMs)
        this.prune(nowMs)
      } while (this.again && !this.closed)
    } finally {
      this.ticking = false
    }
  }

  /**
   * Records what this routine owes, in one short transaction that both writes the occurrence
   * and moves the cursor past it. A unique index turns a concurrent duplicate into the
   * occurrence that already exists instead of a second firing.
   */
  materialise(routine: Routine, nowMs: number) {
    const window = routine.spec.misfirePolicy === 'latest' ? ROUTINE_LIMITS.latestWindowMs : ROUTINE_LIMITS.misfireToleranceMs
    const summary = latestDue(routine.spec.schedule, Date.parse(routine.watermarkUtc), nowMs, window)
    const active = this.deps.routines.activeOccurrence(routine.id)
    const created = this.deps.routines.transaction(() => {
      const current = this.deps.routines.routine(routine.id)
      if (current.status !== 'active') return undefined
      if (current.watermarkUtc !== routine.watermarkUtc) return undefined // another tick already moved it
      const [next] = enumerate(current.spec.schedule, nowMs, 1).occurrences
      let occurrence: RoutineOccurrence | undefined
      let cause: RoutineCauseCode | undefined
      if (summary.latest) {
        if (active) cause = 'OVERLAP'
        else {
          occurrence = {
            id: randomUUID(),
            routineId: current.id,
            target: current.spec.target,
            origin: 'schedule',
            scheduledForUtc: summary.latest.scheduledForUtc,
            scheduledForLocal: summary.latest.scheduledForLocal,
            timeZone: current.spec.schedule.timeZone,
            deadlineAt: new Date(nowMs + current.spec.queueDeadlineMs).toISOString(),
            status: 'pending',
            usedActiveMs: 0,
            usedActions: 0,
            createdAt: now(),
            updatedAt: now(),
            revision: 0,
          }
          try {
            this.deps.routines.saveOccurrence(occurrence)
          } catch (error) {
            // Another writer materialised this exact instant first: adopt it, never duplicate.
            if (error instanceof HostError && ['IDEMPOTENCY_CONFLICT', 'ROUTINE_OCCURRENCE_ACTIVE'].includes(error.code))
              occurrence = this.deps.routines.occurrenceAt(current.id, summary.latest.scheduledForUtc)
            else throw error
          }
        }
      } else if (summary.skipped > 0) cause = 'MISSED_WINDOW'
      // The cursor moves in the same commit: a restart here never replays this window.
      this.deps.routines.saveRoutine({
        ...current,
        watermarkUtc: new Date(nowMs).toISOString(),
        nextDueUtc: next?.scheduledForUtc,
        ...(occurrence ? { lastOccurrenceId: occurrence.id } : {}),
        revision: current.revision + 1,
        updatedAt: now(),
      })
      return { occurrence, cause, skipped: summary.skipped }
    })
    if (!created) return
    if (created.occurrence)
      this.deps.event({
        routineId: routine.id,
        occurrenceId: created.occurrence.id,
        kind: 'occurrence.status',
        summary: `Horário de ${created.occurrence.scheduledForLocal} registrado`,
        detail: { status: 'pending', skipped: created.skipped },
      })
    else if (created.cause)
      this.deps.event({
        routineId: routine.id,
        kind: 'occurrence.status',
        summary:
          created.cause === 'OVERLAP'
            ? 'Horário pulado: a execução anterior desta rotina ainda não terminou'
            : `Horário pulado: o Host não estava disponível (${created.skipped} vez(es))`,
        causeCode: created.cause,
        detail: { status: 'skipped', skipped: created.skipped },
      })
    this.again = true
  }

  /** Moves one occurrence forward: admit it, keep it waiting, or end it with a reason. */
  private async advance(occurrence: RoutineOccurrence, nowMs: number) {
    if (ROUTINE_OCCURRENCE_TERMINAL.has(occurrence.status)) return
    // Once a turn or run exists, the engines that own it decide; the scheduler only follows.
    const executions = this.deps.routines.executionsOf(occurrence.id)
    if (executions.length) {
      for (const execution of executions)
        if (!execution.settled && execution.teamRunId) this.deps.adapter.runChanged(execution.teamRunId)
      return
    }
    let routine: Routine
    try {
      routine = this.deps.routines.routine(occurrence.routineId)
    } catch {
      return
    }
    if (routine.status !== 'active') {
      this.end(occurrence, 'skipped', routine.status === 'archived' ? 'ROUTINE_PAUSED' : 'ROUTINE_PAUSED', 'A rotina não está ativa; este horário foi pulado.')
      return
    }
    // The queue deadline belongs to the wait, not to the work: it is checked before any turn
    // exists and never shortens an execution that already started.
    if (nowMs > Date.parse(occurrence.deadlineAt)) {
      this.end(occurrence, 'skipped', 'QUEUE_DEADLINE', 'O alvo não ficou disponível a tempo; este horário foi pulado.')
      return
    }
    const target = this.deps.authority.describe(routine.spec.target)
    if (target.version !== routine.targetVersion) {
      this.end(occurrence, 'skipped', 'TARGET_CHANGED', 'A conta, o modelo ou os participantes mudaram; confirme a rotina novamente.')
      this.deps.pauseForReview(routine, `A rotina "${routine.spec.name}" foi pausada porque o alvo mudou; revise e confirme para voltar a executar.`)
      return
    }
    const resources = this.deps.authority.resourceState(routine)
    if (!resources.ready) {
      this.end(occurrence, 'skipped', 'ACCESS_REVOKED', resources.message ?? 'Um recurso desta rotina não está mais disponível.')
      return
    }
    const state = this.deps.authority.admissionState(routine.spec.target)
    if (!state.ready) {
      if (!state.transient) {
        this.end(occurrence, 'skipped', state.causeCode ?? 'ACCESS_REVOKED', state.message ?? 'O alvo desta rotina não está disponível.')
        return
      }
      this.wait(occurrence, state.causeCode ?? 'TARGET_BUSY', state.message ?? 'Aguardando o alvo ficar disponível.')
      return
    }
    const ceiling = this.deps.authority.effectiveCeiling(routine.spec.ceiling, target.ceiling)
    const budget = this.deps.authority.canAdmit(routine, ceiling, nowMs)
    if (!budget.ready) {
      this.end(occurrence, 'skipped', 'BUDGET_EXHAUSTED', budget.message ?? 'Esta rotina já atingiu o limite de 24 horas.')
      return
    }
    // Background slots are shared with team work: a routine never gets its own extra pair.
    if (!this.deps.backgroundAvailable()) {
      this.wait(occurrence, 'TARGET_BUSY', 'O Host já está executando outras tarefas em segundo plano; este horário está na fila.')
      return
    }
    try {
      const admitted = this.deps.adapter.admit(routine, occurrence, ceiling)
      this.deps.event({
        routineId: routine.id,
        occurrenceId: admitted.id,
        kind: 'occurrence.status',
        summary: `A rotina "${routine.spec.name}" começou`,
        detail: { status: 'running', target: routine.spec.target.kind },
      })
      if (routine.spec.target.kind === 'bot') this.deps.coordinator.kick(routine.spec.target.id)
    } catch (error) {
      const code = error instanceof HostError ? error.code : 'ROUTINE_TARGET_INVALID'
      // A busy bot, a paused one or a computer waking up are all "not yet": keep waiting.
      if (['BOT_BUSY', 'BOT_PAUSED_BY_USER', 'TEAM_RUN_ACTIVE', 'RUNTIME_NOT_READY', 'VM_STOPPED'].includes(code)) {
        this.wait(occurrence, 'TARGET_BUSY', 'O alvo está ocupado; este horário está na fila.')
        return
      }
      this.end(occurrence, 'failed', 'ACCESS_REVOKED', error instanceof Error ? error.message.slice(0, 400) : 'Não foi possível iniciar esta execução.')
    }
  }

  private wait(occurrence: RoutineOccurrence, causeCode: RoutineCauseCode, message: string) {
    if (occurrence.status === 'waiting_resource' && occurrence.causeCode === causeCode) return
    this.deps.routines.transaction(() => {
      const current = this.deps.routines.occurrence(occurrence.id)
      if (ROUTINE_OCCURRENCE_TERMINAL.has(current.status) || current.execution) return
      this.deps.routines.saveOccurrence({ ...current, status: 'waiting_resource', causeCode, attention: message, revision: current.revision + 1, updatedAt: now() })
    })
    this.deps.event({ routineId: occurrence.routineId, occurrenceId: occurrence.id, kind: 'occurrence.status', summary: message, causeCode, detail: { status: 'waiting_resource' } })
  }

  private end(occurrence: RoutineOccurrence, status: 'skipped' | 'failed', causeCode: RoutineCauseCode, message: string) {
    const ended = this.deps.routines.transaction(() => {
      const current = this.deps.routines.occurrence(occurrence.id)
      if (ROUTINE_OCCURRENCE_TERMINAL.has(current.status)) return undefined
      const value: RoutineOccurrence = {
        ...current,
        status,
        causeCode,
        attention: message,
        finishedAt: now(),
        // A firing that never reached a bot consumed nothing and must not look like it did.
        usedActiveMs: 0,
        usedActions: 0,
        revision: current.revision + 1,
        updatedAt: now(),
      }
      this.deps.routines.saveOccurrence(value)
      const routine = this.deps.routines.routine(current.routineId)
      this.deps.routines.saveRoutine({ ...routine, lastOutcome: status, revision: routine.revision + 1, updatedAt: now() })
      return value
    })
    if (!ended) return
    this.deps.event({ routineId: ended.routineId, occurrenceId: ended.id, kind: 'occurrence.status', summary: message, causeCode, detail: { status } })
    this.again = true
  }

  /** History older than the retention window is compacted; the cursor is never rewound. */
  private prune(nowMs: number) {
    if (nowMs - this.lastPrune < 60 * 60_000) return
    this.lastPrune = nowMs
    this.deps.routines.transaction(() => this.deps.routines.pruneHistory(new Date(nowMs - ROUTINE_LIMITS.historyDays * 24 * 60 * 60_000).toISOString()))
  }
}
export { localReading }
