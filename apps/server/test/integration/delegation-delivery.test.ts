import { describe, expect, it } from 'vitest'
import { delegationCatalogRevision, delegationModelCatalogSchema, type DelegationModelCatalog } from '@maestrly/protocol'
import { inTenantTransaction } from '../../src/db/transaction.js'
import { applyDelegationCommand } from '../../src/modules/delegations/commands.js'
import {
  confirmDelivery,
  deliveryAuthorized,
  recordDeliveryIntention,
  unconfirmedDeliveries,
} from '../../src/modules/delegations/delivery.js'
import { publishDelegationCatalog } from '../../src/modules/delegations/model-catalog.js'
import { pullRequestFacts, recordPullRequestSnapshot } from '../../src/modules/delegations/pull-requests.js'
import { evaluateCompletion } from '../../src/modules/delegations/quality.js'
import { loadTaskRow } from '../../src/modules/delegations/repository.js'
import { createDelegation, getDelegation } from '../../src/modules/delegations/service.js'
import { createProject } from '../../src/modules/projects/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

const links = { webOrigin: 'http://127.0.0.1:4173' }

const features = {
  checks: [],
  github: { available: true, login: 'octocat', issue: null },
  preview: { available: false, issue: null },
  maestro: true,
  subagents: false,
  browserInspect: false,
  browserInteract: false,
}

function catalogFor(projectId: string): DelegationModelCatalog {
  const models = [
    {
      selectionId: 'sel-opus',
      modelLabel: 'claude-opus-5',
      accountLabel: 'Claude · personal',
      efforts: ['high'],
      fastMode: false,
      executionModes: ['standard'],
      delegationProfiles: [],
      harnessProfileId: null,
      harnessHash: null,
    },
  ]
  const workspaces = [
    { projectId, key: 'workspace-key', label: 'Repo', branches: ['main'], repositoryBindingId: null },
  ]
  return delegationModelCatalogSchema.parse({
    capability: 'delegation:stages:v1',
    enabled: true,
    revision: delegationCatalogRevision({ models: models as never, features, workspaces }),
    generatedAt: new Date().toISOString(),
    workspaces,
    models,
    features,
    issues: [],
  })
}

async function fixture(pool: ReturnType<typeof runtimePool>, name: string, policy?: Record<string, unknown>) {
  const owner = 'deliv-owner-' + crypto.randomUUID()
  const organizationId = await seedOrganization(name, owner)
  const project = await createProject(pool, { organizationId, actorUserId: owner, name })
  const projectId = project.project.id
  const enrollment = await createRunnerEnrollment(pool, { organizationId, userId: owner, projectIds: [projectId] })
  const executor = await enrollRunner(pool, {
    organizationId,
    token: enrollment.token,
    name: 'Executor',
    protocolVersion: '1.0',
    capabilities: [{ name: 'executor:maestrly' }],
    maxConcurrency: 2,
  })
  await inTenantTransaction(pool, { organizationId, actor: { type: 'runner', runnerId: executor.runnerId } }, (client) =>
    publishDelegationCatalog(client, { organizationId, runnerId: executor.runnerId, catalog: catalogFor(projectId) })
  )
  const board = await getBoard(pool, { organizationId, userId: owner, boardId: project.boardId })
  const scope = { organizationId, projectId, userId: owner }
  const view = await createDelegation(
    pool,
    scope,
    {
      boardId: board.board.id,
      title: name,
      objective: '',
      acceptanceCriteria: [],
      executorId: executor.runnerId,
      workspaceKey: 'workspace-key',
      baseBranch: 'main',
      ...(policy ? { policy } : {}),
      stages: [
        {
          type: 'implement',
          title: 'Implement',
          instructions: '',
          dependsOn: [],
          requiredForCompletion: true,
          settings: { selectionId: 'sel-opus', reasoning: 'high' },
        },
      ],
      dependsOnTaskIds: [],
      start: false,
    },
    links
  )
  return { owner, organizationId, projectId, executorId: executor.runnerId, scope, taskId: view.task.id, version: view.task.version }
}

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  url: 'https://github.test/org/repo/pull/42',
  branch: 'maestrly/delegation-abc',
  baseBranch: 'main',
  headSha: 'a'.repeat(40),
  state: 'open',
  ready: true,
  reviewDecision: 'APPROVED',
  mergeable: 'MERGEABLE',
  checks: [{ name: 'unit', bucket: 'pass', url: null, workflow: 'CI' }],
  mergedAt: null,
  observedAt: new Date().toISOString(),
  ...overrides,
})

