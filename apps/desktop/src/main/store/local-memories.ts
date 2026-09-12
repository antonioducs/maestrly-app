import type {
  LocalMemory,
  LocalMemoryFilters,
  LocalMemorySource,
  LocalMemoryStatus,
  MemoryType,
} from '../../shared/memory'
import { getDb } from './db'

export interface LocalMemoryRow {
  id: string
  workspace_id: string
  title: string
  content: string
  type: string
  status: string
  scope: string
  tags_json: string
  importance: number
  pinned: number
  source: string
  origin_conversation_id: string | null
  origin_message_id: string | null
  supersedes_id: string | null
  promoted_path: string | null
  content_hash: string
  created_at: number
  updated_at: number
  last_used_at: number | null
  use_count: number
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

export function rowToLocalMemory(row: LocalMemoryRow | undefined): LocalMemory | undefined {
  if (!row) return undefined
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    content: row.content,
    type: row.type as MemoryType,
    status: row.status as LocalMemoryStatus,
    scope: row.scope,
    tags: parseTags(row.tags_json),
    importance: row.importance,
    pinned: row.pinned === 1,
    source: row.source as LocalMemorySource,
    ...(row.origin_conversation_id ? { originConversationId: row.origin_conversation_id } : {}),
    ...(row.origin_message_id ? { originMessageId: row.origin_message_id } : {}),
    ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
    ...(row.promoted_path ? { promotedPath: row.promoted_path } : {}),
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_used_at == null ? {} : { lastUsedAt: row.last_used_at }),
    useCount: row.use_count,
  }
}

export function getLocalMemoryRow(id: string): LocalMemoryRow | undefined {
  return getDb().prepare('SELECT * FROM local_memories WHERE id = ?').get(id) as LocalMemoryRow | undefined
}

export function getLocalMemoryByHash(workspaceId: string, contentHash: string): LocalMemoryRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM local_memories
       WHERE workspace_id = ? AND content_hash = ? AND status <> 'archived'
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
    )
    .get(workspaceId, contentHash) as LocalMemoryRow | undefined
}

export function listLocalMemoryRows(workspaceId: string, filters: LocalMemoryFilters = {}): LocalMemoryRow[] {
  const clauses = ['workspace_id = ?']
  const params: Array<string | number> = [workspaceId]
  const addList = (column: string, value: string | string[] | undefined) => {
    if (!value) return
    const values = Array.isArray(value) ? value : [value]
    if (values.length === 0) return
    clauses.push(`${column} IN (${values.map(() => '?').join(',')})`)
    params.push(...values)
  }
  addList('status', filters.status)
  addList('type', filters.type)
  addList('source', filters.source)
  if (filters.pinned !== undefined) {
    clauses.push('pinned = ?')
    params.push(filters.pinned ? 1 : 0)
  }
  if (filters.scope) {
    clauses.push('(scope = ? OR scope LIKE ?)')
    params.push(filters.scope, `${filters.scope}/%`)
  }
  if (filters.tag) {
    clauses.push("EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags_json) THEN tags_json ELSE '[]' END) WHERE value = ?)")
    params.push(filters.tag)
  }
  if (filters.query?.trim()) {
    const pattern = `%${filters.query.trim().replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR scope LIKE ? ESCAPE '\\')")
    params.push(pattern, pattern, pattern)
  }
  if (filters.updatedAfter !== undefined) {
    clauses.push('updated_at >= ?')
    params.push(filters.updatedAfter)
  }
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 500))
  const offset = Math.max(0, filters.offset ?? 0)
  params.push(limit, offset)
  return getDb()
    .prepare(
      `SELECT * FROM local_memories WHERE ${clauses.join(' AND ')}
       ORDER BY pinned DESC, updated_at DESC, id ASC LIMIT ? OFFSET ?`,
    )
    .all(...params) as unknown as LocalMemoryRow[]
}

export function countLocalMemories(workspaceId: string, status?: LocalMemoryStatus): number {
  const row = status
    ? (getDb().prepare('SELECT COUNT(*) AS count FROM local_memories WHERE workspace_id = ? AND status = ?').get(
        workspaceId,
        status,
      ) as { count: number })
    : (getDb().prepare('SELECT COUNT(*) AS count FROM local_memories WHERE workspace_id = ?').get(workspaceId) as {
        count: number
      })
  return row.count
}
