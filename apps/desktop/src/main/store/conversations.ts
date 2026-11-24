import { normalizeConversationExperience, type ConversationExperience } from '../../shared/conversation-experience'
import type {
  Conversation,
  ConversationDispatchOrigin,
  ProjectConversation,
  StandaloneConversation,
  ConversationMode,
  ConversationStatus,
  ConvRepo,
  ConvUiPrefs,
} from '../../shared/conversation'
export type {
  Conversation,
  ConversationDispatchOrigin,
  ProjectConversation,
  StandaloneConversation,
  ConversationMode,
  ConversationStatus,
  ConvRepo,
  ConvUiPrefs,
  FloatingBounds,
} from '../../shared/conversation'
import { requireProjectConversation } from '../../shared/conversation-scope'
import { getDb, transaction } from './db'
import { getDefaultMainTabOrder } from './settings'

/**
 * Transactionally reorder workspace conversations with dense positions. Visible sidebar IDs move among
 * their slots; omitted archived entries retain absolute slots. Ignore foreign-workspace IDs.
 */
export function setConversationOrder(workspaceId: string, ids: string[]): void {
  setScopedConversationOrder(workspaceId, ids)
}

export function setStandaloneConversationOrder(ids: string[]): void {
  setScopedConversationOrder(null, ids)
}

function setScopedConversationOrder(workspaceId: string | null, ids: string[]): void {
  const base = (
    getDb()
      .prepare(
        'SELECT id FROM conversations WHERE scope = ? AND workspace_id IS ? ORDER BY position ASC, created_at ASC'
      )
      .all(workspaceId === null ? 'standalone' : 'project', workspaceId) as Array<{ id: string }>
  ).map((r) => r.id)
  const baseSet = new Set(base)
  const wanted: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (baseSet.has(id) && !seen.has(id)) {
      seen.add(id)
      wanted.push(id)
    }
  }
  if (wanted.length === 0) return
  const queue = [...wanted]
  const final = base.map((id) => (seen.has(id) ? queue.shift()! : id))
  transaction(() => {
    const stmt = getDb().prepare('UPDATE conversations SET position = ? WHERE id = ?')
    final.forEach((id, i) => stmt.run(i, id))
  })
}

// ---- conversations ----

export function insertConversation(c: Conversation): void {
  // Append every new conversation at workspace MAX+1. Seed configured global drawer-tab order only at
  // insertion; existing conversations remain unchanged. Preserve supplied ui_prefs or the historical empty
  // object when no default exists.
  const def = getDefaultMainTabOrder()
  const uiPrefs = c.uiPrefs ?? (def ? { mainTabOrder: def } : undefined)
  getDb()
    .prepare(
      `INSERT INTO conversations
       (id, scope, workspace_id, name, branch, mode, experience, cwd, status, created_at, archived, pinned_at, last_activity_at, is_multi, ui_prefs, bot_origin, bot_management_state, bot_manual_chat_enabled, folder_owner_id, routine_id, routine_run_id, position)
     VALUES
       (@id, @scope, @workspaceId, @name, @branch, @mode, @experience, @cwd, @status, @createdAt, @archived, @pinnedAt, @lastActivityAt, @isMulti, @uiPrefs, @botOrigin, @botManagementState, @botManualChatEnabled, @folderOwnerId, @routineId, @routineRunId,
        (SELECT COALESCE(MAX(position), -1) + 1 FROM conversations WHERE scope = @scope AND workspace_id IS @workspaceId))`
    )
    .run({
      id: c.id,
      scope: c.scope ?? 'project',
      workspaceId: c.workspaceId,
      name: c.name,
      branch: c.branch,
      mode: c.mode,
      experience: normalizeConversationExperience(c.experience),
      cwd: c.cwd,
      status: c.status,
      createdAt: c.createdAt,
      archived: c.archived,
      pinnedAt: c.pinnedAt,
      lastActivityAt: c.lastActivityAt,
      isMulti: c.isMulti ?? 0,
      uiPrefs: uiPrefs ? JSON.stringify(uiPrefs) : '{}',
      botOrigin: c.botOrigin ? JSON.stringify(c.botOrigin) : null,
      botManagementState: c.botOrigin ? (c.botManagementState ?? 'active') : null,
      // Releasing a bot chat for the person's own messages is their later choice, never a creation default.
      botManualChatEnabled: c.botOrigin && c.botManualChatEnabled ? 1 : 0,
      folderOwnerId: c.scope === 'standalone' ? (c.folderOwnerId ?? null) : null,
      routineId: c.scope === 'standalone' ? (c.routineId ?? null) : null,
      routineRunId: c.scope === 'standalone' ? (c.routineRunId ?? null) : null,
    })
}

