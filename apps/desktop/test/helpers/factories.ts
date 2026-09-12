import { randomUUID } from 'node:crypto'
import { insertWorkspace, insertConversation, type Workspace, type Conversation } from '../../src/main/store'

/** Factories persist through production helpers and require an open test database. */

let wsSeq = 0
let cwdSeq = 0

/** Insert a workspace with a unique path and name by default. */
export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  wsSeq += 1
  const ws: Workspace = {
    id: overrides.id ?? randomUUID(),
    path: overrides.path ?? `/tmp/ws-${wsSeq}-${randomUUID().slice(0, 8)}`,
    name: overrides.name ?? `ws-${wsSeq}`,
    defaultBranch: overrides.defaultBranch ?? 'main',
    addedAt: overrides.addedAt ?? Date.now(),
  }
  insertWorkspace(ws)
  return ws
}

/** Insert a conversation with deterministic defaults for tests. */
export function makeConversation(workspaceId: string, overrides: Partial<Conversation> = {}): Conversation {
  cwdSeq += 1
  const conv: Conversation = {
    id: overrides.id ?? randomUUID(),
    workspaceId,
    name: overrides.name ?? `conv-${cwdSeq}`,
    branch: overrides.branch ?? 'main',
    mode: overrides.mode ?? 'worktree',
    experience: overrides.experience ?? 'standard',
    cwd: overrides.cwd ?? `/tmp/cwd-${cwdSeq}-${randomUUID().slice(0, 8)}`,
    status: overrides.status ?? 'idle',
    createdAt: overrides.createdAt ?? Date.now(),
    archived: overrides.archived ?? 0,
    pinnedAt: overrides.pinnedAt ?? null,
    lastActivityAt: overrides.lastActivityAt ?? Date.now(),
    isMulti: overrides.isMulti ?? 0,
    uiPrefs: overrides.uiPrefs,
  }
  insertConversation(conv)
  return conv
}
