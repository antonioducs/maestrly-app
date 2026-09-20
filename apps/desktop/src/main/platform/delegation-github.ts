/**
 * GitHub delivery and observation through the local `gh` CLI.
 *
 * The executor uses this computer's own login; no token is uploaded. Every operation is argument-based, a pull
 * request is always located by repository and branch (never by title), and a merge names the exact head SHA it
 * expects — the commit the caller authorized — so it cannot merge something newer than what was reviewed.
 * What is observed is reported as observed: a failing or still running check is never read as "no check".
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GhCommandError, ghProducedNoAnswer, runGhCommand } from '../gh-command'

export type GhRunner = (cwd: string, args: string[], options?: { timeoutMs?: number }) => Promise<string>

/** What the CLI still said while failing; a non-zero status is not the same as having no answer. */
export interface GitHubFailureDetails {
  stdout?: string
  exitCode?: number | null
  /** True when `gh` never produced an answer: missing CLI, no session, or an interrupted call. */
  noAnswer?: boolean
}

export class GitHubDeliveryError extends Error {
  readonly reason: 'no-gh' | 'not-logged-in' | 'no-repo' | 'not-found' | 'head-mismatch' | 'blocked' | 'failed'
  readonly stdout: string
  readonly exitCode: number | null
  readonly noAnswer: boolean
  constructor(reason: GitHubDeliveryError['reason'], message: string, details: GitHubFailureDetails = {}) {
    super(message)
    this.name = 'GitHubDeliveryError'
    this.reason = reason
    this.stdout = details.stdout ?? ''
    this.exitCode = details.exitCode ?? null
    this.noAnswer = details.noAnswer ?? this.exitCode === null
  }
}

function translate(error: unknown): GitHubDeliveryError {
  if (error instanceof GitHubDeliveryError) return error
  if (error instanceof GhCommandError) {
    // The output the CLI printed travels with the failure: some commands report their result through the
    // exit status while still answering on stdout, and that answer must not be thrown away here.
    const details: GitHubFailureDetails = {
      stdout: error.stdout,
      exitCode: typeof error.exitCode === 'number' ? error.exitCode : null,
      noAnswer: ghProducedNoAnswer(error),
    }
    if (error.kind === 'no-gh')
      return new GitHubDeliveryError('no-gh', 'The GitHub CLI is not installed on this computer.', details)
    if (error.kind === 'not-logged-in')
      return new GitHubDeliveryError(
        'not-logged-in',
        'This computer is not signed in with `gh auth login`.',
        details
      )
    const detail = `${error.stderr || error.message}`.trim()
    if (/could not resolve to a pullrequest|no pull requests found/i.test(detail))
      return new GitHubDeliveryError('not-found', 'No pull request matches this branch.', details)
    return new GitHubDeliveryError('failed', detail.slice(0, 1000), details)
  }
  return new GitHubDeliveryError('failed', (error as Error).message)
}

export interface GitHubContext {
  cwd: string
  run?: GhRunner
}

async function gh(context: GitHubContext, args: string[], timeoutMs = 25_000): Promise<string> {
  try {
    return await (context.run ?? runGhCommand)(context.cwd, args, { timeoutMs })
  } catch (error) {
    throw translate(error)
  }
}

export async function observedAccount(context: GitHubContext): Promise<string | null> {
  const output = await gh(context, ['auth', 'status', '--active'], 10_000)
  return /account\s+([A-Za-z0-9-]+)/.exec(output)?.[1] ?? null
}

