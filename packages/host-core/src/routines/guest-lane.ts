import { routineParamSchemas, routineResultSchemasRuntime, type RoutineRuntimeRequest } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { RoutineProposals } from './proposals.js'

/**
 * Host side of the private routine lane. It exists to say no in four different ways before it
 * ever says yes: an unknown method, a stale generation, a turn that does not belong to this
 * session's bot, or a thread that is not allowed to propose anything.
 *
 * What it can do is deliberately tiny — write a card and read back the fate of a card the same
 * bot wrote. There is no method here that activates, edits, pauses or runs a routine, because
 * the only thing that may do those is a person confirming a preview in the application.
 */
export class RoutineGuestLane {
  constructor(private readonly proposals: RoutineProposals) {}

  async handle(botId: string, request: RoutineRuntimeRequest): Promise<Record<string, unknown>> {
    switch (request.method) {
      case 'routine_propose': {
        const params = routineParamSchemas.routine_propose.parse(request.params)
        const proposal = this.proposals.create({ botId, turnId: request.turnId, generation: request.generation, params })
        return routineResultSchemasRuntime.routine_propose.parse({
          proposalId: proposal.id,
          status: proposal.status,
          requiresHumanConfirmation: true,
          guidance: proposal.clarification
            ? 'Sugestão registrada como um cartão. Pergunte à pessoa o que faltou; nada será executado até ela confirmar.'
            : 'Sugestão registrada como um cartão. Ela só vira rotina quando a pessoa revisar e confirmar; não afirme que já está agendada.',
        }) as Record<string, unknown>
      }
      case 'routine_proposal_status': {
        const params = routineParamSchemas.routine_proposal_status.parse(request.params)
        const proposal = this.proposals.statusFor(botId, params.proposalId)
        return routineResultSchemasRuntime.routine_proposal_status.parse({
          proposalId: proposal.id,
          status: proposal.status,
          ...(proposal.routineId ? { routineId: proposal.routineId } : {}),
          guidance:
            proposal.status === 'pending'
              ? 'A pessoa ainda não decidiu.'
              : proposal.status === 'activated'
                ? 'A pessoa confirmou e a rotina existe.'
                : 'A sugestão não virou rotina.',
        }) as Record<string, unknown>
      }
      default:
        throw new HostError('ROUTINE_PROPOSAL_INVALID', 'Esta ação de rotina não existe')
    }
  }
}
