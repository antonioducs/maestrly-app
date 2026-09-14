import { randomUUID } from 'node:crypto'
import type { BotMemory } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { type BotRepository, now } from './repository.js'

/** Per-bot inspectable memory. Removing a memory never rewrites past conversation content. */
export class BotMemories {
  constructor(private readonly repo: BotRepository) {}
  list(botId: string, includeInactive: boolean) {
    this.repo.bot(botId)
    return this.repo.memories(botId, includeInactive)
  }
  upsert(botId: string, input: { memoryId?: string; expectedRevision?: number; content: string; active: boolean; origin?: 'user' | 'bot'; sourceMessageId?: string; turnId?: string }) {
    return this.repo.transaction(() => {
      this.repo.bot(botId)
      if (input.memoryId) {
        const existing = this.repo.memory(input.memoryId)
        if (existing.botId !== botId) throw new HostError('NOT_FOUND', 'Memory not found')
        if (input.expectedRevision === undefined || existing.revision !== input.expectedRevision)
          throw new HostError('REVISION_CONFLICT', 'Esta memória mudou; recarregue antes de editar')
        const updated: BotMemory = { ...existing, content: input.content, active: input.active, revision: existing.revision + 1, updatedAt: now() }
        this.repo.saveMemory(updated)
        return updated
      }
      if (this.repo.memories(botId, true).length >= 256) throw new HostError('LIMIT', 'Este bot já tem o máximo de memórias; remova algumas antes de adicionar')
      const memory: BotMemory = {
        id: randomUUID(),
        botId,
        content: input.content,
        origin: input.origin ?? 'user',
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        active: input.active,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      }
      this.repo.saveMemory(memory)
      return memory
    })
  }
  delete(botId: string, memoryId: string, expectedRevision: number) {
    return this.repo.transaction(() => {
      const existing = this.repo.memory(memoryId)
      if (existing.botId !== botId) throw new HostError('NOT_FOUND', 'Memory not found')
      if (existing.revision !== expectedRevision) throw new HostError('REVISION_CONFLICT', 'Esta memória mudou; recarregue antes de remover')
      this.repo.deleteMemory(memoryId)
      return { ...existing, active: false, revision: existing.revision + 1, updatedAt: now() }
    })
  }
}
