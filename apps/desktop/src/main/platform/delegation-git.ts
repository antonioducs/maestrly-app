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

/** Deterministic commit subject; the body carries the task identity for traceability. */
export function commitMessageFor(input: { taskId: string; title: string }): string {
  const subject = input.title.trim().replace(/\s+/g, ' ').slice(0, 72) || 'apply delegated change'
  return `${subject}\n\nMaestrly-Delegation-Task: ${input.taskId}\n`
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
  await fs.writeFile(message, commitMessageFor({ taskId: input.taskId, title: input.title }), { mode: 0o600 })
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
