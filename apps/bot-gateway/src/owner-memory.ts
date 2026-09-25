import { createHash, randomUUID } from 'node:crypto'
import {
  FLEET_OWNER_MEMORY_LIMITS,
  memoryContentProblem,
  normalizeMemoryText,
  type FleetActivityKind,
  type FleetOwnerMemory,
  type FleetOwnerMemoryEntry,
  type FleetOwnerMemoryOrigin,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'
import type { Lifecycle } from './lifecycle.js'
import type { Store } from './store.js'

export type OwnerMemoryAuthor = { kind: 'owner' } | { kind: 'bot'; botId: string }
const activeChars = (entries: readonly FleetOwnerMemoryEntry[]) =>
  entries.reduce((sum, entry) => sum + entry.content.length, 0)
export const ownerMemoryRequestHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

function validContent(raw: string): string {
  const content = normalizeMemoryText(raw)
  if (!content || content.length > FLEET_OWNER_MEMORY_LIMITS.entryMax)
    throw new GatewayError(
      'INVALID_REQUEST',
      `An owner memory entry needs 1 to ${FLEET_OWNER_MEMORY_LIMITS.entryMax} characters.`
    )
  const problem = memoryContentProblem(content)
  if (problem === 'invisible-characters')
    throw new GatewayError('INVALID_REQUEST', 'Remove invisible characters from the entry.')
  if (problem)
    throw new GatewayError(
      'INVALID_REQUEST',
      'Owner memory cannot store instructions to ignore rules or run downloaded scripts.'
    )
  return content
}

export class OwnerMemory {
  constructor(
    private readonly store: Store,
    private readonly lifecycle: Lifecycle,
    private readonly now = () => new Date()
  ) {}

  list(status: 'active' | 'all' = 'all'): FleetOwnerMemory {
    return {
      revision: this.store.ownerMemoryRevision(),
      activeChars: activeChars(this.store.ownerMemories('active')),
      entries: this.store.ownerMemories(status === 'active' ? 'active' : undefined),
    }
  }

  save(
    author: OwnerMemoryAuthor,
    input: { content: string; replacesId?: string; origin?: FleetOwnerMemoryOrigin }
  ): FleetOwnerMemoryEntry {
    const content = validContent(input.content)
    const result = this.store.transaction(() => {
      const active = this.store.ownerMemories('active')
      const duplicate = active.find((entry) => entry.content.toLocaleLowerCase() === content.toLocaleLowerCase())
      const replaced = input.replacesId ? this.resolveActive(active, input.replacesId) : undefined
      if (replaced?.content.toLocaleLowerCase() === content.toLocaleLowerCase())
        return { entry: replaced, changed: false }
      if (duplicate) {
        if (!replaced) return { entry: duplicate, changed: false }
        this.store.saveOwnerMemory({
          ...replaced,
          status: 'superseded',
          replacedById: duplicate.id,
          updatedAt: this.now().toISOString(),
        })
        return { entry: duplicate, changed: true }
      }
      const used = activeChars(active)
      if (used - (replaced?.content.length ?? 0) + content.length > FLEET_OWNER_MEMORY_LIMITS.activeCharsMax)
        throw new GatewayError(
          'CONFLICT',
          `Owner memory is full (${used}/${FLEET_OWNER_MEMORY_LIMITS.activeCharsMax} characters). Replace or forget outdated entries first.`
        )
      const at = this.now().toISOString()
      const entry: FleetOwnerMemoryEntry = {
        id: randomUUID(),
        content,
        status: 'active',
        author:
          author.kind === 'bot'
            ? { kind: 'bot', botId: author.botId, name: this.store.getBot(author.botId)?.name ?? author.botId }
            : { kind: 'owner' },
        origin: author.kind === 'bot' ? (input.origin ?? null) : null,
        replacesId: replaced?.id ?? null,
        replacedById: null,
        createdAt: at,
        updatedAt: at,
      }
      this.store.saveOwnerMemory(entry)
      if (replaced)
        this.store.saveOwnerMemory({ ...replaced, status: 'superseded', replacedById: entry.id, updatedAt: at })
      return { entry, changed: true }
    })
    if (result.changed) this.changed(author, 'owner_memory_saved', result.entry)
    return result.entry
  }

  forget(botId: string, id: string, reason: string): FleetOwnerMemoryEntry {
    const entry = this.resolveActive(this.store.ownerMemories('active'), id)
    const archived = { ...entry, status: 'archived' as const, updatedAt: this.now().toISOString() }
    this.store.saveOwnerMemory(archived)
    this.changed({ kind: 'bot', botId }, 'owner_memory_forgotten', archived, reason)
    return archived
  }

  patch(id: string, patch: { content?: string; status?: 'active' | 'archived' }): FleetOwnerMemoryEntry {
    const result = this.store.transaction(() => {
      const entry = this.store.ownerMemoryById(id)
      if (!entry) throw new GatewayError('NOT_FOUND', 'Owner memory entry not found')
      const content = patch.content === undefined ? entry.content : validContent(patch.content)
      const status =
        patch.status ?? (entry.status === 'superseded' && patch.content !== undefined ? 'active' : entry.status)
      if (content === entry.content && status === entry.status) return { entry, changed: false }
      if (status === 'active') {
        const others = this.store.ownerMemories('active').filter((item) => item.id !== id)
        if (activeChars(others) + content.length > FLEET_OWNER_MEMORY_LIMITS.activeCharsMax)
          throw new GatewayError(
            'CONFLICT',
            `Owner memory is full (${activeChars(others)}/${FLEET_OWNER_MEMORY_LIMITS.activeCharsMax} characters). Archive another entry first.`
          )
      }
      const next = { ...entry, content, status, updatedAt: this.now().toISOString() }
      this.store.saveOwnerMemory(next)
      return { entry: next, changed: true }
    })
    if (result.changed) this.changed({ kind: 'owner' }, null, result.entry)
    return result.entry
  }

  delete(id: string) {
    if (!this.store.ownerMemoryById(id)) throw new GatewayError('NOT_FOUND', 'Owner memory entry not found')
    this.store.deleteOwnerMemory(id)
    this.changed({ kind: 'owner' }, null, null)
  }

  private resolveActive(active: FleetOwnerMemoryEntry[], id: string): FleetOwnerMemoryEntry {
    const exact = active.find((entry) => entry.id === id)
    if (exact) return exact
    const matches = id.length >= 8 ? active.filter((entry) => entry.id.startsWith(id)) : []
    if (matches.length === 1) return matches[0]
    throw new GatewayError(
      'NOT_FOUND',
      'No unique active owner memory entry matches. Use the id shown in your memory (or its full id) and try again.'
    )
  }

  private changed(
    author: OwnerMemoryAuthor,
    kind: FleetActivityKind | null,
    entry: FleetOwnerMemoryEntry | null,
    reason?: string
  ) {
    const revision = this.store.bumpOwnerMemoryRevision()
    if (author.kind === 'bot' && kind && entry)
      this.lifecycle.recordActivity(author.botId, kind, entry.content.slice(0, 160), {
        entryId: entry.id,
        ...(reason ? { reason: reason.slice(0, 160) } : {}),
      })
    this.lifecycle.onEvent({ type: 'owner_memory.updated', at: this.now().toISOString(), revision })
  }
}
