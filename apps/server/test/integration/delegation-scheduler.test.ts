import { describe, expect, it } from 'vitest'
import { delegationCatalogRevision, delegationModelCatalogSchema, type DelegationModelCatalog } from '@maestrly/protocol'
import { inTenantTransaction } from '../../src/db/transaction.js'
import { applyDelegationCommand } from '../../src/modules/delegations/commands.js'
import { publishDelegationCatalog } from '../../src/modules/delegations/model-catalog.js'
import { advanceDelegation, runDelegationScheduler } from '../../src/modules/delegations/scheduler.js'
import { reconcileDelegations } from '../../src/modules/delegations/reconcile.js'
import { createDelegation, getDelegation } from '../../src/modules/delegations/service.js'
import { createProject } from '../../src/modules/projects/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

const links = { webOrigin: 'http://127.0.0.1:4173' }

const features = {
  checks: [{ id: 'unit', label: 'Unit tests', description: '', required: true, mutatesWorkspace: false }],
  github: { available: true, login: 'octocat', issue: null },
  preview: { available: true, issue: null },
  maestro: true,
  subagents: false,
  browserInspect: true,
  browserInteract: false,
}

const models = [
  {
    selectionId: 'sel-opus',
    modelLabel: 'claude-opus-5',
    accountLabel: 'Claude · personal',
    efforts: ['low', 'medium', 'high'],
    fastMode: true,
    executionModes: ['standard', 'maestro'],
    delegationProfiles: [],
    harnessProfileId: null,
    harnessHash: null,
  },
  {
    selectionId: 'sel-astra',
    modelLabel: 'gpt-6-astra',
    accountLabel: 'Codex · personal',
    efforts: ['medium', 'high'],
    fastMode: false,
    executionModes: ['standard'],
    delegationProfiles: [],
    harnessProfileId: null,
    harnessHash: null,
  },
]

function catalogFor(projectId: string, entries = models, enabled = true): DelegationModelCatalog {
  const workspaces = [
    { projectId, key: 'workspace-key', label: 'Repo', branches: ['main'], repositoryBindingId: null },
  ]
  return delegationModelCatalogSchema.parse({
    capability: 'delegation:stages:v1',
    enabled,
    revision: delegationCatalogRevision({ models: entries as never, features, workspaces }),
    generatedAt: new Date().toISOString(),
    workspaces,
    models: entries,
    features,
    issues: [],
  })
}

async function fixture(pool: ReturnType<typeof runtimePool>, name: string) {
  const owner = 'sched-owner-' + crypto.randomUUID()
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
    maxConcurrency: 4,
  })
  const publish = (catalog: DelegationModelCatalog) =>
    inTenantTransaction(pool, { organizationId, actor: { type: 'runner', runnerId: executor.runnerId } }, (client) =>
      publishDelegationCatalog(client, { organizationId, runnerId: executor.runnerId, catalog })
    )
  await publish(catalogFor(projectId))
  const board = await getBoard(pool, { organizationId, userId: owner, boardId: project.boardId })
  return {
    owner,
    organizationId,
    projectId,
    executorId: executor.runnerId,
    boardId: board.board.id,
    publish,
    scope: { organizationId, projectId, userId: owner },
  }
}

const implementThenReview = (boardId: string, executorId: string) => ({
  boardId,
  title: 'Implement with Opus, review with Astra',
  objective: 'Ship it',
  acceptanceCriteria: ['Tests pass'],
  executorId,
  workspaceKey: 'workspace-key',
  baseBranch: 'main',
  stages: [
    {
      type: 'implement' as const,
      title: 'Implement',
      instructions: 'Implement the card',
      dependsOn: [],
      requiredForCompletion: true,
      settings: { selectionId: 'sel-opus', reasoning: 'high' },
    },
    {
      type: 'review' as const,
      title: 'Review',
      instructions: '',
      dependsOn: [0],
      requiredForCompletion: true,
      settings: { selectionId: 'sel-astra', reasoning: 'high' },
    },
  ],
  dependsOnTaskIds: [],
  start: false,
})

