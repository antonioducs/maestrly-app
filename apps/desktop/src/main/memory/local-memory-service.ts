import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  LOCAL_MEMORY_SOURCES,
  LOCAL_MEMORY_STATUSES,
  MEMORY_TYPES,
  type LocalMemory,
  type LocalMemoryCreateInput,
  type LocalMemoryFilters,
  type LocalMemoryMutationResult,
  type LocalMemoryUpdateInput,
  type MemoryChangeEvent,
} from '../../shared/memory'
import {
  getLocalMemoryByHash,
  getLocalMemoryRow,
  listLocalMemoryRows,
  rowToLocalMemory,
} from '../store/local-memories'
import { getDb, transaction } from '../store/db'

const events = new EventEmitter()
events.setMaxListeners(50)

const MAX_TITLE = 240
const MAX_CONTENT = 256 * 1024
const MAX_SCOPE = 500
const MAX_TAGS = 64
const MAX_TAG = 80

function requiredText(value: string, name: string, max: number): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} is required`)
  if (normalized.length > max) throw new Error(`${name} exceeds ${max} characters`)
  return normalized
}

function optionalText(value: string | undefined | null, name: string, max: number): string | undefined {
  if (value == null) return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > max) throw new Error(`${name} exceeds ${max} characters`)
  return normalized
}

function normalizeTags(tags: string[] | undefined): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of tags ?? []) {
    const tag = requiredText(raw, 'tag', MAX_TAG).toLocaleLowerCase()
    if (seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
    if (result.length > MAX_TAGS) throw new Error(`tags exceeds ${MAX_TAGS} entries`)
  }
  return result.sort()
}

function assertEnum<T extends string>(value: string, choices: readonly T[], name: string): asserts value is T {
  if (!choices.includes(value as T)) throw new Error(`invalid ${name}: ${value}`)
}

export function localMemoryContentHash(content: string): string {
  return createHash('sha256').update(content.replaceAll('\r\n', '\n').trim()).digest('hex')
}

function assertSupersedes(workspaceId: string, memoryId: string, supersedesId: string | undefined): void {
  if (!supersedesId) return
  if (supersedesId === memoryId) throw new Error('a memory cannot supersede itself')
  const target = getLocalMemoryRow(supersedesId)
  if (!target || target.workspace_id !== workspaceId) throw new Error('supersedes_id must reference the same workspace')
  const seen = new Set([memoryId])
  let cursor = target
  while (cursor) {
    if (seen.has(cursor.id)) throw new Error('supersedes_id would create a cycle')
    seen.add(cursor.id)
    if (!cursor.supersedes_id) break
    cursor = getLocalMemoryRow(cursor.supersedes_id)!
    if (!cursor) break
  }
}

function emit(event: MemoryChangeEvent): void {
  queueMicrotask(() => events.emit('change', event))
}

export function onLocalMemoryChange(listener: (event: MemoryChangeEvent) => void): () => void {
  events.on('change', listener)
  return () => events.off('change', listener)
}

export function getLocalMemory(workspaceId: string, id: string): LocalMemory | undefined {
  const row = getLocalMemoryRow(id)
  return row?.workspace_id === workspaceId ? rowToLocalMemory(row) : undefined
}

export function listLocalMemories(workspaceId: string, filters: LocalMemoryFilters = {}): LocalMemory[] {
  return listLocalMemoryRows(workspaceId, filters).map((row) => rowToLocalMemory(row)!)
}

export function createLocalMemory(input: LocalMemoryCreateInput): LocalMemoryMutationResult {
  assertEnum(input.type, MEMORY_TYPES, 'memory type')
  assertEnum(input.source, LOCAL_MEMORY_SOURCES, 'memory source')
  const id = optionalText(input.id, 'id', 200) ?? randomUUID()
  const title = requiredText(input.title, 'title', MAX_TITLE)
  const content = requiredText(input.content, 'content', MAX_CONTENT)
  const scope = optionalText(input.scope, 'scope', MAX_SCOPE) ?? ''
  const tags = normalizeTags(input.tags)
  const contentHash = localMemoryContentHash(content)
  const duplicate = getLocalMemoryByHash(input.workspaceId, contentHash)
  if (duplicate) return { memory: rowToLocalMemory(duplicate)!, duplicate: true, changed: false }
  assertSupersedes(input.workspaceId, id, input.supersedesId)
  const now = Date.now()
  const importance = Math.max(0, Math.min(100, Math.trunc(input.importance ?? 0)))
  transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO local_memories
         (id, workspace_id, title, content, type, status, scope, tags_json, importance, pinned, source,
          origin_conversation_id, origin_message_id, supersedes_id, promoted_path, content_hash,
          created_at, updated_at, last_used_at, use_count)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 0)`,
      )
      .run(
        id,
        input.workspaceId,
        title,
        content,
        input.type,
        scope,
        JSON.stringify(tags),
        importance,
        input.pinned ? 1 : 0,
        input.source,
        optionalText(input.originConversationId, 'originConversationId', 200) ?? null,
        optionalText(input.originMessageId, 'originMessageId', 200) ?? null,
        input.supersedesId ?? null,
        contentHash,
        now,
        now,
      )
    if (input.supersedesId) {
      getDb().prepare("UPDATE local_memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(
        now,
        input.supersedesId,
      )
    }
  })
  const memory = getLocalMemory(input.workspaceId, id)!
  emit({ workspaceId: input.workspaceId, kind: 'created', memoryId: id })
  return { memory, duplicate: false, changed: true }
}

