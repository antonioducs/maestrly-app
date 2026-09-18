import { randomUUID } from 'node:crypto'
import {
  ROUTINE_LIMITS,
  TURN_TERMINAL,
  routineParamSchemas,
  routineProposalSchema,
  scheduleSpecSchema,
  type RoutineProposal,
  type RoutineTurnContext,
  type ScheduleSpec,
  type TargetRef,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository } from '../bots/repository.js'
import type { TeamRepository } from '../teams/repository.js'
import type { RoutineAuthority } from './authority.js'
import { describeSchedule, localReading, type Clock, systemClock } from './calendar.js'
import { routineThreadId } from './execution-adapter.js'
import { type RoutineRepository, now } from './repository.js'

export interface RoutineProposalsDeps {
  routines: RoutineRepository
  bots: BotRepository
  teams: TeamRepository
  authority: RoutineAuthority
  clock?: Clock
}

/**
 * Suggestions a model may leave for a person. Everything here is inert by construction: a
 * proposal holds no schedule slot, reserves no budget, cannot be activated by the model that
 * wrote it, and is not even readable as an instruction by the engine — only a person turning
 * it into a preview and confirming that preview creates a routine.
 *
 * Who may propose is decided from the authenticated session and the durable turn, never from
 * the payload. In particular, a scheduled occurrence, a delegated worker and a continuation
 * after a takeover may not propose at all: otherwise a routine could quietly breed routines.
 */
export class RoutineProposals {
  private readonly clock: Clock
  constructor(private readonly deps: RoutineProposalsDeps) {
    this.clock = deps.clock ?? systemClock
  }

  /**
   * Resolves what this turn is allowed to propose for. The bot comes from the session; the
   * target comes from the conversation the turn belongs to.
   */
  scopeOf(botId: string, turnId: string, generation?: number): { target: TargetRef } {
    const turn = this.deps.bots.turn(turnId)
    if (turn.botId !== botId) throw new HostError('ROUTINE_PROPOSAL_FORBIDDEN', 'Esta execução não pertence a este bot')
    // A frame from a superseded attempt is refused outright, never applied to the live turn.
    if (generation !== undefined && generation !== turn.generation)
      throw new HostError('ROUTINE_PROPOSAL_FORBIDDEN', 'Esta execução foi substituída; a sugestão não vale mais')
    if (TURN_TERMINAL.has(turn.status)) throw new HostError('ROUTINE_PROPOSAL_FORBIDDEN', 'Esta execução já terminou')
    // A scheduled routine, or a continuation of one, may never create another routine.
    if (this.deps.routines.executionByTurn(turnId))
      throw new HostError('ROUTINE_PROPOSAL_FORBIDDEN', 'Uma execução programada não pode criar novas rotinas')
    const target = this.targetFor(botId, turn.conversationId)
    if (!target)
      throw new HostError('ROUTINE_PROPOSAL_FORBIDDEN', 'Só uma conversa sua com este bot, ou o bot que coordena um pedido seu, pode sugerir uma rotina')
    return { target }
  }

  /**
   * What, if anything, this thread may propose for. The thread is the authority: a person's
   * own conversation speaks for that bot, a coordination thread of work the person started
   * speaks for that team, and everything else — a delegated worker, a scheduled occurrence,
   * a continuation after a takeover — speaks for nothing at all.
   */
  private targetFor(botId: string, conversationId: string): TargetRef | undefined {
    if (conversationId.startsWith('routine:')) return undefined
    let bot: ReturnType<BotRepository['bot']>
    try {
      bot = this.deps.bots.bot(botId)
    } catch {
      return undefined
    }
    if (bot.status === 'archived') return undefined
    if (bot.conversationId && conversationId === bot.conversationId) return { kind: 'bot', id: botId }
    const coordination = /^team:(.+):coordination$/.exec(conversationId)
    if (!coordination) return undefined
    try {
      const run = this.deps.teams.run(coordination[1])
      if (run.coordinatorBotId !== botId) return undefined
      // Work a routine or another bot started cannot breed more routines.
      const message = this.deps.teams.messageById(run.messageId)
      if (message.author.kind !== 'human') return undefined
      return { kind: 'team', id: run.teamId }
    } catch {
      return undefined
    }
  }

