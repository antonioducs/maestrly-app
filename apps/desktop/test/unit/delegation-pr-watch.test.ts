/**
 * Watching a pull request from the executor. Every due target is settled, a rate limit backs off instead of
 * hammering GitHub, and nothing is invented when the pull request or the workspace is absent.
 */
import { expect, it } from 'vitest'
import {
  retryAfterSeconds,
  runPullRequestWatch,
  type PullRequestWatchTarget,
} from '../../src/main/platform/delegation-pr-watch'
import type { PullRequestObservation } from '../../src/main/platform/delegation-github'

const observation = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
  number: 7,
  url: 'https://github.test/org/repo/pull/7',
  branch: 'maestrly/delegation-abc',
  baseBranch: 'main',
  headSha: 'a'.repeat(40),
  state: 'open',
  ready: true,
  reviewDecision: 'APPROVED',
  mergeable: 'MERGEABLE',
  checks: [{ name: 'unit', bucket: 'pass', url: null, workflow: 'CI' }],
  mergedAt: null,
  observedAt: '2026-09-20T00:00:00.000Z',
  ...overrides,
})

const target = (taskId: string, intervalSeconds = 60): PullRequestWatchTarget => ({
  taskId,
  projectId: 'project-1',
  subscriptionId: `sub-${taskId}`,
  intervalSeconds,
})

it('reports what it observed and records the poll', async () => {
  const reported: Array<{ taskId: string; number: number }> = []
  const polled: Array<{ subscriptionId: string; intervalSeconds: number }> = []
  const outcomes = await runPullRequestWatch({
    due: async () => [target('task-1')],
    workspaceFor: async () => '/tmp/workspace',
    branchFor: () => 'maestrly/delegation-abc',
    read: async () => observation(),
    report: async (taskId, value) => {
      reported.push({ taskId, number: value.number })
    },
    polled: async (input) => {
      polled.push(input)
    },
  })
  expect(outcomes).toEqual([{ taskId: 'task-1', state: 'observed' }])
  expect(reported).toEqual([{ taskId: 'task-1', number: 7 }])
  expect(polled).toEqual([{ subscriptionId: 'sub-task-1', intervalSeconds: 60 }])
})

it('says the pull request is not linked instead of inventing one', async () => {
  const polled: Array<{ intervalSeconds: number }> = []
  const outcomes = await runPullRequestWatch({
    due: async () => [target('task-2')],
    workspaceFor: async () => '/tmp/workspace',
    branchFor: () => 'maestrly/delegation-abc',
    read: async () => null,
    report: async () => {
      throw new Error('should not report')
    },
    polled: async (input) => {
      polled.push(input)
    },
  })
  expect(outcomes[0]).toMatchObject({ state: 'not-linked' })
  // The subscription still advances, so the loop does not spin on the same target.
  expect(polled).toHaveLength(1)
})

it('reports a task that is not bound to this computer without reading anything', async () => {
  let reads = 0
  const outcomes = await runPullRequestWatch({
    due: async () => [target('task-3')],
    workspaceFor: async () => null,
    branchFor: () => 'maestrly/delegation-abc',
    read: async () => {
      reads += 1
      return observation()
    },
    report: async () => {},
    polled: async () => {},
  })
  expect(reads).toBe(0)
  expect(outcomes[0]).toMatchObject({ state: 'no-workspace' })
})

it('backs off when GitHub reports a rate limit and never below the hint', async () => {
  expect(retryAfterSeconds(new Error('plain failure'), 60)).toBe(60)
  expect(retryAfterSeconds(new Error('API rate limit exceeded, retry-after: 300'), 60)).toBe(300)
  expect(retryAfterSeconds(new Error('secondary rate limit; wait 45 seconds'), 60)).toBe(60)
  expect(retryAfterSeconds(new Error('You have exceeded a secondary rate limit'), 60)).toBe(120)

  const polled: Array<{ intervalSeconds: number }> = []
  const outcomes = await runPullRequestWatch({
    due: async () => [target('task-4', 30)],
    workspaceFor: async () => '/tmp/workspace',
    branchFor: () => 'maestrly/delegation-abc',
    read: async () => {
      throw new Error('API rate limit exceeded, retry-after: 240')
    },
    report: async () => {},
    polled: async (input) => {
      polled.push(input)
    },
  })
  expect(outcomes[0]).toMatchObject({ state: 'rate-limited', retryAfterSeconds: 240 })
  expect(polled[0]!.intervalSeconds).toBe(240)
})

it('settles every target even when one of them fails', async () => {
  const polled: string[] = []
  const outcomes = await runPullRequestWatch({
    due: async () => [target('task-a'), target('task-b')],
    workspaceFor: async () => '/tmp/workspace',
    branchFor: () => 'maestrly/delegation-abc',
    read: async ({ branch }) => {
      if (polled.length === 0) throw new Error('gh exited with 1')
      return observation({ branch })
    },
    report: async () => {},
    polled: async (input) => {
      polled.push(input.subscriptionId)
    },
  })
  expect(polled).toEqual(['sub-task-a', 'sub-task-b'])
  expect(outcomes.map((item) => item.state)).toEqual(['failed', 'observed'])
})