export function updateLocalMemory(
  workspaceId: string,
  id: string,
  patch: LocalMemoryUpdateInput,
): LocalMemoryMutationResult {
  const current = getLocalMemory(workspaceId, id)
  if (!current) throw new Error('memory not found')
  const title = patch.title === undefined ? current.title : requiredText(patch.title, 'title', MAX_TITLE)
  const content = patch.content === undefined ? current.content : requiredText(patch.content, 'content', MAX_CONTENT)
  const type = patch.type ?? current.type
  const status = patch.status ?? current.status
  assertEnum(type, MEMORY_TYPES, 'memory type')
  assertEnum(status, LOCAL_MEMORY_STATUSES, 'memory status')
  const scope = patch.scope === undefined ? current.scope : (optionalText(patch.scope, 'scope', MAX_SCOPE) ?? '')
  const tags = patch.tags === undefined ? current.tags : normalizeTags(patch.tags)
  const importance =
    patch.importance === undefined ? current.importance : Math.max(0, Math.min(100, Math.trunc(patch.importance)))
  const pinned = patch.pinned ?? current.pinned
  const supersedesId = patch.supersedesId === undefined ? current.supersedesId : (patch.supersedesId ?? undefined)
  const promotedPath =
    patch.promotedPath === undefined
      ? current.promotedPath
      : optionalText(patch.promotedPath, 'promotedPath', 2_000)
  assertSupersedes(workspaceId, id, supersedesId)
  const contentHash = localMemoryContentHash(content)
  const duplicate = getLocalMemoryByHash(workspaceId, contentHash)
  if (duplicate && duplicate.id !== id) return { memory: rowToLocalMemory(duplicate)!, duplicate: true, changed: false }
  const changed =
    title !== current.title ||
    content !== current.content ||
    type !== current.type ||
    status !== current.status ||
    scope !== current.scope ||
    JSON.stringify(tags) !== JSON.stringify(current.tags) ||
    importance !== current.importance ||
    pinned !== current.pinned ||
    supersedesId !== current.supersedesId ||
    promotedPath !== current.promotedPath
  if (!changed) return { memory: current, duplicate: false, changed: false }
  const now = Date.now()
  transaction(() => {
    getDb()
      .prepare(
        `UPDATE local_memories SET title = ?, content = ?, type = ?, status = ?, scope = ?, tags_json = ?,
         importance = ?, pinned = ?, supersedes_id = ?, promoted_path = ?, content_hash = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      )
      .run(
        title,
        content,
        type,
        status,
        scope,
        JSON.stringify(tags),
        importance,
        pinned ? 1 : 0,
        supersedesId ?? null,
        promotedPath ?? null,
        contentHash,
        now,
        id,
        workspaceId,
      )
    if (supersedesId && supersedesId !== current.supersedesId) {
      getDb().prepare("UPDATE local_memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(
        now,
        supersedesId,
      )
    }
  })
  emit({ workspaceId, kind: 'updated', memoryId: id })
  return { memory: getLocalMemory(workspaceId, id)!, duplicate: false, changed: true }
}

export function archiveLocalMemory(workspaceId: string, id: string): LocalMemory {
  const result = updateLocalMemory(workspaceId, id, { status: 'archived' }).memory
  emit({ workspaceId, kind: 'archived', memoryId: id })
  return result
}

export function restoreLocalMemory(workspaceId: string, id: string): LocalMemory {
  const result = updateLocalMemory(workspaceId, id, { status: 'active' }).memory
  emit({ workspaceId, kind: 'restored', memoryId: id })
  return result
}

export function forgetLocalMemory(workspaceId: string, id: string): boolean {
  const result = getDb().prepare('DELETE FROM local_memories WHERE id = ? AND workspace_id = ?').run(id, workspaceId)
  const forgotten = Number(result.changes) > 0
  if (forgotten) emit({ workspaceId, kind: 'forgotten', memoryId: id })
  return forgotten
}

export function markLocalMemoriesUsed(workspaceId: string, ids: string[], at = Date.now()): void {
  const unique = [...new Set(ids)].slice(0, 20)
  if (unique.length === 0) return
  transaction(() => {
    const statement = getDb().prepare(
      'UPDATE local_memories SET last_used_at = ?, use_count = use_count + 1 WHERE workspace_id = ? AND id = ?',
    )
    for (const id of unique) statement.run(at, workspaceId, id)
  })
}
