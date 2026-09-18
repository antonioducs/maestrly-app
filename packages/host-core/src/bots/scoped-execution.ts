import type { BotConversation, BotTurn, TurnSnapshot } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { type BotRepository, now } from './repository.js'
import type { ContinuationScope } from './turns.js'

/**
 * Composition seams for the domains that ride the single turn engine. Before this, the teams
 * domain installed itself as the one continuation scope, the one turn observer, the one
 * dispatch guard and the one budget ceiling. Routines need the same hooks, and two owners
 * quietly overwriting each other would be the worst possible failure: a turn would resume in
 * the wrong conversation, with the wrong budget, under the wrong authorization.
 *
 * So ownership is explicit and exclusive. Every hook asks all registered domains and fails
 * closed when more than one claims the same turn: a turn has exactly one owner, and an
 * ambiguity is a bug to surface, never a race to resolve by registration order.
 */
export interface ScopeOwner {
  /** Stable name used only to explain an ownership conflict. */
  readonly domain: string
}

export class OwnershipConflict extends HostError {
  constructor(
    readonly turnId: string,
    readonly owners: string[]
  ) {
    super('TURN_OWNERSHIP_CONFLICT', `Esta tarefa está reivindicada por mais de um domínio (${owners.join(', ')}); nada foi executado.`)
  }
}

type Resolution = ReturnType<ContinuationScope['resolve']>
interface RegisteredScope extends ScopeOwner {
  scope: ContinuationScope
}

/** Exactly one continuation scope may claim an interrupted turn. */
export class CompositeContinuationScope implements ContinuationScope {
  private readonly scopes: RegisteredScope[] = []
  register(domain: string, scope: ContinuationScope) {
    if (this.scopes.some((entry) => entry.domain === domain)) throw new Error(`Continuation scope ${domain} registered twice`)
    this.scopes.push({ domain, scope })
  }
  private claims(interruptedTurnId: string) {
    return this.scopes
      .map((entry) => ({ domain: entry.domain, scope: entry.scope, value: entry.scope.resolve(interruptedTurnId) }))
      .filter((entry) => entry.value !== undefined)
  }
  resolve(interruptedTurnId: string): Resolution {
    const claims = this.claims(interruptedTurnId)
    if (claims.length > 1) throw new OwnershipConflict(interruptedTurnId, claims.map((claim) => claim.domain))
    return claims[0]?.value
  }
  record(input: { interruptedTurnId: string; turn: BotTurn; operationId: string; limits: TurnSnapshot['limits'] }) {
    const claims = this.claims(input.interruptedTurnId)
    if (claims.length > 1) throw new OwnershipConflict(input.interruptedTurnId, claims.map((claim) => claim.domain))
    claims[0]?.scope.record(input)
  }
}

export type DispatchGuard = (turnId: string) => { code: string; message: string } | undefined
/**
 * Every guard runs; the first refusal wins. Guards are allowed to overlap because refusing is
 * safe: a turn blocked by any domain must not reach a guest.
 */
export function composeDispatchGuards(...guards: (DispatchGuard | undefined)[]): DispatchGuard {
  return (turnId) => {
    for (const guard of guards) {
      const blocked = guard?.(turnId)
      if (blocked) return blocked
    }
    return undefined
  }
}

export type BudgetCeiling = (turnId: string) => { activeMs: number; maxTools: number } | undefined
/** A continuation may never be handed a fresh standalone allowance by a second owner. */
export function composeBudgetCeilings(owners: { domain: string; ceiling: BudgetCeiling }[]): BudgetCeiling {
  return (turnId) => {
    const claims = owners.map((owner) => ({ domain: owner.domain, value: owner.ceiling(turnId) })).filter((claim) => claim.value !== undefined)
    if (claims.length > 1) throw new OwnershipConflict(turnId, claims.map((claim) => claim.domain))
    return claims[0]?.value
  }
}

/** Turn observers are notifications, not decisions: all of them run, and one failure never stops the others. */
export function composeTurnObservers(...observers: ((turnId: string) => void)[]) {
  return (turnId: string) => {
    for (const observer of observers)
      try {
        observer(turnId)
      } catch {
        /* an observer must never break the turn engine */
      }
  }
}

/**
 * Host-generated conversation for scoped work. The identifier is derived from the work, so a
 * retry can never open a second thread, and it is never the bot's own conversation: private
 * memory and private history stay out of scheduled work by construction.
 */
export function scopedConversation(repo: BotRepository, id: string, botId: string, conflictCode: string, conflictMessage: string): BotConversation {
  try {
    const existing = repo.conversation(id)
    if (existing.botId !== botId) throw new HostError(conflictCode, conflictMessage)
    return existing
  } catch (error) {
    if (error instanceof HostError && error.code === conflictCode) throw error
    const created: BotConversation = {
      id,
      botId,
      title: '',
      contextRevision: 0,
      lastSequence: 0,
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    }
    repo.saveConversation(created)
    return created
  }
}
