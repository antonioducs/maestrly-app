import { describe, expect, it } from 'vitest'
import { delegationCatalogRevision, delegationModelCatalogSchema, type DelegationModelCatalog } from '@maestrly/protocol'
import { inTenantTransaction } from '../../src/db/transaction.js'
import { applyDelegationCommand } from '../../src/modules/delegations/commands.js'
import { listFindings, openFindings, recordReviewResult } from '../../src/modules/delegations/findings.js'
import { publishDelegationCatalog } from '../../src/modules/delegations/model-catalog.js'
import { currentRevisionDigest, evaluateCompletion, planFixRound } from '../../src/modules/delegations/quality.js'
import { reconcileDelegations } from '../../src/modules/delegations/reconcile.js'
import { advanceDelegation, runDelegationScheduler } from '../../src/modules/delegations/scheduler.js'
import { createDelegation, getDelegation } from '../../src/modules/delegations/service.js'
import { loadTaskRow } from '../../src/modules/delegations/repository.js'
import { createProject } from '../../src/modules/projects/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

const links = { webOrigin: 'http://127.0.0.1:4173' }

const features = {
  checks: [],
  github: { available: false, login: null, issue: null },
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

const revision = (digest: string) => ({
  id: crypto.randomUUID(),
  baseCommit: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
  contentDigest: digest,
  snapshotArtifactId: null,
  capturedAt: new Date().toISOString(),
})

async function fixture(pool: ReturnType<typeof runtimePool>, name: string, policy?: Record<string, unknown>) {
  const owner = 'quality-owner-' + crypto.randomUUID()
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
      objective: 'Ship the feature',
      acceptanceCriteria: ['Tests pass'],
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
        {
          type: 'review',
          title: 'Independent review',
          instructions: '',
          dependsOn: [0],
          requiredForCompletion: true,
          settings: { selectionId: 'sel-astra', reasoning: 'high' },
        },
      ],
      dependsOnTaskIds: [],
      start: false,
    },
    links
  )
  await applyDelegationCommand(pool, scope, view.task.id, { type: 'start', expectedVersion: view.task.version }, 'start')
  return { owner, organizationId, projectId, executorId: executor.runnerId, scope, taskId: view.task.id }
}

/** Run the queued stage as the executor would, recording the revision and optional review verdict. */
async function runStage(
  pool: ReturnType<typeof runtimePool>,
  context: { organizationId: string; projectId: string; executorId: string },
  input: { digest: string; review?: Record<string, unknown> }
) {
  return inTenantTransaction(
    pool,
    { organizationId: context.organizationId, actor: { type: 'runner', runnerId: context.executorId } },
    async (client) => {
      const attempts = await client.query(
        `select a.* from delegation_attempts a join delegation_tasks t on t.id=a.task_id
         where a.organization_id=$1 and t.executor_id=$2 and a.state='queued' order by a.created_at limit 1 for update`,
        [context.organizationId, context.executorId]
      )
      const attempt = attempts.rows[0]
      if (!attempt) return null
      const captured = revision(input.digest)
      await client.query(
        "update delegation_attempts set state='running', started_at=now(), code_revision=$2, receipt=$3 where id=$1",
        [
          attempt.id,
          captured,
          {
            requested: attempt.snapshot.settings,
            admitted: attempt.snapshot.settings,
            observed: {
              selectionId: attempt.snapshot.settings?.selectionId ?? null,
              modelId: 'fixture',
              accountLabel: 'Fixture',
              reasoning: attempt.snapshot.settings?.reasoning ?? null,
              fastMode: false,
              harnessProfileId: null,
              harnessHash: null,
            },
            selectionHonored: true,
            conversationId: 'conversation',
            result: 'succeeded',
            summary: '',
            blocker: null,
            tokensObserved: false,
            tokens: null,
            costUsd: null,
            durationMs: 5,
          },
        ]
      )
      if (input.review) {
        const task = await loadTaskRow(
          client,
          { organizationId: context.organizationId, projectId: context.projectId },
          attempt.task_id
        )
        await recordReviewResult(client, {
          task,
          stageId: attempt.stage_id,
          attemptId: attempt.id,
          reviewedRevision: captured,
          result: input.review,
        })
      }
      await client.query("update delegation_stages set state='running', version=version+1 where id=$1", [
        attempt.stage_id,
      ])
      await client.query("update chat_turns set state='succeeded', completed_at=now() where id=$1", [attempt.turn_id])
      return { attemptId: attempt.id as string, stageId: attempt.stage_id as string, digest: input.digest }
    }
  )
}

