import { ROUTINE_METHODS, routineParamSchemas, type RoutineMethodName, type RoutineTurnContext } from '@maestrly/host-protocol'
import { runtimeError } from '../turns/service.js'

/** The Host side of one routine call, as the control session exposes it. */
export type RoutineTransport = (input: {
  turnId: string
  generation: number
  method: RoutineMethodName
  params: Record<string, unknown>
}) => Promise<Record<string, unknown>>

/**
 * Client for the routine proposal lane. Like collaboration, it only ever asks the Host over
 * the private channel that already authenticated this bot — there is no shell, no HTTP and no
 * administrative RPC to fall back on.
 *
 * The only thing it can do is leave a card for a person. It cannot activate, edit, pause or
 * run anything, so a model that decides a routine "has been created" is simply wrong, and the
 * guidance it receives says so explicitly.
 */
export class RoutineClient {
  constructor(
    private readonly transport: RoutineTransport,
    private readonly context: () => { turnId: string; generation: number; routines?: RoutineTurnContext }
  ) {}

  /** Tools offered for the turn in progress; a scheduled run gets none at all. */
  available(): RoutineMethodName[] {
    const routines = this.context().routines
    if (!routines?.canPropose || routines.proposalsRemaining <= 0) return []
    return routines.tools.filter((tool) => ROUTINE_METHODS.includes(tool))
  }
  routines(): RoutineTurnContext | undefined {
    return this.context().routines
  }

  async call<M extends RoutineMethodName>(method: M, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const { turnId, generation, routines } = this.context()
    if (!routines?.canPropose) throw runtimeError('ROUTINE_PROPOSAL_FORBIDDEN', 'This task cannot suggest routines')
    if (!routines.tools.includes(method)) throw runtimeError('ROUTINE_PROPOSAL_FORBIDDEN', 'This action is not available in this task')
    // The Host does not know this person's time zone, so any calendar the model writes would
    // be a guess about which nine o'clock was meant. Asking is the honest move.
    if (method === 'routine_propose' && !routines.timeZone && (params as { schedule?: unknown }).schedule)
      throw runtimeError('ROUTINE_SCHEDULE_INVALID', 'Ask the person which time zone they mean before suggesting a calendar')
    const parsed = routineParamSchemas[method].parse(params)
    return this.transport({ turnId, generation, method, params: parsed as Record<string, unknown> })
  }
}
