import { randomUUID } from 'node:crypto'
import { getDb, transaction } from './db'

export interface Workspace {
  id: string
  path: string // repository root
  name: string
  defaultBranch: string
  addedAt: number
}

// ---- workspaces ----

export function insertWorkspace(w: Workspace): void {
  // Append new workspaces at global MAX+1. Existing-path conflicts insert nothing, so discarded positions
  // create no gap.
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, path, name, default_branch, added_at, position)
     VALUES (@id, @path, @name, @defaultBranch, @addedAt,
             (SELECT COALESCE(MAX(position), -1) + 1 FROM workspaces))
     ON CONFLICT(path) DO NOTHING`
    )
    .run({
      id: w.id,
      path: w.path,
      name: w.name,
      defaultBranch: w.defaultBranch,
      addedAt: w.addedAt,
    })
}

export function getWorkspaceByPath(p: string): Workspace | undefined {
  return rowToWorkspace(getDb().prepare('SELECT * FROM workspaces WHERE path = ?').get(p))
}

export function getWorkspace(id: string): Workspace | undefined {
  return rowToWorkspace(getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id))
}

/** Whether project memory is enabled for this workspace; default is enabled. */
export function getMemoryEnabled(workspaceId: string): boolean {
  const r = getDb().prepare('SELECT memory_enabled FROM workspaces WHERE id = ?').get(workspaceId) as
    | { memory_enabled?: number }
    | undefined
  return r?.memory_enabled !== 0 // ausente/1 = ligada
}

export function setMemoryEnabled(workspaceId: string, enabled: boolean): void {
  getDb()
    .prepare('UPDATE workspaces SET memory_enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, workspaceId)
}

/**
 * Editable default branch is shared by manual and multi-repository conversations (#557). Trim and reject
 * empty values in the store; existence validation remains at UI/execution because branches may be created later.
 */
export function setWorkspaceDefaultBranch(workspaceId: string, branch: string): void {
  const trimmed = branch.trim()
  if (!trimmed) throw new Error('default branch cannot be empty')
  getDb().prepare('UPDATE workspaces SET default_branch = ? WHERE id = ?').run(trimmed, workspaceId)
}

export function listWorkspaces(): Workspace[] {
  return getDb()
    .prepare('SELECT * FROM workspaces ORDER BY position ASC, added_at ASC')
    .all()
    .map(rowToWorkspace) as Workspace[]
}

export function deleteWorkspace(id: string): void {
  getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(id)
}

/**
 * Transactionally reorder workspaces with dense positions. Discard invalid/duplicate IDs, retain
 * omitted workspaces in their current slots, and fill remaining slots in requested order to tolerate
 * concurrent additions.
 */
export function setWorkspaceOrder(ids: string[]): void {
  const base = (
    getDb().prepare('SELECT id FROM workspaces ORDER BY position ASC, added_at ASC').all() as Array<{ id: string }>
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
  // Unrequested workspaces retain their slots; requested ones fill their former slots in new order.
  const final = base.map((id) => (seen.has(id) ? queue.shift()! : id))
  transaction(() => {
    const stmt = getDb().prepare('UPDATE workspaces SET position = ? WHERE id = ?')
    final.forEach((id, i) => stmt.run(i, id))
  })
}

// Virtual sidebar workspace groups with no disk/Git changes (#218).

/**
 * UI grouping metadata, never workspace identity. Workspace/listWorkspaces remain flat without
 * groupId.
 */
export interface WorkspaceGroup {
  id: string
  name: string
  position: number
  collapsed: boolean
}

/** Application-wide workspace groups in display order. */
export function listWorkspaceGroups(): WorkspaceGroup[] {
  return getDb()
    .prepare('SELECT * FROM workspace_groups ORDER BY position ASC, created_at ASC')
    .all()
    .map(rowToWorkspaceGroup) as WorkspaceGroup[]
}

/** Append a group at MAX(position)+1 and return its row. */
export function createWorkspaceGroup(name: string): WorkspaceGroup {
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO workspace_groups (id, name, position, collapsed, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM workspace_groups), 0, ?)`
    )
    .run(id, name, Date.now())
  return rowToWorkspaceGroup(getDb().prepare('SELECT * FROM workspace_groups WHERE id = ?').get(id))!
}

