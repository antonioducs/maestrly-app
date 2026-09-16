import { randomUUID } from 'node:crypto'
import {
  TEAM_LIMITS,
  TEAM_RUN_TERMINAL,
  TEAM_TASK_ACTIVE,
  TEAM_TASK_TERMINAL,
  TURN_TERMINAL,
  type BotTurn,
  type DelegatedTask,
  type TeamArtifactRef,
  type TeamEvent,
  type TeamMessage,
  type TeamRun,
  type TeamTask,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository } from '../bots/repository.js'
import type { RuntimeCoordinator } from '../bots/runtime-coordinator.js'
import type { TeamAccess } from './access.js'
import type { TeamArtifacts } from './artifacts.js'
import type { TeamBudgets } from './budgets.js'
import { dependencyState, runOutcome, taskStatusForTurn, validateBatch } from './reducer.js'
import { type TeamRepository, now } from './repository.js'
import type { TeamSharing } from './sharing.js'
import type { TeamTurnAdapter } from './turn-adapter.js'

export interface TeamSchedulerDeps {
  teams: TeamRepository
  bots: BotRepository
  access: TeamAccess
  adapter: TeamTurnAdapter
  budgets: TeamBudgets
  sharing: TeamSharing
  artifacts: TeamArtifacts
  coordinator: RuntimeCoordinator
  /** Global collaboration slots across every team of this Host. */
  concurrency?: number
  tickMs?: number
}

const coordinatorKey = (round: number) => `coord-${round}`

/**
 * Durable coordination of team work. Nothing is driven by a timer in the application: the
 * Host wakes on durable events, admits at most one task per bot and at most a few tasks
 * across all teams, and reconciles periodically so a lost callback cannot strand a run.
 * The scheduler never polls a provider in a loop to look busy.
 */
export class TeamScheduler {
  private timer?: ReturnType<typeof setInterval>
  private ticking = false
  private again = false
  private closed = false
  /** Rotating cursor so one busy team cannot starve the others. */
  private lastDispatch = new Map<string, number>()
  private sequence = 0
  constructor(private readonly deps: TeamSchedulerDeps) {}

