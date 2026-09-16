import { randomUUID } from 'node:crypto'
import { type TeamMemory } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { TeamRepository, now } from './repository.js'

/**
 * Team memory is versioned text owned by the person. A bot can only propose; a proposal is
 * inert until someone approves it. Removing a memory stops future injections — it cannot
 * erase text that already reached a thread or a file, and nothing here claims otherwise.
 */
export class TeamMemories {
  constructor(private readonly teams: TeamRepository) {}

  list(teamId: string, includeInactive: boolean) {
    return this.teams.memories(teamId, includeInactive)
  }
  proposals(teamId: string) {
    return this.teams.proposals(teamId)
  }
  upsert(teamId: string, input: { memoryId?: string; expectedRevision?: number; content: string }): TeamMemory {
    return this.teams.transaction(() => {
      if (!input.memoryId) {
        const memory: TeamMemory = {
          id: randomUUID(),
          teamId,
          content: input.content,
          origin: 'user',
          status: 'active',
          version: 1,
          revision: 0,
          createdAt: now(),
          updatedAt: now(),
        }
        this.teams.saveMemory(memory)
        return memory
      }
      const current = this.teams.memory(input.memoryId)
      if (current.teamId !== teamId) throw new HostError('NOT_FOUND', 'Esta memória pertence a outra equipe')
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)
        throw new HostError('REVISION_CONFLICT', 'A memória mudou; recarregue antes de editar')
      const updated: TeamMemory = {
        ...current,
        content: input.content,
        origin: 'user',
        status: 'active',
        version: current.version + 1,
        revision: current.revision + 1,
        updatedAt: now(),
      }
      this.teams.saveMemory(updated)
      return updated
    })
  }
  remove(teamId: string, memoryId: string, expectedRevision: number): TeamMemory {
    return this.teams.transaction(() => {
      const current = this.teams.memory(memoryId)
      if (current.teamId !== teamId) throw new HostError('NOT_FOUND', 'Esta memória pertence a outra equipe')
      if (current.revision !== expectedRevision) throw new HostError('REVISION_CONFLICT', 'A memória mudou; recarregue antes de remover')
      const removed: TeamMemory = { ...current, status: 'removed', revision: current.revision + 1, updatedAt: now() }
      this.teams.saveMemory(removed)
      return removed
    })
  }
  /** A bot proposal: recorded with its author, never activated by the proposal itself. */
  propose(teamId: string, botId: string, content: string): TeamMemory {
    return this.teams.transaction(() => {
      const memory: TeamMemory = {
        id: randomUUID(),
        teamId,
        content,
        origin: 'bot',
        proposedByBotId: botId,
        status: 'proposed',
        version: 1,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      }
      this.teams.saveMemory(memory)
      return memory
    })
  }
  decide(teamId: string, memoryId: string, expectedRevision: number, decision: 'approve' | 'discard'): TeamMemory {
    return this.teams.transaction(() => {
      const current = this.teams.memory(memoryId)
      if (current.teamId !== teamId) throw new HostError('NOT_FOUND', 'Esta memória pertence a outra equipe')
      if (current.status !== 'proposed') throw new HostError('INVALID_STATE', 'Esta memória não é uma proposta pendente')
      if (current.revision !== expectedRevision) throw new HostError('REVISION_CONFLICT', 'A proposta mudou; recarregue antes de decidir')
      const decided: TeamMemory = {
        ...current,
        status: decision === 'approve' ? 'active' : 'removed',
        revision: current.revision + 1,
        updatedAt: now(),
      }
      this.teams.saveMemory(decided)
      return decided
    })
  }
  /** Versions consulted by one run, recorded so a later edit does not rewrite history. */
  snapshot(teamId: string) {
    return this.teams.memories(teamId, false).map((memory) => ({ id: memory.id, version: memory.version }))
  }
}
