import { getConversation } from './store'
import { getToplevel, getDefaultBranch, getDiff, isGitRepo } from './git-service'
import { GhCommandError, runGhCommand } from './gh-command'

/**
 * Collect conversation branch review data through gh and Git: PR diff/status, checks/Actions, and
 * comments. Read-only in V1. gh uses the user's CLI login/keyring; remove GH_TOKEN/GITHUB_TOKEN from
 * subprocess environments so they cannot override it. Return friendly errors without breaking the
 * Review tab.
 */

export interface PrInfo {
  number: number
  title: string
  state: string // OPEN | CLOSED | MERGED
  isDraft: boolean
  reviewDecision: string // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
  mergeable: string // MERGEABLE | CONFLICTING | UNKNOWN
  mergeStateStatus: string // CLEAN | BLOCKED | DIRTY | BEHIND | ...
  baseRef: string
  url: string
  additions: number
  deletions: number
  changedFiles: number
}

export interface CheckInfo {
  name: string
  bucket: string // pass | fail | pending | skipping | cancel
  state: string
  link: string // detailsUrl
  workflow: string
}

export interface ReviewComment {
  kind: 'review' | 'comment' | 'inline'
  author: string
  body: string
  state?: string // p/ reviews: APPROVED | CHANGES_REQUESTED | COMMENTED
  path?: string // p/ inline
  line?: number // p/ inline
  side?: string // p/ inline: LEFT | RIGHT
  createdAt?: string
}

export type ReviewError = 'no-gh' | 'not-logged-in' | 'no-repo' | 'no-remote' | 'no-pr'

export interface ReviewData {
  repo: string | null // OWNER/REPO or null
  branch: string
  pr: PrInfo | null
  diff: string // unified diff text
  diffSource: 'pr' | 'local'
  checks: CheckInfo[]
  comments: ReviewComment[]
  error?: ReviewError
}

/** One repository in a single- or multi-repository conversation, with its review data. */
export interface RepoReview extends ReviewData {
  linkName: string // repository link name in the aggregator, empty for single repository
  repoTop: string
}
export interface MultiReviewData {
  repos: RepoReview[]
}

const MAX_DIFF = 400_000 // approximately 400 KB; larger diffs are truncated with an editor hint

function capDiff(s: string): string {
  return s.length > MAX_DIFF
    ? s.slice(0, MAX_DIFF) + '\n\n[… diff truncated; open the file in VS Code to view all content …]'
    : s
}

interface GhResult {
  stdout: string
  exitCode: number // zero means success; positive means gh failed
  notFound: boolean // gh is not installed (ENOENT)
}

async function gh(cwd: string, args: string[]): Promise<GhResult> {
  try {
    const stdout = await runGhCommand(cwd, args)
    return { stdout, exitCode: 0, notFound: false }
  } catch (e) {
    if (e instanceof GhCommandError && e.kind === 'no-gh') return { stdout: '', exitCode: -1, notFound: true }
    const code = e instanceof GhCommandError ? e.exitCode : undefined
    return {
      stdout: e instanceof GhCommandError ? e.stdout : '',
      exitCode: typeof code === 'number' ? code : 1,
      notFound: false,
    }
  }
}

async function ghJson<T>(cwd: string, args: string[]): Promise<T | null> {
  const r = await gh(cwd, args)
  if (!r.stdout) return null
  try {
    return JSON.parse(r.stdout) as T
  } catch {
    return null
  }
}

/**
 * Local branch diff without PR/gh: commits since the base, falling back to uncommitted changes when
 * empty.
 */
async function localDiff(cwd: string): Promise<string> {
  const top = (await getToplevel(cwd)) || cwd
  const base = await getDefaultBranch(top)
  let d = await getDiff(cwd, base) // git diff <base>...HEAD (o que a branch acrescentou)
  if (!d.trim()) d = await getDiff(cwd) // fallback: uncommitted git diff HEAD
  return capDiff(d)
}

/**
 * Review data for one conversation: one repository for single-repository conversations or one isolated
 * entry per linked worktree. gh/Git resolve repositories from each symlinked worktree.
 */
export async function getReviewData(convId: string): Promise<MultiReviewData> {
  const conv = getConversation(convId)
  if (conv?.isMulti && conv.repos?.length) {
    const repos = await Promise.all(
      conv.repos.map(async (r) => ({
        linkName: r.linkName,
        repoTop: r.repoTop,
        ...(await getReviewForCwd(r.worktreePath, r.branch)),
      }))
    )
    return { repos }
  }
  const rd = await getReviewForCwd(conv?.cwd ?? '', conv?.branch ?? '')
  return { repos: [{ linkName: '', repoTop: '', ...rd }] }
}

