import { randomUUID } from 'node:crypto'
import {
  ROUTINE_OCCURRENCE_TERMINAL,
  TURN_TERMINAL,
  TEAM_RUN_TERMINAL,
  type BotTurn,
  type Routine,
  type RoutineCauseCode,
  type RoutineCeiling,
  type RoutineOccurrence,
  type TurnSnapshot,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository } from '../bots/repository.js'
import { workedMs } from '../bots/context.js'
import { scopedConversation } from '../bots/scoped-execution.js'
import type { BotTurns, ContinuationScope } from '../bots/turns.js'
import type { RuntimeCoordinator } from '../bots/runtime-coordinator.js'
import type { TeamRepository } from '../teams/repository.js'
import type { TeamService } from '../teams/service.js'
import type { RoutineAuthority } from './authority.js'
import { type RoutineExecution, type RoutineRepository, now } from './repository.js'

/** Host-internal thread of one occurrence; no caller of the public API can name it. */
export const routineThreadId = (occurrenceId: string) => `routine:${occurrenceId}`

export interface RoutineExecutionDeps {
  routines: RoutineRepository
  bots: BotRepository
  teams: TeamRepository
  turns: BotTurns
  coordinator: RuntimeCoordinator
  authority: RoutineAuthority
  teamService: () => TeamService
  event: (input: { routineId?: string; occurrenceId?: string; kind: 'occurrence.status' | 'attention' | 'routine.changed'; summary: string; causeCode?: RoutineCauseCode; detail?: Record<string, unknown> }) => void
}

/**
 * Bridges a routine occurrence onto the engines that already exist: one scoped turn for an
 * individual bot, one team run for a team. It is not a second executor — it never talks to a
 * provider, never renews a lease and never decides that work finished. It admits, observes
 * and settles.
 *
 * Ownership is exclusive and explicit: a turn it admitted belongs to this adapter, a turn of
 * a member working inside a scheduled team run belongs to the team adapter. The routine
 * follows the run, not the members' turns.
 */
export class RoutineExecutionAdapter implements ContinuationScope {
  constructor(private readonly deps: RoutineExecutionDeps) {}

  /** The message the bot actually reads. It says plainly that nobody is waiting at the screen. */
  private prompt(routine: Routine, occurrence: RoutineOccurrence) {
    return [
      `Esta é uma execução programada da rotina "${routine.spec.name}", prevista para ${occurrence.scheduledForLocal} (${occurrence.timeZone}).`,
      'Ninguém está acompanhando a tela agora. Se faltar uma informação ou uma permissão, registre o que falta e encerre; não invente dados nem tente contornar.',
      '',
      'Pedido:',
      routine.spec.request,
    ].join('\n')
  }
  private instructions(routine: Routine) {
    return [
      'Você está executando uma rotina agendada.',
      'Faça exatamente o que o pedido descreve, nada além disso.',
      'Você não pode criar, alterar, ativar nem apagar rotinas durante esta execução.',
      `Limite desta execução: ${Math.round(routine.spec.ceiling.activeMs / 60_000)} minutos de trabalho e ${routine.spec.ceiling.maxTools} ações.`,
    ].join('\n')
  }

  /**
   * Admits the work of one occurrence. Occurrence, execution and turn (or run) commit in the
   * same transaction, before anything is kicked: a crash between them is impossible, so a
   * restart can never produce a second piece of work for the same firing.
   */
  admit(routine: Routine, occurrence: RoutineOccurrence, ceiling: RoutineCeiling): RoutineOccurrence {
    const existing = this.deps.routines.executionsOf(occurrence.id)
    if (existing.length) return this.deps.routines.occurrence(occurrence.id)
    return routine.spec.target.kind === 'bot' ? this.admitBot(routine, occurrence, ceiling) : this.admitTeam(routine, occurrence, ceiling)
  }

