/**
 * Git delivery for a delegation task.
 *
 * Every step is structured and argument-based: no shell interpolation, no force push, and no commit of changes
 * that arrived after the revision the delivery was authorized for. When the remote moved, both sides are
 * preserved and the task reports it instead of overwriting anything.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CodeRevision } from '@maestrly/protocol'
import { captureCodeRevision, createGitRunner, type GitRunner } from './delegation-snapshot'

export class DeliveryError extends Error {
  readonly reason:
    | 'not-a-repository'
    | 'revision-changed'
    | 'nothing-to-commit'
    | 'no-remote'
    | 'remote-diverged'
    | 'git-failed'
  constructor(reason: DeliveryError['reason'], message: string) {
    super(message)
    this.name = 'DeliveryError'
    this.reason = reason
  }
}

export interface DeliveryBranchInput {
  cwd: string
  taskId: string
  /** Revision the delivery was authorized for; a mismatch stops the delivery. */
  expectedRevision: CodeRevision
  title: string
  git?: GitRunner
  authorName?: string
  authorEmail?: string
}

/** Stable branch name per task, so a retry finds the same branch instead of creating another. */
export function deliveryBranchName(taskId: string): string {
  return `maestrly/delegation-${taskId.replace(/-/g, '').slice(0, 12)}`
}

const DELIVERY_TASK_TRAILER = 'Maestrly-Delegation-Task'
/** The revision the commit was authorized for, so a later delivery mode recognises its own commit. */
const DELIVERY_REVISION_TRAILER = 'Maestrly-Delegation-Revision'

/** Deterministic commit subject; the body carries the task identity for traceability. */
export function commitMessageFor(input: { taskId: string; title: string; revisionDigest?: string | null }): string {
  const subject = input.title.trim().replace(/\s+/g, ' ').slice(0, 72) || 'apply delegated change'
  const trailers = [`${DELIVERY_TASK_TRAILER}: ${input.taskId}`]
  if (input.revisionDigest) trailers.push(`${DELIVERY_REVISION_TRAILER}: ${input.revisionDigest}`)
  return `${subject}\n\n${trailers.join('\n')}\n`
}

async function currentRevision(cwd: string, git: GitRunner): Promise<CodeRevision> {
  return (await captureCodeRevision({ cwd, git })).revision
}

/**
 * Commit the authorized revision. The workspace is re-captured first: if the content changed after the
 * authorization, nothing is committed.
 */
export async function commitAuthorizedRevision(input: DeliveryBranchInput): Promise<{
  commitSha: string
  branch: string
  revision: CodeRevision
}> {
  const git = input.git ?? createGitRunner(input.cwd)
  const observed = await currentRevision(input.cwd, git)
  if (observed.contentDigest !== input.expectedRevision.contentDigest)
    throw new DeliveryError(
      'revision-changed',
      'The workspace changed after this delivery was authorized. Re-review the current revision first.'
    )
  const branch = deliveryBranchName(input.taskId)
  const existing = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).toString('utf8').trim()
  if (existing !== branch) {
    const known = (await git(['for-each-ref', '--format=%(refname:strip=2)', `refs/heads/${branch}`]))
      .toString('utf8')
      .trim()
    await git(known ? ['checkout', '--quiet', branch] : ['checkout', '--quiet', '-b', branch])
  }
  await git(['add', '--all', '--', '.'])
  const staged = (await git(['diff', '--cached', '--name-only'])).toString('utf8').trim()
  if (!staged) throw new DeliveryError('nothing-to-commit', 'There is nothing to commit in this workspace.')
  const message = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-commit-')), 'message.txt')
  await fs.writeFile(
    message,
    commitMessageFor({
      taskId: input.taskId,
      title: input.title,
      revisionDigest: input.expectedRevision.contentDigest,
    }),
    { mode: 0o600 }
  )
  try {
    await git([
      '-c',
      `user.name=${input.authorName ?? 'Maestrly delegation'}`,
      '-c',
      `user.email=${input.authorEmail ?? 'delegation@maestrly.invalid'}`,
      'commit',
      '--file',
      message,
      '--no-verify',
    ])
  } finally {
    await fs.rm(path.dirname(message), { recursive: true, force: true }).catch(() => undefined)
  }
  const commitSha = (await git(['rev-parse', 'HEAD'])).toString('utf8').trim()
  return { commitSha, branch, revision: await currentRevision(input.cwd, git) }
}

