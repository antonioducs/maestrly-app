import {
  ROUTINE_MUTATIONS,
  routineMethods,
  routineRequestSchema,
  routineResultSchemas,
  type RoutineMethod,
  type RoutineResult,
} from '@maestrly/host-protocol'
import { HostRequestError } from './host-client'
import type { BotJournal, BotJournalEntry } from './bot-journal'
import type { RequestFn } from './bot-client'

export type RoutineCall = { method: RoutineMethod; params: Record<string, unknown> }

/**
 * Routine calls are validated by the shared strict schema before anything is journaled or
 * written, exactly like team calls. Nothing in this namespace carries a ticket, a capability
 * or a path, but a method outside it is still refused outright.
 */
export function validateRoutineCall(value: unknown): RoutineCall {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['method', 'params'].includes(key)))
    throw new Error('Invalid routine request')
  const call = value as RoutineCall
  if (!routineMethods.includes(call.method) || JSON.stringify(value).length > 128 * 1024) throw new Error('Invalid routine request')
  const parsed = routineRequestSchema.parse({ version: 1, id: 'ipc', ...call })
  return { method: parsed.method as RoutineMethod, params: parsed.params as Record<string, unknown> }
}

/**
 * Typed routine client over the active Host transport. It keeps the same discipline as the bot
 * and team clients — journal before the wire write, look the key up after a lost reply, never
 * re-send — using the routine namespace explicitly, since `bot.operation.lookup` and
 * `team.operation.lookup` do not answer for these keys.
 *
 * The journal holds references and receipts only: never a request the person did not confirm,
 * and never anything that could be replayed into a second routine.
 */
export class RoutineClient {
  private hostId = ''
  constructor(
    private readonly journal: BotJournal,
    private readonly request: RequestFn
  ) {}
  connected(hostId: string) {
    this.hostId = hostId
  }
  async call<M extends RoutineMethod>(input: unknown): Promise<RoutineResult<M>> {
    const call = validateRoutineCall(input)
    if (!this.hostId) throw new Error('Conecte-se a um computador antes de usar rotinas')
    const entry = await this.journal.begin(this.hostId, call.method, call.params)
    try {
      const result = await this.request(call.method, call.params)
      const parsed = routineResultSchemas[call.method].parse(result) as RoutineResult<M>
      if (entry) await this.journal.receipt(entry, receiptOf(call, parsed))
      return parsed
    } catch (error) {
      // A definitive refusal is not an uncertain outcome: the key is dropped, not retried.
      if (entry && error instanceof HostRequestError) await this.journal.forget(entry)
      throw error
    }
  }
  /**
   * After reconnecting, ask the Host what became of every routine mutation whose reply was
   * lost. An activation that was never accepted is forgotten, so the person is shown the
   * preview again and decides — a routine is never created on their behalf by a retry.
   */
  async recover(): Promise<{ recovered: number; unresolved: number }> {
    if (!this.hostId) return { recovered: 0, unresolved: 0 }
    let recovered = 0
    for (const entry of await this.unresolved()) {
      try {
        const found = await this.request('routine.operation.lookup', { idempotencyKey: entry.reference.idempotencyKey })
        if (found) {
          await this.journal.receipt(entry, { id: (found as { id: string }).id, kind: 'operation' })
          recovered++
        } else await this.journal.forget(entry)
      } catch {
        /* stays unresolved until the next reconnect */
      }
    }
    return { recovered, unresolved: (await this.unresolved()).length }
  }
  async unresolved() {
    return this.hostId ? (await this.journal.unresolved(this.hostId)).filter((entry) => entry.method.startsWith('routine.')) : []
  }
}

export function receiptOf(call: RoutineCall, result: unknown): BotJournalEntry['receipt'] {
  if (call.method === 'routine.runNow') return { id: (result as { id: string }).id, kind: 'turn' }
  if (call.method === 'routine.occurrence.cancel') return { id: (result as { id: string }).id, kind: 'turn' }
  const routine = (result as { routine?: { id?: string } })?.routine
  if (routine?.id) return { id: routine.id, kind: 'operation' }
  if (typeof (result as { id?: unknown })?.id === 'string') return { id: (result as { id: string }).id, kind: 'operation' }
  return { id: 'applied', kind: 'operation' }
}
export const ROUTINE_MUTATION_METHODS = ROUTINE_MUTATIONS