  private admitBot(routine: Routine, occurrence: RoutineOccurrence, ceiling: RoutineCeiling): RoutineOccurrence {
    const botId = routine.spec.target.id
    const limits: TurnSnapshot['limits'] = { activeMs: ceiling.activeMs, maxTools: ceiling.maxTools, maxLogBytes: 10 * 1024 * 1024 }
    return this.deps.routines.transaction(() => {
      const conversation = scopedConversation(
        this.deps.bots,
        routineThreadId(occurrence.id),
        botId,
        'ROUTINE_TARGET_INVALID',
        'Esta conversa de rotina pertence a outro bot'
      )
      const receipt = this.deps.turns.enqueueScopedTurn({
        botId,
        conversationId: conversation.id,
        origin: 'team',
        // One admission per occurrence: a repeat returns the same message and turn.
        clientMessageId: `routine:${occurrence.id}`,
        content: this.prompt(routine, occurrence),
        role: 'system',
        attachments: [],
        limits,
        instructions: this.instructions(routine),
        permissionMode: ceiling.permissionMode,
        // A scheduled run never carries the private memory or private history of the chat.
        includePrivateContext: false,
      })
      const execution: RoutineExecution = {
        id: randomUUID(),
        occurrenceId: occurrence.id,
        routineId: routine.id,
        turnId: receipt.turn.id,
        conversationId: conversation.id,
        reservedActiveMs: ceiling.activeMs,
        reservedActions: ceiling.maxTools,
        settled: false,
        createdAt: now(),
        updatedAt: now(),
      }
      this.deps.routines.saveExecution(execution)
      const updated: RoutineOccurrence = {
        ...this.deps.routines.occurrence(occurrence.id),
        status: 'running',
        startedAt: now(),
        causeCode: undefined,
        attention: undefined,
        execution: { kind: 'bot', turnId: receipt.turn.id, conversationId: conversation.id },
        // Conservative from the start: an uncertain result must never look free.
        usedActiveMs: ceiling.activeMs,
        usedActions: ceiling.maxTools,
        revision: occurrence.revision + 1,
        updatedAt: now(),
      }
      this.deps.routines.saveOccurrence(updated)
      return updated
    })
  }

  private admitTeam(routine: Routine, occurrence: RoutineOccurrence, ceiling: RoutineCeiling): RoutineOccurrence {
    let created: RoutineOccurrence | undefined
    const receipt = this.deps.teamService().enqueueRun({
      teamId: routine.spec.target.id,
      clientMessageId: `routine:${occurrence.id}`,
      content: routine.spec.request,
      artifactIds: routine.spec.resourceIds,
      origin: {
        kind: 'routine',
        routineId: routine.id,
        occurrenceId: occurrence.id,
        name: routine.spec.name,
        scheduledForLocal: occurrence.scheduledForLocal,
      },
      limits: { maxActiveMs: ceiling.activeMs, maxToolCalls: ceiling.maxTools, permissionMode: ceiling.permissionMode },
      onAdmitted: ({ run }) => {
        const execution: RoutineExecution = {
          id: randomUUID(),
          occurrenceId: occurrence.id,
          routineId: routine.id,
          teamRunId: run.id,
          conversationId: run.conversationId,
          reservedActiveMs: ceiling.activeMs,
          reservedActions: ceiling.maxTools,
          settled: false,
          createdAt: now(),
          updatedAt: now(),
        }
        this.deps.routines.saveExecution(execution)
        created = {
          ...this.deps.routines.occurrence(occurrence.id),
          status: 'running',
          startedAt: now(),
          causeCode: undefined,
          attention: undefined,
          execution: { kind: 'team', runId: run.id, conversationId: run.conversationId },
          usedActiveMs: ceiling.activeMs,
          usedActions: ceiling.maxTools,
          revision: occurrence.revision + 1,
          updatedAt: now(),
        }
        this.deps.routines.saveOccurrence(created)
      },
    })
    if (!created) throw new HostError('ROUTINE_TARGET_INVALID', `A equipe não registrou o trabalho da rotina (${receipt.run.id}).`)
    return created
  }

