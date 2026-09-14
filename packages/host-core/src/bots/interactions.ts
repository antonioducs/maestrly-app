import { createHash, randomUUID } from 'node:crypto'
import type { BotInteraction, BotTurn, GuestEvent } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { type BotRepository, now } from './repository.js'
import { TURN_LIMITS } from './context.js'

export function fingerprint(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`
    if (item && typeof item === 'object')
      return `{${Object.entries(item as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(',')}}`
    return JSON.stringify(item)
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}
/** Approvals, questions and grants. A question never changes permissions; decisions are single-use. */
export class BotInteractions {
  constructor(private readonly repo: BotRepository) {}
  fromEvent(turn: BotTurn, event: GuestEvent, policyRevision: number): BotInteraction | undefined {
    const detail = event.detail ?? {}
    const actionId = typeof detail.actionId === 'string' ? detail.actionId : undefined
    if (!actionId) return undefined
    const existing = this.repo.interactionByAction(turn.id, actionId)
    if (existing) return existing
    const kind: BotInteraction['kind'] = event.kind === 'question.asked' ? 'question' : 'approval'
    const parameters = detail.parameters && typeof detail.parameters === 'object' ? (detail.parameters as Record<string, unknown>) : {}
    const interaction: BotInteraction = {
      id: randomUUID(),
      botId: turn.botId,
      turnId: turn.id,
      actionId,
      kind,
      title: String(detail.title ?? (kind === 'question' ? 'O bot tem uma pergunta' : 'O bot precisa da sua autorização')).slice(0, 200),
      reason: String(detail.reason ?? '').slice(0, 2000),
      consequence: String(detail.consequence ?? '').slice(0, 2000),
      parameters,
      fingerprint: fingerprint({ actionId, kind, parameters }),
      policyRevision,
      generation: turn.generation,
      ...(detail.scope && typeof detail.scope === 'object' ? { scope: parseScope(detail.scope as Record<string, unknown>) } : {}),
      expiresAt: new Date(Date.now() + TURN_LIMITS.humanWaitMs).toISOString(),
      status: 'pending',
      createdAt: now(),
      updatedAt: now(),
    }
    this.repo.saveInteraction(interaction)
    return interaction
  }
  /** Late, duplicate, cross-turn or conflicting decisions are rejected; an expired approval is never success. */
  resolve(id: string, expectedGeneration: number, decision: 'approve' | 'deny' | 'answer', answer?: string): { interaction: BotInteraction; turn: BotTurn } {
    return this.repo.transaction(() => {
      const interaction = this.repo.interaction(id)
      const turn = this.repo.turn(interaction.turnId)
      if (interaction.status !== 'pending') throw new HostError('INTERACTION_RESOLVED', 'Esta decisão já foi registrada ou deixou de valer')
      if (interaction.generation !== expectedGeneration || turn.generation !== interaction.generation)
        throw new HostError('INTERACTION_STALE', 'A tarefa mudou desde que este pedido foi feito; verifique o estado atual')
      if (new Date(interaction.expiresAt).getTime() < Date.now()) {
        this.repo.saveInteraction({ ...interaction, status: 'expired', updatedAt: now() })
        throw new HostError('INTERACTION_EXPIRED', 'O prazo desta autorização terminou; ela não foi concedida')
      }
      if (!['waiting_approval', 'waiting_input', 'running'].includes(turn.status))
        throw new HostError('INTERACTION_STALE', 'A tarefa não está mais aguardando esta decisão')
      if ((interaction.kind === 'question') !== (decision === 'answer'))
        throw new HostError('INVALID_REQUEST', 'A decisão não corresponde ao tipo de pedido')
      if (decision === 'answer' && !answer?.trim()) throw new HostError('INVALID_REQUEST', 'Uma resposta é necessária')
      const resolved: BotInteraction = {
        ...interaction,
        status: decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'answered',
        ...(decision === 'answer' ? { answer } : {}),
        updatedAt: now(),
      }
      this.repo.saveInteraction(resolved)
      return { interaction: resolved, turn }
    })
  }
  invalidatePending(turnId: string, botId: string) {
    for (const interaction of this.repo.interactions(botId, true))
      if (interaction.turnId === turnId) this.repo.saveInteraction({ ...interaction, status: 'invalidated', updatedAt: now() })
  }
}
function parseScope(scope: Record<string, unknown>) {
  const list = (value: unknown, max: number) =>
    Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 512).slice(0, max) : []
  return {
    actions: list(scope.actions, 32),
    paths: list(scope.paths, 32),
    destinations: list(scope.destinations, 32),
    expiresAt: typeof scope.expiresAt === 'string' ? scope.expiresAt : new Date(Date.now() + TURN_LIMITS.activeMs).toISOString(),
  }
}
