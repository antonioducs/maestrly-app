import { botResultSchemas, type BotMethod, type BotResult } from '@maestrly/host-protocol'
import { HostRequestError } from './host-client'
import type { BotJournal } from './bot-journal'
import { validateBotCall } from './validation'
import type { BotCall } from '../shared/types'

export type RequestFn = (method: string, params: Record<string, unknown>) => Promise<unknown>
/**
 * Typed bot client over the active Host transport. Mutations with a durable key are journaled
 * before the wire write; after a lost reply the same key is looked up instead of re-sent.
 * Chat content never passes through the diagnostic sanitizer.
 */
export class BotClient {
  private hostId = ''
  private lookups = new Map<string, Promise<void>>()
  constructor(
    private readonly journal: BotJournal,
    private readonly request: RequestFn
  ) {}
  connected(hostId: string) {
    this.hostId = hostId
  }
  /** After reconnecting, resolve journal entries whose reply was lost, without re-sending anything. */
  async recover(): Promise<{ recovered: number; unresolved: number }> {
    if (!this.hostId) return { recovered: 0, unresolved: 0 }
    let recovered = 0
    const entries = await this.journal.unresolved(this.hostId)
    for (const entry of entries) {
      try {
        if (entry.method === 'bot.messages.send') {
          const found = await this.request('bot.messages.lookup', { botId: entry.reference.botId, clientMessageId: entry.reference.clientMessageId })
          if (found) {
            await this.journal.receipt(entry, { id: (found as { turn: { id: string } }).turn.id, kind: 'turn' })
            recovered++
          } else await this.journal.forget(entry) // never accepted: the renderer keeps the draft and the person decides
        } else {
          const found = await this.request(entry.method.startsWith('environment.') ? 'environment.lookup' : 'bot.operation.lookup', { idempotencyKey: entry.reference.idempotencyKey })
          if (found) {
            await this.journal.receipt(entry, { id: (found as { id: string }).id, kind: 'operation' })
            recovered++
          } else await this.journal.forget(entry)
        }
      } catch {
        /* stays unresolved until the next reconnect */
      }
    }
    await this.journal.prune()
    return { recovered, unresolved: (await this.journal.unresolved(this.hostId)).length }
  }
  async call<M extends BotMethod>(input: unknown): Promise<BotResult<M>> {
    const { call } = validateBotCall(input)
    if (!this.hostId) throw new Error('Conecte-se a um computador antes de usar bots')
    const entry = await this.journal.begin(this.hostId, call.method, call.params)
    try {
      const result = await this.request(call.method, call.params)
      const parsed = botResultSchemas[call.method].parse(result) as BotResult<M>
      if (entry) {
        const receipt = receiptOf(call, parsed)
        if (receipt) await this.journal.receipt(entry, receipt)
      }
      return parsed
    } catch (error) {
      if (entry && error instanceof HostRequestError) await this.journal.forget(entry) // definitive rejection
      throw error
    }
  }
  async unresolved() {
    return this.hostId ? this.journal.unresolved(this.hostId) : []
  }
  /** Idempotent per key: concurrent lookups coalesce. */
  lookupOnce(key: string, fn: () => Promise<void>) {
    let pending = this.lookups.get(key)
    if (!pending) {
      pending = fn().finally(() => this.lookups.delete(key))
      this.lookups.set(key, pending)
    }
    return pending
  }
}
function receiptOf(call: BotCall, result: unknown): { id: string; kind: 'turn' | 'operation' } | undefined {
  if (call.method === 'bot.messages.send') return { id: (result as { turn: { id: string } }).turn.id, kind: 'turn' }
  if (call.method === 'bot.create') return { id: (result as { id: string }).id, kind: 'operation' }
  if (typeof (result as { id?: unknown })?.id === 'string') return { id: (result as { id: string }).id, kind: 'operation' }
  return undefined
}