  // ---------------------------------------------------------------- observation and settling

  /** A turn changed. Only turns this adapter admitted are mirrored onto an occurrence. */
  turnChanged(turnId: string) {
    const execution = this.deps.routines.executionByTurn(turnId)
    if (!execution) return
    const turn = this.deps.bots.turn(turnId)
    if (!TURN_TERMINAL.has(turn.status)) {
      this.mirrorWaiting(execution, turn)
      return
    }
    this.settleTurn(execution, turn)
  }

  private mirrorWaiting(execution: RoutineExecution, turn: BotTurn) {
    const occurrence = this.deps.routines.occurrence(execution.occurrenceId)
    if (ROUTINE_OCCURRENCE_TERMINAL.has(occurrence.status)) return
    const status = turn.status === 'waiting_approval' || turn.status === 'waiting_input' ? 'waiting_user' : turn.status === 'needs_attention' ? 'needs_attention' : 'running'
    if (occurrence.status === status) return
    this.deps.routines.transaction(() =>
      this.deps.routines.saveOccurrence({ ...this.deps.routines.occurrence(occurrence.id), status, revision: occurrence.revision + 1, updatedAt: now() })
    )
    this.deps.event({
      routineId: occurrence.routineId,
      occurrenceId: occurrence.id,
      kind: status === 'needs_attention' ? 'attention' : 'occurrence.status',
      summary:
        status === 'waiting_user'
          ? 'A rotina está esperando a sua resposta'
          : status === 'needs_attention'
            ? 'A execução desta rotina precisa da sua atenção'
            : 'A rotina está executando',
      detail: { status },
    })
  }

  /** Settles exactly once: budget, outcome and the answer the person will read. */
  private settleTurn(execution: RoutineExecution, turn: BotTurn) {
    if (execution.settled) return
    const takeover = turn.status === 'interrupted' && turn.error?.code === 'HUMAN_TAKEOVER'
    const outcome: RoutineOccurrence['status'] = takeover
      ? 'waiting_user'
      : turn.status === 'succeeded'
        ? 'succeeded'
        : turn.status === 'cancelled'
          ? 'cancelled'
          : 'failed'
    const summary = this.answerOf(turn)
    const settled = this.deps.routines.transaction(() => {
      const current = this.deps.routines.execution(execution.id)
      if (current.settled) return undefined
      this.deps.routines.saveExecution({ ...current, settled: true, settledAs: turn.status, updatedAt: now() })
      const occurrence = this.deps.routines.occurrence(current.occurrenceId)
      if (ROUTINE_OCCURRENCE_TERMINAL.has(occurrence.status)) return undefined
      // A person's decision time is not computation; the shared helper already excludes it.
      const worked = workedMs(turn, this.deps.bots.interactionsOfTurn(turn.id))
      const updated: RoutineOccurrence = {
        ...occurrence,
        status: outcome,
        ...(takeover ? { causeCode: 'HUMAN_TAKEOVER' as const, attention: 'Você assumiu a tela durante esta execução; ela pode continuar quando devolver o controle.' } : {}),
        ...(turn.error && !takeover ? { error: turn.error } : {}),
        ...(summary ? { summary } : {}),
        // Known consumption replaces the reservation; unknown keeps it.
        usedActiveMs: Math.min(occurrence.usedActiveMs, Math.max(0, worked)),
        usedActions: turn.usage?.toolCalls ?? occurrence.usedActions,
        ...(ROUTINE_OCCURRENCE_TERMINAL.has(outcome) ? { finishedAt: now() } : {}),
        revision: occurrence.revision + 1,
        updatedAt: now(),
      }
      this.deps.routines.saveOccurrence(updated)
      return updated
    })
    if (!settled) return
    this.deps.event({
      routineId: settled.routineId,
      occurrenceId: settled.id,
      kind: 'occurrence.status',
      summary: this.outcomeSummary(settled.status),
      ...(settled.causeCode ? { causeCode: settled.causeCode } : {}),
      detail: { status: settled.status },
    })
  }

