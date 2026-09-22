import { normalizeConversationExperience, type ConversationExperience } from '../../shared/conversation-experience'
import type {
  Conversation,
  ProjectConversation,
  StandaloneConversation,
  ConversationMode,
  ConversationStatus,
  ConvRepo,
  ConvUiPrefs,
} from '../../shared/conversation'
export type {
  Conversation,
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
       (id, scope, workspace_id, name, branch, mode, experience, cwd, status, created_at, archived, pinned_at, last_activity_at, is_multi, ui_prefs, bot_origin, bot_management_state, bot_manual_chat_enabled, position)
     VALUES
       (@id, @scope, @workspaceId, @name, @branch, @mode, @experience, @cwd, @status, @createdAt, @archived, @pinnedAt, @lastActivityAt, @isMulti, @uiPrefs, @botOrigin, @botManagementState, @botManualChatEnabled,
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
  return getDb()
    .prepare(sql)
    .all(workspaceId)
    .map((r) => withRepos(rowToConversation(r))!) as ProjectConversation[]
}

export function listStandaloneConversations(includeArchived = false): StandaloneConversation[] {
  return getDb()
    .prepare(`SELECT * FROM conversations WHERE scope = 'standalone'
    ${includeArchived ? '' : 'AND archived = 0'} ORDER BY position ASC, created_at ASC`)
    .all()
    .map((row) => rowToConversation(row) as StandaloneConversation)
}

export function listAllConversations(): Conversation[] {
  return getDb()
    .prepare('SELECT * FROM conversations ORDER BY position ASC, created_at ASC')
    .all()
    .map((r) => withRepos(rowToConversation(r))!) as Conversation[]
}

export function updateConversationStatus(id: string, status: ConversationStatus): void {
  getDb().prepare('UPDATE conversations SET status = ?, last_activity_at = ? WHERE id = ?').run(status, Date.now(), id)
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