/** Insert multi-repository participants in order, primary at position zero. */
export function insertConvRepos(conversationId: string, repos: ConvRepo[]): void {
  const conversation = getConversation(conversationId)
  if (!conversation) throw new Error('Conversation not found.')
  requireProjectConversation(conversation)
  const stmt = getDb().prepare(
    `INSERT INTO conversation_repos
       (conversation_id, workspace_id, repo_top, branch, base, worktree_path, link_name, position)
     VALUES (@conversationId, @workspaceId, @repoTop, @branch, @base, @worktreePath, @linkName, @position)`
  )
  repos.forEach((r, position) =>
    stmt.run({
      conversationId,
      workspaceId: r.workspaceId,
      repoTop: r.repoTop,
      branch: r.branch,
      base: r.base,
      worktreePath: r.worktreePath,
      linkName: r.linkName,
      position,
    })
  )
}

/** Conversation repositories ordered by position. */
export function listConvRepos(conversationId: string): ConvRepo[] {
  return getDb()
    .prepare('SELECT * FROM conversation_repos WHERE conversation_id = ? ORDER BY position ASC')
    .all(conversationId)
    .map(rowToConvRepo)
}

/** Conversation IDs using a workspace as primary or secondary, for removal guards. */
export function listConvIdsByWorkspaceRepo(workspaceId: string): string[] {
  return (
    getDb()
      .prepare('SELECT DISTINCT conversation_id FROM conversation_repos WHERE workspace_id = ?')
      .all(workspaceId) as Array<{ conversation_id: string }>
  ).map((r) => r.conversation_id)
}

/**
 * Move the same conversation between local checkout and migration worktree. Chat history follows its
 * stable ID without copying or a new session.
 */
export function setConversationLocation(
  id: string,
  location: { branch: string; mode: ConversationMode; cwd: string }
): void {
  const conversation = getConversation(id)
  if (!conversation) throw new Error('Conversation not found.')
  requireProjectConversation(conversation)
  const changed = getDb()
    .prepare('UPDATE conversations SET branch = ?, mode = ?, cwd = ? WHERE id = ?')
    .run(location.branch, location.mode, location.cwd, id).changes
  if (Number(changed) !== 1) throw new Error('Conversation not found.')
}

const MAX_DISPATCH_DEPTH = 32
const DISPATCH_ORIGIN_QUERY_CHUNK = 500

interface DispatchEdgeRow {
  destId: string
  sourceId: string
  destName: string
  sourceName: string | null
}

/**
 * Resolve immediate source and chain root for the requested conversations via an indexed
 * recursive lookup starting from `ids`. Discarded/deleted dispatches and cyclic chains are ignored.
 */
export function dispatchOriginsFor(ids: readonly string[]): Map<string, ConversationDispatchOrigin> {
  const origins = new Map<string, ConversationDispatchOrigin>()
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return origins

  const db = getDb()
  const edgeByDest = new Map<string, DispatchEdgeRow>()
  const fallbackNames = new Map<string, string>()
  const names = new Map<string, string>()

  for (let offset = 0; offset < uniqueIds.length; offset += DISPATCH_ORIGIN_QUERY_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + DISPATCH_ORIGIN_QUERY_CHUNK)
    const values = chunk.map(() => '(?)').join(',')
    const rows = db
      .prepare(
        `WITH RECURSIVE
           seeds(id) AS (VALUES ${values}),
           chain(dest_id, source_id, dest_name, depth) AS (
             SELECT d.conversation_id, d.source_conversation_id, d.conversation_name, 0
             FROM conversation_dispatches d
             JOIN seeds ON seeds.id = d.conversation_id
             WHERE d.phase NOT IN ('discarded', 'deleted')
             UNION
             SELECT d.conversation_id, d.source_conversation_id, d.conversation_name, chain.depth + 1
             FROM conversation_dispatches d
             JOIN chain ON d.conversation_id = chain.source_id
             WHERE d.phase NOT IN ('discarded', 'deleted')
               AND chain.depth < ?
           )
         SELECT DISTINCT
           c.dest_id AS destId,
           c.source_id AS sourceId,
           c.dest_name AS destName,
           s.name AS sourceName
         FROM chain c
         LEFT JOIN conversations s ON s.id = c.source_id`
      )
      .all(...chunk, MAX_DISPATCH_DEPTH) as unknown as DispatchEdgeRow[]

    for (const row of rows) {
      edgeByDest.set(row.destId, row)
      if (row.destName) fallbackNames.set(row.destId, row.destName)
      if (row.sourceName) names.set(row.sourceId, row.sourceName)
    }
  }
  if (edgeByDest.size === 0) return origins

  const nameOf = (id: string, fallback = ''): string => names.get(id) ?? fallbackNames.get(id) ?? fallback

  for (const id of uniqueIds) {
    const first = edgeByDest.get(id)
    if (!first) continue
    const visited = new Set<string>([id])
    let currentId = first.sourceId
    let cyclic = false
    let depth = 0
    while (true) {
      if (visited.has(currentId)) {
        cyclic = true
        break
      }
      visited.add(currentId)
      const parent = edgeByDest.get(currentId)
      if (!parent) break
      depth += 1
      if (depth >= MAX_DISPATCH_DEPTH) break
      currentId = parent.sourceId
    }
    if (cyclic) continue
    origins.set(id, {
      sourceConversationId: first.sourceId,
      sourceName: nameOf(first.sourceId, first.destName),
      rootConversationId: currentId,
      rootName: nameOf(currentId, first.destName),
    })
  }
  return origins
}

