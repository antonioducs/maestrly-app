import {
  TEAM_LIMITS,
  TEAM_RUN_TERMINAL,
  type Bot,
  type Team,
  type TeamMember,
  type TeamRun,
  type TeamTask,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository } from '../bots/repository.js'
import type { TeamRepository } from './repository.js'
import { stageOf, type TeamStage } from './context.js'

export interface CollaborationOrigin {
  team: Team
  run: TeamRun
  task: TeamTask
  member: TeamMember
  bot: Bot
  role: 'coordinator' | 'member'
  stage: TeamStage
}

/**
 * Every authorization question of the teams domain in one place. Membership, coordination
 * and grants are read from durable state at the moment of use, so revoking access takes
 * effect on the next delivery and dispatch instead of at the next restart.
 */
export class TeamAccess {
  constructor(
    private readonly teams: TeamRepository,
    private readonly bots: BotRepository
  ) {}

  team(teamId: string, allowArchived = false): Team {
    const team = this.teams.team(teamId)
    if (!allowArchived && team.status === 'archived') throw new HostError('TEAM_ARCHIVED', 'Esta equipe está arquivada')
    return team
  }

  /** Bots must exist on this Host, be usable, appear once, and name exactly one coordinator. */
  validateMembers(input: { botId: string; role: string; coordinator: boolean }[]): { coordinatorBotId: string } {
    if (input.length < 2) throw new HostError('TEAM_MEMBER_INVALID', 'Uma equipe precisa de pelo menos dois bots')
    if (input.length > TEAM_LIMITS.membersMax) throw new HostError('TEAM_MEMBER_INVALID', `Uma equipe aceita no máximo ${TEAM_LIMITS.membersMax} bots`)
    if (new Set(input.map((member) => member.botId)).size !== input.length)
      throw new HostError('TEAM_MEMBER_INVALID', 'Um bot não pode participar duas vezes da mesma equipe')
    for (const member of input) {
      // A bot of another Host simply does not exist here; the lookup is the check.
      const bot = this.bots.bot(member.botId)
      if (bot.status === 'archived') throw new HostError('TEAM_MEMBER_INVALID', `O bot ${bot.name} está arquivado e não pode entrar numa equipe`)
      if (bot.status !== 'ready') throw new HostError('TEAM_MEMBER_INVALID', `Conclua a preparação do bot ${bot.name} antes de colocá-lo numa equipe`)
    }
    const coordinators = input.filter((member) => member.coordinator)
    if (coordinators.length > 1) throw new HostError('TEAM_COORDINATOR_REQUIRED', 'Escolha um único bot para coordenar a equipe')
    return { coordinatorBotId: coordinators[0]?.botId ?? input[0].botId }
  }

  member(teamId: string, botId: string): TeamMember {
    const member = this.teams.member(teamId, botId)
    if (!member?.active) throw new HostError('TEAM_NOT_MEMBER', 'Este bot não participa desta equipe')
    return member
  }

  /**
   * Resolves who is acting from the Host's own records: the turn registered for a team
   * task, the run it belongs to and the membership that was valid when the run started.
   * The guest never names the bot, the team or the role.
   */
  origin(turnId: string, botId: string): CollaborationOrigin {
    const attempt = this.teams.attemptByTurn(turnId)
    if (!attempt) throw new HostError('TEAM_NOT_MEMBER', 'Esta execução não pertence a um trabalho de equipe')
    if (attempt.botId !== botId) throw new HostError('TEAM_NOT_MEMBER', 'Esta execução pertence a outro bot')
    const run = this.teams.run(attempt.runId)
    if (TEAM_RUN_TERMINAL.has(run.status) || run.status === 'cancelling')
      throw new HostError('TEAM_STAGE_INVALID', 'Este trabalho de equipe já foi encerrado')
    const task = this.teams.task(attempt.taskId)
    const team = this.team(run.teamId)
    const member = this.member(team.id, botId)
    // Membership changed after the run started: the old authorization does not survive it.
    if (member.grantRevision !== run.memberGrantRevision) throw new HostError('TEAM_GRANT_REVOKED', 'A composição da equipe mudou; esta autorização não vale mais')
    const bot = this.bots.bot(botId)
    const role = task.assigneeBotId === run.coordinatorBotId && task.kind !== 'work' ? 'coordinator' : 'member'
    return { team, run, task, member, bot, role, stage: stageOf(task) }
  }

  /** Only the coordinator delegates, and only in the planning stage of the current round. */
  assertCanDelegate(origin: CollaborationOrigin) {
    if (origin.role !== 'coordinator' || origin.task.kind !== 'planning')
      throw new HostError('TEAM_COORDINATOR_REQUIRED', 'Apenas o bot que coordena pode distribuir tarefas, e só no planejamento')
    if (origin.run.budget.rounds >= origin.run.limits.maxRounds)
      throw new HostError('TEAM_ROUND_LIMIT', 'Este trabalho atingiu o limite de rodadas de delegação; conclua com o que já existe')
  }

  /** Work that would be affected by changing or archiving this team, for an honest prompt. */
  affectedRuns(teamId: string): TeamRun[] {
    return this.teams.activeRunsOfTeam(teamId).filter((run) => !TEAM_RUN_TERMINAL.has(run.status))
  }
  assertQuiet(teamId: string, confirmed: boolean) {
    const affected = this.affectedRuns(teamId)
    if (affected.length && !confirmed)
      throw new HostError('TEAM_WORK_IN_PROGRESS', `Esta equipe tem ${affected.length} trabalho(s) em andamento. Pare esse trabalho ou confirme a interrupção para continuar.`)
    return affected
  }
}
