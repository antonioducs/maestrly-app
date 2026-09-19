import path from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { slugifyBranch } from './git-service'

/**
 * Central app-owned userData paths keep operational worktrees and workspace memory/project notes
 * outside user repositories (#143). Stable conventions allow reopening branches at the same paths.
 * Pure *RelPath helpers accept a base directory for tests; public wrappers supply Electron userData.
 */

/**
 * Pure external-worktree path: <base>/worktrees/<workspaceId>/<slug(branch)>. Scope by repository and
 * branch and remain stable when reopening.
 */
export function worktreeRelPath(base: string, workspaceId: string, branch: string): string {
  return path.join(base, 'worktrees', workspaceId, slugifyBranch(branch))
}

/**
 * Pure workspace-data root: <base>/workspace-data/<workspaceId>. Project memory and notes are
 * independent of conversation cwd.
 */
export function workspaceDataRelPath(base: string, workspaceId: string): string {
  return path.join(base, 'workspace-data', workspaceId)
}

/** Migration destination that distinguishes branches with identical normalized slugs. */
export function migrationWorktreeRelPath(
  base: string,
  workspaceId: string,
  branch: string,
  operationId: string
): string {
  const hash = createHash('sha256').update(`${branch}\0${operationId}`).digest('hex').slice(0, 10)
  return path.join(base, 'worktrees', workspaceId, `${slugifyBranch(branch)}-${hash}`)
}

/** External conversation worktree directory under userData. */
export function externalWorktreeDir(workspaceId: string, branch: string): string {
  return worktreeRelPath(app.getPath('userData'), workspaceId, branch)
}

export function migrationWorktreeDir(workspaceId: string, branch: string, operationId: string): string {
  return migrationWorktreeRelPath(app.getPath('userData'), workspaceId, branch, operationId)
}

/** App-owned workspace memory/project-notes directory under userData. */
export function workspaceDataDir(workspaceId: string): string {
  return workspaceDataRelPath(app.getPath('userData'), workspaceId)
}

/** Private conversation directory; callers cannot supply a path segment. */
export function standaloneConversationRelPath(base: string, id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid standalone conversation id.')
  }
  return path.join(base, 'standalone-chats', id)
}

export function standaloneConversationDir(id: string): string {
  return standaloneConversationRelPath(app.getPath('userData'), id)
}

export const standaloneChatRelPath = standaloneConversationRelPath
export const standaloneChatDir = standaloneConversationDir
