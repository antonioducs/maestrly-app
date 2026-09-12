import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHeadState } from '../shared/conversation-branch'
import { GitCommandError, runGit as git, runGitOrNull as gitOrNull } from './git-command'

export async function isGitRepo(dir: string): Promise<boolean> {
  return (await gitOrNull(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true'
}

/** Actual checkout HEAD, including the short SHA when detached so the chip does not look like a branch. */
export async function currentGitHead(cwd: string): Promise<GitHeadState> {
  const branch = await gitOrNull(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 3000)
  if (branch) return { kind: 'branch', name: branch }

  const commit = await gitOrNull(cwd, ['rev-parse', '--short', 'HEAD'], 3000)
  return commit ? { kind: 'detached', commit } : { kind: 'unavailable' }
}

/**
 * Cheap Git context for system prompts from one status --porcelain --branch call: branch and
 * uncommitted state. null means unavailable Git/repository. Dirty state tends to remain stable after
 * the first edit, limiting prompt-cache invalidation.
 */
export async function gitEnvInfo(cwd: string): Promise<{ branch: string; dirty: boolean } | null> {
  const out = await gitOrNull(cwd, ['status', '--porcelain', '--branch'], 3000)
  if (out == null) return null
  const lines = out.split('\n')
  const head = lines[0] ?? ''
  const branch = head.includes('(no branch)')
    ? 'detached'
    : (/^##\s+(?:No commits yet on\s+)?([^.\s]+)/.exec(head)?.[1] ?? 'unknown')
  const dirty = lines.slice(1).some((l) => l.trim().length > 0)
  return { branch, dirty }
}

/**
 * Repository diff for review-worker context. Without against, compare tracked staged/unstaged changes
 * to HEAD; with a ref, compare branch changes since its merge base. Return empty on missing
 * repository/diff; exclude untracked files.
 */
export async function getDiff(cwd: string, against?: string): Promise<string> {
  // --merge-base <base> HEAD matches <base>...HEAD while keeping the ref in a separate token with a --
  // terminator. This avoids treating a leading-dash ref as an option and separates revisions from paths.
  const args = against ? ['diff', '--merge-base', against, 'HEAD', '--'] : ['diff', 'HEAD', '--']
  return (await gitOrNull(cwd, args)) ?? ''
}

/** Repository root path; file pickers may select a subdirectory. */
export async function getToplevel(dir: string): Promise<string | null> {
  return gitOrNull(dir, ['rev-parse', '--show-toplevel'])
}

/** Origin URL for ProjectBinding validation. Never persist credentials; the caller normalizes it first. */
export async function getOriginRemoteUrl(dir: string): Promise<string | null> {
  return gitOrNull(dir, ['remote', 'get-url', 'origin'], 3000)
}

export async function isBareRepo(dir: string): Promise<boolean> {
  return (await gitOrNull(dir, ['rev-parse', '--is-bare-repository'])) === 'true'
}

/**
 * Detect the default branch without network access: origin/HEAD, current valid local HEAD, main,
 * master, init.defaultBranch, then main.
 */
export async function getDefaultBranch(top: string): Promise<string> {
  const originHead = await gitOrNull(top, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead) return originHead.replace(/^origin\//, '')

  // Some remotes, including file:// or servers without origin/HEAD, still leave local HEAD on the correct
  // default branch. Prefer that actual ref before conventional fallbacks.
  const headBranch = await gitOrNull(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (headBranch && (await gitOrNull(top, ['show-ref', '--verify', '--quiet', `refs/heads/${headBranch}`])) !== null) {
    return headBranch
  }

  for (const candidate of ['main', 'master']) {
    const ref = await gitOrNull(top, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`])
    // show-ref --quiet prints nothing; inspect success through gitOrNull being non-null.
    if (ref !== null) return candidate
  }

  const configured = await gitOrNull(top, ['config', 'init.defaultBranch'])
  return configured || 'main'
}

/**
 * Fetch and prune remote refs so newly created remote branches appear locally. Missing remote/offline
 * errors are swallowed by gitOrNull.
 */
export async function fetchRemotes(top: string): Promise<void> {
  await gitOrNull(top, ['fetch', '--prune', '--no-tags'])
}

export interface RemoteBranchInfo {
  remote: string
  name: string
  ref: string
}

export interface BranchInfo {
  current: string
  local: string[]
  remote: string[]
  remoteRefs: RemoteBranchInfo[]
}

export async function listBranches(top: string): Promise<BranchInfo> {
  const current = (await gitOrNull(top, ['branch', '--show-current'])) || ''
  const localRaw = await gitOrNull(top, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  const remoteRaw = await gitOrNull(top, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
  const local = localRaw ? localRaw.split('\n').filter(Boolean) : []
  const remoteRefs = remoteRaw
    ? remoteRaw
        .split('\n')
        // Exclude symbolic remote HEAD, reported as origin/HEAD or origin, and slashless remote names that
        // are not branches.
        .filter((b) => b && !b.endsWith('/HEAD') && b.includes('/'))
        .map((short) => {
          const slash = short.indexOf('/')
          return {
            remote: short.slice(0, slash),
            name: short.slice(slash + 1),
            ref: `refs/remotes/${short}`,
          }
        })
        .filter((item) => !local.includes(item.name))
    : []
  const remoteOnly = [...new Set(remoteRefs.map((item) => item.name))]
  return { current, local, remote: remoteOnly, remoteRefs }
}

export interface WorktreeInfo {
  path: string
  branch: string | null
  head: string
}

export async function listWorktrees(top: string): Promise<WorktreeInfo[]> {
  const raw = await gitOrNull(top, ['worktree', 'list', '--porcelain'])
  if (!raw) return []
  const out: WorktreeInfo[] = []
  let cur: Partial<WorktreeInfo> = {}
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur.path) out.push(cur as WorktreeInfo)
      cur = { path: path.normalize(line.slice('worktree '.length)), branch: null, head: '' }
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace('refs/heads/', '')
    }
  }
  if (cur.path) out.push(cur as WorktreeInfo)
  return out
}

export async function isWorkingTreeClean(top: string): Promise<boolean> {
  const status = await gitOrNull(top, ['status', '--porcelain'])
  return status === ''
}

// Merge pre/postconditions for AI conflict resolution (#321). Reject dirty trees or active merges, then
// verify actual resolution instead of trusting model text. Failed checks conservatively report failure.

/** Whether the index contains unmerged files; git ls-files -u lists stages above zero. */
export async function hasUnmergedFiles(cwd: string): Promise<boolean> {
  return !!(await gitOrNull(cwd, ['ls-files', '-u']))
}

/** Whether MERGE_HEAD exists, indicating a merge not yet completed or aborted. */
export async function isMergeInProgress(cwd: string): Promise<boolean> {
  return (await gitOrNull(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) !== null
}

/**
 * Detect leftover opening/closing conflict-marker lines in tracked files, including incorrectly
 * staged/committed markers that ls-files -u misses. Exclude ======= because it can be legitimate
 * Markdown/comment content. git grep exits 1 when nothing matches.
 */
export async function hasConflictMarkers(cwd: string): Promise<boolean> {
  return !!(await gitOrNull(cwd, ['grep', '-lIE', '^(<{7}|>{7})( |$)']))
}

/**
 * Verify the local HEAD against the live remote ref through git ls-remote, not a possibly stale or
 * differently tracked origin/<branch>. Offline, missing remote, or missing branch conservatively means
 * not pushed.
 */
export async function isBranchPushed(cwd: string, branch: string): Promise<boolean> {
  const head = await gitOrNull(cwd, ['rev-parse', 'HEAD'])
  if (!head) return false
  const remote = await gitOrNull(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`], 20_000)
  const remoteSha = remote?.split(/\s+/)[0]?.trim()
  return !!remoteSha && remoteSha === head
}

/** Convert branch/feature to branch-feature to avoid nested worktree directories. */
export function slugifyBranch(branch: string): string {
  return branch.replace(/[/\\]/g, '-').replace(/[^a-zA-Z0-9._-]/g, '_')
}

function isInsidePath(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Refresh the starting point for a new branch by fetching origin/base. Use the remote ref only if
 * local base is its ancestor; retain local base when ahead/diverged or offline to preserve work. Never
 * pull/merge into the local branch. Fetch has a timeout so creation cannot stall indefinitely.
 */
async function freshestBase(top: string, base: string): Promise<string> {
  await gitOrNull(top, ['fetch', 'origin', base], 20_000)
  const remoteRef = `origin/${base}`
  const remoteExists = (await gitOrNull(top, ['rev-parse', '--verify', '--quiet', remoteRef])) !== null
  if (!remoteExists) return base // no remote base; keep local state
  const localExists = (await gitOrNull(top, ['rev-parse', '--verify', '--quiet', base])) !== null
  if (!localExists) return remoteRef // base exists only remotely; use that ref
  // merge-base --is-ancestor succeeds only when local base is behind the remote. Start from remote then;
  // otherwise preserve local commits.
  const localIsBehind = (await gitOrNull(top, ['merge-base', '--is-ancestor', base, remoteRef])) !== null
  return localIsBehind ? remoteRef : base
}

export interface CreateWorktreeArgs {
  top: string
  branch: string
  base: string
  isNewBranch: boolean
  /**
   * Explicit worktree destination, normally in userData outside the repository (#143). Without it,
   * retain the historical <top>/.claude/worktrees/<slug> fallback.
   */
  dest?: string
}

/**
 * Configure worktree-local push.default=current and push.autoSetupRemote (#557) so a bare push creates
 * the same-named remote branch and sets its upstream. New branches use --no-track to avoid inheriting
 * origin/base. worktreeConfig keeps the user's main repository settings unchanged. Older unsupported
 * Git versions degrade gracefully without breaking creation.
 */
async function configureAppWorktreePush(top: string, wtPath: string): Promise<void> {
  await gitOrNull(top, ['config', 'extensions.worktreeConfig', 'true']) // enable worktree-local configuration support
  await gitOrNull(wtPath, ['config', '--worktree', 'push.default', 'current'])
  await gitOrNull(wtPath, ['config', '--worktree', 'push.autoSetupRemote', 'true'])
}

const MISSING_GIT_LFS_HOOK_MESSAGE =
  "This repository is configured for Git LFS but 'git-lfs' was not found on your path."
const GIT_LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1'

function isMissingGitLfsPostCheckout(error: unknown): error is GitCommandError {
  return error instanceof GitCommandError && error.stderr.includes(MISSING_GIT_LFS_HOOK_MESSAGE)
}

async function sameRealPath(a: string, b: string): Promise<boolean> {
  try {
    const [realA, realB] = await Promise.all([fs.realpath(a), fs.realpath(b)])
    return realA === realB
  } catch {
    return path.resolve(a) === path.resolve(b)
  }
}

/**
 * A Git LFS post-checkout hook can exit 2 after worktree add creates branch, registration, index, and
 * files. Accept that result only after verifying all postconditions and confirming the commit has no
 * real LFS pointers; otherwise preserve the original error because LFS is needed to materialize
 * content.
 */
async function completedWorktreeIsUsable(
  top: string,
  wtPath: string,
  branch: string,
  expectedHead: string
): Promise<boolean> {
  const registered = (await listWorktrees(top)).find((item) => item.branch === branch)
  if (!registered || !(await sameRealPath(registered.path, wtPath)) || registered.head !== expectedHead) return false

  const [actualBranch, actualHead, status] = await Promise.all([
    gitOrNull(wtPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitOrNull(wtPath, ['rev-parse', '--verify', 'HEAD']),
    gitOrNull(wtPath, ['status', '--porcelain=v2', '--untracked-files=all']),
  ])
  if (actualBranch !== branch || actualHead !== expectedHead || status !== '') return false

  try {
    const pointers = await git(wtPath, ['grep', '-I', '-l', '-F', GIT_LFS_POINTER_HEADER, 'HEAD', '--'])
    return pointers === ''
  } catch (error) {
    // git grep exit 1 means a valid search with no matches; other failures make verification inconclusive.
    return error instanceof GitCommandError && Number(error.code) === 1
  }
}

async function addWorktree(
  top: string,
  wtPath: string,
  branch: string,
  expectedHead: string,
  args: string[]
): Promise<void> {
  try {
    await git(top, args)
  } catch (error) {
    if (!isMissingGitLfsPostCheckout(error) || !(await completedWorktreeIsUsable(top, wtPath, branch, expectedHead))) {
      throw error
    }
    console.warn(
      `[git] worktree "${branch}" created; leftover Git LFS hook ignored because the commit does not use LFS.`
    )
  }
}

/**
 * Create a worktree at explicit dest, normally userData, or historical <top>/.claude/worktrees/<slug>.
 * Works with a dirty main checkout and returns its path. Worktrees share the common gitdir
 * info/exclude, so external worktrees receive the same ignore rules.
 */
export async function createWorktree(args: CreateWorktreeArgs): Promise<string> {
  const { top, branch, base, isNewBranch, dest } = args
  const slug = slugifyBranch(branch)
  const wtPath = dest ?? path.join(top, '.claude', 'worktrees', slug)

  // Keep .claude/worktrees out of the main repository's Git status.
  await ensureExclude(top)

  // Check whether this branch already has a worktree.
  const existing = (await listWorktrees(top)).find((w) => w.branch === branch)
  if (existing) {
    if (dest && isInsidePath(top, existing.path)) {
      throw new Error(
        `Branch "${branch}" is already open in a worktree inside the repository. ` +
          'Choose a new branch, remove the old worktree, or use Local mode.'
      )
    }
    await configureAppWorktreePush(top, existing.path) // repair existing worktree configuration
    return existing.path
  }

  if (isNewBranch) {
    // Start from the freshest base, using remote state when local is behind, so recent PR merges are
    // included.
    const startPoint = await freshestBase(top, base)
    // --no-track avoids inheriting origin/base as upstream. Worktree-local current/autoSetupRemote settings
    // make the first bare push create and track the same-named remote branch.
    const expectedHead = await git(top, ['rev-parse', '--verify', `${startPoint}^{commit}`])
    await addWorktree(top, wtPath, branch, expectedHead, [
      'worktree',
      'add',
      wtPath,
      '--no-track',
      '-b',
      branch,
      startPoint,
    ])
  } else {
    // branch existe local?
    const localExists = (await gitOrNull(top, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== null
    if (localExists) {
      const expectedHead = await git(top, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
      await addWorktree(top, wtPath, branch, expectedHead, ['worktree', 'add', wtPath, branch])
    } else {
      // Remote-only branch: fetch and track it.
      await gitOrNull(top, ['fetch', 'origin', branch])
      const expectedHead = await git(top, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`])
      await addWorktree(top, wtPath, branch, expectedHead, [
        'worktree',
        'add',
        '--track',
        '-b',
        branch,
        wtPath,
        `origin/${branch}`,
      ])
    }
  }
  await configureAppWorktreePush(top, wtPath)
  return wtPath
}

/** Whether refs/heads/<branch> exists locally. */
export async function branchExists(top: string, branch: string): Promise<boolean> {
  return (await gitOrNull(top, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== null
}

/**
 * #557: Require an existing local or fetched origin branch before creating a conversation worktree. Reject
 * tags, SHAs, and arbitrary revisions so the result matches freshestBase. This avoids opaque Git
 * errors from invalid bases. Fetch is timed and best-effort; offline checks use local refs.
 */
export async function baseExists(top: string, base: string): Promise<boolean> {
  if (!base.trim()) return false
  // Check local refs first without network access.
  if ((await gitOrNull(top, ['show-ref', '--verify', '--quiet', `refs/heads/${base}`])) !== null) return true
  // The branch may exist only remotely; fetch refs with the default refspec, then check again.
  await gitOrNull(top, ['fetch', 'origin', base], 20_000)
  return (await gitOrNull(top, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${base}`])) !== null
}

export async function removeWorktree(top: string, wtPath: string, force = false): Promise<void> {
  const args = ['worktree', 'remove', wtPath]
  if (force) args.push('--force')
  await git(top, args)
}

/**
 * Move a worktree through git worktree move, which updates its administrative gitdir. Supports
 * explicit migration of legacy in-repository worktrees to userData; not used for normal creation.
 * Throws so callers choose failure handling.
 */
export async function moveWorktree(top: string, from: string, to: string): Promise<void> {
  await git(top, ['worktree', 'move', from, to])
}

/** Delete a local branch with best effort; -D allows deletion without merge. */
export async function deleteBranch(top: string, branch: string): Promise<void> {
  await gitOrNull(top, ['branch', '-D', branch])
}

/**
 * Add local, unversioned ignores to info/exclude without changing the project's .gitignore. Resolve it
 * through git rev-parse --git-path so normal repositories and worktrees use the common gitdir
 * correctly. Missing repositories are harmless.
 */
export async function excludeFromGitInfo(cwd: string, entries: string[]): Promise<void> {
  const rel = await gitOrNull(cwd, ['rev-parse', '--git-path', 'info/exclude'])
  if (!rel) return
  const excludePath = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
  try {
    let content = ''
    try {
      content = await fs.readFile(excludePath, 'utf8')
    } catch {
      /* The file may not exist yet. */
    }
    const begin = '# BEGIN MAESTRLY MANAGED'
    const end = '# END MAESTRLY MANAGED'
    const lines = content.split('\n')
    const retained: string[] = []
    const previousManaged: string[] = []
    let inside = false
    for (const line of lines) {
      if (line === begin) {
        inside = true
        continue
      }
      if (line === end && inside) {
        inside = false
        continue
      }
      if (inside) {
        if (line && !line.startsWith('#')) previousManaged.push(line)
      } else {
        retained.push(line)
      }
    }
    while (retained.at(-1) === '') retained.pop()
    // Place negation after the old broad .agents/ rule to reopen the root while keeping only app-owned
    // notes private. Never delete external lines.
    const required = ['!.agents/', '.agents/notes/', '.agents/notes.md']
    // Do not copy the legacy whole-.agents ignore into the new managed block: it overrides reopening and
    // hides shared knowledge. Preserve external rules and report them through checkKnowledgeGitVisibility.
    const obsoleteBroadAgentsRules = new Set(['.agents', '.agents/', '/.agents', '/.agents/'])
    const retainedManaged = previousManaged.filter((entry) => !obsoleteBroadAgentsRules.has(entry))
    const managed = [...new Set([...required, ...retainedManaged, ...entries].filter(Boolean))]
    await fs.mkdir(path.dirname(excludePath), { recursive: true })
    const next = [...retained, ...(retained.length > 0 ? [''] : []), begin, ...managed, end, ''].join('\n')
    if (next !== content) await fs.writeFile(excludePath, next)
  } catch {
    /* best-effort */
  }
}

/**
 * Single catalog of exact app-owned info/exclude patterns (#143), shared through the common gitdir.
 * Prevent app artifacts from entering status/add without hiding user configuration directories such as
 * .cursor or .claude. The .agents root is shareable; only notes are app-owned.
 */
export const APP_OWNED_EXCLUDES = [
  '.claude/worktrees/',
  '.maestrly/agent-selection.json',
  '.maestrly/agent-open-file.json',
  '.maestrly/agent-navigation.json',
  '.maestrly/debug-cmd.json',
  '.maestrly/debug-result.json',
  '.agents/notes/',
  '.agents/notes.md',
]

export interface KnowledgeGitVisibility {
  ignored: boolean
  rule?: string
}

/** Check a virtual path without creating files or changing user/global rules. */
export async function checkKnowledgeGitVisibility(cwd: string): Promise<KnowledgeGitVisibility> {
  const probe = '.agents/knowledge/__maestrly_probe__.md'
  const rule = await gitOrNull(cwd, ['check-ignore', '-v', '--no-index', '--', probe], 3_000)
  return rule ? { ignored: true, rule: rule.slice(0, 2_000) } : { ignored: false }
}

/** Ensure app-owned info/exclude entries before worktree creation. */
async function ensureExclude(top: string): Promise<void> {
  await excludeFromGitInfo(top, APP_OWNED_EXCLUDES)
}
