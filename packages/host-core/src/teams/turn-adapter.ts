import { randomUUID } from 'node:crypto'
import {
  TEAM_CAPABILITY,
  type Bot,
  type BotConversation,
  type BotTurn,
  type TeamRun,
  type TeamTask,
  type TeamTaskAttempt,
  type TurnSnapshot,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository } from '../bots/repository.js'
import { now as botNow } from '../bots/repository.js'
import type { BotTurns, ContinuationScope } from '../bots/turns.js'
import type { RuntimeCoordinator } from '../bots/runtime-coordinator.js'
import { buildTeamContext, effectivePermissionMode, stageOf, teamInstructions } from './context.js'
import type { TeamBudgets, TurnReservation } from './budgets.js'
import { TeamRepository, now } from './repository.js'

/**
 * A run keeps one coordination thread and one thread per worker task. The identifiers are
 * derived so a retry can never create a second thread for the same work, and they are
 * Host-internal: no caller of the public API can name one.
 */
export const coordinationThreadId = (runId: string) => `team:${runId}:coordination`
export const workerThreadId = (taskId: string) => `team:task:${taskId}`

export interface TeamTurnAdapterDeps {
  repo: BotRepository
  teams: TeamRepository
  turns: BotTurns
  coordinator: RuntimeCoordinator
  budgets: TeamBudgets
}

/**
 * Bridges a team task onto the existing turn engine. It reuses the same admission,
 * leases, account delegation, events, files and cancellation; it never becomes a second
 * executor and never parses provider text to guess which task finished.
 */
export class TeamTurnAdapter implements ContinuationScope {
  constructor(private readonly deps: TeamTurnAdapterDeps) {}

  private conversationFor(task: TeamTask, bot: Bot): BotConversation {
    const id = task.kind === 'work' ? workerThreadId(task.id) : coordinationThreadId(task.runId)
    try {
      const existing = this.deps.repo.conversation(id)
      if (existing.botId !== bot.id) throw new HostError('TEAM_MEMBER_INVALID', 'Esta conversa de equipe pertence a outro bot')
      return existing
    } catch (error) {
      if (error instanceof HostError && error.code === 'TEAM_MEMBER_INVALID') throw error
      const created: BotConversation = {
        id,
        botId: bot.id,
        title: '',
        contextRevision: 0,
        lastSequence: 0,
        revision: 0,
        createdAt: botNow(),
        updatedAt: botNow(),
      }
      this.deps.repo.saveConversation(created)
      return created
    }
  }

  /** Context assembled from durable state only; nothing is carried over between turns. */
  private context(run: TeamRun, task: TeamTask) {
    const team = this.deps.teams.team(run.teamId)
    const bots = new Map<string, Bot>()
    for (const entry of run.roster) {
      try {
        bots.set(entry.botId, this.deps.repo.bot(entry.botId))
      } catch {
        /* an archived member keeps its name in the roster snapshot */
      }
    }
    const dependencies = task.dependsOn.map((id) => this.deps.teams.task(id))
    const grants = this.deps.teams
      .grantsOfRun(run.id)
      .filter((grant) => grant.botId === task.assigneeBotId)
      .map((grant) => ({ grant, artifact: this.deps.teams.artifact(grant.artifactId) }))
      .filter(({ artifact }) => artifact.state === 'available')
    const memories = team.policy.shareMemory ? this.deps.teams.memories(team.id, false) : []
    const context = buildTeamContext({ team, run, task, bots, memories, grants, dependencies })
    const bot = this.deps.repo.bot(task.assigneeBotId)
    return {
      team,
      context,
      instructions: teamInstructions({ bot, team, task, role: context.role, stage: stageOf(task) }),
      permissionMode: effectivePermissionMode(team, bot),
    }
  }