export function withDispatchOrigin<T extends Conversation>(conversation: T): T {
  const origin = dispatchOriginsFor([conversation.id]).get(conversation.id)
  if (origin) conversation.dispatchOrigin = origin
  return conversation
}

function withDispatchOrigins<T extends Conversation>(conversations: T[]): T[] {
  if (conversations.length === 0) return conversations
  const origins = dispatchOriginsFor(conversations.map((conversation) => conversation.id))
  if (origins.size === 0) return conversations
  for (const conversation of conversations) {
    const origin = origins.get(conversation.id)
    if (origin) conversation.dispatchOrigin = origin
  }
  return conversations
}

export function getConversation(id: string): Conversation | undefined {
  return withRepos(rowToConversation(getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id)))
}

/** Attach repository rows to multi-repository conversations; no-op for single repository. */
function withRepos(c: Conversation | undefined): Conversation | undefined {
  if (c?.isMulti) c.repos = listConvRepos(c.id)
  return c
}

/** List workspace conversations, including archived only when requested. */
export function listConversations(workspaceId: string, includeArchived = false): ProjectConversation[] {
  const sql = includeArchived
    ? "SELECT * FROM conversations WHERE scope = 'project' AND workspace_id = ? ORDER BY position ASC, created_at ASC"
    : "SELECT * FROM conversations WHERE scope = 'project' AND workspace_id = ? AND archived = 0 ORDER BY position ASC, created_at ASC"
  const conversations = getDb()
    .prepare(sql)
    .all(workspaceId)
    .map((r) => withRepos(rowToConversation(r))!) as ProjectConversation[]
  return withDispatchOrigins(conversations)
}

export function listStandaloneConversations(includeArchived = false): StandaloneConversation[] {
  return getDb()
    .prepare(`SELECT * FROM conversations WHERE scope = 'standalone' AND routine_id IS NULL
    ${includeArchived ? '' : 'AND archived = 0'} ORDER BY position ASC, created_at ASC`)
    .all()
    .map((row) => rowToConversation(row) as StandaloneConversation)
}

export function listAllConversations(): Conversation[] {
  const conversations = getDb()
    .prepare('SELECT * FROM conversations ORDER BY position ASC, created_at ASC')
    .all()
    .map((r) => withRepos(rowToConversation(r))!) as Conversation[]
  return withDispatchOrigins(conversations)
}

/** Ids of every conversation of the profile, archived and standalone ones included. */
export function listAllConversationIds(): string[] {
  return (getDb().prepare('SELECT id FROM conversations').all() as Array<{ id: string }>).map((row) => row.id)
}

export function updateConversationStatus(id: string, status: ConversationStatus): void {
  getDb().prepare('UPDATE conversations SET status = ?, last_activity_at = ? WHERE id = ?').run(status, Date.now(), id)
}

/** Marks the conversation as waiting for the person; true when it was not marked yet. */
export function markConversationAttention(id: string): boolean {
  return (
    getDb()
      .prepare('UPDATE conversations SET attention_at = ? WHERE id = ? AND attention_at IS NULL')
      .run(Date.now(), id).changes === 1
  )
}

