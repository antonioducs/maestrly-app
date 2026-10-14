import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { MoveBlocker, MoveBlockerCode, MoveBranchAction, MoveWarningCode } from '../../shared/conversation-move'
import type { LocalChangeSummary } from '../../shared/local-conversation'
import { GitCommandError, runGit, runGitOrNull, runGitRaw } from '../git-command'
import {
  createWorktree,
  deleteBranch,
  ensureAppOwnedExcludes,
  fetchRemotes,
  getDefaultBranch,
  listWorktrees,
  removeWorktree,
} from '../git-service'
import { inspectWorkingTree } from '../local-conversation/git'
import { MoveError, moveErrorMessage } from './errors'

/**
 * A conversation's checkout carried to another machine: its branch's commits travel in a `git bundle` with two
 * synthetic commits on top of HEAD, one holding the index and one the whole working tree (tracked and untracked,
 * never ignored files). Both are built through a temporary index, so the source checkout, its index and the shared
 * stash are never touched; only refs under `refs/maestrly/move/<operation>/` are added.
 */

export interface GitSourceInspection {
  branch: string | null
  headOid: string
  remoteUrl: string | null
  defaultBranch: string
  commitsAhead: number
  changes: LocalChangeSummary
  statusRaw: string
  stagedIndex: string
  blockers: MoveBlocker[]
  warnings: MoveWarningCode[]
}

export interface GitSnapshot {
  branch: string
  headOid: string
  indexTree: string
  worktreeTree: string
  indexCommit: string
  worktreeCommit: string
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Maestrly',
  GIT_AUTHOR_EMAIL: 'maestrly@localhost',
  GIT_COMMITTER_NAME: 'Maestrly',
  GIT_COMMITTER_EMAIL: 'maestrly@localhost',
}
const NON_INTERACTIVE = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
}
const BUNDLE_TIMEOUT_MS = 30 * 60_000

type RefNamespace = 'move' | 'incoming'
const moveRef = (operationId: string, namespace: RefNamespace, name: string): string =>
  `refs/maestrly/${namespace}/${operationId}/${name}`

/** A worktree's branch as `git worktree list` reports it, without its `refs/heads/` prefix. */
export const branchName = (ref: string | null): string | null => ref?.replace(/^refs\/heads\//, '') ?? null

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false
  )
}

async function git(cwd: string, args: string[], env?: Record<string, string>, timeoutMs?: number): Promise<string> {
  return (await runGitRaw(cwd, args, { ...(env ? { env } : {}), ...(timeoutMs ? { timeoutMs } : {}) })).trim()
}