  /**
   * A team run changed. The routine follows the run and never the members' turns: those
   * belong to the team adapter, which already owns their budget and their continuations.
   */
  runChanged(runId: string) {
    const execution = this.deps.routines.executionByRun(runId)
    if (!execution || execution.settled) return
    const run = this.deps.teams.run(runId)
    const occurrence = this.deps.routines.occurrence(execution.occurrenceId)
    if (ROUTINE_OCCURRENCE_TERMINAL.has(occurrence.status)) return
    if (!TEAM_RUN_TERMINAL.has(run.status)) {
      const status: RoutineOccurrence['status'] =
        run.status === 'waiting_user' || run.status === 'paused' ? 'waiting_user' : run.status === 'needs_attention' ? 'needs_attention' : 'running'
      if (occurrence.status === status) return
      this.deps.routines.transaction(() =>
        this.deps.routines.saveOccurrence({ ...this.deps.routines.occurrence(occurrence.id), status, revision: occurrence.revision + 1, updatedAt: now() })
      )
      return
    }
    const outcome: RoutineOccurrence['status'] =
      run.status === 'succeeded' ? 'succeeded' : run.status === 'partial' ? 'partial' : run.status === 'cancelled' ? 'cancelled' : 'failed'
    const settled = this.deps.routines.transaction(() => {
      const current = this.deps.routines.execution(execution.id)
      if (current.settled) return undefined
      this.deps.routines.saveExecution({ ...current, settled: true, settledAs: run.status, updatedAt: now() })
      const latest = this.deps.routines.occurrence(current.occurrenceId)
      if (ROUTINE_OCCURRENCE_TERMINAL.has(latest.status)) return undefined
      const updated: RoutineOccurrence = {
        ...latest,
        status: outcome,
        ...(run.summary ? { summary: run.summary } : {}),
        ...(run.error ? { error: run.error } : {}),
        usedActiveMs: Math.min(latest.usedActiveMs, run.budget.activeMsSettled || latest.usedActiveMs),
        usedActions: run.budget.toolCallsSettled || latest.usedActions,
        finishedAt: now(),
        revision: latest.revision + 1,
        updatedAt: now(),
      }
      this.deps.routines.saveOccurrence(updated)
      return updated
    })
    if (!settled) return
    this.deps.event({ routineId: settled.routineId, occurrenceId: settled.id, kind: 'occurrence.status', summary: this.outcomeSummary(settled.status), detail: { status: settled.status } })
  }

  private outcomeSummary(status: RoutineOccurrence['status']) {
    const labels: Partial<Record<RoutineOccurrence['status'], string>> = {
      succeeded: 'A rotina executou e concluiu',
      partial: 'A rotina concluiu parte do trabalho',
      failed: 'A rotina não conseguiu concluir',
      cancelled: 'Execução interrompida',
      skipped: 'Execução pulada',
      waiting_user: 'A rotina está esperando você',
      needs_attention: 'A execução precisa da sua atenção',
    }
    return labels[status] ?? status
  }
  private answerOf(turn: BotTurn): string {
    const messages = this.deps.bots.messages(turn.conversationId, undefined, 40)
    const reply = [...messages].reverse().find((message) => message.turnId === turn.id && message.role === 'assistant')
    return reply?.content.slice(0, 16 * 1024) ?? ''
  }

  // ------------------------------------------------------------------------ authorization

