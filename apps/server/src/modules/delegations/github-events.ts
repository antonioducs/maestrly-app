/**
 * External events that wake a task.
 *
 * Ingestion is idempotent by the source's own identifier, so a duplicate delivery is recognized instead of
 * acted on twice. An event about an older head is recorded and marked superseded: it never produces a fix on a
 * revision it did not observe. Third-party content (a review body, a check name) is data only.
 */
import { createHmac } from 'node:crypto'
import { delegationSourceEventSchema, type DelegationSourceEvent, type DelegationTask } from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { appendDelegationEvent, delegationFail, loadTaskRow } from './repository.js'
import { pullRequestFacts } from './pull-requests.js'
import { secretsMatch } from '../connectors/secrets.js'

export interface IngestResult {
  eventId: string
  state: 'received' | 'applied' | 'ignored' | 'superseded'
  reason: string | null
}

/**
 * Verify a GitHub webhook signature over the raw body. A body that was re-serialized cannot be verified, so the
 * caller must keep the exact bytes.
 */
export function verifyGitHubSignature(input: { rawBody: Buffer; signature: string | undefined; secret: string }): boolean {
  if (!input.signature?.startsWith('sha256=')) return false
  const expected = 'sha256=' + createHmac('sha256', input.secret).update(input.rawBody).digest('hex')
  return secretsMatch(input.signature, expected)
}

/**
 * Record one normalized event for a task. Returns the stored state so the caller can tell a fresh event from a
 * duplicate without inspecting the table.
 */
export async function ingestSourceEvent(
  client: DatabaseClient,
  input: { task: DelegationTask; subscriptionId: string | null; event: unknown }
): Promise<IngestResult> {
  const event: DelegationSourceEvent = delegationSourceEventSchema.parse(input.event)
  const existing = await client.query<{ id: string; state: string; reason: string | null }>(
    'select id, state, reason from delegation_source_events where organization_id=$1 and source=$2 and external_id=$3',
    [input.task.organizationId, event.source, event.externalId]
  )
  if (existing.rows[0])
    return {
      eventId: existing.rows[0].id,
      state: existing.rows[0].state as IngestResult['state'],
      reason: existing.rows[0].reason ?? 'This delivery was already recorded.',
    }

  // An event about a head the task no longer has is kept for the record but cannot drive a reaction.
  const facts = await pullRequestFacts(client, input.task.id)
  const superseded =
    event.headSha && facts?.headSha && event.headSha !== facts.headSha
      ? `The event describes head ${event.headSha.slice(0, 12)} while the pull request is at ${facts.headSha.slice(0, 12)}.`
      : null
  const inserted = await client.query<{ id: string }>(
    `insert into delegation_source_events(
       organization_id, project_id, task_id, subscription_id, source, external_id, type, pull_request_number,
       head_sha, payload, state, reason, occurred_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [
      input.task.organizationId,
      input.task.projectId,
      input.task.id,
      input.subscriptionId,
      event.source,
      event.externalId,
      event.type,
      event.pullRequestNumber,
      event.headSha,
      event.payload,
      superseded ? 'superseded' : 'received',
      superseded,
      event.occurredAt,
    ]
  )
  await appendDelegationEvent(client, input.task, 'source_event.received', {
    eventId: inserted.rows[0]!.id,
    source: event.source,
    type: event.type,
    headSha: event.headSha,
    superseded: !!superseded,
  })
  return {
    eventId: inserted.rows[0]!.id,
    state: superseded ? 'superseded' : 'received',
    reason: superseded,
  }
}

export interface PendingSourceEvent {
  id: string
  taskId: string
  projectId: string
  source: DelegationSourceEvent['source']
  type: string
  headSha: string | null
  pullRequestNumber: number | null
  subscriptionId: string | null
  payload: Record<string, unknown>
}

/**
 * Pending events, coalesced per task and pull request so a burst of check updates wakes an agent once.
 */
export async function pendingSourceEvents(
  client: DatabaseClient,
  organizationId: string
): Promise<PendingSourceEvent[]> {
  const rows = await client.query(
    `select distinct on (task_id, coalesce(pull_request_number, 0))
       id, task_id, project_id, source, type, head_sha, pull_request_number, subscription_id, payload
     from delegation_source_events
     where organization_id=$1 and state='received'
     order by task_id, coalesce(pull_request_number, 0), occurred_at desc, created_at desc`,
    [organizationId]
  )
  return rows.rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    source: row.source,
    type: row.type,
    headSha: row.head_sha ?? null,
    pullRequestNumber: row.pull_request_number === null ? null : Number(row.pull_request_number),
    subscriptionId: row.subscription_id ?? null,
    payload: row.payload,
  }))
}

export async function settleSourceEvent(
  client: DatabaseClient,
  input: { organizationId: string; eventId: string; state: 'applied' | 'ignored' | 'superseded'; reason?: string }
): Promise<void> {
  await client.query(
    `update delegation_source_events set state=$3, reason=$4, applied_at=now()
     where organization_id=$1 and id=$2 and state='received'`,
    [input.organizationId, input.eventId, input.state, input.reason ?? null]
  )
}

/** Mark every earlier pending event for the same pull request as superseded by the one being applied. */
export async function supersedeOlderEvents(
  client: DatabaseClient,
  input: { organizationId: string; taskId: string; pullRequestNumber: number | null; keepEventId: string }
): Promise<number> {
  const rows = await client.query(
    `update delegation_source_events set state='superseded', reason='A newer event for the same pull request was applied.',
       applied_at=now()
     where organization_id=$1 and task_id=$2 and state='received' and id <> $4
       and coalesce(pull_request_number, 0) = coalesce($3, 0)
     returning id`,
    [input.organizationId, input.taskId, input.pullRequestNumber, input.keepEventId]
  )
  return rows.rowCount ?? 0
}

/** Public entry point used by the webhook route; resolves the task from the repository binding and branch. */
export async function ingestForRepository(
  pool: DatabasePool,
  input: {
    organizationId: string
    repository: string
    branch: string
    event: unknown
  }
): Promise<IngestResult> {
  return inTenantTransaction(
    pool,
    { organizationId: input.organizationId, actor: { type: 'system', service: 'delegation-scheduler' } },
    async (client) => {
      const rows = await client.query<{ task_id: string; project_id: string }>(
        `select p.task_id, p.project_id from delegation_pull_requests p
         where p.organization_id=$1 and p.branch=$2
         order by p.updated_at desc limit 1`,
        [input.organizationId, input.branch]
      )
      const found = rows.rows[0]
      if (!found) delegationFail('No delegation task is following that branch.', 404)
      const task = await loadTaskRow(
        client,
        { organizationId: input.organizationId, projectId: found.project_id },
        found.task_id
      )
      return ingestSourceEvent(client, { task, subscriptionId: null, event: input.event })
    }
  )
}
