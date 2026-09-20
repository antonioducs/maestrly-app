import { randomBytes, randomUUID } from 'node:crypto'
import {
  checkResultSchema,
  codeRevisionSchema,
  delegationModelCatalogSchema,
  reviewResultSchema,
  stageExecutionReceiptSchema,
  type ProjectChatClaim,
} from '@maestrly/protocol'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ServerConfig } from '../../config.js'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { chatRunnerIdentity } from '../project-chat/runner-routes.js'
import { runnerTransaction, tokenHash } from '../project-chat/dispatch.js'
import { appendChatEvent } from '../project-chat/events.js'
import { mapMessage, mapSession, mapTurn } from '../project-chat/service.js'
import {
  appendArtifactChunk,
  artifactChunkSchema,
  artifactUploadStartSchema,
  completeArtifactUpload,
  startArtifactUpload,
  type ArtifactLimits,
} from './artifacts.js'
import { enabledCheckConfigs, recordCheckResult } from './checks.js'
import { recordReviewResult } from './findings.js'
import { claimInspection, completeInspection, inspectionCompletionSchema } from './inspections.js'
import { publishDelegationCatalog } from './model-catalog.js'
import { appendDelegationEvent, delegationFail, loadTaskRow, mapAttempt } from './repository.js'

/** Machine endpoints for delegation stages. Authentication reuses the runner credential contract. */
export function registerDelegationRunnerRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  serverConfig: ServerConfig
): void {
  const root = '/api/v1/runners/delegations'
  const config = { rateLimit: { max: 1800, timeWindow: '1 minute' } }
  const limits: ArtifactLimits = {
    maxArtifactBytes: serverConfig.maxDelegationArtifactBytes,
    maxTaskBytes: serverConfig.maxDelegationTaskArtifactBytes,
  }

  /** Resolve the task an authenticated executor owns, so a machine cannot touch another task. */
  async function ownedTask(client: DatabaseClient, organizationId: string, runnerId: string, taskId: string) {
    const rows = await client.query<{ project_id: string }>(
      'select project_id from delegation_tasks where organization_id=$1 and id=$2 and executor_id=$3',
      [organizationId, taskId, runnerId]
    )
    if (!rows.rows[0]) delegationFail('This task does not belong to this executor.', 403)
    return loadTaskRow(client, { organizationId, projectId: rows.rows[0].project_id }, taskId)
  }

  app.get(root + '/checks', { config }, async (request) => {
    const identity = chatRunnerIdentity(request)
    const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.query)
    return runnerTransaction(pool, identity, async (client) => {
      const task = await ownedTask(client, identity.organizationId, identity.runnerId, taskId)
      return {
        items: await enabledCheckConfigs(client, {
          organizationId: task.organizationId,
          projectId: task.projectId,
        }),
      }
    })
  })

  app.post(root + '/tasks/:taskId/checks', { config }, async (request) => {
    const identity = chatRunnerIdentity(request)
    const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params)
    const body = z
      .object({ attemptId: z.string().uuid().nullable().default(null), result: checkResultSchema })
      .strict()
      .parse(request.body)
    return runnerTransaction(pool, identity, async (client) => {
      const task = await ownedTask(client, identity.organizationId, identity.runnerId, taskId)
      return recordCheckResult(client, { task, attemptId: body.attemptId, result: body.result })
    })
  })

  app.post(root + '/tasks/:taskId/artifacts/uploads', { config }, async (request) => {
    const identity = chatRunnerIdentity(request)
    const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params)
    const body = artifactUploadStartSchema.parse(request.body)
    return runnerTransaction(pool, identity, async (client) => {
      const task = await ownedTask(client, identity.organizationId, identity.runnerId, taskId)
      return startArtifactUpload(
        client,
        {
          organizationId: task.organizationId,
          projectId: task.projectId,
          taskId: task.id,
          runnerId: identity.runnerId,
          storageDirectory: serverConfig.storageDirectory,
          limits,
        },
        body
      )
    })
  })

  app.post(root + '/tasks/:taskId/artifacts/uploads/:uploadId/chunks', { config }, async (request) => {
    const identity = chatRunnerIdentity(request)
    const { taskId, uploadId } = z
      .object({ taskId: z.string().uuid(), uploadId: z.string().uuid() })
      .parse(request.params)
    const body = artifactChunkSchema.parse(request.body)
    return runnerTransaction(pool, identity, async (client) => {
      const task = await ownedTask(client, identity.organizationId, identity.runnerId, taskId)
      return appendArtifactChunk(
        client,
        {
          organizationId: task.organizationId,
          projectId: task.projectId,
          taskId: task.id,
          runnerId: identity.runnerId,
          storageDirectory: serverConfig.storageDirectory,
          limits,
        },
        uploadId,
        body
      )
    })
  })

  app.post(root + '/tasks/:taskId/artifacts/uploads/:uploadId/complete', { config }, async (request) => {
    const identity = chatRunnerIdentity(request)
    const { taskId, uploadId } = z
      .object({ taskId: z.string().uuid(), uploadId: z.string().uuid() })
      .parse(request.params)
    const body = z.object({ digest: z.string().min(16).max(191) }).strict().parse(request.body)
    return runnerTransaction(pool, identity, async (client) => {
      const task = await ownedTask(client, identity.organizationId, identity.runnerId, taskId)
      const artifact = await completeArtifactUpload(
        client,
        {
          organizationId: task.organizationId,
          projectId: task.projectId,
          taskId: task.id,
          runnerId: identity.runnerId,
          storageDirectory: serverConfig.storageDirectory,
          limits,
        },
        uploadId,
        body.digest
      )
      await appendDelegationEvent(client, task, 'artifact.stored', {
        artifactId: artifact.id,
        kind: artifact.kind,
        name: artifact.name,
        sizeBytes: artifact.sizeBytes,
      })
      return artifact
    })
  })

  app.post(root + '/inspections/claim', { config }, async (request) => {
    const identity = chatRunnerIdentity(request)
    return runnerTransaction(pool, identity, (client) =>
      claimInspection(client, { organizationId: identity.organizationId, runnerId: identity.runnerId })
    )
  })

  app.post(root + '/inspections/:inspectionId/complete', { config }, async (request) => {
    const identity = chatRunnerIdentity(request)
    const { inspectionId } = z.object({ inspectionId: z.string().uuid() }).parse(request.params)
    const body = inspectionCompletionSchema.parse(request.body)
    return runnerTransaction(pool, identity, (client) =>
      completeInspection(client, {
        organizationId: identity.organizationId,
        runnerId: identity.runnerId,
        inspectionId,
        body,
      })
    )
  })

  app.post(root + '/inventory', { config }, async (request) => {
    const identity = chatRunnerIdentity(request)
    const catalog = delegationModelCatalogSchema.parse(request.body)
    return runnerTransaction(pool, identity, async (client) => {
      await publishDelegationCatalog(client, {
        organizationId: identity.organizationId,
        runnerId: identity.runnerId,
        catalog,
      })
      return { ok: true }
    })
  })

  /**
   * Claim the next queued stage for this executor. The claim is only offered when the executor still
   * advertises `delegation:stages:v1`; it leases the underlying chat turn so renew, controls, events and
   * completion reuse the existing machine routes.
   */
  app.post(root + '/claim', { config }, async (request): Promise<ProjectChatClaim | null> => {
    const identity = chatRunnerIdentity(request)
    return runnerTransaction(pool, identity, async (client) => {
      const runner = await client.query(
        "select * from runners where organization_id=$1 and id=$2 and status<>'revoked' for update",
        [identity.organizationId, identity.runnerId]
      )
      const row = runner.rows[0]
      if (!row || (row.owner_user_id && !row.personal_enabled)) return null
      const catalog = delegationModelCatalogSchema.safeParse(row.delegation_capabilities)
      if (!catalog.success || !catalog.data.enabled) return null

      const attempts = await client.query(
        `select a.* from delegation_attempts a
         join delegation_tasks t on t.id = a.task_id
         where a.organization_id=$1 and t.executor_id=$2 and a.state='queued'
           and t.state in ('queued','running','waiting_review')
         order by a.created_at for update skip locked limit 1`,
        [identity.organizationId, identity.runnerId]
      )
      if (!attempts.rows[0]) return null
      const attempt = mapAttempt(attempts.rows[0])
      if (!attempt.turnId || !attempt.sessionId) delegationFail('The attempt has no execution turn.', 409)

      const sessionRow = await client.query('select * from chat_sessions where id=$1 for update', [attempt.sessionId])
      const session = mapSession(sessionRow.rows[0]!)
      const turnRow = await client.query("select * from chat_turns where id=$1 and state='queued' for update", [
        attempt.turnId,
      ])
      if (!turnRow.rows[0]) return null
      const leaseId = randomUUID()
      const token = randomBytes(32).toString('base64url')
      const turn = mapTurn(
        (
          await client.query(
            "update chat_turns set state='running', lease_id=$2, lease_expires_at=now()+interval '60 seconds', attempt=attempt+1 where id=$1 returning *",
            [attempt.turnId, leaseId]
          )
        ).rows[0]
      )
      await client.query(
        "insert into chat_turn_tokens(organization_id,project_id,session_id,turn_id,token_hash,lease_id,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '60 seconds')",
        [session.organizationId, session.projectId, session.id, turn.id, tokenHash(token), leaseId]
      )
      await appendChatEvent(client, session, { type: 'turn', turn }, 'claimed-' + turn.id, turn.id)
      await client.query("update delegation_attempts set state='running', started_at=now() where id=$1", [attempt.id])
      await client.query("update delegation_stages set state='running', version=version+1 where id=$1", [
        attempt.stageId,
      ])
      const task = await loadTaskRow(
        client,
        { organizationId: session.organizationId, projectId: session.projectId },
        attempt.taskId
      )
      await appendDelegationEvent(client, task, 'stage.started', {
        stageId: attempt.stageId,
        attemptId: attempt.id,
        attempt: attempt.attempt,
      })
      const message = mapMessage(
        (await client.query('select * from chat_messages where id=$1', [turn.messageId])).rows[0]
      )
      return {
        session,
        turn,
        message,
        token,
        delegation: {
          taskId: task.id,
          stageId: attempt.stageId,
          attemptId: attempt.id,
          attempt: attempt.attempt,
          stageType: attempt.snapshot.stageType,
          snapshot: attempt.snapshot as unknown as Record<string, unknown>,
          catalogRevision: attempt.snapshot.catalogRevision,
          workspaceKey: task.workspaceKey,
          baseBranch: task.baseBranch,
          repositoryBindingId: task.repositoryBindingId,
          cardId: task.cardId,
          boardId: task.boardId,
        },
      }
    })
  })

  /** Record what the runtime actually did. The receipt is required before a stage counts as succeeded. */
  app.post(root + '/attempts/:attemptId/receipt', { config }, async (request) => {
    const identity = chatRunnerIdentity(request)
    const { attemptId } = z.object({ attemptId: z.string().uuid() }).parse(request.params)
    const body = z
      .object({
        leaseId: z.string().uuid(),
        receipt: stageExecutionReceiptSchema,
        /** Revision this stage produced or read; reviews and checks are bound to it. */
        codeRevision: codeRevisionSchema.optional(),
        /** Structured verdict for a review stage. */
        review: reviewResultSchema.optional(),
      })
      .strict()
      .parse(request.body)
    return runnerTransaction(pool, identity, async (client) => {
      const rows = await client.query(
        `select a.* from delegation_attempts a
         join delegation_tasks t on t.id = a.task_id
         join chat_turns c on c.id = a.turn_id
         where a.organization_id=$1 and a.id=$2 and t.executor_id=$3 and c.lease_id=$4 for update`,
        [identity.organizationId, attemptId, identity.runnerId, body.leaseId]
      )
      if (!rows.rows[0]) delegationFail('The attempt does not belong to this lease.', 409)
      const attempt = mapAttempt(rows.rows[0])
      await client.query('update delegation_attempts set receipt=$2, code_revision=coalesce($3, code_revision) where id=$1', [
        attempt.id,
        body.receipt,
        body.codeRevision ?? null,
      ])
      const task = await loadTaskRow(
        client,
        { organizationId: identity.organizationId, projectId: String(rows.rows[0].project_id) },
        attempt.taskId
      )
      if (body.review) {
        const revision = body.codeRevision ?? attempt.codeRevision
        if (!revision)
          delegationFail('A review verdict requires the revision it reviewed.', 409, 'EVIDENCE_STALE')
        await recordReviewResult(client, {
          task,
          stageId: attempt.stageId,
          attemptId: attempt.id,
          reviewedRevision: revision,
          result: body.review,
        })
      }
      await appendDelegationEvent(client, task, 'stage.receipt', {
        stageId: attempt.stageId,
        attemptId: attempt.id,
        result: body.receipt.result,
        selectionHonored: body.receipt.selectionHonored,
        tokensObserved: body.receipt.tokensObserved,
        blocker: body.receipt.blocker,
        codeRevisionDigest: body.codeRevision?.contentDigest ?? attempt.codeRevision?.contentDigest ?? null,
      })
      return { ok: true }
    })
  })
}