/** The person saw the conversation on some computer; true when it was marked. */
export function clearConversationAttention(id: string): boolean {
  return (
    getDb().prepare('UPDATE conversations SET attention_at = NULL WHERE id = ? AND attention_at IS NOT NULL').run(id)
      .changes === 1
  )
}

/** Unarchived conversations waiting for the person. */
export function listConversationAttention(): string[] {
  return (
    getDb()
      .prepare('SELECT id FROM conversations WHERE attention_at IS NOT NULL AND archived = 0 AND routine_id IS NULL')
      .all() as Array<{
      id: string
    }>
  ).map((row) => row.id)
}

export interface ConversationAttentionRow {
  id: string
  name: string
  status: ConversationStatus
  marked: boolean
  at: number
  routine?: boolean
}

/** Unarchived conversations with fields needed to compute attention state and snapshots. */
export function listConversationsForAttention(): ConversationAttentionRow[] {
  return (
    getDb()
      .prepare(
        `SELECT id, name, status, attention_at, last_activity_at, created_at, routine_id
         FROM conversations
         WHERE archived = 0
         ORDER BY COALESCE(
           CASE WHEN attention_at IS NOT NULL THEN MAX(attention_at, COALESCE(last_activity_at, 0)) END,
           NULLIF(last_activity_at, 0),
           created_at
         ) DESC`
      )
      .all() as Array<{
      id: string
      name: string
      status: ConversationStatus
      attention_at: number | null
      last_activity_at: number
      created_at: number
      routine_id: string | null
    }>
  ).map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    marked: row.routine_id === null && row.attention_at !== null,
    at:
      row.attention_at !== null
        ? Math.max(row.attention_at, row.last_activity_at)
        : row.last_activity_at > 0
          ? row.last_activity_at
          : row.created_at,
    routine: row.routine_id !== null,
  }))
}

/** Single-conversation state for evaluating attention transitions; null when deleted. */
export function getConversationAttentionState(id: string): {
  status: ConversationStatus
  marked: boolean
  archived: boolean
  routine: boolean
} | null {
  const row = getDb()
    .prepare('SELECT status, attention_at, archived, routine_id FROM conversations WHERE id = ?')
    .get(id) as
    | { status: ConversationStatus; attention_at: number | null; archived: number; routine_id: string | null }
    | undefined
  if (!row) return null
  return {
    status: row.status,
    marked: row.attention_at !== null,
    archived: row.archived !== 0,
    routine: row.routine_id !== null,
  }
}

/** Compare-and-set keeps explicit experience transitions from overwriting a concurrent or stale state. */
export function updateConversationExperience(
  id: string,
  expected: ConversationExperience,
  next: ConversationExperience
): boolean {
  return (
    getDb().prepare('UPDATE conversations SET experience = ? WHERE id = ? AND experience = ?').run(next, id, expected)
      .changes === 1
  )
}

export function renameConversation(id: string, name: string): void {
  getDb().prepare('UPDATE conversations SET name = ? WHERE id = ?').run(name, id)
}

export function setConversationArchived(id: string, archived: boolean): void {
  if (archived) {
    getDb().prepare('UPDATE conversations SET archived = 1, pinned_at = NULL WHERE id = ?').run(id)
    return
  }
  getDb().prepare('UPDATE conversations SET archived = 0 WHERE id = ?').run(id)
}

export function setConversationPinned(id: string, pinned: boolean): number | null {
  if (!pinned) {
    getDb().prepare('UPDATE conversations SET pinned_at = NULL WHERE id = ?').run(id)
    return null
  }

  const conversation = getDb().prepare('SELECT archived, pinned_at FROM conversations WHERE id = ?').get(id) as
    | { archived: number; pinned_at: number | null }
    | undefined
  if (!conversation) throw new Error('Conversation not found.')
  if (conversation.archived !== 0) throw new Error('Archived conversations cannot be pinned.')
  if (conversation.pinned_at !== null) return conversation.pinned_at

  const pinnedAt = Date.now()
  getDb().prepare('UPDATE conversations SET pinned_at = ? WHERE id = ?').run(pinnedAt, id)
  return pinnedAt
}

export function touchConversation(id: string, ts: number): void {
  getDb().prepare('UPDATE conversations SET last_activity_at = ? WHERE id = ?').run(ts, id)
}

