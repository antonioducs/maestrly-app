/**
 * Delivery is reconcilable. A commit only carries the authorized revision, a push never forces, a pull request
 * is located by branch, and a merge names the exact head that was reviewed.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { captureCodeRevision } from '../../src/main/platform/delegation-snapshot'
import {
  commitAuthorizedRevision,
  commitMessageFor,
  deliveryBranchName,
  deliveryKey,
  DeliveryError,
  pushDeliveryBranch,
} from '../../src/main/platform/delegation-git'
import {
  GitHubDeliveryError,
  mergePullRequest,
  openOrUpdatePullRequest,
  pullRequestBody,
  readPullRequest,
  readPullRequestComments,
} from '../../src/main/platform/delegation-github'

let scratch = ''
let repository = ''
let remote = ''

function git(args: string[], cwd: string) {
  return execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
}

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'delegation-delivery-'))
  remote = path.join(scratch, 'remote.git')
  mkdirSync(remote)
  git(['init', '--bare', '--initial-branch=main'], remote)
  repository = path.join(scratch, 'repo')
  mkdirSync(repository)
  git(['init', '--initial-branch=main'], repository)
  git(['config', 'user.email', 'fixture@example.test'], repository)
  git(['config', 'user.name', 'Fixture'], repository)
  git(['remote', 'add', 'origin', remote], repository)
  writeFileSync(path.join(repository, 'README.md'), '# base\n')
  git(['add', '.'], repository)
  git(['commit', '-m', 'base'], repository)
  git(['push', '-u', 'origin', 'main'], repository)
})
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})

const taskId = '11111111-2222-4333-8444-555555555555'

it('builds a stable branch name, commit message and idempotency key', () => {
  expect(deliveryBranchName(taskId)).toBe('maestrly/delegation-111111112222')
  expect(deliveryBranchName(taskId)).toBe(deliveryBranchName(taskId))
  const message = commitMessageFor({ taskId, title: '  Add   the   panel  ' })
  expect(message.split('\n')[0]).toBe('Add the panel')
  expect(message).toContain(`Maestrly-Delegation-Task: ${taskId}`)
  const key = deliveryKey({ taskId, mode: 'ready_pr', revisionDigest: 'd'.repeat(64) })
  expect(key).toBe(deliveryKey({ taskId, mode: 'ready_pr', revisionDigest: 'd'.repeat(64) }))
  expect(key).not.toBe(deliveryKey({ taskId, mode: 'push', revisionDigest: 'd'.repeat(64) }))
})

it('commits only the authorized revision and refuses later changes', async () => {
  writeFileSync(path.join(repository, 'feature.ts'), 'export const feature = 1\n')
  const authorized = await captureCodeRevision({ cwd: repository })

  // A change that arrives after the authorization is refused, not quietly included.
  writeFileSync(path.join(repository, 'sneaky.ts'), 'export const sneaky = true\n')
  await expect(
    commitAuthorizedRevision({ cwd: repository, taskId, expectedRevision: authorized.revision, title: 'Add feature' })
  ).rejects.toBeInstanceOf(DeliveryError)
  rmSync(path.join(repository, 'sneaky.ts'))

  const committed = await commitAuthorizedRevision({
    cwd: repository,
    taskId,
    expectedRevision: authorized.revision,
    title: 'Add feature',
  })
  expect(committed.branch).toBe(deliveryBranchName(taskId))
  expect(committed.commitSha).toMatch(/^[0-9a-f]{40}$/)
  expect(git(['log', '-1', '--pretty=%s'], repository).trim()).toBe('Add feature')
  expect(git(['ls-files'], repository)).toContain('feature.ts')

  // A second delivery with nothing new reports it instead of creating an empty commit.
  const after = await captureCodeRevision({ cwd: repository })
  await expect(
    commitAuthorizedRevision({ cwd: repository, taskId, expectedRevision: after.revision, title: 'Add feature' })
  ).rejects.toThrow(/nothing to commit/)
})

it('pushes without force and refuses a remote that moved', async () => {
  writeFileSync(path.join(repository, 'feature.ts'), 'export const feature = 1\n')
  const authorized = await captureCodeRevision({ cwd: repository })
  const committed = await commitAuthorizedRevision({
    cwd: repository,
    taskId,
    expectedRevision: authorized.revision,
    title: 'Add feature',
  })
  const pushed = await pushDeliveryBranch({ cwd: repository, branch: committed.branch, knownRemoteSha: null })
  expect(pushed.created).toBe(true)
  expect(pushed.remoteSha).toMatch(/^[0-9a-f]{40}$/)

  // Someone else pushes to the same branch from another clone.
  const other = path.join(scratch, 'other')
  git(['clone', remote, other], scratch)
  git(['config', 'user.email', 'other@example.test'], other)
  git(['config', 'user.name', 'Other'], other)
  git(['checkout', committed.branch], other)
  writeFileSync(path.join(other, 'theirs.ts'), 'export const theirs = true\n')
  git(['add', '.'], other)
  git(['commit', '-m', 'their change'], other)
  git(['push', 'origin', committed.branch], other)

  writeFileSync(path.join(repository, 'mine.ts'), 'export const mine = true\n')
  const next = await captureCodeRevision({ cwd: repository })
  await commitAuthorizedRevision({ cwd: repository, taskId, expectedRevision: next.revision, title: 'Add mine' })
  await expect(
    pushDeliveryBranch({ cwd: repository, branch: committed.branch, knownRemoteSha: pushed.remoteSha })
  ).rejects.toThrow(/moved to/)
  // Both sides survive: the remote still holds their commit.
  expect(git(['log', '-1', '--pretty=%s', `origin/${committed.branch}`], other).trim()).toBe('their change')
})

it('reports a missing remote instead of inventing one', async () => {
  const bare = path.join(scratch, 'no-remote')
  mkdirSync(bare)
  git(['init', '--initial-branch=main'], bare)
  git(['config', 'user.email', 'fixture@example.test'], bare)
  git(['config', 'user.name', 'Fixture'], bare)
  writeFileSync(path.join(bare, 'a.txt'), 'a')
  git(['add', '.'], bare)
  git(['commit', '-m', 'base'], bare)
  await expect(pushDeliveryBranch({ cwd: bare, branch: 'feature', knownRemoteSha: null })).rejects.toThrow(
    /no "origin" remote/
  )
})

it('locates a pull request by branch, updates it and refuses a merge on a different head', async () => {
  const calls: string[][] = []
  let created = false
  const pr = {
    number: 42,
    url: 'https://github.test/org/repo/pull/42',
    headRefName: 'maestrly/delegation-111111112222',
    baseRefName: 'main',
    headRefOid: 'a'.repeat(40),
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    mergedAt: null as string | null,
  }
  const run = async (_cwd: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'auth') return 'Logged in to github.test account octocat (keyring)'
    if (args[1] === 'view' && args.includes('comments,reviews'))
      return JSON.stringify({
        comments: [{ author: { login: 'reviewer' }, body: 'please add a test', createdAt: '2026-09-20T00:00:00Z' }],
        reviews: [{ author: { login: 'reviewer' }, body: 'changes', state: 'CHANGES_REQUESTED' }],
      })
    if (args[1] === 'view' && args.includes('headRefOid,headRefName'))
      return JSON.stringify({ headRefOid: pr.headRefOid, headRefName: pr.headRefName })
    if (args[1] === 'view') {
      if (!created) throw new GitHubDeliveryError('not-found', 'no pull requests found')
      return JSON.stringify(pr)
    }
    if (args[1] === 'checks') return JSON.stringify([{ name: 'unit', bucket: 'fail', link: 'https://ci.test/1', workflow: 'CI' }])
    if (args[1] === 'create') {
      created = true
      return 'https://github.test/org/repo/pull/42'
    }
    if (args[1] === 'edit' || args[1] === 'ready') return ''
    if (args[1] === 'merge') {
      pr.mergedAt = '2026-09-20T01:00:00Z'
      pr.state = 'MERGED'
      return ''
    }
    if (args[1] === 'comment') return ''
    throw new GitHubDeliveryError('failed', `unexpected ${args.join(' ')}`)
  }
  const context = { cwd: repository, run }

  expect(await readPullRequest(context, { branch: pr.headRefName })).toBeNull()
  const opened = await openOrUpdatePullRequest(context, {
    branch: pr.headRefName,
    baseBranch: 'main',
    title: 'Delegated change',
    body: 'body',
    draft: false,
  })
  expect(opened.number).toBe(42)
  expect(opened.checks).toEqual([{ name: 'unit', bucket: 'fail', url: 'https://ci.test/1', workflow: 'CI' }])
  expect(opened.ready).toBe(true)
  // The body always travels through a file, never as an inline shell argument.
  expect(calls.some((args) => args.includes('--body-file'))).toBe(true)
  expect(calls.every((args) => !args.some((value) => value === 'body'))).toBe(true)

  await expect(
    mergePullRequest(context, { number: 42, expectedHeadSha: 'b'.repeat(40), method: 'squash' })
  ).rejects.toThrow(/not the reviewed/)
  const merged = await mergePullRequest(context, { number: 42, expectedHeadSha: pr.headRefOid, method: 'squash' })
  expect(merged.state).toBe('merged')
  expect(merged.mergedAt).toBe('2026-09-20T01:00:00Z')
  // The merge names the reviewed head explicitly and uses no administrative bypass.
  const mergeCall = calls.find((args) => args[1] === 'merge')!
  expect(mergeCall).toContain('--match-head-commit')
  expect(mergeCall).toContain(pr.headRefOid)
  expect(mergeCall.some((value) => value.includes('admin'))).toBe(false)

  const comments = await readPullRequestComments(context, { number: 42 })
  expect(comments.map((item) => item.kind)).toEqual(['review', 'comment'])
  expect(comments[0]!.state).toBe('CHANGES_REQUESTED')
})

it('states the validation honestly in the pull request body', () => {
  const withEvidence = pullRequestBody({
    taskId,
    objective: 'Ship the delegation panel',
    acceptanceCriteria: ['Panel renders'],
    checks: [{ checkId: 'unit', passed: true, exitCode: 0 }],
    reviewVerdict: 'approved',
    evidenceUrl: 'https://maestrly.test/evidence',
    taskUrl: 'https://maestrly.test/task',
  })
  expect(withEvidence).toContain('passed: `unit` (exit 0)')
  expect(withEvidence).toContain('Independent review: approved')
  const withoutEvidence = pullRequestBody({
    taskId,
    objective: '',
    acceptanceCriteria: [],
    checks: [],
    reviewVerdict: null,
    evidenceUrl: 'https://maestrly.test/evidence',
    taskUrl: 'https://maestrly.test/task',
  })
  // Absent evidence is declared as absent instead of implying success.
  expect(withoutEvidence).toContain('No project check was recorded')
  expect(withoutEvidence).toContain('Independent review: not recorded')
  expect(withoutEvidence).toContain('(none recorded)')
})
