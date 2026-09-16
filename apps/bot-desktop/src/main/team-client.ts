import { TEAM_MUTATIONS, teamMethods, teamRequestSchema, teamResultSchemas, type TeamMethod, type TeamResult } from '@maestrly/host-protocol'
import { HostRequestError } from './host-client'
import type { BotJournal, BotJournalEntry } from './bot-journal'
import type { RequestFn } from './bot-client'

export type TeamCall = { method: TeamMethod; params: Record<string, unknown> }
/**
 * Team calls are validated by the shared strict schema before anything is journaled or
 * written. Team results never carry tickets or capabilities, so nothing here is hidden
 * from the renderer — but a method outside the namespace is still refused outright.
 */
export function validateTeamCall(value: unknown): TeamCall {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['method', 'params'].includes(key)))
    throw new Error('Invalid team request')
  const call = value as TeamCall
  if (!teamMethods.includes(call.method) || JSON.stringify(value).length > 128 * 1024) throw new Error('Invalid team request')
  const parsed = teamRequestSchema.parse({ version: 1, id: 'ipc', ...call })
  return { method: parsed.method as TeamMethod, params: parsed.params as Record<string, unknown> }
}

/**
 * Typed team client over the active Host transport. It mirrors BotClient's discipline —
 * journal before the wire write, look the key up after a lost reply, never re-send — but
 * uses the team namespace explicitly: `bot.operation.lookup` does not answer for these.
 *
 * A new connection always validates the Host identity first, so a mutation is never
 * replayed against a different Host that happens to share an alias.
 */
export class TeamClient {
  private hostId = ''
  constructor(
    private readonly journal: BotJournal,
    private readonly request: RequestFn
  ) {}
  connected(hostId: string) {
    this.hostId = hostId
  }
  async call<M extends TeamMethod>(input: unknown): Promise<TeamResult<M>> {
    const call = validateTeamCall(input)
    if (!this.hostId) throw new Error('Conecte-se a um computador antes de usar equipes')
    const entry = await this.journal.begin(this.hostId, call.method, call.params)
    try {
      const result = await this.request(call.method, call.params)
      const parsed = teamResultSchemas[call.method].parse(result) as TeamResult<M>
      if (entry) await this.journal.receipt(entry, receiptOf(call, parsed))
      return parsed
    } catch (error) {
      // A definitive refusal is not an uncertain outcome: the key is dropped, not retried.
      if (entry && error instanceof HostRequestError) await this.journal.forget(entry)
      throw error
    }
  }
  /**
   * After reconnecting, ask the Host about every team mutation whose reply was lost. A
   * request that was never accepted is forgotten so the person keeps the draft and decides;
   * nothing is ever sent a second time here.
   */
  async recover(): Promise<{ recovered: number; unresolved: number }> {
    if (!this.hostId) return { recovered: 0, unresolved: 0 }
    let recovered = 0
    const entries = (await this.journal.unresolved(this.hostId)).filter((entry) => entry.method.startsWith('team.'))
    for (const entry of entries) {
      try {
        const send = entry.method === 'team.messages.send'
        // The team namespace answers for its own keys; the bot lookups do not.
        const found = send
          ? await this.request('team.messages.lookup', { teamId: entry.reference.teamId, clientMessageId: entry.reference.clientMessageId })
          : await this.request('team.operation.lookup', { idempotencyKey: entry.reference.idempotencyKey })
        if (found) {
          const id = send ? (found as { run: { id: string } }).run.id : (found as { id: string }).id
          await this.journal.receipt(entry, { id, kind: send ? 'turn' : 'operation' })
          recovered++
        } else await this.journal.forget(entry)
      } catch {
        /* stays unresolved until the next reconnect */
      }
    }
    return { recovered, unresolved: (await this.unresolved()).length }
  }
  async unresolved() {
    return this.hostId ? (await this.journal.unresolved(this.hostId)).filter((entry) => entry.method.startsWith('team.')) : []
  }
}
export function receiptOf(call: TeamCall, result: unknown): BotJournalEntry['receipt'] {
  // A team send produces a run, not a bot turn or a VM operation; the namespaces differ.
  if (call.method === 'team.messages.send') return { id: (result as { run: { id: string } }).run.id, kind: 'turn' }
  if (call.method === 'team.create' || call.method === 'team.members.set') return { id: (result as { team: { id: string } }).team.id, kind: 'operation' }
  if (call.method === 'team.run.cancel') return { id: (result as { id: string }).id, kind: 'turn' }
  if (typeof (result as { id?: unknown })?.id === 'string') return { id: (result as { id: string }).id, kind: 'operation' }
  return { id: 'applied', kind: 'operation' }
}
export const TEAM_MUTATION_METHODS = TEAM_MUTATIONS