const approved = (digest: string) => ({
  verdict: 'approved',
  codeRevisionDigest: digest,
  findings: [],
  criteriaCoverage: [{ criterion: 'Tests pass', satisfied: true, evidence: 'npm test' }],
  notes: '',
})

const changesRequested = (digest: string, id = 'missing-test') => ({
  verdict: 'changes_requested',
  codeRevisionDigest: digest,
  findings: [
    {
      id,
      severity: 'blocking',
      title: 'The new path is untested',
      details: 'Add coverage for the new branch.',
      paths: ['src/feature.ts'],
      recommendation: 'Add a focused test.',
      state: 'open',
    },
  ],
  criteriaCoverage: [{ criterion: 'Tests pass', satisfied: false, evidence: '' }],
  notes: '',
})

describe.skipIf(!integrationAvailable)('delegation quality loop', () => {
  it('completes only when the approving review matches the current revision', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Quality approve')
      await advanceDelegation(pool, { organizationId: context.organizationId, taskId: context.taskId })
      await runStage(pool, context, { digest: 'd'.repeat(64) })
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })
      const readyForReview = await getDelegation(pool, context.scope, context.taskId, links)
      expect(readyForReview.stages[1]!.state).toBe('queued')

      await runStage(pool, context, { digest: 'd'.repeat(64), review: approved('d'.repeat(64)) })
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })
      const done = await getDelegation(pool, context.scope, context.taskId, links)
      expect(done.task.state).toBe('completed')
      expect(currentRevisionDigest(done.attempts)).toBe('d'.repeat(64))
    } finally {
      await pool.end()
    }
  })

  it('plans a fix round from blocking findings and re-reviews the new revision', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Quality fix round')
      await advanceDelegation(pool, { organizationId: context.organizationId, taskId: context.taskId })
      await runStage(pool, context, { digest: 'a'.repeat(64) })
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })
      await runStage(pool, context, { digest: 'a'.repeat(64), review: changesRequested('a'.repeat(64)) })
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })

      const afterReview = await getDelegation(pool, context.scope, context.taskId, links)
      const fix = afterReview.stages.find((stage) => stage.type === 'fix')
      expect(fix).toBeDefined()
      expect(fix!.instructions).toContain('missing-test')
      expect(fix!.instructions).toContain('Add a focused test.')
      // The fix round inherits the implementation profile, not the reviewer's.
      expect(fix!.settings).toMatchObject({ selectionId: 'sel-opus' })
      expect(afterReview.task.state).not.toBe('completed')

      // The fix produces a new revision; a re-review is planned against it.
      await runStage(pool, context, { digest: 'b'.repeat(64) })
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })
      const afterFix = await getDelegation(pool, context.scope, context.taskId, links)
      const reviews = afterFix.stages.filter((stage) => stage.type === 'review')
      expect(reviews.length).toBe(2)
      expect(reviews[1]!.settings).toMatchObject({ selectionId: 'sel-astra' })

      await runStage(pool, context, { digest: 'b'.repeat(64), review: approved('b'.repeat(64)) })
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })
      const completed = await getDelegation(pool, context.scope, context.taskId, links)
      expect(completed.task.state).toBe('completed')
      await inTenantTransaction(
        pool,
        { organizationId: context.organizationId, projectId: context.projectId, actor: { type: 'human', userId: context.owner } },
        async (client) => {
          expect((await openFindings(client, context.taskId)).length).toBe(0)
          const all = await listFindings(client, context.taskId)
          expect(all.map((finding) => finding.state)).toEqual(['fixed'])
        }
      )
    } finally {
      await pool.end()
    }
  })

  it('refuses a verdict that does not match the reviewed revision or contradicts itself', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Quality verdict validation')
      await advanceDelegation(pool, { organizationId: context.organizationId, taskId: context.taskId })
      await runStage(pool, context, { digest: 'c'.repeat(64) })
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })
      await expect(
        runStage(pool, context, { digest: 'c'.repeat(64), review: approved('f'.repeat(64)) })
      ).rejects.toThrow(/does not match the revision/)
      await expect(
        runStage(pool, context, {
          digest: 'c'.repeat(64),
          review: { ...changesRequested('c'.repeat(64)), verdict: 'approved' },
        })
      ).rejects.toThrow(/cannot approve/)
    } finally {
      await pool.end()
    }
  })

  it('stops with the remaining findings when a fix round changes nothing', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Quality no progress', { limits: { maxFixAttempts: 3 } })
      await advanceDelegation(pool, { organizationId: context.organizationId, taskId: context.taskId })
      await runStage(pool, context, { digest: '1'.repeat(64) })
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })
      await runStage(pool, context, { digest: '1'.repeat(64), review: changesRequested('1'.repeat(64)) })
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })
      // The fix round runs but the reviewer reports the very same finding again.
      await runStage(pool, context, { digest: '2'.repeat(64) })
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })
      await runStage(pool, context, { digest: '2'.repeat(64), review: changesRequested('2'.repeat(64)) })
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })
      const stalled = await getDelegation(pool, context.scope, context.taskId, links)
      expect(stalled.task.state).toBe('needs_attention')
      expect(stalled.task.blocker?.reason).toBe('review_findings_open')
      expect(stalled.task.blocker?.detail).toContain('did not change')
      // An interrupted loop is never reported as success.
      expect(stalled.task.completedAt).toBeNull()
    } finally {
      await pool.end()
    }
  })

  it('evaluates the completion target without inventing delivery facts', () => {
    const task = {
      acceptanceCriteria: ['Tests pass'],
      policy: {
        requireReview: true,
        completionTarget: 'pr_ready',
        limits: { maxFixAttempts: 2 },
      },
    } as never
    const decision = evaluateCompletion({
      task,
      stages: [{ requiredForCompletion: true, state: 'succeeded', title: 'Implement' } as never],
      attempts: [],
      findings: [],
      review: {
        id: 'r',
        stageId: 's',
        attemptId: 'a',
        verdict: 'approved',
        codeRevisionDigest: 'x'.repeat(64),
        criteriaCoverage: [{ criterion: 'Tests pass', satisfied: true, evidence: 'ok' }],
        notes: '',
        createdAt: '2026-09-20T00:00:00.000Z',
      },
      currentRevisionDigest: 'x'.repeat(64),
      pullRequest: null,
    })
    expect(decision.satisfied).toBe(false)
    expect(decision.missing.map((item) => item.reason)).toContain('pull_request_missing')

    const stale = evaluateCompletion({
      task,
      stages: [{ requiredForCompletion: true, state: 'succeeded', title: 'Implement' } as never],
      attempts: [],
      findings: [],
      review: {
        id: 'r',
        stageId: 's',
        attemptId: 'a',
        verdict: 'approved',
        codeRevisionDigest: 'x'.repeat(64),
        criteriaCoverage: [{ criterion: 'Tests pass', satisfied: true, evidence: 'ok' }],
        notes: '',
        createdAt: '2026-09-20T00:00:00.000Z',
      },
      currentRevisionDigest: 'y'.repeat(64),
      pullRequest: { number: 7, state: 'open', ready: true, mergedAt: null },
    })
    expect(stale.missing.map((item) => item.reason)).toContain('evidence_stale')

    const limited = planFixRound({
      task: { policy: { limits: { maxFixAttempts: 1 } } } as never,
      stages: [{ type: 'fix' } as never],
      findings: [{ id: 'f', severity: 'blocking', state: 'open', title: 't', details: 'd', paths: [], recommendation: '' }],
      previousSignature: null,
    })
    expect(limited).toMatchObject({ create: null, reason: 'limit_reached' })
    const repeated = planFixRound({
      task: { policy: { limits: { maxFixAttempts: 5 } } } as never,
      stages: [],
      findings: [{ id: 'f', severity: 'blocking', state: 'open', title: 't', details: 'd', paths: [], recommendation: '' }],
      previousSignature: 'f:blocking',
    })
    expect(repeated).toMatchObject({ create: null, reason: 'no_progress' })
  })
})