  /**
   * Last check before a queued routine turn is written to a guest. A routine paused,
   * archived or edited in the meantime, a target whose approved identity changed, or a
   * shared file that was revoked all block the old outbox item instead of running it.
   */
  dispatchGuard(turnId: string): { code: string; message: string } | undefined {
    const execution = this.deps.routines.executionByTurn(turnId)
    if (!execution) return undefined
    try {
      const occurrence = this.deps.routines.occurrence(execution.occurrenceId)
      if (ROUTINE_OCCURRENCE_TERMINAL.has(occurrence.status))
        return { code: 'ROUTINE_ARCHIVED', message: 'Esta execução de rotina foi encerrada antes de começar.' }
      const routine = this.deps.routines.routine(execution.routineId)
      if (routine.status === 'archived') return { code: 'ROUTINE_ARCHIVED', message: 'Esta rotina foi arquivada antes desta execução começar.' }
      if (routine.status === 'paused') return { code: 'ROUTINE_ARCHIVED', message: 'Esta rotina foi pausada antes desta execução começar.' }
      const target = this.deps.authority.describe(routine.spec.target)
      if (target.version !== routine.targetVersion)
        return { code: 'ROUTINE_TARGET_INVALID', message: 'A conta, o modelo ou as permissões deste alvo mudaram; confirme a rotina novamente.' }
      const resources = this.deps.authority.resourceState(routine)
      if (!resources.ready) return { code: 'ROUTINE_TARGET_INVALID', message: resources.message ?? 'Um recurso desta rotina não está mais disponível.' }
      return undefined
    } catch (error) {
      return { code: error instanceof HostError ? error.code : 'ROUTINE_TARGET_INVALID', message: 'Não foi possível confirmar a autorização desta execução.' }
    }
  }

  /** The parcel this occurrence reserved. A continuation uses what is left of it, never more. */
  budgetCeiling(turnId: string): { activeMs: number; maxTools: number } | undefined {
    const execution = this.deps.routines.executionByTurn(turnId)
    if (!execution) return undefined
    const root = this.deps.routines.executionsOf(execution.occurrenceId).find((candidate) => candidate.reservedActions > 0)
    if (!root) return undefined
    return { activeMs: root.reservedActiveMs, maxTools: root.reservedActions }
  }

  // ---------------------------------------------------------- ContinuationScope after takeover

  resolve(interruptedTurnId: string) {
    const execution = this.deps.routines.executionByTurn(interruptedTurnId)
    if (!execution) return undefined
    const routine = this.deps.routines.routine(execution.routineId)
    const target = this.deps.authority.describe(routine.spec.target)
    const ceiling = this.deps.authority.effectiveCeiling(routine.spec.ceiling, target.ceiling)
    return { conversationId: execution.conversationId, instructions: this.instructions(routine), permissionMode: ceiling.permissionMode }
  }
  record(input: { interruptedTurnId: string; turn: BotTurn; operationId: string; limits: TurnSnapshot['limits'] }) {
    const previous = this.deps.routines.executionByTurn(input.interruptedTurnId)
    if (!previous) return
    // Same occurrence, same budget: a takeover never grants a fresh standalone allowance.
    this.deps.routines.saveExecution({
      id: randomUUID(),
      occurrenceId: previous.occurrenceId,
      routineId: previous.routineId,
      turnId: input.turn.id,
      continuationOfTurnId: input.interruptedTurnId,
      conversationId: input.turn.conversationId,
      reservedActiveMs: 0,
      reservedActions: 0,
      settled: false,
      createdAt: now(),
      updatedAt: now(),
    })
    const occurrence = this.deps.routines.occurrence(previous.occurrenceId)
    if (ROUTINE_OCCURRENCE_TERMINAL.has(occurrence.status)) return
    this.deps.routines.saveOccurrence({ ...occurrence, status: 'running', causeCode: undefined, attention: undefined, revision: occurrence.revision + 1, updatedAt: now() })
  }

