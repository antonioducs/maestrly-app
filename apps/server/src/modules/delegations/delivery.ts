/**
 * Delivery records. The intention is durable BEFORE any external effect happens, so a retry after a lost
 * response reconciles with what already exists instead of pushing or opening a pull request twice.
 */
import {
  deliveryModeSchema,
  type DelegationTask,
  type DeliveryMode,
} from '@maestrly/protocol'
import { z } from 'zod'
import type { DatabaseClient } from '../../db/pool.js'
import { appendDelegationEvent, delegationFail } from './repository.js'
import { recordPullRequestSnapshot, pullRequestSnapshotSchema } from './pull-requests.js'

export const deliveryStateSchema = z.enum(['intended', 'confirmed', 'failed', 'needs_attention'])

export const deliveryReceiptSchema = z
  .object({
    deliveryId: z.string().uuid(),
    mode: deliveryModeSchema,
    state: deliveryStateSchema,
    expectedRevision: z.string().min(16).max(191),
    commitSha: z.string().max(64).nullable().default(null),
    branch: z.string().max(250).nullable().default(null),
    pullRequestNumber: z.number().int().positive().nullable().default(null),
    pullRequestUrl: z.string().max(2000).nullable().default(null),
    /** GitHub account the executor actually acted as; recorded, never assumed. */
    observedAccount: z.string().max(191).nullable().default(null),
    error: z.string().max(4_000).nullable().default(null),
  })
  .strict()

export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>

/** Modes the task policy authorizes. A mode outside it is refused before any record is written. */
export function deliveryAuthorized(task: DelegationTask, mode: DeliveryMode): boolean {
  const autonomy = task.policy.autonomy
  return {
    patch: true,
    commit: autonomy.commit,
    push: autonomy.push,
    draft_pr: autonomy.openPullRequest,
    ready_pr: autonomy.openPullRequest,
    merge: autonomy.merge,
  }[mode]
}

export interface DeliveryIntention {
  deliveryId: string
  mode: DeliveryMode
  expectedRevision: string
  /** Set when a previous attempt already confirmed this exact delivery. */
  alreadyConfirmed: DeliveryReceipt | null
}

/**
 * Record the intention to deliver. A live intention for the same task and mode is reused, so a retry keeps one
 * identity for the external effect.
 */
export async function recordDeliveryIntention(
  client: DatabaseClient,
  input: { task: DelegationTask; attemptId: string | null; mode: DeliveryMode; expectedRevision: string }
): Promise<DeliveryIntention> {
  if (!deliveryAuthorized(input.task, input.mode))
    delegationFail(`The task policy does not authorize ${input.mode} delivery.`, 403)
  const confirmed = await client.query(
    `select * from delegation_deliveries
     where task_id=$1 and mode=$2 and expected_revision=$3 and state='confirmed'
     order by confirmed_at desc limit 1`,
    [input.task.id, input.mode, input.expectedRevision]
  )
  if (confirmed.rows[0]) {
    const row = confirmed.rows[0]
    return {
      deliveryId: row.id,
      mode: input.mode,
      expectedRevision: input.expectedRevision,
      alreadyConfirmed: deliveryReceiptSchema.parse({
        deliveryId: row.id,
        mode: row.mode,
        state: row.state,
        expectedRevision: row.expected_revision,
        commitSha: row.commit_sha,
        branch: row.branch,
        pullRequestNumber: row.pull_request_number === null ? null : Number(row.pull_request_number),
        pullRequestUrl: row.pull_request_url,
        observedAccount: row.observed_account,
        error: row.error,
      }),
    }
  }
  const existing = await client.query(
    "select * from delegation_deliveries where task_id=$1 and mode=$2 and state='intended' for update",
    [input.task.id, input.mode]
  )
  if (existing.rows[0]) {
    const row = existing.rows[0]
    if (row.expected_revision !== input.expectedRevision)
      // The pending intention targets another revision; that has to be resolved before a new one starts.
      delegationFail(
        'A delivery is already pending for another revision of this task. Reconcile it before retrying.',
        409,
        'EVIDENCE_STALE'
      )
    return {
      deliveryId: row.id,
      mode: input.mode,
      expectedRevision: input.expectedRevision,
      alreadyConfirmed: null,
    }
  }
  const inserted = await client.query<{ id: string }>(
    `insert into delegation_deliveries(organization_id, project_id, task_id, attempt_id, mode, expected_revision)
     values($1,$2,$3,$4,$5,$6) returning id`,
    [
      input.task.organizationId,
      input.task.projectId,
      input.task.id,
      input.attemptId,
      input.mode,
      input.expectedRevision,
    ]
  )
  await appendDelegationEvent(client, input.task, 'delivery.intended', {
    deliveryId: inserted.rows[0]!.id,
    mode: input.mode,
    expectedRevision: input.expectedRevision,
  })
  return {
    deliveryId: inserted.rows[0]!.id,
    mode: input.mode,
    expectedRevision: input.expectedRevision,
    alreadyConfirmed: null,
  }
}

