/**
 * Code revision capture and stable review copies.
 *
 * A revision identifies a complete version of the code: the base and head commits plus a digest over the
 * whole captured content (tracked changes and new files). A partial capture is refused instead of being
 * reported as a weaker fingerprint, because reviews and checks are bound to this identity.
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CodeRevision } from '@maestrly/protocol'

const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 256 * 1024 * 1024
/** Hard ceiling for one captured revision; exceeding it fails the capture with an explicit reason. */
export const MAX_REVISION_BYTES = 128 * 1024 * 1024
const MAX_UNTRACKED_FILES = 2_000

export class RevisionCaptureError extends Error {
  readonly reason: 'not-a-repository' | 'too-large' | 'too-many-files' | 'git-failed'
  constructor(reason: RevisionCaptureError['reason'], message: string) {
    super(message)
    this.name = 'RevisionCaptureError'
    this.reason = reason
  }
}

export type GitRunner = (args: string[], options?: { cwd?: string; binary?: boolean }) => Promise<Buffer>

export function createGitRunner(defaultCwd: string): GitRunner {
  return (args, options = {}) =>
    new Promise<Buffer>((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
        {
          cwd: options.cwd ?? defaultCwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
          encoding: 'buffer',
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          },
        },
        (error, stdout) => {
          if (error) reject(new RevisionCaptureError('git-failed', error.message))
          else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)))
        }
      )
    })
}

export interface CapturedRevision {
  revision: CodeRevision
  /** Unified patch of every tracked and new file relative to the head commit. */
  patch: Buffer
  untracked: string[]
}

async function untrackedFiles(git: GitRunner): Promise<string[]> {
  const output = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).toString('utf8')
  const files = output.split('\0').filter((entry) => entry.length > 0)
  if (files.length > MAX_UNTRACKED_FILES)
    throw new RevisionCaptureError(
      'too-many-files',
      `The workspace has ${files.length} new files, above the ${MAX_UNTRACKED_FILES} that can be captured as one revision.`
    )
  return files
}

/**
 * Capture the current version of a workspace. New files are added with `--intent-to-add` so they appear in
 * the patch, and the index is restored afterwards.
 */
export async function captureCodeRevision(input: { cwd: string; git?: GitRunner }): Promise<CapturedRevision> {
  const git = input.git ?? createGitRunner(input.cwd)
  let head: string
  try {
    head = (await git(['rev-parse', 'HEAD'])).toString('utf8').trim()
  } catch {
    throw new RevisionCaptureError('not-a-repository', 'The delegation workspace is not a Git repository.')
  }
  const base = (await git(['rev-parse', '--verify', `${head}^{commit}`])).toString('utf8').trim()
  const untracked = await untrackedFiles(git)
  if (untracked.length) await git(['add', '--intent-to-add', '--', ...untracked])
  let patch: Buffer
  try {
    patch = await git(['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'])
  } finally {
    if (untracked.length) await git(['reset', '--quiet', '--', ...untracked]).catch(() => undefined)
  }
  if (patch.byteLength > MAX_REVISION_BYTES)
    throw new RevisionCaptureError(
      'too-large',
      `The captured change is ${patch.byteLength} bytes, above the ${MAX_REVISION_BYTES} byte limit for one revision.`
    )
  const digest = createHash('sha256')
    .update(head)
    .update('\0')
    .update(String(patch.byteLength))
    .update('\0')
    .update(patch)
    .digest('hex')
  return {
    revision: {
      id: randomUUID(),
      baseCommit: base,
      headCommit: head,
      contentDigest: digest,
      snapshotArtifactId: null,
      capturedAt: new Date().toISOString(),
    },
    patch,
    untracked,
  }
}

export interface ReviewCopy {
  path: string
  revision: CodeRevision
  dispose(): Promise<void>
}

/**
 * Materialize a stable copy of a captured revision. The reviewer works on this directory, so a later edit in
 * the implementer's workspace cannot change what was reviewed.
 */
export async function materializeReviewCopy(input: {
  cwd: string
  captured?: CapturedRevision
  baseDirectory?: string
  git?: GitRunner
}): Promise<ReviewCopy> {
  const git = input.git ?? createGitRunner(input.cwd)
  const captured = input.captured ?? (await captureCodeRevision({ cwd: input.cwd, git }))
  const root = await fs.mkdtemp(
    path.join(input.baseDirectory ?? os.tmpdir(), `maestrly-review-${captured.revision.id}-`)
  )
  const target = path.join(root, 'workspace')
  try {
    await git(['worktree', 'add', '--detach', '--quiet', target, captured.revision.headCommit!])
    if (captured.patch.byteLength > 0) {
      const patchFile = path.join(root, 'revision.patch')
      await fs.writeFile(patchFile, captured.patch, { mode: 0o600 })
      await git(['apply', '--binary', '--whitespace=nowarn', patchFile], { cwd: target })
    }
    await fs.chmod(target, 0o700).catch(() => undefined)
    return {
      path: target,
      revision: captured.revision,
      dispose: async () => {
        await git(['worktree', 'remove', '--force', target]).catch(() => undefined)
        await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
      },
    }
  } catch (error) {
    await git(['worktree', 'remove', '--force', target]).catch(() => undefined)
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** True when a path exists and is a directory this process can read. */
export async function directoryUsable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, fsConstants.R_OK)
    return (await fs.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}
