import { TEAM_LIMITS, type BotTurn, type TeamBudget, type TeamRun, type TeamTaskAttempt } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { TURN_LIMITS } from '../bots/context.js'

export interface TurnReservation {
  toolCalls: number
  activeMs: number
}
export type ReservationKind = 'planning' | 'work' | 'consolidation'

export const emptyBudget = (): TeamBudget => ({
  rounds: 0,
  tasks: 0,
  turns: 0,
  toolCallsReserved: 0,
  toolCallsSettled: 0,
  activeMsReserved: 0,
  activeMsSettled: 0,
  consolidationHeld: true,
  tokensObserved: false,
})

/**
 * One budget per piece of work, never per bot: three members do not get three times the
 * allowance. A parcel is reserved in the Host before each physical turn and only released
 * against evidence that the turn ended. Unknown consumption keeps the conservative
 * reservation instead of silently returning capacity.
 *
 * Token counts are informative: they are aggregated when the provider reports them and
 * stay absent otherwise. This is not a hard financial ceiling and is not presented as one.
 */
export class TeamBudgets {
  /** Room left for a new parcel, with the consolidation share still held back. */
  available(run: TeamRun, kind: ReservationKind) {
    const holdTools = kind === 'consolidation' || !run.budget.consolidationHeld ? 0 : TEAM_LIMITS.consolidationToolCalls
    const holdMs = kind === 'consolidation' || !run.budget.consolidationHeld ? 0 : TEAM_LIMITS.consolidationActiveMs
    return {
      turns: run.limits.maxTurns - run.budget.turns,
      toolCalls: run.limits.maxToolCalls - run.budget.toolCallsReserved - holdTools,
      activeMs: run.limits.maxActiveMs - run.budget.activeMsReserved - holdMs,
    }
  }
  /**
   * Reserves the next parcel. The returned limits are also bounded by the existing
   * per-turn ceiling, so a team turn is never allowed to run longer than a normal one.
   */
  reserve(run: TeamRun, kind: ReservationKind): { budget: TeamBudget; reservation: TurnReservation } {
    const room = this.available(run, kind)
    if (room.turns < 1) throw new HostError('TEAM_TURN_LIMIT', 'Este trabalho atingiu o limite de execuções permitidas.')
    if (room.toolCalls < 1 || room.activeMs < 60_000)
      throw new HostError('TEAM_BUDGET_EXHAUSTED', 'O limite de trabalho desta equipe foi atingido; peça um novo pedido ou aumente o limite no avançado.')
    // A parcel is at most a share of the work's allowance, the per-turn ceiling and what
    // is left: one member can never take the budget the others still need.
    const share = (total: number) => Math.ceil(total / TEAM_LIMITS.parcelDivisor)
    const reservation: TurnReservation = {
      toolCalls: Math.max(1, Math.min(TURN_LIMITS.maxTools, share(run.limits.maxToolCalls), room.toolCalls)),
      activeMs: Math.min(TURN_LIMITS.activeMs, Math.max(60_000, share(run.limits.maxActiveMs)), room.activeMs),
    }
    return {
      budget: {
        ...run.budget,
        turns: run.budget.turns + 1,
        toolCallsReserved: run.budget.toolCallsReserved + reservation.toolCalls,
        activeMsReserved: run.budget.activeMsReserved + reservation.activeMs,
        // Once consolidation itself starts, nothing else needs to be held back.
        consolidationHeld: kind === 'consolidation' ? false : run.budget.consolidationHeld,
      },
      reservation,
    }
  }
  /** True when a consolidation parcel can still be taken; otherwise the run ends honestly. */
  canConsolidate(run: TeamRun) {
    const room = this.available(run, 'consolidation')
    return room.turns >= 1 && room.toolCalls >= 1 && room.activeMs >= 60_000
  }
  /**
   * Settles one attempt after its turn reached a terminal state. Measured usage releases
   * the unused part of the parcel; unknown usage keeps the whole reservation.
   */
  settle(run: TeamRun, attempt: TeamTaskAttempt, turn: BotTurn): TeamBudget {
    const tools = turn.usage?.toolCalls
    const elapsed =
      turn.startedAt && turn.finishedAt ? Math.max(0, new Date(turn.finishedAt).getTime() - new Date(turn.startedAt).getTime()) : undefined
    const usedTools = typeof tools === 'number' ? Math.min(attempt.reservedToolCalls, tools) : attempt.reservedToolCalls
    const usedMs = typeof elapsed === 'number' ? Math.min(attempt.reservedActiveMs, elapsed) : attempt.reservedActiveMs
    const input = turn.usage?.inputTokens
    const output = turn.usage?.outputTokens
    const observed = typeof input === 'number' || typeof output === 'number'
    return {
      ...run.budget,
      toolCallsReserved: Math.max(0, run.budget.toolCallsReserved - (attempt.reservedToolCalls - usedTools)),
      toolCallsSettled: run.budget.toolCallsSettled + usedTools,
      activeMsReserved: Math.max(0, run.budget.activeMsReserved - (attempt.reservedActiveMs - usedMs)),
      activeMsSettled: run.budget.activeMsSettled + usedMs,
      tokensObserved: run.budget.tokensObserved || observed,
      ...(typeof input === 'number' ? { inputTokens: (run.budget.inputTokens ?? 0) + input } : {}),
      ...(typeof output === 'number' ? { outputTokens: (run.budget.outputTokens ?? 0) + output } : {}),
    }
  }
}