  /** A person returned the desktop without continuing: the occurrence ends honestly. */
  handoffReturned(input: { interruptedTurnId?: string; continuationTurnId?: string; failureCode?: string }) {
    if (!input.interruptedTurnId) return
    const execution = this.deps.routines.executionByTurn(input.interruptedTurnId)
    if (!execution) return
    if (input.continuationTurnId) return
    const occurrence = this.deps.routines.occurrence(execution.occurrenceId)
    if (ROUTINE_OCCURRENCE_TERMINAL.has(occurrence.status)) return
    this.deps.routines.transaction(() =>
      this.deps.routines.saveOccurrence({
        ...this.deps.routines.occurrence(occurrence.id),
        status: 'failed',
        causeCode: 'HUMAN_TAKEOVER',
        attention: 'Você assumiu esta execução e devolveu o controle sem retomá-la; ela foi encerrada.',
        finishedAt: now(),
        revision: occurrence.revision + 1,
        updatedAt: now(),
      })
    )
    this.deps.event({
      routineId: occurrence.routineId,
      occurrenceId: occurrence.id,
      kind: 'occurrence.status',
      summary: 'A execução foi encerrada por você',
      causeCode: 'HUMAN_TAKEOVER',
      detail: { status: 'failed', ...(input.failureCode ? { code: input.failureCode } : {}) },
    })
  }

  /**
   * Stops one occurrence. Before any dispatch this is local and transactional; after it, the
   * existing cancellation and reconciliation paths decide, and an uncertain result keeps its
   * reservation and asks for attention instead of being declared finished.
   */
  async cancel(occurrenceId: string, reason: string, causeCode: RoutineCauseCode = 'STOPPED_BY_USER') {
    const occurrence = this.deps.routines.occurrence(occurrenceId)
    if (ROUTINE_OCCURRENCE_TERMINAL.has(occurrence.status)) return occurrence
    const executions = this.deps.routines.executionsOf(occurrenceId).filter((execution) => !execution.settled)
    if (!executions.length) {
      this.deps.routines.transaction(() =>
        this.deps.routines.saveOccurrence({
          ...this.deps.routines.occurrence(occurrenceId),
          status: 'cancelled',
          causeCode,
          finishedAt: now(),
          usedActiveMs: 0,
          usedActions: 0,
          revision: occurrence.revision + 1,
          updatedAt: now(),
        })
      )
      this.deps.event({ routineId: occurrence.routineId, occurrenceId, kind: 'occurrence.status', summary: reason, causeCode, detail: { status: 'cancelled' } })
      return this.deps.routines.occurrence(occurrenceId)
    }
    for (const execution of executions) {
      if (execution.teamRunId) {
        const run = this.deps.teams.run(execution.teamRunId)
        if (!TEAM_RUN_TERMINAL.has(run.status)) await this.deps.teamService().scheduler.cancel(run.id, run.revision).catch(() => {})
        continue
      }
      if (!execution.turnId) continue
      const turn = this.deps.bots.turn(execution.turnId)
      if (TURN_TERMINAL.has(turn.status)) {
        this.settleTurn(execution, turn)
        continue
      }
      await this.deps.coordinator.requestCancel(turn.botId, turn.id, reason).catch(() => {})
    }
    return this.deps.routines.occurrence(occurrenceId)
  }

  /**
   * Conservative recovery after a restart: apply results that are already terminal and leave
   * anything still uncertain to the coordinator's own reconciliation. No turn and no run is
   * ever recreated to replace an uncertain one.
   */
  recover() {
    for (const occurrence of this.deps.routines.activeOccurrences())
      for (const execution of this.deps.routines.executionsOf(occurrence.id)) {
        if (execution.settled) continue
        try {
          if (execution.turnId) {
            const turn = this.deps.bots.turn(execution.turnId)
            if (TURN_TERMINAL.has(turn.status)) this.settleTurn(execution, turn)
          } else if (execution.teamRunId) this.runChanged(execution.teamRunId)
        } catch {
          /* a missing turn or run is reconciled by the domain that owns it */
        }
      }
  }
}