export interface PullRequestObservation {
  number: number
  url: string
  branch: string
  baseBranch: string
  headSha: string | null
  state: 'open' | 'closed' | 'merged'
  ready: boolean
  reviewDecision: string | null
  mergeable: string | null
  checks: Array<{ name: string; bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'; url: string | null; workflow: string }>
  mergedAt: string | null
  observedAt: string
}

const PR_FIELDS = [
  'number',
  'url',
  'headRefName',
  'baseRefName',
  'headRefOid',
  'state',
  'isDraft',
  'reviewDecision',
  'mergeable',
  'mergeStateStatus',
  'mergedAt',
].join(',')

/** Locate the pull request for a branch. Selection is by repository and branch, never by title. */
export async function readPullRequest(
  context: GitHubContext,
  input: { branch: string }
): Promise<PullRequestObservation | null> {
  let raw: string
  try {
    raw = await gh(context, ['pr', 'view', input.branch, '--json', PR_FIELDS])
  } catch (error) {
    if (error instanceof GitHubDeliveryError && error.reason === 'not-found') return null
    throw error
  }
  const parsed = JSON.parse(raw) as {
    number: number
    url: string
    headRefName: string
    baseRefName: string
    headRefOid: string | null
    state: string
    isDraft: boolean
    reviewDecision: string | null
    mergeable: string | null
    mergeStateStatus: string | null
    mergedAt: string | null
  }
  const checks = await readChecks(context, parsed.number)
  const state = parsed.mergedAt ? 'merged' : parsed.state === 'CLOSED' ? 'closed' : 'open'
  return {
    number: parsed.number,
    url: parsed.url,
    branch: parsed.headRefName,
    baseBranch: parsed.baseRefName,
    headSha: parsed.headRefOid ?? null,
    state,
    // A draft or a blocked merge state is not "ready"; the distinction is reported, not smoothed over.
    ready: state === 'open' && !parsed.isDraft && parsed.mergeStateStatus !== 'BLOCKED',
    reviewDecision: parsed.reviewDecision,
    mergeable: parsed.mergeable,
    checks,
    mergedAt: parsed.mergedAt,
    observedAt: new Date().toISOString(),
  }
}

const CHECK_BUCKETS = ['pass', 'fail', 'pending', 'skipping', 'cancel'] as const
/** The only silence that means "this pull request has no check", as opposed to "the read failed". */
const NO_CHECKS_CONFIGURED = /no checks reported|no check runs|no checks found/i

/** Parse the JSON `gh pr checks` prints. Anything that is not a check list is not an answer. */
function parseChecks(raw: string): PullRequestObservation['checks'] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  return (parsed as Array<{ name?: string; bucket?: string; link?: string; workflow?: string }>).map((check) => ({
    name: check.name ?? '',
    // An unrecognized bucket is reported as still pending: it is never promoted to a pass.
    bucket: ((CHECK_BUCKETS as readonly string[]).includes(check.bucket ?? '')
      ? check.bucket
      : 'pending') as PullRequestObservation['checks'][number]['bucket'],
    url: check.link ?? null,
    workflow: check.workflow ?? '',
  }))
}

/**
 * Read the checks of a pull request.
 *
 * `gh pr checks` uses its exit status to report the checks themselves — non-zero when one is failing, 8 when
 * one is still running — and prints the requested JSON all the same. That output is the answer, so it is
 * interpreted instead of discarded: a red pipeline must never be recorded as "no check was observed", which
 * is exactly the state that would silence the configured follow-up. An empty list is returned only when the
 * pull request genuinely has no check; a CLI that could not run, or is not signed in, fails loudly.
 */
async function readChecks(context: GitHubContext, number: number): Promise<PullRequestObservation['checks']> {
  let raw: string
  try {
    raw = await gh(context, ['pr', 'checks', String(number), '--json', 'name,bucket,link,workflow'])
  } catch (error) {
    const failure = translate(error)
    if (failure.noAnswer) throw failure
    const reported = parseChecks(failure.stdout)
    if (reported) return reported
    if (NO_CHECKS_CONFIGURED.test(failure.message)) return []
    throw failure
  }
  const parsed = parseChecks(raw)
  if (!parsed)
    throw new GitHubDeliveryError('failed', 'The checks of the pull request could not be read as a list.')
  return parsed
}

export interface OpenPullRequestInput {
  branch: string
  baseBranch: string
  title: string
  body: string
  draft: boolean
}