export interface ExistingAuthorizedCommit {
  commitSha: string
  branch: string
}

/**
 * The commit a previous delivery of this task already created, when the workspace still holds exactly it.
 *
 * Delivery modes are cumulative: a commit is followed by a push, a pull request and a merge with nothing new
 * in between, and committing moves the revision identity (the digest covers the head commit plus the pending
 * patch). Without this, every mode after the first would either fail with `nothing-to-commit` or look like a
 * workspace that changed after the authorization.
 *
 * Reuse is accepted only when the delivery branch head is this task's own commit, the workspace is exactly
 * that commit with nothing uncommitted, and the authorized revision is either what the workspace shows now or
 * the digest that commit recorded. Anything else keeps the ordinary refusal.
 */
export async function existingAuthorizedCommit(input: {
  cwd: string
  taskId: string
  /** Revision digest this delivery was authorized for. */
  authorizedDigest: string
  /** Revision digest captured from the workspace right now. */
  observedDigest: string
  git?: GitRunner
}): Promise<ExistingAuthorizedCommit | null> {
  const git = input.git ?? createGitRunner(input.cwd)
  const branch = deliveryBranchName(input.taskId)
  const head = (await git(['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`])).toString('utf8').trim()
  if (!head) return null
  const message = (await git(['log', '-1', '--format=%B', head])).toString('utf8')
  if (!message.includes(`${DELIVERY_TASK_TRAILER}: ${input.taskId}`)) return null
  if (
    input.authorizedDigest !== input.observedDigest &&
    !message.includes(`${DELIVERY_REVISION_TRAILER}: ${input.authorizedDigest}`)
  )
    return null
  // The delivery branch must be what this workspace is on, with no change on top of the commit being reused.
  const current = (await git(['rev-parse', 'HEAD'])).toString('utf8').trim()
  if (current !== head) return null
  const pending = (await git(['status', '--porcelain', '--untracked-files=all'])).toString('utf8').trim()
  if (pending) return null
  return { commitSha: head, branch }
}

/** Patch of an already committed delivery, so a patch delivery after a commit still carries the real change. */
export async function authorizedCommitPatch(input: {
  cwd: string
  commitSha: string
  git?: GitRunner
}): Promise<Buffer> {
  const git = input.git ?? createGitRunner(input.cwd)
  return git(['show', '--binary', '--no-ext-diff', '--no-textconv', '--format=', input.commitSha])
}

export interface PushInput {
  cwd: string
  branch: string
  /** Last remote commit this computer observed; a different one means someone else pushed. */
  knownRemoteSha: string | null
  git?: GitRunner
  remote?: string
}

/**
 * Push without force. When the remote advanced past what this computer knew, the push is refused so both
 * histories survive and a person decides.
 */
export async function pushDeliveryBranch(input: PushInput): Promise<{ remoteSha: string; created: boolean }> {
  const git = input.git ?? createGitRunner(input.cwd)
  const remote = input.remote ?? 'origin'
  const remotes = (await git(['remote'])).toString('utf8').trim().split('\n').filter(Boolean)
  if (!remotes.includes(remote)) throw new DeliveryError('no-remote', `This workspace has no "${remote}" remote.`)
  const listed = (await git(['ls-remote', '--heads', remote, input.branch])).toString('utf8').trim()
  const remoteSha = listed ? listed.split(/\s+/)[0]! : null
  if (remoteSha && input.knownRemoteSha && remoteSha !== input.knownRemoteSha)
    throw new DeliveryError(
      'remote-diverged',
      `The remote branch moved to ${remoteSha.slice(0, 12)} after this task last saw ${input.knownRemoteSha.slice(0, 12)}. Nothing was overwritten.`
    )
  await git(['push', '--set-upstream', remote, `${input.branch}:${input.branch}`])
  const after = (await git(['ls-remote', '--heads', remote, input.branch])).toString('utf8').trim()
  return { remoteSha: after.split(/\s+/)[0] ?? '', created: !remoteSha }
}

/** Stable idempotency key for a delivery attempt, so a retry reuses the recorded intention. */
export function deliveryKey(input: { taskId: string; mode: string; revisionDigest: string }): string {
  return createHash('sha256')
    .update([input.taskId, input.mode, input.revisionDigest].join('\0'))
    .digest('hex')
    .slice(0, 40)
}