  /**
   * Reference time and, when it is actually known, the person's zone. The zone comes from a
   * routine they already created for this target — never from the machine the Host runs on
   * and never from a network address. Without it the model has to ask, which is the honest
   * outcome: "amanhã às nove" means nothing until somebody says nine where.
   */
  context(botId: string, turnId: string, conversationId: string): RoutineTurnContext {
    const target = this.targetFor(botId, conversationId)
    const nowMs = this.clock.now()
    const used = target ? this.deps.routines.proposalsOfTurn(turnId).length : ROUTINE_LIMITS.proposalsPerTurnMax
    const timeZone = target ? this.knownTimeZone(target) : undefined
    return {
      nowUtc: new Date(nowMs).toISOString(),
      ...(timeZone ? { timeZone, nowLocal: localReading(timeZone, nowMs) } : {}),
      canPropose: !!target,
      proposalsRemaining: Math.max(0, ROUTINE_LIMITS.proposalsPerTurnMax - used),
      tools: target ? (['routine_propose', 'routine_proposal_status'] as const).slice() : [],
      existing: target
        ? this.deps.routines
            .routines(target)
            .filter((routine) => routine.status !== 'archived')
            .slice(0, 20)
            .map((routine) => ({ routineId: routine.id, name: routine.spec.name, schedule: describeSchedule(routine.spec.schedule) }))
        : [],
    }
  }
  /** The zone the person already chose for this target, if they ever chose one. */
  private knownTimeZone(target: TargetRef) {
    const routines = this.deps.routines.routines(target, true)
    return routines.length ? routines[routines.length - 1].spec.schedule.timeZone : undefined
  }

  /**
   * Records one suggestion. It never resolves an ambiguous phrasing on the model's behalf:
   * a proposal without a calendar simply asks the person, which is the honest outcome when
   * "de manhã" could mean anything.
   */
  create(input: { botId: string; turnId: string; generation?: number; params: unknown }): RoutineProposal {
    const params = routineParamSchemas.routine_propose.parse(input.params)
    const { target } = this.scopeOf(input.botId, input.turnId, input.generation)
    const nowMs = this.clock.now()
    if (this.deps.routines.proposalsOfTurn(input.turnId).length >= ROUTINE_LIMITS.proposalsPerTurnMax)
      throw new HostError('ROUTINE_LIMIT', 'Esta execução já sugeriu rotinas demais; fale com a pessoa antes de sugerir outra.')
    if (this.deps.routines.proposals(target).length >= ROUTINE_LIMITS.pendingProposalsPerTargetMax)
      throw new HostError('ROUTINE_LIMIT', 'Há sugestões de rotina demais aguardando decisão para este alvo.')
    let schedule: ScheduleSpec | undefined
    if (params.schedule) {
      const parsed = scheduleSpecSchema.safeParse(params.schedule)
      if (!parsed.success) throw new HostError('ROUTINE_SCHEDULE_INVALID', 'Este horário não é válido; pergunte o dia, a hora e o fuso à pessoa.')
      schedule = parsed.data
      // A relative moment that already passed while the person was reading must be chosen
      // again, not silently moved to the next day.
      if (schedule.kind === 'once' && Date.parse(schedule.atUtc) <= nowMs)
        throw new HostError('ROUTINE_SCHEDULE_INVALID', 'Este horário já passou; peça à pessoa um horário futuro.')
    }
    // The Host never confirmed a zone for this target, so a calendar the model wrote is a
    // guess. The card keeps it, and asks the person to confirm the zone before it can become
    // a routine — the preview shows the real instants either way.
    const clarification =
      params.clarification ??
      (schedule && !this.knownTimeZone(target) ? `Confirme o fuso horário: a sugestão assume ${schedule.timeZone}.` : undefined)
    const proposal: RoutineProposal = routineProposalSchema.parse({
      id: randomUUID(),
      target,
      proposedByBotId: input.botId,
      turnId: input.turnId,
      name: params.name,
      request: params.request,
      ...(schedule ? { schedule } : {}),
      ...(clarification ? { clarification } : {}),
      status: 'pending',
      createdAt: now(),
      expiresAt: new Date(nowMs + ROUTINE_LIMITS.proposalTtlMs).toISOString(),
      revision: 0,
    })
    this.deps.routines.transaction(() => this.deps.routines.saveProposal(proposal))
    return proposal
  }

  /** A model may look up what became of its own card, and nothing else. */
  statusFor(botId: string, proposalId: string) {
    const proposal = this.deps.routines.proposal(proposalId)
    if (proposal.proposedByBotId !== botId) throw new HostError('ROUTINE_PROPOSAL_FORBIDDEN', 'Esta sugestão pertence a outro bot')
    return proposal
  }

  list(target?: TargetRef) {
    this.deps.routines.expireProposals(new Date(this.clock.now()).toISOString())
    return this.deps.routines.proposals(target)
  }
  dismiss(proposalId: string, expectedRevision: number) {
    return this.deps.routines.transaction(() => {
      const current = this.deps.routines.proposal(proposalId)
      if (current.status !== 'pending') return current
      if (current.revision !== expectedRevision) throw new HostError('REVISION_CONFLICT', 'Esta sugestão mudou; recarregue antes de decidir')
      const updated: RoutineProposal = { ...current, status: 'dismissed', revision: current.revision + 1 }
      this.deps.routines.saveProposal(updated)
      return updated
    })
  }
  markActivated(proposalId: string, routineId: string) {
    try {
      const current = this.deps.routines.proposal(proposalId)
      if (current.status !== 'pending') return
      this.deps.routines.saveProposal({ ...current, status: 'activated', routineId, revision: current.revision + 1 })
    } catch {
      /* a card that expired while the person reviewed it is not an error */
    }
  }
}
export { routineThreadId }
