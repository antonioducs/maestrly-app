import { describe, expect, it } from 'vitest'
import { getBoard } from '../../src/modules/boards/service.js'
import { createCard, moveCard } from '../../src/modules/cards/service.js'
import { assignColumnPolicy, createExecutionPolicy } from '../../src/modules/automation/policies.js'
import { createProject } from '../../src/modules/projects/service.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { claimJob } from '../../src/modules/jobs/claim.js'
import { authenticateExecutionToken, commentOnAssignedCard, listAuthorizedCards } from '../../src/modules/agent-tools/service.js'
import { completeRun } from '../../src/modules/runs/service.js'
import { readAuthorizedArtifact, uploadRunArtifact } from '../../src/modules/artifacts/service.js'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { integrationAvailable, migrationPool, runtimePool, seedOrganization } from './helpers.js'

describe.skipIf(!integrationAvailable)('card to evidence vertical flow', () => {
  it('creates one eligible job, scopes the agent and leaves delivery for human review', async () => {
    const pool = runtimePool()
    const storage = await mkdtemp(path.join(os.tmpdir(), 'maestrly-artifacts-'))
    try {
      const suffix = crypto.randomUUID()
      const owner = `owner-${suffix}`
      const organizationId = await seedOrganization(`Flow ${suffix}`, owner)
      const created = await createProject(pool, { organizationId, actorUserId: owner, name: 'Delivery' })
      const board = await getBoard(pool, { organizationId, boardId: created.boardId, userId: owner })
      const backlog = board.columns.find((column) => column.name === 'Backlog')!
      const inProgress = board.columns.find((column) => column.name === 'In progress')!
      const card = await createCard(pool, { organizationId, boardId: board.board.id, columnId: backlog.id, userId: owner, title: 'Implement evidence flow' })
      const policy = await createExecutionPolicy(pool, {
        organizationId, projectId: created.project.id, userId: owner, name: 'Codex patch', taskType: 'code', executionProfileId: 'default',
        requiredCapabilities: [{ name: 'executor:codex', attributes: {} }, { name: 'delivery:patch', attributes: {} }],
        repositoryBindingId: null, provider: 'codex', model: 'gpt-5', approvalRequired: false,
        maxDurationSeconds: 3600, maxLogBytes: 1_000_000, delivery: { mode: 'patch', requireHumanApproval: true }, enabled: true,
      })
      await assignColumnPolicy(pool, { organizationId, projectId: created.project.id, columnId: inProgress.id, policyId: policy.id, userId: owner })
      const moved = await moveCard(pool, { organizationId, cardId: card.id, userId: owner, move: {
        expectedVersion: card.version, targetColumnId: inProgress.id, targetPosition: 0, source: 'human', allowAutomationChain: false, chainDepth: 0,
      } })
      expect(moved.jobId).toBeTruthy()

      const enrollment = await createRunnerEnrollment(pool, { organizationId, projectIds: [created.project.id], userId: owner })
      const runner = await enrollRunner(pool, {
        organizationId, token: enrollment.token, name: 'CI runner', protocolVersion: '1.0', maxConcurrency: 1,
        capabilities: [{ name: 'executor:codex', attributes: {} }, { name: 'delivery:patch', attributes: {} }],
      })
      const [first, second] = await Promise.all([
        claimJob(pool, { organizationId, runnerId: runner.runnerId, credential: runner.credential, protocolVersion: '1.0' }),
        claimJob(pool, { organizationId, runnerId: runner.runnerId, credential: runner.credential, protocolVersion: '1.0' }),
      ])
      const claim = first ?? second
      expect([first, second].filter(Boolean)).toHaveLength(1)
      expect(claim).not.toBeNull()

      const scope = await authenticateExecutionToken(pool, organizationId, claim!.executionToken)
      expect(scope?.projectId).toBe(created.project.id)
      expect(await listAuthorizedCards(pool, scope!)).toHaveLength(1)
      await commentOnAssignedCard(pool, scope!, 'Verification completed by the execution agent.')
      const uploaded = await uploadRunArtifact(pool, storage, {
        organizationId, runnerId: runner.runnerId, runId: claim!.envelope.runId, leaseId: claim!.envelope.leaseId,
        kind: 'patch', name: 'changes.patch', contentType: 'text/x-diff', bytes: Buffer.from('patch-content'),
      })
      await completeRun(pool, {
        organizationId, runnerId: runner.runnerId, runId: claim!.envelope.runId, leaseId: claim!.envelope.leaseId,
        completion: { state: 'succeeded', summary: 'Patch is ready for review.', artifacts: [uploaded] },
      })
      await expect(completeRun(pool, {
        organizationId, runnerId: runner.runnerId, runId: claim!.envelope.runId, leaseId: claim!.envelope.leaseId,
        completion: { state: 'succeeded', summary: 'Patch is ready for review.', artifacts: [uploaded] },
      })).resolves.toEqual({ repeated: true })
      const downloaded = await readAuthorizedArtifact(pool, storage, { organizationId, artifactId: uploaded.id, userId: owner })
      expect(downloaded.bytes.toString()).toBe('patch-content')

      const after = await getBoard(pool, { organizationId, boardId: created.boardId, userId: owner })
      expect(after.cards.find((item) => item.id === card.id)?.columnId).toBe(inProgress.id)
      const admin = migrationPool()
      try {
        const job = await admin.query<{ state: string }>('select state from jobs where id = $1', [moved.jobId])
        const artifact = await admin.query<{ orphaned: boolean }>('select orphaned from artifacts where run_id = $1', [claim!.envelope.runId])
        expect(job.rows[0]!.state).toBe('completed')
        expect(artifact.rows[0]!.orphaned).toBe(false)
      } finally { await admin.end() }

      const secondCard = await createCard(pool, { organizationId, boardId: board.board.id, columnId: backlog.id, userId: owner, title: 'Cancel safely' })
      const secondMove = await moveCard(pool, { organizationId, cardId: secondCard.id, userId: owner, move: {
        expectedVersion: secondCard.version, targetColumnId: inProgress.id, targetPosition: 0, source: 'human', allowAutomationChain: false, chainDepth: 0,
      } })
      expect(secondMove.jobId).toBeTruthy()
      const secondClaim = await claimJob(pool, { organizationId, runnerId: runner.runnerId, credential: runner.credential, protocolVersion: '1.0' })
      expect(secondClaim).not.toBeNull()
      const cancelledMove = await moveCard(pool, { organizationId, cardId: secondCard.id, userId: owner, move: {
        expectedVersion: secondMove.card.version, targetColumnId: board.columns.find((column) => column.name === 'Review')!.id,
        targetPosition: 0, source: 'human', allowAutomationChain: false, chainDepth: 0,
      } })
      await expect(completeRun(pool, {
        organizationId, runnerId: runner.runnerId, runId: secondClaim!.envelope.runId, leaseId: secondClaim!.envelope.leaseId,
        completion: { state: 'succeeded', summary: 'Arrived after cancellation.', artifacts: [{ kind: 'patch', name: 'late.patch', contentType: 'text/x-diff', sizeBytes: 4, digest: 'late', storageKey: `runs/${secondClaim!.envelope.runId}/late/late.patch` }] },
      })).rejects.toThrow(/no longer the active authorization/)
      expect(cancelledMove.card.columnId).toBe(board.columns.find((column) => column.name === 'Review')!.id)
      const lateAdmin = migrationPool()
      try {
        const lateJob = await lateAdmin.query<{ state: string }>('select state from jobs where id = $1', [secondMove.jobId])
        const lateArtifact = await lateAdmin.query<{ orphaned: boolean }>('select orphaned from artifacts where run_id = $1', [secondClaim!.envelope.runId])
        expect(lateJob.rows[0]!.state).toBe('cancelled')
        expect(lateArtifact.rows[0]!.orphaned).toBe(true)
      } finally { await lateAdmin.end() }
    } finally { await pool.end(); await rm(storage, { recursive: true, force: true }) }
  })
})
