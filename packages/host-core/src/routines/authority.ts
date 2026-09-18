import { createHash } from 'node:crypto'
import {
  ROUTINE_LIMITS,
  routineCeilingSchema,
  type Routine,
  type RoutineCauseCode,
  type RoutineCeiling,
  type RoutineWarning,
  type TargetRef,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository } from '../bots/repository.js'
import type { TeamRepository } from '../teams/repository.js'
import type { RoutineRepository } from './repository.js'

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

export interface TargetDescription {
  ref: TargetRef
  name: string
  /** Digest of exactly the identity a person approved; transient state is deliberately out. */
  version: string
  /** What the target itself is allowed to do, before the routine's own ceiling narrows it. */
  ceiling: RoutineCeiling
  permissionSummary: string[]
  warnings: RoutineWarning[]
}
export interface AdmissionState {
  ready: boolean
  causeCode?: RoutineCauseCode
  message?: string
  /** True when waiting is the right answer: the occurrence queues instead of failing. */
  transient?: boolean
}

export interface RoutineAuthorityDeps {
  bots: BotRepository
  teams: TeamRepository
  routines: RoutineRepository
  /** True while a person is driving this bot's screen. */
  held: (botId: string) => boolean
  /** Live state of the computer a bot runs on, when the Host can tell. */
  vmRunning?: (vmId: string) => boolean
}

/**
 * Everything a routine is allowed to do, and nothing more.
 *
 * Three rules drive this file. An approval fixes a ceiling, so a later change to the bot can
 * only narrow what a scheduled firing may do, never widen it. Identity that a person
 * consented to — account, model, permission mode, roster — is fingerprinted, so a silent
 * swap forces a new review instead of running under something the person never saw. And a
 * routine has an aggregate allowance across a moving twenty-four hours, so a schedule that
 * turns out to be too frequent cannot quietly consume a whole plan.
 */
export class RoutineAuthority {
  constructor(private readonly deps: RoutineAuthorityDeps) {}

  /** Human name for a target, without asserting it exists in a way that throws unhelpfully. */
  name(ref: TargetRef): string {
    try {
      return ref.kind === 'bot' ? this.deps.bots.bot(ref.id).name : this.deps.teams.team(ref.id).name
    } catch {
      return ref.kind === 'bot' ? 'bot' : 'equipe'
    }
  }

  describe(ref: TargetRef): TargetDescription {
    const warnings: RoutineWarning[] = []
    if (ref.kind === 'bot') {
      const bot = this.deps.bots.bot(ref.id)
      if (bot.status === 'archived') throw new HostError('ROUTINE_TARGET_INVALID', 'Este bot foi arquivado e não pode receber rotinas')
      const network = this.deps.bots.network(bot.id)
      if (bot.accountState !== 'connected') warnings.push({ code: 'ACCOUNT_DISCONNECTED', message: 'A conta de IA deste bot está desconectada; a rotina só executa depois de reconectar.' })
      return {
        ref,
        name: bot.name,
        // Identity a person consented to. The bot's decorative name, its current turn and
        // operational timestamps are deliberately absent: renaming a bot is not a new approval.
        version: digest({
          kind: 'bot',
          accountId: bot.accountId ?? null,
          model: bot.model ?? null,
          permissionMode: bot.permissionMode,
          vmId: bot.vmId ?? null,
          // Only the network *mode* is part of the approval. Narrowing the allowed domains
          // takes effect immediately; widening the mode is a new decision to review.
          networkMode: network.mode,
        }),
        ceiling: routineCeilingSchema.parse({ permissionMode: bot.permissionMode }),
        permissionSummary: [
          bot.permissionMode === 'ask' ? 'Pede permissão antes de ações sensíveis' : 'Controle administrativo completo no computador dele',
          network.mode === 'offline' ? 'Sem acesso à internet' : network.mode === 'allowlist' ? `Internet limitada a ${network.domains.length} destino(s)` : 'Internet pública com bloqueios',
        ],
        warnings,
      }
    }
    const team = this.deps.teams.team(ref.id)
    if (team.status === 'archived') throw new HostError('ROUTINE_TARGET_INVALID', 'Esta equipe foi arquivada e não pode receber rotinas')
    const members = this.deps.teams.members(team.id, true)
    if (members.length < 2) throw new HostError('ROUTINE_TARGET_INVALID', 'Esta equipe não tem membros suficientes para trabalhar')
    return {
      ref,
      name: team.name,
      version: digest({
        kind: 'team',
        coordinatorBotId: team.coordinatorBotId,
        roster: members.map((member) => ({ botId: member.botId, grantRevision: member.grantRevision, coordinator: member.coordinator })).sort((a, b) => a.botId.localeCompare(b.botId)),
        policy: team.policy,
      }),
      ceiling: routineCeilingSchema.parse({
        permissionMode: team.policy.permissionMode,
        activeMs: Math.min(team.policy.maxActiveMs, routineCeilingSchema.parse({}).activeMs),
        maxTools: Math.min(team.policy.maxToolCalls, routineCeilingSchema.parse({}).maxTools),
      }),
      permissionSummary: [
        team.policy.permissionMode === 'ask' ? 'Cada membro pede permissão antes de ações sensíveis' : 'Controle administrativo completo para os membros',
        `${members.length} participante(s), coordenados por ${this.name({ kind: 'bot', id: team.coordinatorBotId })}`,
      ],
      warnings,
    }
  }

