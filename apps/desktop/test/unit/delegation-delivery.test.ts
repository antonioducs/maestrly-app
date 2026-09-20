/**
 * Delivery is reconcilable. A commit only carries the authorized revision, a push never forces, a pull request
 * is located by branch, and a merge names the exact head that was reviewed.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { GhCommandError } from '../../src/main/gh-command'
import { captureCodeRevision } from '../../src/main/platform/delegation-snapshot'
import {
  authorizedCommitPatch,
  commitAuthorizedRevision,
  commitMessageFor,
  deliveryBranchName,
  deliveryKey,
  DeliveryError,
  existingAuthorizedCommit,
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
import { DelegationWorker } from '../../src/main/platform/delegation-worker'

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

it('recognises the commit a previous delivery created instead of demanding a new one', async () => {
  writeFileSync(path.join(repository, 'feature.ts'), 'export const feature = 1\n')
  const authorized = await captureCodeRevision({ cwd: repository })
  const committed = await commitAuthorizedRevision({
    cwd: repository,
    taskId,
    expectedRevision: authorized.revision,
    title: 'Add feature',
  })
  // Committing moves the revision identity: the digest covers the head commit plus the pending patch.
  const afterCommit = await captureCodeRevision({ cwd: repository })
  expect(afterCommit.revision.contentDigest).not.toBe(authorized.revision.contentDigest)

  const reuse = {
    cwd: repository,
    taskId,
    authorizedDigest: authorized.revision.contentDigest,
    observedDigest: afterCommit.revision.contentDigest,
  }
  // The revision the commit was authorized for is recorded in the commit, so a later mode finds its own work.
  expect(await existingAuthorizedCommit(reuse)).toEqual({ commitSha: committed.commitSha, branch: committed.branch })
  // And so is a delivery authorized against the workspace exactly as it stands now.
  expect(
    await existingAuthorizedCommit({ ...reuse, authorizedDigest: afterCommit.revision.contentDigest })
  ).toEqual({ commitSha: committed.commitSha, branch: committed.branch })
  // The patch of that commit is still the real change, not an empty file.
  const patch = await authorizedCommitPatch({ cwd: repository, commitSha: committed.commitSha })
  expect(patch.toString('utf8')).toContain('export const feature = 1')

  // A revision this task never committed is not reconciled.
  expect(await existingAuthorizedCommit({ ...reuse, authorizedDigest: 'f'.repeat(64) })).toBeNull()
  // Neither is another task's commit, even on a branch that exists.
  expect(await existingAuthorizedCommit({ ...reuse, taskId: '99999999-2222-4333-8444-555555555555' })).toBeNull()

  // A workspace that moved on after the commit is not reconciled: that is a genuine new revision.
  writeFileSync(path.join(repository, 'later.ts'), 'export const later = true\n')
  const moved = await captureCodeRevision({ cwd: repository })
  expect(
    await existingAuthorizedCommit({ ...reuse, observedDigest: moved.revision.contentDigest })
  ).toBeNull()
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

/**
 * A `gh` stand-in with the states a delivery sequence goes through: no pull request, open, merged. The head
 * it reports is the real head of the delivery branch, so a merge can be checked against the actual commit,
 * and `advance` simulates another actor pushing on top of it.
 */
function fakeGitHub(branch: string, headSha: () => string) {
  const calls: string[][] = []
  let created = false
  let advanced: string | null = null
  const pr = {
    number: 7,
    url: 'https://github.test/org/repo/pull/7',
    headRefName: branch,
    baseRefName: 'main',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    mergedAt: null as string | null,
  }
  const head = () => advanced ?? headSha()
  const run = async (_cwd: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'auth') return 'Logged in to github.test account octocat (keyring)'
    if (args[1] === 'view' && args.includes('headRefOid,headRefName'))
      return JSON.stringify({ headRefOid: head(), headRefName: pr.headRefName })
    if (args[1] === 'view') {
      if (!created) throw new GitHubDeliveryError('not-found', 'no pull requests found')
      return JSON.stringify({ ...pr, headRefOid: head() })
    }
    if (args[1] === 'checks') return JSON.stringify([])
    if (args[1] === 'create') {
      created = true
      return pr.url
    }
    if (args[1] === 'edit' || args[1] === 'ready') return ''
    if (args[1] === 'merge') {
      pr.mergedAt = '2026-09-20T01:00:00Z'
      pr.state = 'MERGED'
      return ''
    }
    throw new GitHubDeliveryError('failed', `unexpected ${args.join(' ')}`)
  }
  const markMerged = () => {
    pr.mergedAt = '2026-09-20T01:00:00Z'
    pr.state = 'MERGED'
  }
  return { calls, run, advance: (sha: string) => (advanced = sha), merge: markMerged }
}