/** Create or update the pull request for this branch. Body text always travels through a file. */
export async function openOrUpdatePullRequest(
  context: GitHubContext,
  input: OpenPullRequestInput
): Promise<PullRequestObservation> {
  const existing = await readPullRequest(context, { branch: input.branch })
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-pr-'))
  const bodyFile = path.join(directory, 'body.md')
  await fs.writeFile(bodyFile, input.body, { mode: 0o600 })
  try {
    if (!existing) {
      await gh(context, [
        'pr',
        'create',
        '--head',
        input.branch,
        '--base',
        input.baseBranch,
        '--title',
        input.title,
        '--body-file',
        bodyFile,
        ...(input.draft ? ['--draft'] : []),
      ])
    } else {
      await gh(context, ['pr', 'edit', String(existing.number), '--title', input.title, '--body-file', bodyFile])
      if (!input.draft && existing.state === 'open' && !existing.ready)
        await gh(context, ['pr', 'ready', String(existing.number)]).catch(() => undefined)
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
  const observed = await readPullRequest(context, { branch: input.branch })
  if (!observed) throw new GitHubDeliveryError('failed', 'The pull request could not be observed after the write.')
  return observed
}

/**
 * Merge only the exact head that was reviewed: `expectedHeadSha` is the commit the caller authorized, not the
 * head read back from the branch. The head is re-read here as a second line of defence against a change
 * between that decision and this call. Branch protection and required checks are respected; no administrative
 * bypass is used.
 */
export async function mergePullRequest(
  context: GitHubContext,
  input: { number: number; expectedHeadSha: string; method: 'merge' | 'squash' | 'rebase' }
): Promise<PullRequestObservation> {
  const raw = await gh(context, ['pr', 'view', String(input.number), '--json', 'headRefOid,headRefName'])
  const current = JSON.parse(raw) as { headRefOid: string | null; headRefName: string }
  if (current.headRefOid !== input.expectedHeadSha)
    throw new GitHubDeliveryError(
      'head-mismatch',
      `The pull request head is ${current.headRefOid ?? 'unknown'}, not the reviewed ${input.expectedHeadSha}.`
    )
  await gh(context, ['pr', 'merge', String(input.number), `--${input.method}`, '--match-head-commit', input.expectedHeadSha])
  const observed = await readPullRequest(context, { branch: current.headRefName })
  if (!observed) throw new GitHubDeliveryError('failed', 'The pull request could not be observed after the merge.')
  return observed
}

export interface PullRequestComment {
  kind: 'review' | 'comment' | 'inline'
  author: string
  body: string
  state?: string
  path?: string
  line?: number
  createdAt?: string
}

/** Read reviews and comments. Third-party content is data: it never changes permissions or configuration. */
export async function readPullRequestComments(
  context: GitHubContext,
  input: { number: number }
): Promise<PullRequestComment[]> {
  const raw = await gh(context, ['pr', 'view', String(input.number), '--json', 'comments,reviews'])
  const parsed = JSON.parse(raw) as {
    comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>
    reviews?: Array<{ author?: { login?: string }; body?: string; state?: string; submittedAt?: string }>
  }
  return [
    ...(parsed.reviews ?? []).map((review) => ({
      kind: 'review' as const,
      author: review.author?.login ?? 'unknown',
      body: (review.body ?? '').slice(0, 20_000),
      state: review.state,
      createdAt: review.submittedAt,
    })),
    ...(parsed.comments ?? []).map((comment) => ({
      kind: 'comment' as const,
      author: comment.author?.login ?? 'unknown',
      body: (comment.body ?? '').slice(0, 20_000),
      createdAt: comment.createdAt,
    })),
  ]
}

export async function commentOnPullRequest(
  context: GitHubContext,
  input: { number: number; body: string }
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-comment-'))
  const bodyFile = path.join(directory, 'comment.md')
  await fs.writeFile(bodyFile, input.body, { mode: 0o600 })
  try {
    await gh(context, ['pr', 'comment', String(input.number), '--body-file', bodyFile])
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Pull request body with the problem, the behaviour, the validation and links to the recorded evidence. */
export function pullRequestBody(input: {
  taskId: string
  objective: string
  acceptanceCriteria: string[]
  checks: Array<{ checkId: string; passed: boolean; exitCode: number | null }>
  reviewVerdict: string | null
  evidenceUrl: string
  taskUrl: string
}): string {
  const lines = [
    '## What this changes',
    input.objective.trim() || '(no objective was recorded)',
    '',
    '## Acceptance criteria',
    ...(input.acceptanceCriteria.length
      ? input.acceptanceCriteria.map((item) => `- ${item}`)
      : ['- (none recorded)']),
    '',
    '## Validation',
    ...(input.checks.length
      ? input.checks.map(
          (check) => `- ${check.passed ? 'passed' : 'failed'}: \`${check.checkId}\` (exit ${check.exitCode ?? 'unknown'})`
        )
      : ['- No project check was recorded for this revision.']),
    `- Independent review: ${input.reviewVerdict ?? 'not recorded'}`,
    '',
    '## Evidence',
    `- Delegation task: ${input.taskUrl}`,
    `- Recorded evidence: ${input.evidenceUrl}`,
    '',
    `<!-- Maestrly-Delegation-Task: ${input.taskId} -->`,
  ]
  return lines.join('\n')
}