  /**
   * Admits one physical turn for a task. Message, turn, outbox, attempt and budget
   * reservation commit in the same transaction; a lost reply is reconciled, never replayed.
   */
  enqueue(run: TeamRun, task: TeamTask): { turn: BotTurn; attempt: TeamTaskAttempt; run: TeamRun } {
    const bot = this.deps.repo.bot(task.assigneeBotId)
    const session = this.deps.coordinator.liveSession(bot.id)
    if (session && !session.capabilities.includes(TEAM_CAPABILITY) && !session.capabilities.includes('teams.collaboration'))
      throw new HostError('TEAM_UPDATE_REQUIRED', 'Atualize o ambiente deste bot para ele trabalhar em equipe.')
    return this.deps.teams.transaction(() => {
      const current = this.deps.teams.run(run.id)
      const { budget, reservation } = this.deps.budgets.reserve(current, task.kind)
      const conversation = this.conversationFor(task, bot)
      const { context, instructions, permissionMode } = this.context(current, task)
      const limits: TurnSnapshot['limits'] = {
        activeMs: reservation.activeMs,
        maxTools: reservation.toolCalls,
        maxLogBytes: 10 * 1024 * 1024,
      }
      const receipt = this.deps.turns.enqueueScopedTurn({
        botId: bot.id,
        conversationId: conversation.id,
        origin: 'team',
        // One admission per task attempt; a retry with the same key returns the same turn.
        clientMessageId: `team:${task.id}:${task.attempts}`,
        content: this.prompt(current, task),
        attachments: [],
        limits,
        instructions,
        team: context,
        permissionMode,
        includePrivateContext: false,
      })
      const attempt: TeamTaskAttempt = {
        id: randomUUID(),
        taskId: task.id,
        runId: run.id,
        botId: bot.id,
        turnId: receipt.turn.id,
        conversationId: conversation.id,
        generation: receipt.turn.generation,
        reservedToolCalls: reservation.toolCalls,
        reservedActiveMs: reservation.activeMs,
        settled: false,
        createdAt: now(),
        updatedAt: now(),
      }
      this.deps.teams.saveAttempt(attempt)
      this.deps.teams.saveTask({ ...task, status: 'running', attempts: task.attempts + 1, attention: undefined, revision: task.revision + 1, updatedAt: now() })
      const updated: TeamRun = { ...current, budget, revision: current.revision + 1, updatedAt: now() }
      this.deps.teams.saveRun(updated)
      return { turn: receipt.turn, attempt, run: updated }
    })
  }

  /** The message the member actually reads. Results arrive as structured context, not chat. */
  private prompt(run: TeamRun, task: TeamTask): string {
    const lines: string[] = []
    if (task.kind === 'planning')
      lines.push(
        'Pedido da pessoa para a equipe:',
        task.goal,
        '',
        'Se precisar de outros membros, envie um único lote com team_delegate e encerre o turno. Se puder responder sozinho, responda agora.'
      )
    else if (task.kind === 'consolidation')
      lines.push('Os membros terminaram. Consolide o resultado para a pessoa a partir dos resultados recebidos.', '', `Pedido original: ${task.goal}`)
    else {
      lines.push(`Tarefa atribuída a você pela equipe ${run.roster.find((entry) => entry.coordinator)?.name ?? 'coordenação'}:`, task.goal)
      if (task.acceptanceCriteria) lines.push('', `Critérios de conclusão: ${task.acceptanceCriteria}`)
    }
    return lines.join('\n').slice(0, 64 * 1024)
  }

  // ContinuationScope: a human takeover resumes the scoped thread, not the private chat.
  resolve(interruptedTurnId: string) {
    const attempt = this.deps.teams.attemptByTurn(interruptedTurnId)
    if (!attempt) return undefined
    const run = this.deps.teams.run(attempt.runId)
    const task = this.deps.teams.task(attempt.taskId)
    const { context, instructions, permissionMode } = this.context(run, task)
    return { conversationId: attempt.conversationId, instructions, team: context, permissionMode }
  }
  record(input: { interruptedTurnId: string; turn: BotTurn; operationId: string; limits: TurnSnapshot['limits'] }) {
    const previous = this.deps.teams.attemptByTurn(input.interruptedTurnId)
    if (!previous) return
    // The continuation reuses the original reservation: no new parcel is taken.
    this.deps.teams.saveAttempt({
      id: randomUUID(),
      taskId: previous.taskId,
      runId: previous.runId,
      botId: previous.botId,
      turnId: input.turn.id,
      conversationId: input.turn.conversationId,
      generation: input.turn.generation,
      continuationOfTurnId: input.interruptedTurnId,
      handoffOperationId: input.operationId,
      reservedToolCalls: 0,
      reservedActiveMs: 0,
      settled: false,
      createdAt: now(),
      updatedAt: now(),
    })
    const task = this.deps.teams.task(previous.taskId)
    this.deps.teams.saveTask({ ...task, status: 'running', attention: undefined, revision: task.revision + 1, updatedAt: now() })
  }
}