describe.skipIf(!integrationAvailable)('delegation delivery', () => {
  it('records one durable intention per mode and revision, and reuses it on retry', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Delivery intention', {
        autonomy: { commit: true, push: true, openPullRequest: true },
      })
      const runner = { organizationId: context.organizationId, actor: { type: 'runner' as const, runnerId: context.executorId } }
      const digest = 'd'.repeat(64)
      const first = await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        return recordDeliveryIntention(client, { task, attemptId: null, mode: 'ready_pr', expectedRevision: digest })
      })
      expect(first.alreadyConfirmed).toBeNull()
      // A retry reuses the same intention instead of creating a second external effect.
      const retry = await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        return recordDeliveryIntention(client, { task, attemptId: null, mode: 'ready_pr', expectedRevision: digest })
      })
      expect(retry.deliveryId).toBe(first.deliveryId)

      // A pending intention for another revision has to be reconciled first.
      await expect(
        inTenantTransaction(pool, runner, async (client) => {
          const task = await loadTaskRow(client, context.scope, context.taskId)
          return recordDeliveryIntention(client, {
            task,
            attemptId: null,
            mode: 'ready_pr',
            expectedRevision: 'e'.repeat(64),
          })
        })
      ).rejects.toThrow(/already pending for another revision/)

      const receipt = await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        return confirmDelivery(client, {
          task,
          body: {
            deliveryId: first.deliveryId,
            state: 'confirmed',
            commitSha: 'c'.repeat(40),
            branch: 'maestrly/delegation-abc',
            observedAccount: 'octocat',
            error: null,
            pullRequest: snapshot(),
          },
        })
      })
      expect(receipt.state).toBe('confirmed')
      expect(receipt.pullRequestNumber).toBe(42)
      expect(receipt.observedAccount).toBe('octocat')

      // Once confirmed, the same delivery is recognized instead of repeated.
      const afterConfirm = await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        return recordDeliveryIntention(client, { task, attemptId: null, mode: 'ready_pr', expectedRevision: digest })
      })
      expect(afterConfirm.alreadyConfirmed?.pullRequestNumber).toBe(42)
      await inTenantTransaction(pool, runner, async (client) => {
        expect(await unconfirmedDeliveries(client, context.taskId)).toEqual([])
      })
    } finally {
      await pool.end()
    }
  })

  it('refuses a delivery the task policy does not authorize', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Delivery policy')
      const runner = { organizationId: context.organizationId, actor: { type: 'runner' as const, runnerId: context.executorId } }
      await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        expect(deliveryAuthorized(task, 'patch')).toBe(true)
        expect(deliveryAuthorized(task, 'push')).toBe(false)
        expect(deliveryAuthorized(task, 'merge')).toBe(false)
        await expect(
          recordDeliveryIntention(client, { task, attemptId: null, mode: 'push', expectedRevision: 'd'.repeat(64) })
        ).rejects.toThrow(/does not authorize push/)
      })
      // The command surface refuses it too, before any stage is created.
      await expect(
        applyDelegationCommand(
          pool,
          context.scope,
          context.taskId,
          { type: 'deliver', expectedVersion: context.version, mode: 'merge', expectedCodeRevision: null },
          'deliver-merge'
        )
      ).rejects.toThrow(/does not authorize merge/)
    } finally {
      await pool.end()
    }
  })

  it('keeps a failed or diverged delivery visible instead of retrying it silently', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Delivery divergence', { autonomy: { commit: true, push: true } })
      const runner = { organizationId: context.organizationId, actor: { type: 'runner' as const, runnerId: context.executorId } }
      const intention = await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        return recordDeliveryIntention(client, { task, attemptId: null, mode: 'push', expectedRevision: 'd'.repeat(64) })
      })
      const receipt = await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        return confirmDelivery(client, {
          task,
          body: {
            deliveryId: intention.deliveryId,
            state: 'needs_attention',
            commitSha: null,
            branch: 'maestrly/delegation-abc',
            observedAccount: null,
            error: 'The remote branch moved after this task last saw it. Nothing was overwritten.',
          },
        })
      })
      expect(receipt.state).toBe('needs_attention')
      expect(receipt.error).toContain('Nothing was overwritten')
      const events = (await getDelegation(pool, context.scope, context.taskId, links)).task
      expect(events.state).not.toBe('completed')
    } finally {
      await pool.end()
    }
  })

  it('reports the pull request as observed, with the time it was observed', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Delivery observation', {
        autonomy: { commit: true, push: true, openPullRequest: true, merge: true },
        completionTarget: 'merged',
        requireReview: false,
      })
      const runner = { organizationId: context.organizationId, actor: { type: 'runner' as const, runnerId: context.executorId } }
      const observedAt = '2026-09-20T00:00:00.000Z'
      await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        await recordPullRequestSnapshot(client, { task, snapshot: snapshot({ observedAt }) })
        const facts = await pullRequestFacts(client, context.taskId)
        expect(facts).toMatchObject({ number: 42, ready: true, mergedAt: null, observedAt })
        // A merged pull request must state when it was merged.
        await expect(
          recordPullRequestSnapshot(client, { task, snapshot: snapshot({ state: 'merged', mergedAt: null }) })
        ).rejects.toThrow(/must report when it was merged/)

        const beforeMerge = evaluateCompletion({
          task,
          stages: [{ requiredForCompletion: true, state: 'succeeded', title: 'Implement' } as never],
          attempts: [],
          findings: [],
          review: null,
          currentRevisionDigest: 'd'.repeat(64),
          pullRequest: await pullRequestFacts(client, context.taskId),
        })
        expect(beforeMerge.satisfied).toBe(false)
        expect(beforeMerge.missing.map((item) => item.reason)).toContain('merge_missing')

        await recordPullRequestSnapshot(client, {
          task,
          snapshot: snapshot({ state: 'merged', mergedAt: '2026-09-20T01:00:00.000Z', ready: true }),
        })
        const afterMerge = evaluateCompletion({
          task,
          stages: [{ requiredForCompletion: true, state: 'succeeded', title: 'Implement' } as never],
          attempts: [],
          findings: [],
          review: null,
          currentRevisionDigest: 'd'.repeat(64),
          pullRequest: await pullRequestFacts(client, context.taskId),
        })
        expect(afterMerge.satisfied).toBe(true)
      })
    } finally {
      await pool.end()
    }
  })
})