/** Simulate the executor: claim the queued turn, report a receipt and complete it. */
async function runStage(
  pool: ReturnType<typeof runtimePool>,
  input: { organizationId: string; executorId: string; result?: 'succeeded' | 'failed'; selectionHonored?: boolean }
) {
  return inTenantTransaction(
    pool,
    { organizationId: input.organizationId, actor: { type: 'runner', runnerId: input.executorId } },
    async (client) => {
      const attempts = await client.query(
        `select a.* from delegation_attempts a join delegation_tasks t on t.id=a.task_id
         where a.organization_id=$1 and t.executor_id=$2 and a.state='queued' order by a.created_at limit 1 for update`,
        [input.organizationId, input.executorId]
      )
      const attempt = attempts.rows[0]
      if (!attempt) return null
      await client.query("update delegation_attempts set state='running', started_at=now(), receipt=$2 where id=$1", [
        attempt.id,
        {
          requested: attempt.snapshot.settings,
          admitted: attempt.snapshot.settings,
          observed: {
            selectionId: attempt.snapshot.settings?.selectionId ?? null,
            modelId: 'fixture',
            accountLabel: 'Fixture',
            reasoning: attempt.snapshot.settings?.reasoning ?? null,
            fastMode: attempt.snapshot.settings?.fastMode ?? null,
            harnessProfileId: null,
            harnessHash: null,
          },
          selectionHonored: input.selectionHonored ?? true,
          conversationId: 'conversation',
          result: input.result ?? 'succeeded',
          summary: 'fixture run',
          blocker: null,
          tokensObserved: false,
          tokens: null,
          costUsd: null,
          durationMs: 10,
        },
      ])
      await client.query("update delegation_stages set state='running', version=version+1 where id=$1", [
        attempt.stage_id,
      ])
      await client.query(
        "update chat_turns set state=$2, completed_at=now() where id=$1",
        [attempt.turn_id, input.result === 'failed' ? 'failed' : 'succeeded']
      )
      return { attemptId: attempt.id as string, taskId: attempt.task_id as string, turnId: attempt.turn_id as string }
    }
  )
}

