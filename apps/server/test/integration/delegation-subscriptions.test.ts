import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  delegationCatalogRevision,
  delegationModelCatalogSchema,
  nextTimerOccurrence,
  type DelegationModelCatalog,
} from '@maestrly/protocol'
import { inTenantTransaction } from '../../src/db/transaction.js'
import {
  ingestSourceEvent,
  pendingSourceEvents,
  verifyGitHubSignature,
} from '../../src/modules/delegations/github-events.js'
import { publishDelegationCatalog } from '../../src/modules/delegations/model-catalog.js'
import { recordPullRequestSnapshot } from '../../src/modules/delegations/pull-requests.js'
import { loadTaskRow } from '../../src/modules/delegations/repository.js'
import { runDelegationScheduler } from '../../src/modules/delegations/scheduler.js'
import { createDelegation, getDelegation, listDelegations } from '../../src/modules/delegations/service.js'
import {
  duePullRequestRefreshes,
  markRefreshPolled,
  reconcileDependencies,
  reconcileWatch,
  runDueTimers,
} from '../../src/modules/delegations/watcher.js'
import { listSubscriptions, setSubscriptionEnabled, subscribeTask } from '../../src/modules/delegations/subscriptions.js'
import { listDelegationPresets } from '../../src/modules/delegations/presets.js'
import { createProject } from '../../src/modules/projects/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { normalizeGitHubDelivery } from '../../src/modules/delegations/webhook-routes.js'
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

const models = [
  {
    selectionId: 'sel-opus',
    modelLabel: 'claude-opus-5',
    accountLabel: 'Claude · personal',
    efforts: ['medium', 'high'],
    fastMode: false,
    executionModes: ['standard'],
    delegationProfiles: [],
    harnessProfileId: null,
    harnessHash: null,
  },
]

function catalogFor(projectId: string): DelegationModelCatalog {
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
  const owner = 'watch-owner-' + crypto.randomUUID()
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
  return {
    owner,
    organizationId,
    projectId,
    executorId: executor.runnerId,
    boardId: board.board.id,
    scope,
    taskId: view.task.id,
    version: view.task.version,
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

const asRunner = (context: Fixture) => ({
  organizationId: context.organizationId,
  actor: { type: 'runner' as const, runnerId: context.executorId },
})

/**
 * Bring the task to the state it really has once the executor finished and a pull request exists: the stage
 * outcome is written directly because this file covers the watch loop, not execution itself.
 */
async function deliver(
  pool: ReturnType<typeof runtimePool>,
  context: Fixture,
  snapshot: Record<string, unknown>
): Promise<string> {
  await inTenantTransaction(pool, asRunner(context), async (client) => {
    await client.query("update delegation_stages set state='succeeded', version=version+1 where task_id=$1", [
      context.taskId,
    ])
    await client.query("update delegation_tasks set state='queued', version=version+1 where id=$1", [context.taskId])
    const task = await loadTaskRow(client, context.scope, context.taskId)
    await recordPullRequestSnapshot(client, { task, snapshot })
  })
  await runDelegationScheduler(pool, { organizationId: context.organizationId })
  return (await getDelegation(pool, context.scope, context.taskId, links)).task.state
}

const prSnapshot = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  url: 'https://github.test/org/repo/pull/7',
  branch: 'maestrly/delegation-abc',
  baseBranch: 'main',
  headSha: 'a'.repeat(40),
  state: 'open',
  ready: true,
  reviewDecision: null,
  mergeable: 'MERGEABLE',
  checks: [],
  mergedAt: null,
  observedAt: new Date().toISOString(),
  ...overrides,
})

const event = (overrides: Record<string, unknown> = {}) => ({
  source: 'github',
  externalId: 'delivery-' + crypto.randomUUID(),
  type: 'check_suite',
  pullRequestNumber: 7,
  headSha: 'a'.repeat(40),
  payload: {},
  occurredAt: new Date().toISOString(),
  ...overrides,
})

