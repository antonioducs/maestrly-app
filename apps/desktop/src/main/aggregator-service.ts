import path from 'node:path'
import { promises as fs } from 'node:fs'
import { app } from 'electron'
import { createWorktree, removeWorktree, deleteBranch, listWorktrees } from './git-service'
import { externalWorktreeDir } from './app-paths'
import { symlinkDirType } from './platform'
import type { ConvRepo } from './store'

/**
 * Multi-repository conversation aggregator: one isolated worktree per repository on a coordinated
 * branch, plus an app-owned userData directory linking them. cwd is the aggregator so tools can edit
 * all repositories; Git/gh remain scoped to each linked worktree. Conversation identity must use
 * convId, never cwd, because tools resolve symlinks to physical paths. Cleanup removes links by name
 * and worktrees through Git; never recursively traverse a link, which would delete its target. Windows
 * uses junctions, so cleanup must not rely solely on isSymbolicLink. See cleanupAggregator,
 * removeDirLink, and aggDirSafeToRecursiveRm.
 */

export interface RepoSpec {
  workspaceId: string
  repoTop: string
  branch: string
  base: string
  isNewBranch: boolean
}

/** Real, app-owned conversation aggregator directory outside all repositories. */
export function aggregatorDir(convId: string): string {
  return path.join(app.getPath('userData'), 'aggregators', convId)
}

/** Unique link names from repository basenames, disambiguated with -2, -3, and subsequent suffixes. */
function linkNames(repos: RepoSpec[]): string[] {
  const used = new Set<string>()
  return repos.map((r) => {
    let base = path.basename(r.repoTop) || 'repo'
    let name = base
    let i = 2
    while (used.has(name)) name = `${base}-${i++}`
    used.add(name)
    return name
  })
}

/**
 * Create repository worktrees and aggregator links, returning ConvRepo records for persistence. On
 * failure, roll back created resources and rethrow the original error.
 */
export async function createAggregator(convId: string, repos: RepoSpec[]): Promise<ConvRepo[]> {
  const aggDir = aggregatorDir(convId)
  const names = linkNames(repos)

  // Precheck all branches before creating resources. Git permits a branch in only one worktree; reusing an
  // existing worktree would break conversation isolation and let one cleanup destroy another's resources.
  // Require a different branch name.
  for (const r of repos) {
    const existing = (await listWorktrees(r.repoTop)).find((w) => w.branch === r.branch)
    if (existing) {
      throw new Error(
        `Branch "${r.branch}" is already in use by a worktree in repository "${path.basename(r.repoTop)}". Choose another branch name.`
      )
    }
  }

  await fs.mkdir(aggDir, { recursive: true })
  const done: ConvRepo[] = []
  try {
    for (let i = 0; i < repos.length; i++) {
      const r = repos[i]
      // #143: Multi-repository worktrees also live in userData, keeping operational files outside user
      // repositories. Aggregator links point there and cleanup uses persisted worktreePath.
      const worktreePath = await createWorktree({
        top: r.repoTop,
        branch: r.branch,
        base: r.base,
        isNewBranch: r.isNewBranch,
        dest: externalWorktreeDir(r.workspaceId, r.branch),
      })
      // Windows junctions need no elevated privileges or Developer Mode; POSIX uses directory symlinks.
      await fs.symlink(worktreePath, path.join(aggDir, names[i]), symlinkDirType())
      done.push({
        workspaceId: r.workspaceId,
        repoTop: r.repoTop,
        branch: r.branch,
        base: r.base,
        worktreePath,
        linkName: names[i],
      })
    }
    return done
  } catch (err) {
    // Roll back created resources, then rethrow the original error.
    await cleanupAggregator(convId, done).catch(() => {})
    throw err
  }
}

/**
 * Remove aggregator links by name, worktrees through Git, branches, and the aggregator directory, with
 * per-repository best effort. Do not touch original repositories. Windows junction detection must not
 * depend on isSymbolicLink: unlink/rmdir remove the reparse point without traversing its target. Only
 * recursively remove the final directory after verifying no links/reparse points remain.
 */
export async function cleanupAggregator(convId: string, repos: ConvRepo[]): Promise<void> {
  const aggDir = aggregatorDir(convId)
  // Remove links by name before recursive deletion; do not rely on isSymbolicLink.
  for (const r of repos) await removeDirLink(path.join(aggDir, r.linkName))
  // Remove worktrees through Git and branches with per-repository best effort, preserving original
  // repositories.
  for (const r of repos) {
    await removeWorktree(r.repoTop, r.worktreePath, true).catch(() => {})
    await deleteBranch(r.repoTop, r.branch).catch(() => {})
  }
  // Remove the aggregator directory through the guarded removeAggregatorDir path.
  await removeAggregatorDir(aggDir)
}

/**
 * Remove a directory link by name without traversing its target. Use unlink for POSIX symlinks and
 * fall back to rmdir for Windows junctions. Missing links are harmless.
 */
async function removeDirLink(link: string): Promise<void> {
  const st = await fs.lstat(link).catch(() => null)
  if (!st) return
  try {
    await fs.unlink(link)
    return
  } catch {
    /* If unlink fails for a Windows junction, rmdir removes the reparse point without its target. */
  }
  await fs.rmdir(link).catch(() => {})
}

/**
 * Recursively remove the aggregator only when no remaining entry is a symlink or escaping Windows
 * reparse point. Otherwise remove links by name and use nonrecursive rmdir. Exported so tests can
 * verify real worktrees survive leftover links.
 */
export async function removeAggregatorDir(aggDir: string): Promise<void> {
  if (await aggDirSafeToRecursiveRm(aggDir)) {
    await fs.rm(aggDir, { recursive: true, force: true }).catch(() => {})
    return
  }
  const entries = await fs.readdir(aggDir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) await removeDirLink(path.join(aggDir, e.name))
  await fs.rmdir(aggDir).catch(() => {})
}

/**
 * Recursive deletion is safe only if no entry points outside the aggregator. Detect POSIX symlinks and
 * Windows directories whose realpath escapes. On inaccessible paths or errors, return false.
 */
async function aggDirSafeToRecursiveRm(aggDir: string): Promise<boolean> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(aggDir, { withFileTypes: true })
  } catch {
    return false
  }
  const aggReal = await fs.realpath(aggDir).catch(() => aggDir)
  for (const e of entries) {
    const full = path.join(aggDir, e.name)
    const lst = await fs.lstat(full).catch(() => null)
    if (lst?.isSymbolicLink()) return false // a surviving POSIX symlink is unsafe
    if (lst?.isDirectory()) {
      // A Windows junction whose realpath escapes the aggregator points to the real worktree and is unsafe
      // to traverse.
      const real = await fs.realpath(full).catch(() => full)
      const rel = path.relative(aggReal, real)
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false
    }
  }
  return true
}
