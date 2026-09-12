import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { defineTool, type ToolContext } from './util'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 20_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const SECTION_LIMIT = 24_000
const UNTRACKED_LIMIT = 200

const parameters = z.object({}).strict()

export interface GitDiffResult {
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

async function git(ctx: ToolContext, args: readonly string[]): Promise<string> {
  if (ctx.signal.aborted) throw new Error('git_diff was cancelled')
  const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: ctx.cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    signal: ctx.signal,
    windowsHide: true,
  })
  return stdout.trimEnd()
}

async function optionalGit(ctx: ToolContext, args: readonly string[]): Promise<string> {
  try {
    return await git(ctx, args)
  } catch {
    return ''
  }
}

async function run(_args: z.infer<typeof parameters>, ctx: ToolContext): Promise<GitDiffResult> {
  if (!ctx.reviewer) throw new Error('git_diff is available only in an internal reviewer turn')

  const [branchRaw, headRaw, upstreamRaw, originHead, stagedRaw, unstagedRaw, untrackedRaw] = await Promise.all([
    optionalGit(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']),
    optionalGit(ctx, ['rev-parse', 'HEAD']),
    optionalGit(ctx, ['rev-parse', '--verify', '@{upstream}']),
    optionalGit(ctx, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
    optionalGit(ctx, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--']),
    optionalGit(ctx, ['diff', '--no-ext-diff', '--no-textconv', '--']),
    optionalGit(ctx, ['ls-files', '--others', '--exclude-standard', '--']),
  ])

  const branch = branchRaw.split(/\r?\n/, 1)[0] ?? ''
  const head = headRaw.split(/\r?\n/, 1)[0] ?? ''
  const upstream = upstreamRaw.split(/\r?\n/, 1)[0] ?? ''

  let base = upstream
  if (!base && originHead) base = await optionalGit(ctx, ['rev-parse', '--verify', originHead, '--'])
  const mergeBase = base ? await optionalGit(ctx, ['merge-base', base, 'HEAD', '--']) : ''
  const baseRaw = mergeBase
    ? await optionalGit(ctx, ['diff', '--no-ext-diff', '--no-textconv', `${mergeBase}..HEAD`, '--'])
    : ''
  const baseDiff = clip(baseRaw)
  const staged = clip(stagedRaw)
  const unstaged = clip(unstagedRaw)
  const allUntracked = untrackedRaw ? untrackedRaw.split(/\r?\n/).filter(Boolean) : []
  const untracked = allUntracked.slice(0, UNTRACKED_LIMIT)
  const truncated = baseDiff.truncated || staged.truncated || unstaged.truncated || allUntracked.length > untracked.length
  ctx.reviewer.recordEvidence('diff')
  return {
    branch: branch || '(detached)',
    head: head || '(unknown)',
    ...(mergeBase ? { base: mergeBase } : {}),
    baseDiff: baseDiff.value,
    staged: staged.value,
    unstaged: unstaged.value,
    untracked,
    truncated,
  }
}

export const gitDiffTool = defineTool({
  name: 'git_diff',
  description:
    'Returns a bounded, read-only Git snapshot: base-to-HEAD when a base is known, staged and unstaged diffs, and untracked paths.',
  parameters,
  execute: run,
  toModelText: (_args, result) =>
    [
      `Branch: ${result.branch}`,
      `HEAD: ${result.head}`,
      result.base ? `Base: ${result.base}` : 'Base: unavailable',
      `Truncated: ${result.truncated ? 'yes' : 'no'}`,
      `\n## Base to HEAD\n${result.baseDiff || '(no committed diff or base unavailable)'}`,
      `\n## Staged\n${result.staged || '(none)'}`,
      `\n## Unstaged\n${result.unstaged || '(none)'}`,
      `\n## Untracked\n${result.untracked.join('\n') || '(none)'}`,
    ].join('\n'),
})
