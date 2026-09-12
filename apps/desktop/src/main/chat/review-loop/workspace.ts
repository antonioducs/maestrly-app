import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { WorkspaceSnapshot } from './types'

const UNTRACKED_LIMIT = 200
const UNTRACKED_HASH_BYTES = 512 * 1024
const SNAPSHOT_TEXT_HASH_BYTES = 16 * 1024 * 1024
const GIT_TIMEOUT_MS = 20_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024

/** Known internal Maestrly sidecars that never enter the workspace fingerprint. */
const MAESTRLY_SIDECAR_PATHS = ['.maestrly/agent-open-file.json']

export type ReviewLoopGitRunner = (args: string[], signal?: AbortSignal) => Promise<string>

function isMaestrlySidecar(rel: string): boolean {
  return MAESTRLY_SIDECAR_PATHS.includes(rel) || rel === '.maestrly' || rel.startsWith('.maestrly/')
}

function hashText(text: string): string {
  const buf = Buffer.from(text, 'utf8')
  const head = buf.subarray(0, SNAPSHOT_TEXT_HASH_BYTES)
  return createHash('sha256').update(head).update(String(buf.length)).digest('hex')
}

export function fingerprintOf(snapshot: WorkspaceSnapshot): string {
  const normalized = {
    branch: snapshot.branch,
    head: snapshot.head,
    unstaged: hashText(snapshot.unstaged),
    staged: hashText(snapshot.staged),
    untracked: snapshot.untracked.map((u) => [u.path, u.hash]),
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export function createReviewLoopGitRunner(cwd: string): ReviewLoopGitRunner {
  return (args, signal) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'core.fsmonitor=false', ...args],
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8', signal },
        (error, stdout) => {
          if (error) reject(error instanceof Error ? error : new Error(String(error)))
          else resolve(stdout)
        }
      )
    })
}

export async function snapshotWorkspace(input: {
  cwd: string
  runGit: ReviewLoopGitRunner
}): Promise<WorkspaceSnapshot> {
  const git = async (args: string[]): Promise<string> => {
    try {
      return (await input.runGit(args))?.trim() ?? ''
    } catch {
      return ''
    }
  }
  const [branch, head, unstaged, staged, untrackedRaw] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['rev-parse', 'HEAD']),
    git(['diff', '--no-ext-diff', '--no-textconv']),
    git(['diff', '--cached', '--no-ext-diff', '--no-textconv']),
    git(['ls-files', '--others', '--exclude-standard']),
  ])
  const untracked: Array<{ path: string; hash: string }> = []
  for (const raw of untrackedRaw.split('\n')) {
    const rel = raw.trim()
    if (!rel || rel.includes('\0') || /[\r\n]/.test(rel)) continue
    if (isMaestrlySidecar(rel)) continue
    if (untracked.length >= UNTRACKED_LIMIT) break
    const abs = path.resolve(input.cwd, rel)
    if (path.relative(input.cwd, abs).startsWith('..')) continue
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
    try {
      handle = await fsp.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const stat = await handle.stat()
      if (!stat.isFile()) continue
      const len = Math.min(stat.size, UNTRACKED_HASH_BYTES)
      const buf = Buffer.alloc(len)
      let bytesRead = 0
      while (bytesRead < len) {
        const chunk = await handle.read(buf, bytesRead, len - bytesRead, bytesRead)
        if (chunk.bytesRead === 0) break
        bytesRead += chunk.bytesRead
      }
      untracked.push({
        path: rel,
        hash: createHash('sha256')
          .update(buf.subarray(0, bytesRead))
          .update(String(stat.size))
          .digest('hex')
          .slice(0, 16),
      })
    } catch {
      await handle?.close().catch(() => undefined)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
  return { branch, head, unstaged, staged, untracked }
}