  /**
   * The ceiling that actually applies: the intersection of what the person approved for this
   * routine and what the target may do right now. `ask` always wins over `full-vm`, and every
   * numeric limit takes the smaller side. Nothing here can ever produce a wider ceiling.
   */
  effectiveCeiling(requested: RoutineCeiling, target: RoutineCeiling): RoutineCeiling {
    return routineCeilingSchema.parse({
      activeMs: Math.min(requested.activeMs, target.activeMs),
      maxTools: Math.min(requested.maxTools, target.maxTools),
      permissionMode: requested.permissionMode === 'ask' || target.permissionMode === 'ask' ? 'ask' : 'full-vm',
    })
  }

  /** Can this target start a firing right now? A "not yet" is never reported as a failure. */
  admissionState(ref: TargetRef): AdmissionState {
    if (ref.kind === 'bot') {
      let bot: ReturnType<BotRepository['bot']>
      try {
        bot = this.deps.bots.bot(ref.id)
      } catch {
        return { ready: false, causeCode: 'ACCESS_REVOKED', message: 'Este bot não existe mais neste Host.' }
      }
      if (bot.status === 'archived') return { ready: false, causeCode: 'ACCESS_REVOKED', message: 'Este bot foi arquivado.' }
      if (bot.status !== 'ready') return { ready: false, causeCode: 'TARGET_BUSY', message: 'O bot ainda está sendo preparado.', transient: true }
      if (this.deps.held(bot.id)) return { ready: false, causeCode: 'TARGET_PAUSED_BY_USER', message: 'Você está usando a tela deste bot.', transient: true }
      if (bot.vmId && this.deps.vmRunning && !this.deps.vmRunning(bot.vmId))
        return { ready: false, causeCode: 'COMPUTER_OFF', message: 'O computador deste bot está desligado; ligue-o para a rotina executar.', transient: true }
      if (bot.accountState !== 'connected') return { ready: false, causeCode: 'ACCOUNT_REQUIRED', message: 'A conta de IA deste bot está desconectada.', transient: true }
      if (this.deps.bots.activeTurn(bot.id)) return { ready: false, causeCode: 'TARGET_BUSY', message: 'O bot está ocupado com outra tarefa.', transient: true }
      return { ready: true }
    }
    let team: ReturnType<TeamRepository['team']>
    try {
      team = this.deps.teams.team(ref.id)
    } catch {
      return { ready: false, causeCode: 'ACCESS_REVOKED', message: 'Esta equipe não existe mais neste Host.' }
    }
    if (team.status === 'archived') return { ready: false, causeCode: 'ACCESS_REVOKED', message: 'Esta equipe foi arquivada.' }
    if (this.deps.teams.activeRun(team.conversationId)) return { ready: false, causeCode: 'TARGET_BUSY', message: 'A equipe já está trabalhando em outro pedido.', transient: true }
    const coordinator = this.deps.teams.members(team.id, true).find((member) => member.botId === team.coordinatorBotId)
    if (!coordinator) return { ready: false, causeCode: 'ACCESS_REVOKED', message: 'Esta equipe não tem coordenador ativo.' }
    return { ready: true }
  }

  /** Shared resources are re-checked at every firing: a revoked file blocks the next one. */
  resourceState(routine: Routine): AdmissionState {
    if (!routine.spec.resourceIds.length) return { ready: true }
    if (routine.spec.target.kind !== 'team') return { ready: false, causeCode: 'ACCESS_REVOKED', message: 'Arquivos compartilhados só existem em equipes.' }
    for (const artifactId of routine.spec.resourceIds) {
      try {
        const artifact = this.deps.teams.artifact(artifactId)
        if (artifact.teamId !== routine.spec.target.id || artifact.state !== 'available')
          return { ready: false, causeCode: 'ACCESS_REVOKED', message: 'Um arquivo escolhido para esta rotina não está mais disponível.' }
      } catch {
        return { ready: false, causeCode: 'ACCESS_REVOKED', message: 'Um arquivo escolhido para esta rotina não existe mais.' }
      }
    }
    return { ready: true }
  }

  /**
   * Consumption in the moving twenty-four hours, computed from the occurrences themselves
   * rather than from a counter that a restart would reset. An occurrence that is still
   * running counts its full reservation: an uncertain result must not look free.
   */
  window(routineId: string, nowMs: number) {
    const floor = nowMs - 24 * 60 * 60_000
    const recent = this.deps.routines
      .occurrences(routineId, undefined, ROUTINE_LIMITS.admissionsPer24h * 4)
      .filter((occurrence) => Date.parse(occurrence.createdAt) >= floor && occurrence.status !== 'skipped')
    return {
      admissions: recent.length,
      activeMs: recent.reduce((sum, occurrence) => sum + occurrence.usedActiveMs, 0),
      actions: recent.reduce((sum, occurrence) => sum + occurrence.usedActions, 0),
    }
  }

  /** Whether one more firing fits the routine's aggregate allowance. */
  canAdmit(routine: Routine, ceiling: RoutineCeiling, nowMs: number): AdmissionState {
    const used = this.window(routine.id, nowMs)
    if (used.admissions >= ROUTINE_LIMITS.admissionsPer24h)
      return { ready: false, causeCode: 'BUDGET_EXHAUSTED', message: `Esta rotina já executou ${used.admissions} vezes nas últimas 24 horas.` }
    if (used.activeMs + ceiling.activeMs > ROUTINE_LIMITS.activeMsPer24h)
      return { ready: false, causeCode: 'BUDGET_EXHAUSTED', message: 'Esta rotina já usou o tempo de trabalho previsto para 24 horas.' }
    if (used.actions + ceiling.maxTools > ROUTINE_LIMITS.actionsPer24h)
      return { ready: false, causeCode: 'BUDGET_EXHAUSTED', message: 'Esta rotina já usou as ações previstas para 24 horas.' }
    return { ready: true }
  }
}