  start() {
    this.timer ??= setInterval(() => void this.tick().catch(() => {}), this.deps.tickMs ?? 5_000)
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

  event(input: Omit<TeamEvent, 'seq' | 'createdAt'>): TeamEvent {
    return this.deps.teams.appendEvent({ ...input, createdAt: now() })
  }

  /**
   * Conservative recovery: rebuild from runs, tasks, attempts and the outbox. An attempt
   * whose turn already reached a terminal state is applied once; an attempt whose turn is
   * still uncertain is left to the runtime coordinator's own reconciliation. No turn is
   * ever recreated to replace an uncertain result.
   */
  recover() {
    for (const run of this.deps.teams.activeRuns()) {
      for (const attempt of this.deps.teams.attemptsOfRun(run.id)) {
        if (attempt.settled) continue
        const turn = this.deps.bots.turn(attempt.turnId)
        if (TURN_TERMINAL.has(turn.status)) this.settle(turn)
      }
    }
  }

  /**
   * A person returned the desktop. Continuing keeps the same task, run and budget (the
   * adapter already recorded the new attempt); not continuing ends the task explicitly, so
   * the team reports a partial result instead of waiting forever for a paused member.
   */
  handoffReturned(input: { interruptedTurnId?: string; continuationTurnId?: string; failureCode?: string }) {
    if (!input.interruptedTurnId) return
    const attempt = this.deps.teams.attemptByTurn(input.interruptedTurnId)
    if (!attempt) return
    if (input.continuationTurnId) {
      this.kick()
      return
    }
    const task = this.deps.teams.task(attempt.taskId)
    if (TEAM_TASK_TERMINAL.has(task.status)) return
    this.deps.teams.transaction(() =>
      this.deps.teams.saveTask({
        ...this.deps.teams.task(task.id),
        status: 'failed',
        error: {
          code: input.failureCode ?? 'HUMAN_TAKEOVER',
          message: 'Você assumiu esta tarefa e devolveu o controle sem retomá-la; ela foi encerrada.',
        },
        revision: task.revision + 1,
        updatedAt: now(),
      })
    )
    this.event({
      teamId: task.teamId,
      runId: task.runId,
      taskId: task.id,
      botId: task.assigneeBotId,
      kind: 'task.status',
      summary: `A tarefa de ${this.name(task.assigneeBotId)} foi encerrada por você`,
      detail: { status: 'failed', ...(input.failureCode ? { code: input.failureCode } : {}) },
    })
    this.advance(this.deps.teams.run(task.runId))
    this.kick()
  }

  /** Called by the runtime coordinator whenever a turn changes state. */
  applyTurnEvent(turnId: string) {
    const attempt = this.deps.teams.attemptByTurn(turnId)
    if (!attempt) return
    const turn = this.deps.bots.turn(turnId)
    if (!TURN_TERMINAL.has(turn.status)) {
      this.mirrorWaiting(attempt.taskId, turn)
      return
    }
    this.settle(turn)
    this.kick()
  }

  /** Approval and question waits are shown on the team task, with the member's own name. */
  private mirrorWaiting(taskId: string, turn: BotTurn) {
    const task = this.deps.teams.task(taskId)
    const status = turn.status === 'waiting_approval' ? 'waiting_approval' : turn.status === 'waiting_input' ? 'waiting_input' : 'running'
    if (task.status === status || TEAM_TASK_TERMINAL.has(task.status)) return
    this.deps.teams.transaction(() => this.deps.teams.saveTask({ ...task, status, revision: task.revision + 1, updatedAt: now() }))
    // The whole work is blocked on the person, so it must say so instead of reporting that the
    // members are working: someone watching the team would wait for a bot that is waiting for them.
    const run = this.deps.teams.run(task.runId)
    if (status !== 'running' && ['planning', 'working', 'reviewing'].includes(run.status)) this.setStatus(run, 'waiting_user')
    else if (status === 'running' && run.status === 'waiting_user' && !this.deps.teams.tasks(run.id).some((other) => other.id !== task.id && (other.status === 'waiting_approval' || other.status === 'waiting_input')))
      this.setStatus(run, this.busyStatus(run))
    this.event({
      teamId: task.teamId,
      runId: task.runId,
      taskId: task.id,
      botId: task.assigneeBotId,
      kind: status === 'waiting_approval' ? 'approval.requested' : status === 'waiting_input' ? 'question.asked' : 'task.status',
      summary:
        status === 'waiting_approval'
          ? `${this.name(task.assigneeBotId)} precisa da sua permissão`
          : status === 'waiting_input'
            ? `${this.name(task.assigneeBotId)} fez uma pergunta`
            : `${this.name(task.assigneeBotId)} começou a trabalhar`,
      detail: { status },
    })
  }

  /** What the work is doing when nobody is waiting on a person, derived from its own tasks. */
  private busyStatus(run: TeamRun): TeamRun['status'] {
    const tasks = this.deps.teams.tasks(run.id).filter((task) => TEAM_TASK_ACTIVE.has(task.status))
    if (tasks.some((task) => task.kind === 'work')) return 'working'
    return run.round === 0 ? 'planning' : 'reviewing'
  }
  private name(botId: string) {
    try {
      return this.deps.bots.bot(botId).name
    } catch {
      return 'membro'
    }
  }

  /** Settles one attempt exactly once: budget, task state, result and recorded artifacts. */
  private settle(turn: BotTurn) {
    const attempt = this.deps.teams.attemptByTurn(turn.id)
    if (!attempt || attempt.settled) return
    const decision = taskStatusForTurn(turn)
    const summary = this.answerOf(turn)
    const settled = this.deps.teams.transaction(() => {
      const current = this.deps.teams.attemptByTurn(turn.id)!
      if (current.settled) return undefined
      const run = this.deps.teams.run(current.runId)
      const task = this.deps.teams.task(current.taskId)
      this.deps.teams.saveAttempt({ ...current, settled: true, settledAs: turn.status, updatedAt: now() })
      this.deps.teams.saveRun({ ...run, budget: this.deps.budgets.settle(run, current, turn), revision: run.revision + 1, updatedAt: now() })
      if (TEAM_TASK_TERMINAL.has(task.status)) return { task, run }
      const artifacts: TeamArtifactRef[] = this.deps.teams
        .artifacts(task.teamId)
        .filter((artifact) => artifact.taskId === task.id)
        .map((artifact) => ({ artifactId: artifact.id, name: artifact.name, size: artifact.size, digest: artifact.digest, version: artifact.version }))
      this.deps.teams.saveTask({
        ...task,
        status: decision.status,
        ...(decision.error ? { error: decision.error } : {}),
        ...(decision.status === 'succeeded' && summary ? { result: { summary, artifacts, turnId: turn.id, completedAt: now() } } : {}),
        revision: task.revision + 1,
        updatedAt: now(),
      })
      return { task: this.deps.teams.task(task.id), run: this.deps.teams.run(run.id) }
    })
    if (!settled) return
    this.event({
      teamId: settled.task.teamId,
      runId: settled.task.runId,
      taskId: settled.task.id,
      botId: settled.task.assigneeBotId,
      kind: 'task.status',
      summary:
        decision.status === 'succeeded'
          ? `${this.name(settled.task.assigneeBotId)} concluiu sua parte`
          : decision.status === 'paused_human'
            ? `${this.name(settled.task.assigneeBotId)} está sob seu controle`
            : `${this.name(settled.task.assigneeBotId)} não conseguiu concluir`,
      detail: { status: decision.status, ...(decision.error ? { code: decision.error.code } : {}) },
    })
    this.advance(this.deps.teams.run(settled.run.id))
  }

  /** The member's own final text, read from the thread that belongs to that turn. */
  private answerOf(turn: BotTurn): string {
    const messages = this.deps.bots.messages(turn.conversationId, undefined, 40)
    const reply = [...messages].reverse().find((message) => message.turnId === turn.id && message.role === 'assistant')
    return reply?.content.slice(0, 16 * 1024) ?? ''
  }

  /**
   * Accepts a whole delegation batch atomically. The tasks are recorded as the coordinator's
   * intent and only become eligible once its planning turn ends successfully: keeping the
   * coordinator's call waiting for a child would occupy its only slot and deadlock.
   */
  submitBatch(input: { turnId: string; botId: string; tasks: readonly DelegatedTask[] }) {
    const origin = this.deps.access.origin(input.turnId, input.botId)
    this.deps.access.assertCanDelegate(origin)
    return this.deps.teams.transaction(() => {
      const run = this.deps.teams.run(origin.run.id)
      const round = run.round + 1
      const existing = this.deps.teams.tasks(run.id).filter((task) => task.round === round)
      if (existing.length) throw new HostError('TEAM_STAGE_INVALID', 'Este lote já foi registrado; consulte o recibo em vez de enviar de novo')
      const assignable = new Set(run.roster.filter((entry) => !entry.coordinator).map((entry) => entry.botId))
      const knownArtifacts = new Set([
        ...run.resources.map((resource) => resource.artifactId),
        ...this.deps.teams.artifacts(run.teamId).map((artifact) => artifact.id),
      ])
      const used = this.deps.teams.tasks(run.id).filter((task) => task.kind === 'work').length
      const ordered = validateBatch({
        tasks: input.tasks,
        coordinatorBotId: run.coordinatorBotId,
        assignable,
        availableTasks: Math.min(run.limits.maxTasks - used, TEAM_LIMITS.tasksPerBatchMax),
        knownArtifacts,
      })
      const byKey = new Map<string, string>()
      const accepted = ordered.map((task) => {
        const id = randomUUID()
        byKey.set(task.localKey, id)
        return { task, id }
      })
      for (const { task, id } of accepted) {
        const member = this.deps.access.member(run.teamId, task.assigneeBotId)
        this.deps.teams.saveTask({
          id,
          runId: run.id,
          teamId: run.teamId,
          round,
          localKey: task.localKey,
          kind: 'work',
          assigneeBotId: task.assigneeBotId,
          memberId: member.id,
          goal: task.goal,
          acceptanceCriteria: task.acceptanceCriteria,
          dependsOn: task.dependsOn.map((key) => byKey.get(key)!),
          inputArtifactIds: task.inputArtifactIds,
          useDependencyOutputs: task.useDependencyOutputs,
          origin: 'coordinator',
          status: 'planned',
          attempts: 0,
          revision: 0,
          createdAt: now(),
          updatedAt: now(),
        })
      }
      const receiptId = randomUUID()
      this.event({
        teamId: run.teamId,
        runId: run.id,
        botId: run.coordinatorBotId,
        kind: 'delegation.submitted',
        summary: `${this.name(run.coordinatorBotId)} distribuiu ${accepted.length} tarefa(s)`,
        detail: { receiptId, round, tasks: accepted.map(({ task, id }) => ({ localKey: task.localKey, taskId: id, assigneeBotId: task.assigneeBotId })) },
      })
      return {
        receiptId,
        round,
        accepted: accepted.map(({ task, id }) => ({ localKey: task.localKey, taskId: id, assigneeBotId: task.assigneeBotId })),
      }
    })
  }

  private orderedRuns(): TeamRun[] {
    return this.deps.teams
      .activeRuns()
      .sort((a, b) => (this.lastDispatch.get(a.id) ?? 0) - (this.lastDispatch.get(b.id) ?? 0))
  }

  async tick() {
    if (this.closed) return
    if (this.ticking) {
      this.again = true
      return
    }
    this.ticking = true
    try {
      do {
        this.again = false
        for (const run of this.orderedRuns()) this.advance(this.deps.teams.run(run.id))
        for (const run of this.orderedRuns()) {
          if (TEAM_RUN_TERMINAL.has(run.status)) continue
          await this.dispatchRun(this.deps.teams.run(run.id))
        }
      } while (this.again && !this.closed)
    } finally {
      this.ticking = false
    }
  }

  /** Global slots and per-team concurrency are checked before any effect is attempted. */
  private async dispatchRun(run: TeamRun) {
    if (run.status === 'cancelling' || TEAM_RUN_TERMINAL.has(run.status)) return
    const limit = this.deps.concurrency ?? TEAM_LIMITS.globalConcurrency
    for (const candidate of this.deps.teams.tasks(run.id)) {
      // Re-read on every iteration: the previous dispatch already took a slot.
      const tasks = this.deps.teams.tasks(run.id)
      const task = tasks.find((current) => current.id === candidate.id)!
      if (task.status !== 'planned' || task.round > run.round) continue
      if (this.deps.teams.activeTaskCount() >= limit) return
      if (tasks.filter((other) => TEAM_TASK_ACTIVE.has(other.status)).length >= run.limits.concurrency) return
      const state = dependencyState(task, new Map(tasks.map((entry) => [entry.id, entry])))
      if (state === 'waiting') continue
      if (state === 'blocked') {
        this.skip(task, 'Uma tarefa da qual esta dependia não foi concluída.')
        continue
      }
      await this.dispatch(run, task)
    }
  }

  private skip(task: TeamTask, reason: string) {
    this.deps.teams.transaction(() =>
      this.deps.teams.saveTask({ ...task, status: 'skipped', error: { code: 'TEAM_DEPENDENCY_INVALID', message: reason }, revision: task.revision + 1, updatedAt: now() })
    )
    this.event({ teamId: task.teamId, runId: task.runId, taskId: task.id, botId: task.assigneeBotId, kind: 'task.status', summary: reason, detail: { status: 'skipped' } })
    this.again = true
  }

  /**
   * Pre-admission, staging and the turn all follow the same durable intent. Membership,
   * grants, account and desktop hold are revalidated here and again immediately before the
   * wire write, so a permission that was reduced in between blocks the old outbox item.
   */
  private async dispatch(run: TeamRun, task: TeamTask) {
    const blocked = this.preAdmit(run, task)
    if (blocked) {
      if (blocked !== 'wait') this.attention(task, blocked)
      return
    }
    this.deps.teams.transaction(() => this.deps.teams.saveTask({ ...this.deps.teams.task(task.id), status: 'staging', revision: task.revision + 1, updatedAt: now() }))
    try {
      const inputs = this.deps.sharing.inputsFor(run, task)
      if (inputs.length) {
        this.deps.sharing.authorize(run, task, inputs)
        const staged = await this.deps.sharing.stage(run, task)
        if (staged.failed) {
          // A graphical session starts on demand and takes a while: a transport failure here
          // means "not yet", not "never". Asking a person to act would be wrong, so the task
          // goes back to the queue and is retried a bounded number of times before giving up.
          const current = this.deps.teams.task(task.id)
          if (TRANSIENT_DELIVERY.has(staged.failed.code) && current.attempts < TEAM_STAGING_ATTEMPTS) {
            this.deps.teams.transaction(() =>
              this.deps.teams.saveTask({ ...current, status: 'planned', attempts: current.attempts + 1, revision: current.revision + 1, updatedAt: now() })
            )
            return
          }
          // The stable code travels with the message: a failure that only says "it did not work"
          // leaves the person — and whoever supports them — with no next step at all.
          this.attention(current, deliveryReason(staged.failed.code), { code: staged.failed.code, artifactId: staged.failed.artifactId })
          return
        }
      }
      // Anything may have changed while files moved; revalidate before taking the slot.
      const recheck = this.preAdmit(this.deps.teams.run(run.id), this.deps.teams.task(task.id))
      if (recheck) {
        this.deps.teams.transaction(() => this.deps.teams.saveTask({ ...this.deps.teams.task(task.id), status: 'planned', revision: task.revision + 2, updatedAt: now() }))
        if (recheck !== 'wait') this.attention(this.deps.teams.task(task.id), recheck)
        return
      }
      const result = this.deps.adapter.enqueue(this.deps.teams.run(run.id), this.deps.teams.task(task.id))
      this.lastDispatch.set(run.id, ++this.sequence)
      this.event({
        teamId: run.teamId,
        runId: run.id,
        taskId: task.id,
        botId: task.assigneeBotId,
        kind: 'task.status',
        summary: `${this.name(task.assigneeBotId)} começou a trabalhar`,
        detail: { status: 'running', turnId: result.turn.id },
      })
      this.deps.coordinator.kick(task.assigneeBotId)
    } catch (error) {
      const code = error instanceof HostError ? error.code : 'TEAM_DISPATCH_FAILED'
      const message = error instanceof HostError ? error.message : 'Não foi possível iniciar esta tarefa agora.'
      const current = this.deps.teams.task(task.id)
      const retry = TRANSIENT_DELIVERY.has(code) && current.attempts < TEAM_STAGING_ATTEMPTS
      this.deps.teams.transaction(() =>
        this.deps.teams.saveTask({ ...current, status: 'planned', ...(retry ? { attempts: current.attempts + 1 } : {}), revision: current.revision + 1, updatedAt: now() })
      )
      // A busy bot simply waits its turn; it is not an error and never interrupts its work.
      // A computer still waking up is the same kind of "not yet" and is retried, not reported.
      if (code === 'BOT_BUSY' || code === 'BOT_PAUSED_BY_USER' || retry) return
      this.attention(this.deps.teams.task(task.id), message, { code })
    }
  }

  /** Returns a human explanation when the task cannot start, or 'wait' when it should retry. */
  private preAdmit(run: TeamRun, task: TeamTask): string | 'wait' | undefined {
    if (run.status === 'cancelling' || TEAM_RUN_TERMINAL.has(run.status)) return 'wait'
    const team = this.deps.teams.team(run.teamId)
    if (team.status === 'archived') return 'A equipe foi arquivada.'
    const member = this.deps.teams.member(run.teamId, task.assigneeBotId)
    if (!member?.active) return 'Este bot não participa mais da equipe.'
    if (member.grantRevision !== run.memberGrantRevision) return 'A composição da equipe mudou durante o trabalho.'
    if (this.deps.coordinator.held(task.assigneeBotId)) return 'wait'
    const bot = this.deps.bots.bot(task.assigneeBotId)
    if (bot.status === 'archived') return 'Este bot foi arquivado.'
    if (bot.accountState !== 'connected') return 'A conta de IA deste bot está desconectada.'
    if (this.deps.bots.activeTurn(bot.id)) return 'wait'
    return undefined
  }

  private attention(task: TeamTask, message: string, detail: Record<string, unknown> = {}) {
    this.deps.teams.transaction(() => {
      const current = this.deps.teams.task(task.id)
      if (TEAM_TASK_TERMINAL.has(current.status)) return
      this.deps.teams.saveTask({ ...current, status: 'needs_attention', attention: message, revision: current.revision + 1, updatedAt: now() })
    })
    this.event({ teamId: task.teamId, runId: task.runId, taskId: task.id, botId: task.assigneeBotId, kind: 'attention', summary: message, detail: { status: 'needs_attention', ...detail } })
  }

  /**
   * Moves a run forward from durable facts only: release a validated batch once planning
   * succeeded, open the next coordination round once a batch finished, or finish exactly
   * once with a result that distinguishes done, failed and waiting for a person.
   */
  advance(run: TeamRun) {
    if (TEAM_RUN_TERMINAL.has(run.status)) return
    const tasks = this.deps.teams.tasks(run.id)
    const active = tasks.filter((task) => TEAM_TASK_ACTIVE.has(task.status))
    if (run.status === 'cancelling') {
      // A task with nothing left running cannot stop by itself. Ending it here also recovers a
      // Host that restarted mid-cancellation, which would otherwise wait for it forever.
      const pending = active.filter((task) => this.stoppable(task))
      for (const task of active.filter((task) => !this.stoppable(task))) this.endUnstarted(task)
      if (!pending.length) this.finish(run, 'cancelled', run.summary ?? '', 'Trabalho interrompido por você.')
      return
    }
    const coordination = tasks.find((task) => task.localKey === coordinatorKey(run.round) && task.kind !== 'work')
    // No coordination turn for this round yet: it opens once the batch of this round ends.
    if (!coordination) {
      this.openNextRound(run)
      return
    }
    if (!TEAM_TASK_TERMINAL.has(coordination.status)) {
      if (coordination.status === 'paused_human' && run.status !== 'paused') this.setStatus(run, 'paused')
      return
    }
    if (coordination.status === 'succeeded') {
      const batch = tasks.filter((task) => task.round === run.round + 1)
      if (batch.length) {
        // The batch becomes eligible only now: the planning turn ended and released its slot.
        this.setStatus(this.deps.teams.run(run.id), 'working', {
          round: run.round + 1,
          budget: { ...run.budget, rounds: run.budget.rounds + 1, tasks: run.budget.tasks + batch.length },
        })
        this.again = true
        return
      }
      const workers = tasks.filter((task) => task.kind === 'work')
      this.finish(run, runOutcome(workers, !!coordination.result?.summary), coordination.result?.summary ?? '')
      return
    }
    if (coordination.status === 'paused_human') {
      if (run.status !== 'paused') this.setStatus(run, 'paused')
      return
    }
    // The coordination turn did not finish: the run ends honestly instead of hanging.
    const workers = tasks.filter((task) => task.kind === 'work')
    const delivered = workers.filter((task) => task.status === 'succeeded')
    this.finish(
      run,
      delivered.length ? 'partial' : coordination.status === 'cancelled' ? 'cancelled' : 'failed',
      delivered.map((task) => `**${this.name(task.assigneeBotId)}**\n${task.result?.summary ?? ''}`).join('\n\n'),
      coordination.error?.message ?? 'A coordenação do trabalho não pôde ser concluída.'
    )
  }

  /** Opens the next coordination turn once every task of the current round is finished. */
  openNextRound(run: TeamRun) {
    const tasks = this.deps.teams.tasks(run.id)
    const batch = tasks.filter((task) => task.round === run.round && task.kind === 'work')
    if (!batch.length || batch.some((task) => !TEAM_TASK_TERMINAL.has(task.status))) return
    if (tasks.some((task) => task.localKey === coordinatorKey(run.round) && task.kind !== 'work')) return
    if (!this.deps.budgets.canConsolidate(run)) {
      const delivered = batch.filter((task) => task.status === 'succeeded')
      this.finish(
        run,
        delivered.length ? 'partial' : 'failed',
        delivered.map((task) => `**${this.name(task.assigneeBotId)}**\n${task.result?.summary ?? ''}`).join('\n\n'),
        'O limite de trabalho desta equipe foi atingido antes da consolidação.'
      )
      return
    }
    const message = this.deps.teams.messageById(this.deps.teams.run(run.id).messageId)
    const member = this.deps.access.member(run.teamId, run.coordinatorBotId)
    this.deps.teams.transaction(() => {
      this.deps.teams.saveTask({
        id: randomUUID(),
        runId: run.id,
        teamId: run.teamId,
        round: run.round,
        localKey: coordinatorKey(run.round),
        kind: run.budget.rounds < run.limits.maxRounds ? 'planning' : 'consolidation',
        assigneeBotId: run.coordinatorBotId,
        memberId: member.id,
        goal: message.content,
        acceptanceCriteria: '',
        dependsOn: batch.map((task) => task.id).filter((id) => this.deps.teams.task(id).status === 'succeeded'),
        inputArtifactIds: [],
        useDependencyOutputs: true,
        origin: 'system',
        status: 'planned',
        attempts: 0,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      })
      this.setStatus(this.deps.teams.run(run.id), 'reviewing')
    })
    this.again = true
  }

  private setStatus(run: TeamRun, status: TeamRun['status'], patch: Partial<TeamRun> = {}) {
    this.deps.teams.transaction(() => {
      const current = this.deps.teams.run(run.id)
      if (TEAM_RUN_TERMINAL.has(current.status)) return
      this.deps.teams.saveRun({ ...current, ...patch, status, revision: current.revision + 1, updatedAt: now() })
    })
    this.event({ teamId: run.teamId, runId: run.id, kind: 'run.status', summary: this.runSummary(status), detail: { status } })
  }
  private runSummary(status: TeamRun['status']) {
    const labels: Partial<Record<TeamRun['status'], string>> = {
      planning: 'A equipe está organizando o trabalho',
      working: 'Os membros estão trabalhando',
      reviewing: 'A equipe está juntando os resultados',
      waiting_user: 'A equipe está esperando a sua resposta',
      paused: 'O trabalho está pausado enquanto você usa a tela',
      cancelling: 'Parando o trabalho da equipe…',
      succeeded: 'A equipe concluiu o trabalho',
      partial: 'A equipe concluiu parte do trabalho',
      failed: 'A equipe não conseguiu concluir o trabalho',
      cancelled: 'Trabalho interrompido',
      needs_attention: 'O trabalho precisa da sua atenção',
    }
    return labels[status] ?? status
  }

  /** Exactly one final answer per run, written by the Host from recorded results. */
  private finish(run: TeamRun, status: TeamRun['status'], summary: string, notice?: string) {
    const finished = this.deps.teams.transaction(() => {
      const current = this.deps.teams.run(run.id)
      if (TEAM_RUN_TERMINAL.has(current.status)) return undefined
      const tasks = this.deps.teams.tasks(current.id)
      const artifacts = tasks.flatMap((task) => task.result?.artifacts ?? [])
      const conversation = this.deps.teams.conversation(current.conversationId)
      const sequence = conversation.lastSequence + 1
      const content = [summary, notice ? `\n\n_${notice}_` : ''].join('').trim() || notice || 'A equipe não produziu um resultado.'
      const message: TeamMessage = {
        id: randomUUID(),
        conversationId: conversation.id,
        clientMessageId: `run-final:${current.id}`,
        author: { kind: 'bot', botId: current.coordinatorBotId, name: this.name(current.coordinatorBotId) },
        kind: 'answer',
        content: content.slice(0, 64 * 1024),
        runId: current.id,
        sequence,
        artifacts: artifacts.slice(0, 16),
        createdAt: now(),
      }
      this.deps.teams.saveMessage(message)
      const updated: TeamRun = { ...current, status, summary: summary.slice(0, 16 * 1024), finishedAt: now(), revision: current.revision + 1, updatedAt: now() }
      this.deps.teams.saveRun(updated)
      this.deps.teams.saveConversation({ ...conversation, activeRunId: undefined, lastSequence: sequence, revision: conversation.revision + 1, updatedAt: now() })
      return updated
    })
    if (!finished) return
    this.event({ teamId: finished.teamId, runId: finished.id, kind: 'run.status', summary: this.runSummary(status), detail: { status, tasks: this.deps.teams.tasks(finished.id).length } })
  }

  /** The attempt that may still be running for this task, if the Host ever started one. */
  private unsettled(task: TeamTask) {
    return [...this.deps.teams.attempts(task.id)].reverse().find((candidate) => !candidate.settled)
  }
  /**
   * A task the Host can still ask a bot to stop: it has a live attempt, and a member a person is
   * driving is already stopped — taking its desktop away to cancel would be a second harm.
   */
  private stoppable(task: TeamTask) {
    return task.status !== 'paused_human' && !!this.unsettled(task)
  }
  /** Ends a task that never produced work, without inventing a result for it. */
  private endUnstarted(task: TeamTask) {
    this.deps.teams.transaction(() =>
      this.deps.teams.saveTask({ ...this.deps.teams.task(task.id), status: 'cancelled', attention: undefined, revision: task.revision + 1, updatedAt: now() })
    )
  }
  /**
   * Stopping a team records the intent first, so no new delegation or admission is accepted,
   * then cancels only the turns of this run. The VM stays on, other bots keep working, and a
   * member that a person is driving keeps its desktop.
   */
  async cancel(runId: string, expectedRevision: number) {
    const run = this.deps.teams.run(runId)
    if (TEAM_RUN_TERMINAL.has(run.status)) return run
    if (run.revision !== expectedRevision) throw new HostError('REVISION_CONFLICT', 'O trabalho mudou; verifique o estado atual antes de parar')
    this.setStatus(run, 'cancelling')
    const tasks = this.deps.teams.tasks(runId)
    for (const task of tasks) {
      if (task.status === 'planned') {
        this.endUnstarted(task)
        continue
      }
      if (!TEAM_TASK_ACTIVE.has(task.status)) continue
      // Nothing left to ask a bot to stop: a paused member is already stopped, and a task that
      // never reached one has no turn at all. Both end here instead of holding the run open.
      if (!this.stoppable(task)) {
        this.endUnstarted(task)
        continue
      }
      const attempt = this.unsettled(task)!
      const turn = this.deps.bots.turn(attempt.turnId)
      if (TURN_TERMINAL.has(turn.status)) {
        this.settle(turn)
        continue
      }
      await this.deps.coordinator.requestCancel(task.assigneeBotId, turn.id, 'A equipe foi parada por você').catch(() => {})
    }
    this.advance(this.deps.teams.run(runId))
    return this.deps.teams.run(runId)
  }
}

/**
 * A computer that is still waking up, a channel that dropped or a request that timed out are all
 * "not yet": the graphical session of a bot starts on demand and is not instantaneous. Asking a
 * person to intervene for these would be wrong, so the Host retries them instead.
 */
export const TRANSIENT_DELIVERY: ReadonlySet<string> = new Set([
  'RUNTIME_UNREACHABLE',
  'RUNTIME_TIMEOUT',
  'RUNTIME_BUSY',
  'RUNTIME_RESTARTED',
  'VM_STOPPED',
  'SESSION_STARTING',
  'TEAM_DISPATCH_FAILED',
])
/**
 * How many times a task may go back to the queue before the person is actually told. Retries are
 * spaced by the scheduler tick, so this is a waiting budget rather than a tight loop: on the
 * measured laboratory a graphical session took around forty seconds to answer after a restart,
 * and this leaves room for a slower one without ever waiting indefinitely.
 */
export const TEAM_STAGING_ATTEMPTS = 24
/** Turns a delivery failure into the next step a person can act on. */
export function deliveryReason(code: string): string {
  switch (code) {
    case 'TEAM_GRANT_REVOKED':
      return 'O acesso a um arquivo compartilhado foi revogado antes da entrega.'
    case 'FILE_EXISTS':
      return 'Já existe um arquivo com este nome no espaço de trabalho deste bot.'
    case 'FILE_CHANGED':
      return 'O arquivo mudou durante a cópia; compartilhe novamente.'
    case 'LIMIT':
      return 'O arquivo compartilhado passou do limite permitido.'
    case 'INVALID_PATH':
      return 'O destino do arquivo compartilhado não é válido neste espaço de trabalho.'
    default:
      return `Não foi possível entregar um arquivo compartilhado a este membro (${code}).`
  }
}