export function renameWorkspaceGroup(id: string, name: string): void {
  getDb().prepare('UPDATE workspace_groups SET name = ? WHERE id = ?').run(name, id)
}

/** Persisted group collapse state (#218). */
export function setGroupCollapsed(id: string, collapsed: boolean): void {
  getDb()
    .prepare('UPDATE workspace_groups SET collapsed = ? WHERE id = ?')
    .run(collapsed ? 1 : 0, id)
}

/** Transactionally ungroup members and delete the group. Never cascade into workspace deletion. */
export function deleteWorkspaceGroup(id: string): void {
  transaction(() => {
    getDb().prepare('UPDATE workspaces SET group_id = NULL WHERE group_id = ?').run(id)
    getDb().prepare('DELETE FROM workspace_groups WHERE id = ?').run(id)
  })
}

/**
 * Densely reorder groups like workspaces, ignoring invalid/duplicate IDs and retaining omitted groups'
 * slots.
 */
export function setGroupOrder(ids: string[]): void {
  const base = (
    getDb().prepare('SELECT id FROM workspace_groups ORDER BY position ASC, created_at ASC').all() as Array<{
      id: string
    }>
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
    const stmt = getDb().prepare('UPDATE workspace_groups SET position = ? WHERE id = ?')
    final.forEach((id, i) => stmt.run(i, id))
  })
}

/** Persisted workspace collapse state, matching group collapse behavior (#218). */
export function setWorkspaceCollapsed(id: string, collapsed: boolean): void {
  getDb()
    .prepare('UPDATE workspaces SET collapsed = ? WHERE id = ?')
    .run(collapsed ? 1 : 0, id)
}

/**
 * Atomically set workspace group and flatten sidebar positions for all move/reorder variants. Reuse
 * robust order normalization. Since group_id has no FK, coerce nonexistent groups to null to prevent
 * invisible orphan membership.
 */
export function setWorkspaceGroupAndOrder(workspaceId: string, groupId: string | null, flatIds: string[]): void {
  let safeGroup: string | null = groupId
  if (safeGroup !== null && !getDb().prepare('SELECT 1 FROM workspace_groups WHERE id = ?').get(safeGroup)) {
    safeGroup = null
  }
  const base = (
    getDb().prepare('SELECT id FROM workspaces ORDER BY position ASC, added_at ASC').all() as Array<{ id: string }>
  ).map((r) => r.id)
  const baseSet = new Set(base)
  const wanted: string[] = []
  const seen = new Set<string>()
  for (const id of flatIds) {
    if (baseSet.has(id) && !seen.has(id)) {
      seen.add(id)
      wanted.push(id)
    }
  }
  const queue = [...wanted]
  const final = base.map((id) => (seen.has(id) ? queue.shift()! : id))
  transaction(() => {
    if (baseSet.has(workspaceId)) {
      getDb().prepare('UPDATE workspaces SET group_id = ? WHERE id = ?').run(safeGroup, workspaceId)
    }
    if (wanted.length > 0) {
      const stmt = getDb().prepare('UPDATE workspaces SET position = ? WHERE id = ?')
      final.forEach((id, i) => stmt.run(i, id))
    }
  })
}

/**
 * Workspace group/collapse metadata for one sidebar-envelope query. Orphan group IDs are tolerated
 * here and treated as ungrouped by the service.
 */
export function listWorkspaceGroupIds(): Array<{ id: string; groupId: string | null; collapsed: boolean }> {
  return (
    getDb().prepare('SELECT id, group_id, collapsed FROM workspaces').all() as Array<{
      id: string
      group_id: string | null
      collapsed: number
    }>
  ).map((r) => ({ id: r.id, groupId: r.group_id ?? null, collapsed: r.collapsed === 1 }))
}

function rowToWorkspace(r: any): Workspace | undefined {
  if (!r) return undefined
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    defaultBranch: r.default_branch,
    addedAt: r.added_at,
  }
}

function rowToWorkspaceGroup(r: any): WorkspaceGroup | undefined {
  if (!r) return undefined
  return {
    id: r.id,
    name: r.name,
    position: r.position,
    collapsed: r.collapsed === 1,
  }
}