describe.skipIf(!integrationAvailable)('delegation scheduler', () => {
  it('admits one stage at a time, respects dependencies and completes only when required stages succeed', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Scheduler happy path')
      const view = await createDelegation(
        pool,
        context.scope,
        implementThenReview(context.boardId, context.executorId),
        links
      )
      await applyDelegationCommand(
        pool,
        context.scope,
        view.task.id,
        { type: 'start', expectedVersion: view.task.version },
        'start'
      )
      const first = await advanceDelegation(pool, { organizationId: context.organizationId, taskId: view.task.id })
      expect(first?.admitted).toHaveLength(1)
      const afterFirst = await getDelegation(pool, context.scope, view.task.id, links)
      expect(afterFirst.stages[0]!.state).toBe('queued')
      // The dependent review is not admitted while the implementation is live.
      expect(afterFirst.stages[1]!.state).toBe('pending')
      expect(afterFirst.attempts[0]!.snapshot.settings).toMatchObject({ selectionId: 'sel-opus', reasoning: 'high' })
      expect(afterFirst.attempts[0]!.snapshot.prompt).toContain('Acceptance criteria')

      // A second scheduler pass admits nothing new.
      const second = await advanceDelegation(pool, { organizationId: context.organizationId, taskId: view.task.id })
      expect(second?.admitted).toEqual([])

      const ran = await runStage(pool, { organizationId: context.organizationId, executorId: context.executorId })
      expect(ran).not.toBeNull()
      await reconcileDelegations(pool)
      await runDelegationScheduler(pool)
      const afterImplement = await getDelegation(pool, context.scope, view.task.id, links)
      expect(afterImplement.stages[0]!.state).toBe('succeeded')
      expect(afterImplement.stages[1]!.state).toBe('queued')
      expect(afterImplement.attempts[1]!.snapshot.settings).toMatchObject({ selectionId: 'sel-astra' })

      await runStage(pool, { organizationId: context.organizationId, executorId: context.executorId })
      await reconcileDelegations(pool)
      await runDelegationScheduler(pool)
      const done = await getDelegation(pool, context.scope, view.task.id, links)
      expect(done.task.state).toBe('completed')
      expect(done.task.completedAt).not.toBeNull()
    } finally {
      await pool.end()
    }
  })

  it('does not treat a finished turn without an honored selection as a successful stage', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Scheduler receipt')
      const view = await createDelegation(
        pool,
        context.scope,
        implementThenReview(context.boardId, context.executorId),
        links
      )
      await applyDelegationCommand(
        pool,
        context.scope,
        view.task.id,
        { type: 'start', expectedVersion: view.task.version },
        'start'
      )
      await advanceDelegation(pool, { organizationId: context.organizationId, taskId: view.task.id })
      await runStage(pool, {
        organizationId: context.organizationId,
        executorId: context.executorId,
        selectionHonored: false,
      })
      await reconcileDelegations(pool)
      await runDelegationScheduler(pool)
      const after = await getDelegation(pool, context.scope, view.task.id, links)
      expect(after.stages[0]!.state).toBe('failed')
      expect(after.task.state).toBe('needs_attention')
      expect(after.task.blocker?.reason).toBe('executor_error')
      expect(after.stages[1]!.state).toBe('pending')
    } finally {
      await pool.end()
    }
  })

  it('pauses after the current stage, cancels before a claim and blocks when the catalog loses the model', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Scheduler controls')
      const view = await createDelegation(
        pool,
        context.scope,
        implementThenReview(context.boardId, context.executorId),
        links
      )
      await applyDelegationCommand(
        pool,
        context.scope,
        view.task.id,
        { type: 'start', expectedVersion: view.task.version },
        'start'
      )
      await advanceDelegation(pool, { organizationId: context.organizationId, taskId: view.task.id })
      const running = await getDelegation(pool, context.scope, view.task.id, links)
      const paused = await applyDelegationCommand(
        pool,
        context.scope,
        view.task.id,
        { type: 'pause', expectedVersion: running.task.version, immediate: false },
        'pause'
      )
      expect(paused.state).toBe('pausing')
      // A pausing task admits nothing while its stage is live.
      expect((await advanceDelegation(pool, { organizationId: context.organizationId, taskId: view.task.id }))?.admitted).toEqual([])
      await runStage(pool, { organizationId: context.organizationId, executorId: context.executorId })
      await reconcileDelegations(pool)
      await runDelegationScheduler(pool)
      const afterPause = await getDelegation(pool, context.scope, view.task.id, links)
      expect(afterPause.task.state).toBe('paused')
      expect(afterPause.stages[1]!.state).toBe('pending')

      // The executor stops advertising the model the review stage needs.
      await context.publish(catalogFor(context.projectId, [models[0]!]))
      await applyDelegationCommand(
        pool,
        context.scope,
        view.task.id,
        { type: 'resume', expectedVersion: afterPause.task.version },
        'resume'
      )
      await reconcileDelegations(pool)
      await runDelegationScheduler(pool)
      const blocked = await getDelegation(pool, context.scope, view.task.id, links)
      expect(blocked.task.state).toBe('needs_attention')
      expect(blocked.task.blocker?.reason).toBe('selection_unavailable')
      expect(blocked.stages[1]!.state).toBe('pending')

      // Cancelling a task with no live stage is immediate and removes the queued work.
      const cancelled = await applyDelegationCommand(
        pool,
        context.scope,
        view.task.id,
        { type: 'cancel', expectedVersion: blocked.task.version, reason: 'stop' },
        'cancel'
      )
      expect(cancelled.state).toBe('cancelled')
      const afterCancel = await getDelegation(pool, context.scope, view.task.id, links)
      expect(afterCancel.stages[1]!.state).toBe('cancelled')
      expect((await advanceDelegation(pool, { organizationId: context.organizationId, taskId: view.task.id }))?.admitted).toEqual([])
    } finally {
      await pool.end()
    }
  })

  it('keeps a running attempt on its snapshot and applies an interrupt only after it stops', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Scheduler interrupt')
      const view = await createDelegation(
        pool,
        context.scope,
        implementThenReview(context.boardId, context.executorId),
        links
      )
      const started = await applyDelegationCommand(
        pool,
        context.scope,
        view.task.id,
        { type: 'start', expectedVersion: view.task.version },
        'start'
      )
      await advanceDelegation(pool, { organizationId: context.organizationId, taskId: view.task.id })
      const live = await getDelegation(pool, context.scope, view.task.id, links)
      expect(live.attempts[0]!.snapshot.settings).toMatchObject({ selectionId: 'sel-opus' })

      // "after_current" leaves the live attempt untouched and names the attempt the change applies from.
      const afterCurrent = await applyDelegationCommand(
        pool,
        context.scope,
        view.task.id,
        {
          type: 'configure',
          expectedVersion: live.task.version,
          target: 'stage',
          stageId: live.stages[0]!.id,
          settingsPatch: { selectionId: 'sel-astra', reasoning: 'high' },
          apply: 'after_current',
        },
        'configure-after'
      )
      expect(afterCurrent.appliesFromAttempt).toBe(2)
      expect(afterCurrent.pendingInterrupt).toBe(false)
      const unchanged = await getDelegation(pool, context.scope, view.task.id, links)
      expect(unchanged.attempts[0]!.snapshot.settings).toMatchObject({ selectionId: 'sel-opus' })
      expect(unchanged.stages[0]!.settings).toMatchObject({ selectionId: 'sel-astra' })

      const interrupt = await applyDelegationCommand(
        pool,
        context.scope,
        view.task.id,
        {
          type: 'configure',
          expectedVersion: unchanged.task.version,
          target: 'stage',
          stageId: unchanged.stages[0]!.id,
          settingsPatch: { selectionId: 'sel-opus', reasoning: 'medium' },
          apply: 'interrupt_and_restart',
        },
        'configure-interrupt'
      )
      expect(interrupt.pendingInterrupt).toBe(true)
      await reconcileDelegations(pool)
      await runDelegationScheduler(pool)
      const restarted = await getDelegation(pool, context.scope, view.task.id, links)
      const attempts = restarted.attempts.filter((attempt) => attempt.stageId === restarted.stages[0]!.id)
      expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2])
      expect(attempts[0]!.state).toBe('cancelled')
      // The new attempt carries the new configuration; the previous attempt keeps its own history.
      expect(attempts[1]!.snapshot.settings).toMatchObject({ selectionId: 'sel-opus', reasoning: 'medium' })
      expect(attempts[0]!.snapshot.settings).toMatchObject({ selectionId: 'sel-opus', reasoning: 'high' })
      expect(started.state).toBe('queued')
    } finally {
      await pool.end()
    }
  })
})