export const deliveryConfirmationSchema = z
  .object({
    deliveryId: z.string().uuid(),
    state: z.enum(['confirmed', 'failed', 'needs_attention']),
    commitSha: z.string().max(64).nullable().default(null),
    branch: z.string().max(250).nullable().default(null),
    observedAccount: z.string().max(191).nullable().default(null),
    error: z.string().max(4_000).nullable().default(null),
    /** Present when the delivery produced or observed a pull request. */
    pullRequest: pullRequestSnapshotSchema.optional(),
  })
  .strict()

/** Confirm a delivery only from an external fact the executor observed after the effect. */
export async function confirmDelivery(
  client: DatabaseClient,
  input: { task: DelegationTask; body: z.infer<typeof deliveryConfirmationSchema> }
): Promise<DeliveryReceipt> {
  const rows = await client.query(
    'select * from delegation_deliveries where organization_id=$1 and task_id=$2 and id=$3 for update',
    [input.task.organizationId, input.task.id, input.body.deliveryId]
  )
  if (!rows.rows[0]) delegationFail('Delivery not found for this task.', 404)
  if (input.body.state === 'confirmed' && input.body.pullRequest)
    await recordPullRequestSnapshot(client, { task: input.task, snapshot: input.body.pullRequest })
  const updated = await client.query(
    `update delegation_deliveries set state=$2, commit_sha=$3, branch=$4, pull_request_number=$5,
       pull_request_url=$6, observed_account=$7, error=$8,
       confirmed_at = case when $2='confirmed' then now() else confirmed_at end, updated_at=now()
     where id=$1 returning *`,
    [
      input.body.deliveryId,
      input.body.state,
      input.body.commitSha,
      input.body.branch,
      input.body.pullRequest?.number ?? null,
      input.body.pullRequest?.url ?? null,
      input.body.observedAccount,
      input.body.error,
    ]
  )
  const row = updated.rows[0]!
  await appendDelegationEvent(client, input.task, 'delivery.settled', {
    deliveryId: row.id,
    mode: row.mode,
    state: row.state,
    commitSha: row.commit_sha,
    pullRequestNumber: row.pull_request_number === null ? null : Number(row.pull_request_number),
    observedAccount: row.observed_account,
    error: row.error,
  })
  return deliveryReceiptSchema.parse({
    deliveryId: row.id,
    mode: row.mode,
    state: row.state,
    expectedRevision: row.expected_revision,
    commitSha: row.commit_sha,
    branch: row.branch,
    pullRequestNumber: row.pull_request_number === null ? null : Number(row.pull_request_number),
    pullRequestUrl: row.pull_request_url,
    observedAccount: row.observed_account,
    error: row.error,
  })
}

/** Deliveries still pending an external confirmation, surfaced instead of retried silently. */
export async function unconfirmedDeliveries(client: DatabaseClient, taskId: string): Promise<DeliveryReceipt[]> {
  const rows = await client.query(
    "select * from delegation_deliveries where task_id=$1 and state='intended' order by created_at",
    [taskId]
  )
  return rows.rows.map((row) =>
    deliveryReceiptSchema.parse({
      deliveryId: row.id,
      mode: row.mode,
      state: row.state,
      expectedRevision: row.expected_revision,
      commitSha: row.commit_sha,
      branch: row.branch,
      pullRequestNumber: row.pull_request_number === null ? null : Number(row.pull_request_number),
      pullRequestUrl: row.pull_request_url,
      observedAccount: row.observed_account,
      error: row.error,
    })
  )
}