/** A worker driving `runDelivery` against this repository and the `gh` stand-in, as a stage would. */
function deliveryHarness() {
  const branch = deliveryBranchName(taskId)
  const github = fakeGitHub(branch, () => git(['rev-parse', branch], repository).trim())
  const confirmations: Array<Record<string, unknown>> = []
  const intentions: Array<{ mode: string; expectedRevision: string }> = []
  const client = {
    recordDeliveryIntention: async (_taskId: string, body: { mode: string; expectedRevision: string }) => {
      intentions.push(body)
      return {
        deliveryId: `delivery-${intentions.length}`,
        mode: body.mode,
        expectedRevision: body.expectedRevision,
        alreadyConfirmed: null,
      }
    },
    confirmDelivery: async (_taskId: string, body: Record<string, unknown>) => {
      confirmations.push(body)
    },
  }
  const worker = new DelegationWorker({
    client: client as never,
    catalog: {} as never,
    settings: {} as never,
    bindings: [],
    instanceId: 'instance',
    url: 'http://instance.test',
    githubRunner: github.run,
    workspaces: {} as never,
  })
  const deliver = (mode: string, expectedCodeRevision: string | null) =>
    (
      worker as unknown as {
        runDelivery(
          delegation: unknown,
          workspace: unknown,
          action: unknown
        ): Promise<{ status: string; error?: string }>
      }
    ).runDelivery(
      { taskId, attemptId: 'attempt-1', stageType: 'deliver', baseBranch: 'main', snapshot: { prompt: 'Ship it' } },
      { conversationId: 'conversation', cwd: repository, readOnly: false, revision: null, dispose: async () => {} },
      { kind: 'deliver', mode, expectedCodeRevision, title: 'Add feature' }
    )
  return { branch, github, confirmations, intentions, deliver }
}

it('delivers commit, push, pull request and merge from one authorized revision', async () => {
  // Delivery modes are cumulative. After a commit there is nothing new to commit, and the revision identity
  // has moved with the commit: every later mode has to recognise this task's own work instead of refusing.
  const { branch, github, confirmations, intentions, deliver } = deliveryHarness()

  writeFileSync(path.join(repository, 'feature.ts'), 'export const feature = 1\n')
  const authorized = (await captureCodeRevision({ cwd: repository })).revision.contentDigest

  expect(await deliver('commit', authorized)).toEqual({ status: 'success' })
  // The reported failure: push, pull request and merge with no change in between.
  expect(await deliver('push', authorized)).toEqual({ status: 'success' })
  expect(await deliver('ready_pr', authorized)).toEqual({ status: 'success' })
  expect(await deliver('merge', authorized)).toEqual({ status: 'success' })

  expect(intentions.map((intention) => intention.mode)).toEqual(['commit', 'push', 'ready_pr', 'merge'])
  expect(intentions.every((intention) => intention.expectedRevision === authorized)).toBe(true)
  expect(confirmations.every((confirmation) => confirmation.state === 'confirmed')).toBe(true)
  // One commit carries the whole delivery: no empty commit was created for the later modes.
  const commits = confirmations.map((confirmation) => confirmation.commitSha)
  expect(new Set(commits).size).toBe(1)
  expect(git(['log', '--pretty=%s', 'main..' + branch], repository).trim().split('\n')).toEqual(['Add feature'])
  expect(git(['log', '-1', '--pretty=%s', `origin/${branch}`], repository).trim()).toBe('Add feature')
  expect(confirmations.at(-1)).toMatchObject({ observedAccount: 'octocat' })

  // The merge names the commit this delivery authorized, not whatever head the branch happened to show.
  const mergeCall = github.calls.find((args) => args[1] === 'merge')!
  expect(mergeCall).toContain('--match-head-commit')
  expect(mergeCall).toContain(commits[0])

  // A merge whose confirmation was lost is reconciled with what GitHub reports, not merged twice.
  const merges = () => github.calls.filter((args) => args[1] === 'merge').length
  expect(merges()).toBe(1)
  expect(await deliver('merge', authorized)).toEqual({ status: 'success' })
  expect(merges()).toBe(1)
  expect(confirmations.at(-1)).toMatchObject({ state: 'confirmed' })

  // A delivery authorized against the workspace as it stands now, with no recorded revision, finds the same
  // commit too instead of failing because there is nothing left to commit.
  expect(await deliver('push', null)).toEqual({ status: 'success' })
  expect(new Set(confirmations.map((confirmation) => confirmation.commitSha)).size).toBe(1)

  // A workspace that really changed after the authorization is still refused.
  writeFileSync(path.join(repository, 'later.ts'), 'export const later = true\n')
  const refused = await deliver('push', authorized)
  expect(refused.status).toBe('error')
  expect(refused.error).toMatch(/changed after this delivery was authorized/)
})