/** Runs `work` with a private copy of the checkout's index, so the real one is neither read-locked nor rewritten. */
async function withIndexCopy<T>(cwd: string, work: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'maestrly-move-index-'))
  try {
    const index = path.join(dir, 'index')
    const real = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    // Seeds the stat cache so unchanged files are not hashed again; an empty index works too.
    await copyFile(real, index).catch(() => undefined)
    return await work({ GIT_INDEX_FILE: index })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * The branch a clone of origin checks out. Without origin/HEAD, a conventional remote branch is preferred to the
 * checkout's own branch, which may exist only here.
 */
async function remoteDefaultBranch(cwd: string): Promise<string> {
  const originHead = await runGitOrNull(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead) return originHead.replace(/^origin\//, '')
  for (const candidate of ['main', 'master']) {
    if ((await runGitOrNull(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`])) !== null)
      return candidate
  }
  return getDefaultBranch(cwd)
}

export async function inspectGitSource(cwd: string): Promise<GitSourceInspection> {
  const branch = (await runGitOrNull(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || null
  const headOid = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'])
  const remoteUrl = (await runGitOrNull(cwd, ['config', '--get', 'remote.origin.url'])) || null
  const defaultBranch = await remoteDefaultBranch(cwd)
  const commitsAhead = Number(await runGit(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'])) || 0
  const tree = await inspectWorkingTree(cwd)
  // inspectWorkingTree reports git-operation, unmerged and submodule-dirty, which share their codes here.
  const blockers: MoveBlocker[] = tree.blockers.map(({ code, message, paths }) => ({
    code: code as MoveBlockerCode,
    message,
    ...(paths ? { paths } : {}),
  }))
  if (!branch) blockers.push({ code: 'detached-head', message: 'The conversation is on a detached HEAD.' })
  if (!remoteUrl) blockers.push({ code: 'no-origin', message: 'The repository has no origin remote.' })
  const warnings: MoveWarningCode[] = []
  if (await exists(path.join(cwd, '.gitmodules'))) warnings.push('submodules')
  const attributes = await readFile(path.join(cwd, '.gitattributes'), 'utf8').catch(() => '')
  if (/filter=lfs/.test(attributes)) warnings.push('git-lfs')
  return {
    branch,
    headOid,
    remoteUrl,
    defaultBranch,
    commitsAhead,
    changes: tree.changes,
    statusRaw: tree.statusRaw,
    stagedIndex: tree.stagedIndex,
    blockers,
    warnings,
  }
}

/** The tree of the whole working tree as `git add -A` would stage it, without touching the real index. */
export async function worktreeTreeOid(cwd: string): Promise<string> {
  // Maestrly's own files (notes, editor sidecars) never travel as working-tree content: notes move as files and the
  // rest is ephemeral. They are app-owned excludes, which the app keeps in every checkout's info/exclude.
  await ensureAppOwnedExcludes(cwd)
  return withIndexCopy(cwd, async (env) => {
    // Honors .gitignore and info/exclude, so ignored files stay out.
    await git(cwd, ['add', '-A', '--', ':/'], env)
    return git(cwd, ['write-tree'], env)
  })
}

async function indexTreeOid(cwd: string): Promise<string> {
  return withIndexCopy(cwd, (env) => git(cwd, ['write-tree'], env))
}

export async function createGitSnapshot(cwd: string, operationId: string, bundlePath: string): Promise<GitSnapshot> {
  const branch = await runGit(cwd, ['symbolic-ref', '--short', 'HEAD'])
  const headOid = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'])
  const indexTree = await indexTreeOid(cwd)
  const worktreeTree = await worktreeTreeOid(cwd)
  const commit = (tree: string, label: string) =>
    git(
      cwd,
      ['commit-tree', '--no-gpg-sign', tree, '-p', headOid, '-m', `maestrly move ${label} ${operationId}`],
      IDENTITY
    )
  const indexCommit = await commit(indexTree, 'index')
  const worktreeCommit = await commit(worktreeTree, 'worktree')
  for (const [name, oid] of [
    ['head', headOid],
    ['index', indexCommit],
    ['worktree', worktreeCommit],
  ]) {
    await runGit(cwd, ['update-ref', moveRef(operationId, 'move', name), oid])
  }
  // Commits the remote already has are left out; the destination fetches them from its origin. When HEAD itself is
  // on the remote, Git drops the head ref from the bundle and it becomes a prerequisite of the two snapshots.
  await git(
    cwd,
    [
      'bundle',
      'create',
      bundlePath,
      moveRef(operationId, 'move', 'head'),
      moveRef(operationId, 'move', 'index'),
      moveRef(operationId, 'move', 'worktree'),
      '--not',
      '--remotes=origin',
    ],
    undefined,
    BUNDLE_TIMEOUT_MS
  )
  return { branch, headOid, indexTree, worktreeTree, indexCommit, worktreeCommit }
}

export async function isAncestor(cwd: string, ancestorOid: string, oid: string): Promise<boolean> {
  try {
    await runGitRaw(cwd, ['merge-base', '--is-ancestor', ancestorOid, oid])
    return true
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 1) return false
    throw error
  }
}

export interface ApplyGitSnapshotArgs {
  top: string
  destination: string
  operationId: string
  bundlePath: string
  snapshot: GitSnapshot
  branch: string
  branchAction: MoveBranchAction
  expectedTipOid?: string
}

export interface AppliedGitSnapshot {
  branchCreated: boolean
  previousTipOid: string | null
}

/**
 * Recreates the snapshot in a new worktree of `top` at `destination`: the branch at the source's HEAD, the index and
 * the working tree as they were. A failure removes whatever this call created before it is rethrown.
 */
export async function applyGitSnapshot(args: ApplyGitSnapshotArgs): Promise<AppliedGitSnapshot> {
  const { top, operationId, snapshot } = args
  // Best effort: brings the bundle's prerequisites from origin.
  await fetchRemotes(top)
  try {
    await git(top, ['bundle', 'verify', args.bundlePath], NON_INTERACTIVE)
  } catch (error) {
    throw new MoveError('base-unavailable', `The destination lacks the base commits: ${moveErrorMessage(error)}`)
  }
  await git(
    top,
    [
      'fetch',
      '--no-tags',
      args.bundlePath,
      `refs/maestrly/move/${operationId}/*:refs/maestrly/incoming/${operationId}/*`,
    ],
    NON_INTERACTIVE,
    BUNDLE_TIMEOUT_MS
  )
  const parents = await Promise.all(
    (['index', 'worktree'] as const).map((name) =>
      runGitOrNull(top, ['rev-parse', '--verify', `${moveRef(operationId, 'incoming', name)}^1`])
    )
  )
  const fetched = await Promise.all(
    (['index', 'worktree'] as const).map((name) =>
      runGitOrNull(top, ['rev-parse', '--verify', moveRef(operationId, 'incoming', name)])
    )
  )
  if (
    parents.some((parent) => parent !== snapshot.headOid) ||
    fetched[0] !== snapshot.indexCommit ||
    fetched[1] !== snapshot.worktreeCommit
  ) {
    await dropMoveRefs(top, operationId, 'incoming')
    throw new MoveError('package-invalid', 'The bundle does not hold the exported snapshot.')
  }

  const applied: AppliedGitSnapshot = { branchCreated: false, previousTipOid: null }
  let worktreeAdded = false
  try {
    let cwd: string
    if (args.branchAction === 'create') {
      cwd = await createWorktree({
        top,
        branch: args.branch,
        base: snapshot.headOid,
        isNewBranch: true,
        baseRevision: snapshot.headOid,
        exclusive: true,
        reserveDestination: true,
        dest: args.destination,
      })
      applied.branchCreated = true
    } else {
      // Moving the tip of a branch another worktree has checked out would change that checkout under it.
      if ((await listWorktrees(top)).some((worktree) => branchName(worktree.branch) === args.branch))
        throw new MoveError('branch-changed', `Branch ${args.branch} is already checked out on the destination.`)
      const tip = await runGitOrNull(top, ['rev-parse', '--verify', `refs/heads/${args.branch}`])
      if (args.branchAction === 'reuse' && tip !== snapshot.headOid)
        throw new MoveError('branch-changed', 'The destination branch moved.')
      if (args.branchAction === 'fast-forward') {
        if (!tip || tip !== args.expectedTipOid) throw new MoveError('branch-changed', 'The destination branch moved.')
        await runGit(top, ['update-ref', `refs/heads/${args.branch}`, snapshot.headOid, tip])
        applied.previousTipOid = tip
      }
      cwd = await createWorktree({
        top,
        branch: args.branch,
        base: args.branch,
        isNewBranch: false,
        dest: args.destination,
      })
    }
    // createWorktree hands back an existing checkout of the branch instead of creating one.
    if (path.resolve(cwd) !== path.resolve(args.destination))
      throw new MoveError('branch-changed', `Branch ${args.branch} is already checked out on the destination.`)
    worktreeAdded = true
    await ensureAppOwnedExcludes(args.destination)
    // The working tree first (tracked and untracked contents), then the staged state in the index alone.
    await runGit(args.destination, ['read-tree', '-u', '--reset', snapshot.worktreeCommit])
    await runGit(args.destination, ['read-tree', snapshot.indexCommit])
    return applied
  } catch (error) {
    if (worktreeAdded || applied.branchCreated || applied.previousTipOid) {
      await rollbackAppliedSnapshot({
        top,
        destination: worktreeAdded ? args.destination : '',
        operationId,
        branch: args.branch,
        branchCreated: applied.branchCreated,
        previousTipOid: applied.previousTipOid,
        headOid: snapshot.headOid,
      }).catch(() => undefined)
    } else {
      await dropMoveRefs(top, operationId, 'incoming').catch(() => undefined)
    }
    throw error
  }
}

export async function verifyAppliedSnapshot(cwd: string, snapshot: GitSnapshot, branch: string): Promise<boolean> {
  try {
    return (
      (await runGitOrNull(cwd, ['symbolic-ref', '--short', 'HEAD'])) === branch &&
      (await runGit(cwd, ['rev-parse', 'HEAD'])) === snapshot.headOid &&
      (await indexTreeOid(cwd)) === snapshot.indexTree &&
      (await worktreeTreeOid(cwd)) === snapshot.worktreeTree
    )
  } catch {
    return false
  }
}

export interface RollbackAppliedSnapshotArgs {
  top: string
  /** The worktree to remove; empty when none was created. */
  destination: string
  operationId: string
  branch: string
  branchCreated: boolean
  previousTipOid: string | null
  headOid: string
}

export async function rollbackAppliedSnapshot(args: RollbackAppliedSnapshotArgs): Promise<void> {
  if (args.destination) {
    await removeWorktree(args.top, args.destination, true).catch(() => undefined)
    await rm(args.destination, { recursive: true, force: true })
    await runGitOrNull(args.top, ['worktree', 'prune'])
  }
  if (args.branchCreated) await deleteBranch(args.top, args.branch)
  else if (args.previousTipOid)
    // Only puts the old tip back while the branch is still where the move left it.
    await runGitOrNull(args.top, ['update-ref', `refs/heads/${args.branch}`, args.previousTipOid, args.headOid])
  await dropMoveRefs(args.top, args.operationId, 'incoming')
}

/** Keeps the moved working tree reachable on the source as `refs/maestrly/moved/<operation>`. */
export async function keepMovedBackupRef(cwd: string, operationId: string): Promise<void> {
  const worktree = await runGitOrNull(cwd, ['rev-parse', '--verify', moveRef(operationId, 'move', 'worktree')])
  if (worktree) await runGit(cwd, ['update-ref', `refs/maestrly/moved/${operationId}`, worktree])
  await dropMoveRefs(cwd, operationId, 'move')
}

export async function dropMoveRefs(cwd: string, operationId: string, namespace: RefNamespace): Promise<void> {
  const refs =
    (await runGitOrNull(cwd, ['for-each-ref', '--format=%(refname)', `refs/maestrly/${namespace}/${operationId}`])) ??
    ''
  for (const name of refs.split('\n').filter(Boolean)) await runGitOrNull(cwd, ['update-ref', '-d', name])
}
