import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { jsonSchema, tool, type Tool } from 'ai'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 20_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const SECTION_LIMIT = 24_000
const UNTRACKED_LIMIT = 200

/** Bounded, read-only snapshot of what changed in a checkout. */
export interface GitSnapshot {
  repository: boolean
  branch: string
  head: string
  base?: string
  baseDiff: string
  staged: string
  unstaged: string
  untracked: string[]
  truncated: boolean
}

function clip(value: string, limit = SECTION_LIMIT): { value: string; truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false }
  const half = Math.floor((limit - 32) / 2)
  return {
    value: `${value.slice(0, half)}\n… [truncated by host] …\n${value.slice(-half)}`,
    truncated: true,
  }
}

async function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('git_diff was cancelled')
  const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    signal,
    windowsHide: true,
  })
  return stdout.trimEnd()
}

async function optionalGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  try {
    return await git(cwd, args, signal)
  } catch {
    return ''
  }
}

const firstLine = (value: string): string => value.split(/\r?\n/, 1)[0] ?? ''

/**
 * Base-to-HEAD (merge base with the upstream, or with origin's default branch), staged and unstaged diffs, and
 * untracked paths. Never runs external diff or textconv drivers.
 */
export async function readGitSnapshot(cwd: string, signal?: AbortSignal): Promise<GitSnapshot> {
  const inside = await optionalGit(cwd, ['rev-parse', '--is-inside-work-tree'], signal)
  if (inside !== 'true') {
    return {
      repository: false,
      branch: '',
      head: '',
      baseDiff: '',
      staged: '',
      unstaged: '',
      untracked: [],
      truncated: false,
    }
  }
  const [branchRaw, headRaw, upstreamRaw, originHead, stagedRaw, unstagedRaw, untrackedRaw] = await Promise.all([
    optionalGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], signal),
    optionalGit(cwd, ['rev-parse', 'HEAD'], signal),
    optionalGit(cwd, ['rev-parse', '--verify', '@{upstream}'], signal),
    optionalGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], signal),
    optionalGit(cwd, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--'], signal),
    optionalGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--'], signal),
    optionalGit(cwd, ['ls-files', '--others', '--exclude-standard', '--'], signal),
  ])
  const branch = firstLine(branchRaw)
  const head = firstLine(headRaw)
  // Prefer the default branch: on a feature branch whose upstream is itself, the upstream hides committed work.
  let base = originHead ? firstLine(await optionalGit(cwd, ['rev-parse', '--verify', originHead, '--'], signal)) : ''
  if (!base) base = firstLine(upstreamRaw)
  const mergeBase = base ? firstLine(await optionalGit(cwd, ['merge-base', base, 'HEAD', '--'], signal)) : ''
  const baseRaw =
    mergeBase && mergeBase !== head
      ? await optionalGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', `${mergeBase}..HEAD`, '--'], signal)
      : ''
  const baseDiff = clip(baseRaw)
  const staged = clip(stagedRaw)
  const unstaged = clip(unstagedRaw)
  const allUntracked = untrackedRaw ? untrackedRaw.split(/\r?\n/).filter(Boolean) : []
  const untracked = allUntracked.slice(0, UNTRACKED_LIMIT)
  return {
    repository: true,
    branch: branch || '(detached)',
    head: head || '(unknown)',
    ...(mergeBase ? { base: mergeBase } : {}),
    baseDiff: baseDiff.value,
    staged: staged.value,
    unstaged: unstaged.value,
    untracked,
    truncated: baseDiff.truncated || staged.truncated || unstaged.truncated || allUntracked.length > untracked.length,
  }
}

export function snapshotHasChanges(snapshot: GitSnapshot): boolean {
  return (
    snapshot.repository &&
    (snapshot.baseDiff.trim().length > 0 ||
      snapshot.staged.trim().length > 0 ||
      snapshot.unstaged.trim().length > 0 ||
      snapshot.untracked.length > 0)
  )
}

export function formatGitSnapshot(snapshot: GitSnapshot): string {
  return [
    `Branch: ${snapshot.branch}`,
    `HEAD: ${snapshot.head}`,
    snapshot.base ? `Base: ${snapshot.base}` : 'Base: unavailable',
    `Truncated: ${snapshot.truncated ? 'yes (read the files for the full change)' : 'no'}`,
    `\n## Base to HEAD\n${snapshot.baseDiff || '(no committed changes or base unavailable)'}`,
    `\n## Staged\n${snapshot.staged || '(none)'}`,
    `\n## Unstaged\n${snapshot.unstaged || '(none)'}`,
    `\n## Untracked\n${snapshot.untracked.join('\n') || '(none)'}`,
  ].join('\n')
}

/** Read-only host tool that shows a reviewer what changed in the checkout. */
export function gitDiffTool(cwd: string): Tool {
  return tool({
    description:
      'Returns a bounded, read-only Git snapshot of the checkout under review: the committed diff from the base ' +
      'branch to HEAD, staged and unstaged diffs, and untracked paths. Read files for anything truncated.',
    metadata: { readOnly: true, parallelSafe: true },
    inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
    execute: async (_input: unknown, options?: { abortSignal?: AbortSignal }) =>
      formatGitSnapshot(await readGitSnapshot(cwd, options?.abortSignal)),
  })
}
