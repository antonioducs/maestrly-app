import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { appendDomainEvent } from '../events/store.js'

export async function renewLease(
  pool: DatabasePool,
  input: { organizationId: string; runnerId: string; runId: string; leaseId: string },
): Promise<{ leaseExpiresAt: string; cancellationRequested: boolean }> {
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'runner', runnerId: input.runnerId } }, async (client) => {
    // An existing lease does not preserve a user's permissions after revocation.
    await client.query(`update runs run set state='cancelling' from runners r, jobs j
      where run.id=$1 and run.runner_id=$2 and run.job_id=j.id and r.id=run.runner_id and r.owner_user_id is not null
      and run.state in ('claimed','running') and (not r.personal_enabled or r.status='revoked' or not exists(
        select 1 from organization_members om left join project_members pm on pm.organization_id=om.organization_id and pm.user_id=om.user_id and pm.project_id=j.project_id
        where om.organization_id=j.organization_id and om.user_id=r.owner_user_id and (om.role in ('owner','admin') or pm.role in ('maintainer','contributor'))))`,[input.runId,input.runnerId])
    const result = await client.query<{ lease_expires_at: Date; state: string }>(`
      update runs set lease_expires_at = now() + interval '60 seconds',
        state = case when state = 'claimed' then 'running' else state end,
        started_at = coalesce(started_at, now())
      where organization_id = $1 and id = $2 and runner_id = $3 and lease_id = $4
        and state in ('claimed', 'running', 'cancelling') and lease_expires_at > now()
      returning lease_expires_at, state
    `, [input.organizationId, input.runId, input.runnerId, input.leaseId])
    const run = result.rows[0]
    if (!run) throw new Error('Lease is expired, replaced, or does not belong to this runner.')
    await client.query("update runners set last_seen_at=now(),status='online' where id=$1 and status <> 'revoked'",[input.runnerId])
    return { leaseExpiresAt: run.lease_expires_at.toISOString(), cancellationRequested: run.state === 'cancelling' }
  })
}

export async function appendExecutionEvent(
  pool: DatabasePool,
  input: { organizationId: string; runnerId: string; runId: string; leaseId: string; eventId: string; type: string; data: Record<string, unknown> },
): Promise<void> {
  await inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'runner', runnerId: input.runnerId } }, async (client) => {
    const run = await client.query<{ project_id: string }>(`
      select project_id from runs where organization_id = $1 and id = $2 and runner_id = $3 and lease_id = $4
        and state in ('claimed', 'running', 'cancelling') and lease_expires_at > now()
    `, [input.organizationId, input.runId, input.runnerId, input.leaseId])
    if (!run.rows[0]) throw new Error('Event does not belong to the active lease.')
    await client.query(`
      insert into execution_events(organization_id, project_id, run_id, lease_id, client_event_id, type, data)
      values ($1,$2,$3,$4,$5,$6,$7) on conflict (run_id, client_event_id) do nothing
    `, [input.organizationId, run.rows[0].project_id, input.runId, input.leaseId, input.eventId, input.type, input.data])
  })
}

export async function answerInformationRequest(
  pool: DatabasePool,
  input: { organizationId: string; projectId: string; requestId: string; userId: string; response: string },
): Promise<void> {
  await inTenantTransaction(pool, { organizationId: input.organizationId, projectId: input.projectId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    await authorizeProject(client, input.organizationId, input.projectId, input.userId, 'execution:request')
    const request = await client.query<{ job_id: string; run_id: string; question: string }>(`
      update information_requests set response = $4, responded_at = now()
      where organization_id = $1 and project_id = $2 and id = $3 and response is null
        and exists(select 1 from jobs where id = information_requests.job_id and state = 'waiting_input')
      returning job_id, run_id, question
    `, [input.organizationId, input.projectId, input.requestId, input.response])
    const row = request.rows[0]
    if (!row) throw Object.assign(new Error('Information request is no longer awaiting a response.'), { statusCode: 409 })
    await client.query(`
      update jobs set state = 'queued', updated_at = now(), snapshot = snapshot || jsonb_build_object(
        'continuation', jsonb_build_object('priorRunId', $2::text, 'question', $3::text, 'response', $4::text)
      ) where id = $1 and state = 'waiting_input'
    `, [row.job_id, row.run_id, row.question, input.response])
    await appendDomainEvent(client, {
      organizationId: input.organizationId, projectId: input.projectId, type: 'information_request.answered',
      aggregateType: 'job', aggregateId: row.job_id, actor: { type: 'human', userId: input.userId }, data: { requestId: input.requestId },
    })
  })
}