export function deleteConversation(id: string): void {
  getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

/**
 * Count other conversations sharing cwd. Remove a shared worktree only when no other conversation remains,
 * including archived ones that can reopen.
 */
export function countOtherConversationsInCwd(cwd: string, excludeId: string): number {
  const r = getDb()
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE cwd = ? AND id != ?')
    .get(cwd, excludeId) as { n: number }
  return r.n
}

/**
 * Count other active siblings for watcher cleanup. Archiving the last active sibling releases watchers
 * even when archived siblings remain; physical worktree deletion uses the all-conversation count
 * instead.
 */
export function countOtherActiveConversationsInCwd(cwd: string, excludeId: string): number {
  const r = getDb()
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE cwd = ? AND id != ? AND archived = 0')
    .get(cwd, excludeId) as { n: number }
  return r.n
}

/**
 * Sibling turns in working/waiting/asking block migration because they may write during stashing. Idle
 * siblings do not; the exclusive cwd lease prevents them starting new work during migration.
 */
export function countOtherRunningConversationsInCwd(cwd: string, excludeId: string): number {
  const r = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM conversations WHERE cwd = ? AND id != ? AND archived = 0 AND status IN ('working', 'waiting', 'asking')"
    )
    .get(cwd, excludeId) as { n: number }
  return r.n
}

// Conversation ui_prefs JSON.

function parseUiPrefs(s: unknown): ConvUiPrefs {
  if (typeof s !== 'string' || !s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export function getConvUiPrefs(id: string): ConvUiPrefs {
  const row = getDb().prepare('SELECT ui_prefs FROM conversations WHERE id = ?').get(id) as
    | { ui_prefs?: string }
    | undefined
  return parseUiPrefs(row?.ui_prefs)
}

/**
 * Synchronously read, merge top-level UI preference keys, and write. Main's single-threaded
 * synchronous SQLite access prevents renderer and main updates from interleaving on the same JSON.
 */
export function patchConvUiPrefs(id: string, patch: Partial<ConvUiPrefs>): void {
  const next = { ...getConvUiPrefs(id), ...patch }
  getDb().prepare('UPDATE conversations SET ui_prefs = ? WHERE id = ?').run(JSON.stringify(next), id)
}

// ---- mapeadores (snake_case → camelCase) ----

function rowToConversation(r: any): Conversation | undefined {
  if (!r) return undefined
  if (r.scope !== 'project' && r.scope !== 'standalone') throw new Error('Invalid conversation scope')
  if (
    r.scope === 'standalone' &&
    (r.workspace_id !== null || r.branch !== null || r.mode !== null || r.experience !== 'standard' || r.is_multi !== 0)
  )
    throw new Error('Invalid standalone conversation context')
  if (
    r.scope === 'project' &&
    (typeof r.workspace_id !== 'string' || typeof r.branch !== 'string' || !['local', 'worktree'].includes(r.mode))
  )
    throw new Error('Invalid project conversation context')
  return {
    id: r.id,
    scope: r.scope,
    workspaceId: r.workspace_id,
    name: r.name,
    branch: r.branch,
    mode: r.mode,
    experience: r.scope === 'standalone' ? 'standard' : normalizeConversationExperience(r.experience),
    cwd: r.cwd,
    status: r.status,
    createdAt: r.created_at,
    archived: r.archived ?? 0,
    pinnedAt: r.pinned_at ?? null,
    lastActivityAt: r.last_activity_at ?? r.created_at,
    isMulti: r.is_multi ?? 0,
    uiPrefs: parseUiPrefs(r.ui_prefs),
    ...(r.scope === 'standalone' && typeof r.folder_owner_id === 'string' ? { folderOwnerId: r.folder_owner_id } : {}),
    ...(r.scope === 'standalone' && typeof r.routine_id === 'string' ? { routineId: r.routine_id } : {}),
    ...(r.scope === 'standalone' && typeof r.routine_run_id === 'string' ? { routineRunId: r.routine_run_id } : {}),
    ...(r.bot_origin
      ? {
          botOrigin: JSON.parse(r.bot_origin),
          botManagementState: r.bot_management_state,
          botManualChatEnabled: r.bot_manual_chat_enabled === 1,
        }
      : {}),
  } as Conversation
}

function rowToConvRepo(r: any): ConvRepo {
  return {
    workspaceId: r.workspace_id,
    repoTop: r.repo_top,
    branch: r.branch,
    base: r.base,
    worktreePath: r.worktree_path,
    linkName: r.link_name,
  }
}