/** gh/Git review pipeline for one cwd: a repository worktree or a single conversation directory. */
async function getReviewForCwd(cwd: string, branch: string): Promise<ReviewData> {
  const base: ReviewData = {
    repo: null,
    branch,
    pr: null,
    diff: '',
    diffSource: 'local',
    checks: [],
    comments: [],
  }
  if (!cwd || !(await isGitRepo(cwd))) return { ...base, error: 'no-repo' }

  // Check gh installation/login; either failure still allows the local diff.
  const auth = await gh(cwd, ['auth', 'status'])
  if (auth.notFound) return { ...base, diff: await localDiff(cwd), error: 'no-gh' }
  if (auth.exitCode !== 0) return { ...base, diff: await localDiff(cwd), error: 'not-logged-in' }

  // remote GitHub?
  const repo = (await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).stdout.trim()
  if (!repo) return { ...base, diff: await localDiff(cwd), error: 'no-remote' }

  // Legacy conversations without a branch must not list PRs: gh ignores an empty --head filter and could
  // display an unrelated PR. Fall back to the local diff.
  if (!branch) return { ...base, repo, diff: await localDiff(cwd), error: 'no-pr' }

  // Map the branch to its PR with --head, independently of cwd.
  const prs = await ghJson<PrRaw[]>(cwd, [
    'pr',
    'list',
    '--repo',
    repo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,baseRefName,url,additions,deletions,changedFiles',
  ])
  const prRaw = prs?.[0]
  if (!prRaw) return { ...base, repo, diff: await localDiff(cwd), error: 'no-pr' }

  const n = prRaw.number
  const pr: PrInfo = {
    number: n,
    title: prRaw.title,
    state: prRaw.state,
    isDraft: prRaw.isDraft,
    reviewDecision: prRaw.reviewDecision || '',
    mergeable: prRaw.mergeable,
    mergeStateStatus: prRaw.mergeStateStatus,
    baseRef: prRaw.baseRefName,
    url: prRaw.url,
    additions: prRaw.additions,
    deletions: prRaw.deletions,
    changedFiles: prRaw.changedFiles,
  }

  // Fetch diff, checks, and comments concurrently once the PR number is known.
  const [diffR, checksRaw, view, inline] = await Promise.all([
    gh(cwd, ['pr', 'diff', String(n), '--repo', repo]),
    ghJson<CheckRaw[]>(cwd, ['pr', 'checks', String(n), '--repo', repo, '--json', 'name,state,bucket,link,workflow']),
    ghJson<{ comments?: CommentRaw[]; reviews?: ReviewRaw[] }>(cwd, [
      'pr',
      'view',
      String(n),
      '--repo',
      repo,
      '--json',
      'comments,reviews',
    ]),
    ghJson<InlineRaw[]>(cwd, ['api', `repos/${repo}/pulls/${n}/comments`]),
  ])

  const diff = capDiff(diffR.stdout)
  const checks: CheckInfo[] = (checksRaw ?? []).map((c) => ({
    name: c.name,
    bucket: c.bucket,
    state: c.state,
    link: c.link,
    workflow: c.workflow,
  }))

  const comments: ReviewComment[] = []
  for (const r of view?.reviews ?? [])
    if ((r.body && r.body.trim()) || (r.state && r.state !== 'COMMENTED'))
      comments.push({
        kind: 'review',
        author: r.author?.login ?? '?',
        body: r.body ?? '',
        state: r.state,
        createdAt: r.submittedAt,
      })
  for (const c of view?.comments ?? [])
    if (c.body?.trim())
      comments.push({ kind: 'comment', author: c.author?.login ?? '?', body: c.body, createdAt: c.createdAt })
  for (const c of inline ?? [])
    comments.push({
      kind: 'inline',
      author: c.user?.login ?? '?',
      body: c.body ?? '',
      path: c.path,
      line: c.line ?? c.original_line ?? undefined,
      side: c.side,
      createdAt: c.created_at,
    })

  return { repo, branch, pr, diff, diffSource: 'pr', checks, comments }
}

// Partial raw gh response shapes containing only fields used here.
interface PrRaw {
  number: number
  title: string
  state: string
  isDraft: boolean
  reviewDecision: string
  mergeable: string
  mergeStateStatus: string
  baseRefName: string
  url: string
  additions: number
  deletions: number
  changedFiles: number
}
interface CheckRaw {
  name: string
  state: string
  bucket: string
  link: string
  workflow: string
}
interface ReviewRaw {
  author?: { login?: string }
  body?: string
  state?: string
  submittedAt?: string
}
interface CommentRaw {
  author?: { login?: string }
  body?: string
  createdAt?: string
}
interface InlineRaw {
  user?: { login?: string }
  body?: string
  path?: string
  line?: number
  original_line?: number
  side?: string
  created_at?: string
}
