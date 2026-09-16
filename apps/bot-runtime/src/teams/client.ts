import {
  COLLABORATION_METHODS,
  collaborationParamSchemas,
  type CollaborationMethod,
  type TeamTurnContext,
} from '@maestrly/host-protocol'
import { runtimeError } from '../turns/service.js'

/** The Host side of one collaboration call, as the control session exposes it. */
export type CollaborationTransport = (input: {
  turnId: string
  generation: number
  method: CollaborationMethod
  params: Record<string, unknown>
}) => Promise<Record<string, unknown>>

/**
 * Collaboration client used by the tools. It only ever asks the Host, over the private
 * channel that already authenticated this bot: there is no fallback to a shell, to the
 * administrative RPC or to any HTTP endpoint, so a runtime without the capability simply
 * has no collaboration at all.
 *
 * When a reply is lost after the Host accepted the work, the client consults the receipt
 * with the original identity instead of issuing a second action of its own.
 */
export class CollaborationClient {
  constructor(
    private readonly transport: CollaborationTransport,
    private readonly context: () => { turnId: string; generation: number; team?: TeamTurnContext }
  ) {}

  /** Tools offered for the turn in progress; anything else is refused by the Host too. */
  available(): CollaborationMethod[] {
    const team = this.context().team
    return team ? team.tools.filter((tool) => COLLABORATION_METHODS.includes(tool)) : []
  }
  team(): TeamTurnContext | undefined {
    return this.context().team
  }

  async call<M extends CollaborationMethod>(method: M, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const { turnId, generation, team } = this.context()
    if (!team) throw runtimeError('TEAM_UNAVAILABLE', 'This task does not belong to a team')
    if (!team.tools.includes(method)) throw runtimeError('TEAM_STAGE_INVALID', 'This action is not available in this stage of the work')
    const parsed = collaborationParamSchemas[method].parse(params)
    try {
      return await this.transport({ turnId, generation, method, params: parsed as Record<string, unknown> })
    } catch (error) {
      const failure = error as { code?: string; requestId?: string }
      // Accepted-but-unanswered work is consulted, never repeated as a new action.
      if (failure.code === 'TEAM_TIMEOUT' && method === 'team_publish_file')
        throw runtimeError('TEAM_TIMEOUT', 'The Host may have accepted this publication; check team_status before trying again')
      throw error
    }
  }
}