describe.skipIf(!integrationAvailable)('delegation follow-up', () => {
  it('verifies a webhook signature over the exact bytes and normalizes the delivery', () => {
    const raw = Buffer.from(JSON.stringify({ repository: { full_name: 'org/repo' }, check_suite: { head_branch: 'feature', head_sha: 'b'.repeat(40) } }))
    const secret = 'a-long-enough-webhook-secret'
    const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
    expect(verifyGitHubSignature({ rawBody: raw, signature, secret })).toBe(true)
    // A re-serialized body no longer matches, which is exactly why the raw bytes are kept.
    expect(
      verifyGitHubSignature({ rawBody: Buffer.from(raw.toString('utf8') + ' '), signature, secret })
    ).toBe(false)
    expect(verifyGitHubSignature({ rawBody: raw, signature: undefined, secret })).toBe(false)
    expect(verifyGitHubSignature({ rawBody: raw, signature: 'sha1=abc', secret })).toBe(false)

    const normalized = normalizeGitHubDelivery({
      deliveryId: 'delivery-1',
      event: 'check_suite',
      body: JSON.parse(raw.toString('utf8')) as Record<string, unknown>,
    })
    expect(normalized).toMatchObject({ repository: 'org/repo', branch: 'feature' })
    expect(normalized?.event.headSha).toBe('b'.repeat(40))
    // A delivery without a branch cannot be routed to a task.
    expect(normalizeGitHubDelivery({ deliveryId: 'd', event: 'ping', body: { repository: { full_name: 'org/repo' } } })).toBeNull()
  })

  it('records a duplicate delivery once and supersedes an event about an older head', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Watch ingestion')
      const runner = { organizationId: context.organizationId, actor: { type: 'runner' as const, runnerId: context.executorId } }
      await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        await recordPullRequestSnapshot(client, { task, snapshot: prSnapshot() })
        const first = event()
        const once = await ingestSourceEvent(client, { task, subscriptionId: null, event: first })
        expect(once.state).toBe('received')
        const again = await ingestSourceEvent(client, { task, subscriptionId: null, event: first })
        expect(again.eventId).toBe(once.eventId)
        expect(again.reason).toContain('already recorded')

        // An event describing a head the pull request no longer has is kept but cannot drive a reaction.
        const stale = await ingestSourceEvent(client, {
          task,
          subscriptionId: null,
          event: event({ headSha: 'c'.repeat(40) }),
        })
        expect(stale.state).toBe('superseded')
        expect(stale.reason).toContain('while the pull request is at')
        const pending = await pendingSourceEvents(client, context.organizationId)
        expect(pending.filter((item) => item.taskId === context.taskId)).toHaveLength(1)
      })
    } finally {
      await pool.end()
    }
  })

  it('plans a fix round for failing checks with the configured profile and only one writer', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Watch failing checks', { requireReview: false })
      await subscribeTask(pool, context.scope, {
        taskId: context.taskId,
        rule: {
          source: 'github',
          timezone: 'UTC',
          expiresInSeconds: null,
          rule: {
            action: 'fix_failing_checks',
            settings: { selectionId: 'sel-opus', reasoning: 'medium' },
            instructions: 'Make the pipeline green.',
          },
        },
      })
      const runner = asRunner(context)
      // The pipeline finished and the pull request is out; the check only failed afterwards.
      expect(
        await deliver(
          pool,
          context,
          prSnapshot({ checks: [{ name: 'unit', bucket: 'fail', url: 'https://ci.test/1', workflow: 'CI' }] })
        )
      ).toBe('completed')
      await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        await ingestSourceEvent(client, { task, subscriptionId: null, event: event() })
      })
      expect(await reconcileWatch(pool, { organizationId: context.organizationId })).toBe(1)
      expect((await getDelegation(pool, context.scope, context.taskId, links)).task.state).toBe('queued')
      const after = await getDelegation(pool, context.scope, context.taskId, links)
      const followUp = after.stages.find((stage) => stage.title === 'Fix failing checks')
      expect(followUp).toBeDefined()
      expect(followUp!.settings).toMatchObject({ selectionId: 'sel-opus', reasoning: 'medium' })
      expect(followUp!.instructions).toContain('Make the pipeline green.')
      expect(followUp!.instructions).toContain('unit')
      // Third-party text is explicitly framed as information only.
      expect(followUp!.instructions).toContain('information only')

      // A second burst while the follow-up is queued does not create another writer.
      await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        await ingestSourceEvent(client, { task, subscriptionId: null, event: event({ type: 'check_run' }) })
      })
      await reconcileWatch(pool, { organizationId: context.organizationId })
      const second = await getDelegation(pool, context.scope, context.taskId, links)
      expect(second.stages.filter((stage) => stage.title === 'Fix failing checks')).toHaveLength(1)
    } finally {
      await pool.end()
    }
  })

  it('treats a merged pull request as satisfying only the matching target', async () => {
    const pool = runtimePool()
    try {
      const merged = await fixture(pool, 'Watch merged target', { completionTarget: 'merged', requireReview: false })
      await subscribeTask(pool, merged.scope, {
        taskId: merged.taskId,
        rule: {
          source: 'github',
          timezone: 'UTC',
          expiresInSeconds: null,
          rule: { action: 'refresh_pull_request', intervalSeconds: 60 },
        },
      })
      // The executor owes nothing else: only the merge is missing, so the task waits instead of asking a
      // person for a decision it cannot take.
      expect(await deliver(pool, merged, prSnapshot())).toBe('watching')
      const runner = asRunner(merged)
      await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, merged.scope, merged.taskId)
        await recordPullRequestSnapshot(client, {
          task,
          snapshot: prSnapshot({ state: 'merged', mergedAt: new Date().toISOString() }),
        })
        await ingestSourceEvent(client, { task, subscriptionId: null, event: event({ type: 'pull_request' }) })
      })
      await reconcileWatch(pool, { organizationId: merged.organizationId })
      expect((await getDelegation(pool, merged.scope, merged.taskId, links)).task.state).toBe('completed')

      const patchOnly = await fixture(pool, 'Watch closed pull request', { requireReview: false })
      expect(await deliver(pool, patchOnly, prSnapshot({ state: 'closed', ready: false }))).toBe('completed')
      await inTenantTransaction(pool, asRunner(patchOnly), async (client) => {
        const task = await loadTaskRow(client, patchOnly.scope, patchOnly.taskId)
        await ingestSourceEvent(client, { task, subscriptionId: null, event: event({ type: 'pull_request' }) })
      })
      await reconcileWatch(pool, { organizationId: patchOnly.organizationId })
      const closed = await getDelegation(pool, patchOnly.scope, patchOnly.taskId, links)
      expect(closed.task.state).toBe('needs_attention')
      expect(closed.task.blocker?.detail).toContain('closed without being merged')
    } finally {
      await pool.end()
    }
  })

  it('polls at the configured interval, expires the watch window and disables the subscription', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Watch polling')
      const subscription = await subscribeTask(pool, context.scope, {
        taskId: context.taskId,
        rule: {
          source: 'github',
          timezone: 'UTC',
          expiresInSeconds: 3600,
          rule: { action: 'refresh_pull_request', intervalSeconds: 30 },
        },
      })
      expect(subscription.nextFireAt).not.toBeNull()
      // Not due yet.
      expect(await duePullRequestRefreshes(pool, context.organizationId)).toEqual([])
      await inTenantTransaction(
        pool,
        { organizationId: context.organizationId, actor: { type: 'system', service: 'delegation-scheduler' } },
        (client) =>
          client.query("update delegation_subscriptions set next_fire_at = now() - interval '1 second' where id=$1", [
            subscription.id,
          ])
      )
      const due = await duePullRequestRefreshes(pool, context.organizationId)
      expect(due).toEqual([
        {
          taskId: context.taskId,
          projectId: context.projectId,
          subscriptionId: subscription.id,
          intervalSeconds: 30,
        },
      ])
      await markRefreshPolled(pool, {
        organizationId: context.organizationId,
        subscriptionId: subscription.id,
        intervalSeconds: 30,
      })
      expect(await duePullRequestRefreshes(pool, context.organizationId)).toEqual([])

      // An expired window disables the subscription and records it.
      await inTenantTransaction(
        pool,
        { organizationId: context.organizationId, actor: { type: 'system', service: 'delegation-scheduler' } },
        (client) =>
          client.query("update delegation_subscriptions set expires_at = now() - interval '1 second' where id=$1", [
            subscription.id,
          ])
      )
      expect(await duePullRequestRefreshes(pool, context.organizationId)).toEqual([])
      const listed = await listSubscriptions(pool, context.scope, context.taskId)
      expect(listed[0]!.enabled).toBe(false)
      const reenabled = await setSubscriptionEnabled(pool, context.scope, {
        taskId: context.taskId,
        subscriptionId: subscription.id,
        enabled: true,
      })
      expect(reenabled.enabled).toBe(true)
    } finally {
      await pool.end()
    }
  })

  it('fires a timer once per occurrence and creates the task from its preset', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Watch timer')
      const preset = (await listDelegationPresets(pool, context.scope)).find(
        (item) => item.name === 'Implement and review'
      )!
      const subscription = await subscribeTask(pool, context.scope, {
        taskId: context.taskId,
        rule: {
          source: 'timer',
          timezone: 'America/Sao_Paulo',
          expiresInSeconds: null,
          rule: {
            action: 'create_task_from_preset',
            presetId: preset.id,
            title: 'Daily backlog triage',
            cadence: 'daily',
            atHour: 9,
            atMinute: 0,
            weekday: 1,
            // A preset carries a pipeline, never an account: the profile is chosen when the timer is created.
            settings: { selectionId: 'sel-opus', reasoning: 'high' },
          },
        },
      })
      expect(subscription.nextFireAt).not.toBeNull()
      expect(await runDueTimers(pool, { organizationId: context.organizationId, ...links })).toBe(0)

      await inTenantTransaction(
        pool,
        { organizationId: context.organizationId, actor: { type: 'system', service: 'delegation-scheduler' } },
        (client) =>
          client.query("update delegation_subscriptions set next_fire_at = now() - interval '1 minute' where id=$1", [
            subscription.id,
          ])
      )
      expect(await runDueTimers(pool, { organizationId: context.organizationId, ...links })).toBe(1)
      // The occurrence is recorded, so a second pass does not create a duplicate task.
      expect(await runDueTimers(pool, { organizationId: context.organizationId, ...links })).toBe(0)

      // The created task carries the preset pipeline with the profile the timer declared.
      const created = (await listDelegations(pool, context.scope, {}, links)).items.filter(
        (item) => item.task.title === 'Daily backlog triage'
      )
      expect(created).toHaveLength(1)
      const pipeline = await getDelegation(pool, context.scope, created[0]!.task.id, links)
      expect(pipeline.stages.map((stage) => stage.type)).toEqual(['implement', 'review'])
      expect(pipeline.stages[0]!.settings).toMatchObject({ selectionId: 'sel-opus', reasoning: 'high' })
      expect(pipeline.stages[1]!.settings).toMatchObject({ selectionId: 'sel-opus', reasoning: 'high' })

      const rescheduled = await listSubscriptions(pool, context.scope, context.taskId)
      expect(rescheduled[0]!.firedCount).toBe(1)
      expect(Date.parse(rescheduled[0]!.nextFireAt!)).toBeGreaterThan(Date.now())

      // The next occurrence is deterministic for the declared timezone.
      const rule = {
        action: 'create_task_from_preset' as const,
        presetId: preset.id,
        title: 'Daily backlog triage',
        cadence: 'daily' as const,
        atHour: 9,
        atMinute: 0,
        weekday: 1,
        settings: null,
      }
      const from = new Date('2026-09-20T20:00:00.000Z')
      const next = nextTimerOccurrence(rule, 'America/Sao_Paulo', from)
      expect(next.getTime()).toBeGreaterThan(from.getTime())
      expect(nextTimerOccurrence(rule, 'America/Sao_Paulo', from).toISOString()).toBe(next.toISOString())
    } finally {
      await pool.end()
    }
  })

  it('satisfies a task dependency once, when the predecessor completed', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Watch dependency')
      const dependent = await createDelegation(
        pool,
        context.scope,
        {
          boardId: context.boardId,
          title: 'Integration task',
          objective: '',
          acceptanceCriteria: [],
          executorId: context.executorId,
          workspaceKey: 'workspace-key',
          baseBranch: 'main',
          stages: [
            {
              type: 'implement',
              title: 'Integrate',
              instructions: '',
              dependsOn: [],
              requiredForCompletion: true,
              settings: { selectionId: 'sel-opus', reasoning: 'high' },
            },
          ],
          dependsOnTaskIds: [context.taskId],
          start: false,
        },
        links
      )
      // Nothing is satisfied while the predecessor is unfinished.
      expect(await reconcileDependencies(pool, { organizationId: context.organizationId })).toBe(0)
      await inTenantTransaction(
        pool,
        { organizationId: context.organizationId, actor: { type: 'system', service: 'delegation-scheduler' } },
        (client) => client.query("update delegation_tasks set state='completed' where id=$1", [context.taskId])
      )
      expect(await reconcileDependencies(pool, { organizationId: context.organizationId })).toBe(1)
      // A second pass does not fire again.
      expect(await reconcileDependencies(pool, { organizationId: context.organizationId })).toBe(0)
      const events = (await getDelegation(pool, context.scope, dependent.task.id, links)).task
      expect(events.id).toBe(dependent.task.id)
    } finally {
      await pool.end()
    }
  })
})
