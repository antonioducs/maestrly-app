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
const chars = (entries: readonly FleetOwnerMemoryEntry[]) =>
  entries.reduce((sum, entry) => sum + entry.content.length, 0)
/**
 * The characters of the owner memory that reach a prompt. The bots of an environment see the global entries and the
 * environment's own; for the global entries (`null`) it is the largest of those prompts.
 */
export function promptChars(active: readonly FleetOwnerMemoryEntry[], environmentId: string | null): number {
  const global = chars(active.filter((entry) => entry.environmentId === null))
  if (environmentId !== null) return global + chars(active.filter((entry) => entry.environmentId === environmentId))
  const scoped = new Map<string, number>()
  for (const entry of active)
    if (entry.environmentId !== null)
      scoped.set(entry.environmentId, (scoped.get(entry.environmentId) ?? 0) + entry.content.length)
  return global + Math.max(0, ...scoped.values())
}
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

/**
 * The owner memory: facts about the owner, global or scoped to an environment. The owner sees and changes every
 * entry. A bot sees the global entries and its environment's, and changes only its environment's: global entries
 * and other environments' are never changed by a bot, and nothing of another environment reaches it.
 */
export class OwnerMemory {
  constructor(
    private readonly store: Store,
    private readonly lifecycle: Lifecycle,
    private readonly now = () => new Date()
  ) {}

  /** Every entry, as the owner sees them; `activeChars` is the largest prompt they make. */
  list(status: 'active' | 'all' = 'all'): FleetOwnerMemory {
    return {
      revision: this.store.ownerMemoryRevision(),
      activeChars: promptChars(this.store.ownerMemories('active'), null),
      entries: this.store.ownerMemories(status === 'active' ? 'active' : undefined),
    }
  }

  /** The active entries a bot sees: the global ones and its environment's. */
  listFor(botId: string): FleetOwnerMemory {
    const environmentId = this.environmentOf(botId)
    const entries = this.store.ownerMemories('active', environmentId)
    return {
      revision: this.store.ownerMemoryRevision(),
      activeChars: chars(entries),
      entries: entries.map((entry) => this.visibleTo(entry, environmentId)),
    }
  }

  save(
    author: OwnerMemoryAuthor,
    input: {
      content: string
      replacesId?: string
      origin?: FleetOwnerMemoryOrigin
      environmentId?: string | null
    }
  ): FleetOwnerMemoryEntry {
    const content = validContent(input.content)
    // A bot's entries belong to its environment; the owner's are global unless the owner scopes them.
    const environmentId = author.kind === 'bot' ? this.environmentOf(author.botId) : (input.environmentId ?? null)
    if (author.kind === 'owner' && environmentId !== null) this.requireEnvironment(environmentId)
    const same = (entry: FleetOwnerMemoryEntry) => entry.content.toLocaleLowerCase() === content.toLocaleLowerCase()
    const result = this.store.transaction(() => {
      const active = this.store.ownerMemories('active')
      // The entries the new one joins in a prompt, and those its author may replace.
      const alongside = active.filter((entry) => entry.environmentId === null || entry.environmentId === environmentId)
      const replaceable =
        author.kind === 'bot' ? active.filter((entry) => entry.environmentId === environmentId) : active
      const duplicate = alongside.find(same)
      const replaced = input.replacesId ? this.resolveActive(replaceable, input.replacesId) : undefined
      if (replaced && same(replaced)) return { entry: replaced, changed: false }
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
        environmentId,
        createdAt: at,
        updatedAt: at,
      }
      const after = [...active.filter((item) => item.id !== replaced?.id), entry]
      if (promptChars(after, environmentId) > FLEET_OWNER_MEMORY_LIMITS.activeCharsMax)
        throw new GatewayError(
          'CONFLICT',
          `Owner memory is full (${promptChars(active, environmentId)}/${FLEET_OWNER_MEMORY_LIMITS.activeCharsMax} characters). Replace or forget outdated entries first.`
        )
      this.store.saveOwnerMemory(entry)
      if (replaced)
        this.store.saveOwnerMemory({ ...replaced, status: 'superseded', replacedById: entry.id, updatedAt: at })
      return { entry, changed: true }
    })
    if (result.changed) this.changed(author, 'owner_memory_saved', result.entry)
    return author.kind === 'bot' && environmentId !== null ? this.visibleTo(result.entry, environmentId) : result.entry
  }

  /** A bot archives an entry of its environment. */
  forget(botId: string, id: string, reason: string): FleetOwnerMemoryEntry {
    const environmentId = this.environmentOf(botId)
    const entry = this.resolveActive(
      this.store.ownerMemories('active', environmentId).filter((item) => item.environmentId === environmentId),
      id
    )
    const archived = { ...entry, status: 'archived' as const, updatedAt: this.now().toISOString() }
    this.store.saveOwnerMemory(archived)
    this.changed({ kind: 'bot', botId }, 'owner_memory_forgotten', archived, reason)
    return this.visibleTo(archived, environmentId)
  }

  /** The owner edits, archives, restores or moves an entry: `environmentId` null makes it global. */
  patch(
    id: string,
    patch: { content?: string; status?: 'active' | 'archived'; environmentId?: string | null }
  ): FleetOwnerMemoryEntry {
    const result = this.store.transaction(() => {
      const entry = this.store.ownerMemoryById(id)
      if (!entry) throw new GatewayError('NOT_FOUND', 'Owner memory entry not found')
      const environmentId = patch.environmentId === undefined ? entry.environmentId : patch.environmentId
      if (environmentId !== null && environmentId !== entry.environmentId) this.requireEnvironment(environmentId)
      const content = patch.content === undefined ? entry.content : validContent(patch.content)
      const status =
        patch.status ?? (entry.status === 'superseded' && patch.content !== undefined ? 'active' : entry.status)
      if (content === entry.content && status === entry.status && environmentId === entry.environmentId)
        return { entry, changed: false }
      const next = { ...entry, content, status, environmentId, updatedAt: this.now().toISOString() }
      if (status === 'active') {
        const others = this.store.ownerMemories('active').filter((item) => item.id !== id)
        if (promptChars([...others, next], environmentId) > FLEET_OWNER_MEMORY_LIMITS.activeCharsMax)
          throw new GatewayError(
            'CONFLICT',
            `Owner memory is full (${promptChars(others, environmentId)}/${FLEET_OWNER_MEMORY_LIMITS.activeCharsMax} characters). Archive another entry first.`
          )
      }
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

  private environmentOf(botId: string): string {
    const environmentId = this.store.botPlacement(botId)?.environmentId
    if (!environmentId) throw new GatewayError('NOT_FOUND', 'Bot not found')
    return environmentId
  }

  private requireEnvironment(id: string) {
    const environment = this.store.getEnvironment(id)
    if (!environment || environment.archivedAt) throw new GatewayError('NOT_FOUND', 'Environment not found')
  }

  /** An entry as a bot of `environmentId` sees it: links to entries it cannot see are left out. */
  private visibleTo(entry: FleetOwnerMemoryEntry, environmentId: string): FleetOwnerMemoryEntry {
    const seen = (id: string | null) => {
      if (!id) return null
      const linked = this.store.ownerMemoryById(id)
      return linked && (linked.environmentId === null || linked.environmentId === environmentId) ? id : null
    }
    return { ...entry, replacesId: seen(entry.replacesId), replacedById: seen(entry.replacedById) }
  }

  /**
   * The entry an id (or a unique prefix of at least 8 characters) names among `active`. The answer is the same when
   * the id names nothing and when it names an entry the caller may not change.
   */
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