it('refuses to merge a head that is not the authorized commit, even after a remote advance', async () => {
  const harness = deliveryHarness()
  writeFileSync(path.join(repository, 'feature.ts'), 'export const feature = 1\n')
  const authorized = (await captureCodeRevision({ cwd: repository })).revision.contentDigest
  expect(await harness.deliver('ready_pr', authorized)).toEqual({ status: 'success' })
  const reviewed = harness.confirmations.at(-1)!.commitSha as string

  // Another actor pushes onto the same branch between this delivery's push and the merge stage's read of
  // the pull request. Reading the head back would accept it as "expected"; the authorized commit does not.
  harness.github.advance('b'.repeat(40))
  const refused = await harness.deliver('merge', authorized)
  expect(refused.status).toBe('error')
  expect(refused.error).toContain(reviewed)
  expect(refused.error).toMatch(/not the authorized/)
  // Nothing was merged, and the delivery asks for a person instead of being recorded as a plain failure.
  expect(harness.github.calls.some((args) => args[1] === 'merge')).toBe(false)
  expect(harness.confirmations.at(-1)).toMatchObject({ state: 'needs_attention' })

  // The same identity decides a reconciliation: a pull request merged on someone else's head is not this
  // delivery's own work, so it is never confirmed as if it were.
  harness.github.merge()
  const reconciled = await harness.deliver('merge', authorized)
  expect(reconciled.status).toBe('error')
  expect(reconciled.error).toMatch(/not the authorized/)
  expect(harness.confirmations.at(-1)).toMatchObject({ state: 'needs_attention' })

  // Back on the authorized commit, the merge proceeds and names it explicitly.
  harness.github.advance(reviewed)
  expect(await harness.deliver('merge', authorized)).toEqual({ status: 'success' })
  expect(harness.confirmations.at(-1)).toMatchObject({ state: 'confirmed', commitSha: reviewed })
})

it('records the checks gh reports through its exit status and never hides a failed read', async () => {
  const branch = 'maestrly/delegation-checks'
  const view = JSON.stringify({
    number: 9,
    url: 'https://github.test/org/repo/pull/9',
    headRefName: branch,
    baseRefName: 'main',
    headRefOid: 'a'.repeat(40),
    state: 'OPEN',
    isDraft: false,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    mergedAt: null,
  })
  /** `gh pr checks` fails the way the CLI really does: a status code, and whatever it printed. */
  interface ChecksFailure {
    exitCode?: number
    stdout?: string
    stderr?: string
    kind?: 'failed' | 'not-logged-in'
  }
  const observing = (failure: ChecksFailure) => ({
    cwd: repository,
    run: async (_cwd: string, args: string[]) => {
      if (args[1] !== 'checks') return view
      throw new GhCommandError(
        failure.kind ?? 'failed',
        args,
        failure.stderr || 'GitHub CLI failed.',
        failure.exitCode,
        failure.stdout ?? '',
        failure.stderr ?? ''
      )
    },
  })
  const failing = JSON.stringify([{ name: 'unit', bucket: 'fail', link: 'https://ci.test/1', workflow: 'CI' }])
  const pending = JSON.stringify([{ name: 'unit', bucket: 'pending', link: null, workflow: 'CI' }])

  // A red pipeline: gh exits non-zero to say so and still prints the answer, which is the whole point.
  const red = await readPullRequest(
    observing({ exitCode: 1, stdout: failing, stderr: 'Some checks were not successful' }),
    { branch }
  )
  expect(red!.checks).toEqual([{ name: 'unit', bucket: 'fail', url: 'https://ci.test/1', workflow: 'CI' }])

  // Checks still running exit with 8; "pending" stays pending instead of disappearing.
  const running = await readPullRequest(
    observing({ exitCode: 8, stdout: pending, stderr: 'Some checks are still pending' }),
    { branch }
  )
  expect(running!.checks).toEqual([{ name: 'unit', bucket: 'pending', url: null, workflow: 'CI' }])

  // An unknown bucket is never promoted to a pass.
  const unknown = await readPullRequest(
    observing({ exitCode: 1, stdout: JSON.stringify([{ name: 'unit', bucket: 'startled', workflow: 'CI' }]) }),
    { branch }
  )
  expect(unknown!.checks).toEqual([{ name: 'unit', bucket: 'pending', url: null, workflow: 'CI' }])

  // A pull request with no check at all is the only empty list.
  const none = await readPullRequest(
    observing({ exitCode: 1, stderr: "no checks reported on the 'feature' branch" }),
    { branch }
  )
  expect(none!.checks).toEqual([])

  // A read that failed is a failure, never an absence of checks: no session, and no answer at all.
  await expect(
    readPullRequest(observing({ kind: 'not-logged-in', exitCode: 4, stderr: 'gh auth login required' }), { branch })
  ).rejects.toMatchObject({ reason: 'not-logged-in' })
  await expect(
    readPullRequest(observing({ stderr: 'read ETIMEDOUT' }), { branch })
  ).rejects.toMatchObject({ reason: 'failed', noAnswer: true })
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
