import { createHash, randomBytes } from 'node:crypto'
import { PROTOCOL_VERSION, executionEnvelopeSchema, type ExecutionEnvelope, type RunnerAutomationCapabilities } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'

const secretHash = (secret: string) => createHash('sha256').update(secret).digest()

interface ClaimRow {
  id: string; organization_id: string; project_id: string; board_id: string; card_id: string; source_event_id: string;
  policy_version: string; snapshot: ExecutionEnvelope['snapshot']; requested_by_user_id: string; execution_profile_id: string
}

export interface ClaimedJob {
  envelope: ExecutionEnvelope
  executionToken: string
}

export async function claimJob(
  pool: DatabasePool,
  input: { organizationId: string; runnerId: string; credential: string; protocolVersion: string; automationCapabilities?:RunnerAutomationCapabilities; repositories?: Array<{bindingId:string;available:boolean;branches:string[];error?:string}> },
): Promise<ClaimedJob | null> {
  if (input.protocolVersion !== PROTOCOL_VERSION) throw new Error('Runner protocol is incompatible.')
  return inTenantTransaction(pool, {
    organizationId: input.organizationId, actor: { type: 'runner', runnerId: input.runnerId },
  }, async (client) => {
    const runnerResult = await client.query<{ max_concurrency: string;owner_user_id:string|null;personal_enabled:boolean }>(`
      select r.max_concurrency,r.owner_user_id,r.personal_enabled from runners r
      join runner_credentials rc on rc.organization_id = r.organization_id and rc.runner_id = r.id
      where r.organization_id = $1 and r.id = $2 and r.status <> 'revoked'
        and rc.secret_hash = $3 and rc.revoked_at is null and (rc.expires_at is null or rc.expires_at > now())
      for update of r
    `, [input.organizationId, input.runnerId, secretHash(input.credential)])
    const runner = runnerResult.rows[0]
    if (!runner) throw new Error('Runner credential is invalid or revoked.')
    if(runner.owner_user_id&&!runner.personal_enabled)return null
    const inventory=input.repositories ?? []
    await client.query("update runners set repositories=$2,repositories_seen_at=now(),last_seen_at=now(),status='online' where id=$1",[input.runnerId,JSON.stringify(inventory)])
    if(input.automationCapabilities) await client.query('update runners set automation_capabilities=$2,automation_seen_at=now() where id=$1',[input.runnerId,input.automationCapabilities])
    const active = await client.query<{ count: string }>(`
      select ((select count(*) from runs where runner_id = $1 and state in ('claimed', 'running', 'cancelling'))
        + (select count(*) from chat_turns where runner_id=$1 and state in ('running','waiting_input','cancelling')))::text as count
    `, [input.runnerId])
    if (Number(active.rows[0]!.count) >= Number(runner.max_concurrency)) return null

    const candidate = await client.query<ClaimRow>(`
      select j.*, p.execution_profile_id
      from jobs j
      join execution_policies p on p.id = j.policy_id and p.organization_id = j.organization_id and p.project_id = j.project_id
      join runner_project_bindings rb on rb.organization_id = j.organization_id and rb.project_id = j.project_id and rb.runner_id = $2
      join runners r on r.organization_id = j.organization_id and r.id = $2
      where j.organization_id = $1 and j.state = 'queued' and p.enabled = true
        and r.protocol_version = $3
        and (j.snapshot->>'automationVersion'='1' or r.capabilities @> p.required_capabilities)
        and (
          (r.owner_user_id is null and j.snapshot->'personalDevice' is null)
          or (r.owner_user_id is not null and r.personal_enabled and j.snapshot->'personalDevice'->>'deviceId'=r.id::text
            and j.snapshot->'personalDevice'->>'ownerUserId'=r.owner_user_id and j.requested_by_user_id=r.owner_user_id
            and exists(select 1 from organization_members om left join project_members pm on pm.organization_id=om.organization_id and pm.user_id=om.user_id and pm.project_id=j.project_id
              where om.organization_id=j.organization_id and om.user_id=r.owner_user_id and (om.role in ('owner','admin') or pm.role in ('contributor','maintainer'))))
        )
        and (j.snapshot->>'targetRunnerId' is null or j.snapshot->>'targetRunnerId'=r.id::text)
        and (j.snapshot->>'automationVersion' is null or (
          r.automation_capabilities->>'version'='1' and exists(
            select 1 from jsonb_array_elements(r.automation_capabilities->'models') m
            where m->>'provider'=j.snapshot->>'provider' and m->>'model'=j.snapshot->>'model'
              and (j.snapshot->>'effort' is null or j.snapshot->>'effort'='off' or (m->'efforts') ? (j.snapshot->>'effort'))
              and (coalesce(j.snapshot->>'fastMode','false')='false' or m->>'fastMode'='true')
              and (j.snapshot->>'fastServiceTier' is null or m->>'fastServiceTier'=j.snapshot->>'fastServiceTier')
          )
          and (j.snapshot->'automation'->>'mode'<>'maestro' or r.automation_capabilities->>'maestro'='true')
          and (j.snapshot->'automation'->>'subagentsEnabled'<>'true' or r.automation_capabilities->>'subagents'='true')
          and (jsonb_array_length(j.snapshot->'automation'->'preCommands')=0 or r.automation_capabilities->>'preCommands'='true')
        ))
        and exists(select 1 from cards c join boards b on b.id=c.board_id where c.id=j.card_id and c.deleted_at is null and c.archived_at is null and b.archived_at is null)
        and (j.snapshot->>'repositoryBindingId' is null or (
          exists(select 1 from repository_bindings repo where repo.id=(j.snapshot->>'repositoryBindingId')::uuid and repo.project_id=j.project_id and repo.disabled_at is null)
          and exists(select 1 from jsonb_array_elements(r.repositories) available
            where available->>'bindingId'=j.snapshot->>'repositoryBindingId' and available->>'available'='true'
              and (available->'branches') ? (j.snapshot->>'repositoryBranch'))
        ))
        and not exists (
          select 1 from runs conflicting
          join jobs conflicting_job on conflicting_job.id = conflicting.job_id
          where conflicting_job.card_id = j.card_id and conflicting.state in ('claimed', 'running', 'cancelling')
        )
      order by j.created_at, j.id
      for update of j skip locked
      limit 1
    `, [input.organizationId, input.runnerId, input.protocolVersion])
    const job = candidate.rows[0]
    if (!job) return null
    const attempt = await client.query<{ attempt: string }>('select (coalesce(max(attempt), 0) + 1)::text as attempt from runs where job_id = $1', [job.id])
    const leaseId = crypto.randomUUID()
    const run = await client.query<{ id: string; lease_expires_at: Date }>(`
      insert into runs(organization_id, project_id, job_id, runner_id, attempt, state, lease_id, lease_expires_at)
      values ($1,$2,$3,$4,$5,'claimed',$6,now() + interval '60 seconds') returning id, lease_expires_at
    `, [job.organization_id, job.project_id, job.id, input.runnerId, Number(attempt.rows[0]!.attempt), leaseId])
    await client.query("update jobs set state = 'active', updated_at = now() where id = $1", [job.id])
    const executionToken = randomBytes(32).toString('base64url')
    await client.query(`
      insert into execution_tokens(
        organization_id, project_id, board_id, card_id, run_id, token_hash, allowed_operations, expires_at
      ) values ($1,$2,$3,$4,$5,$6,$7,now() + interval '24 hours')
    `, [
      job.organization_id, job.project_id, job.board_id, job.card_id, run.rows[0]!.id, secretHash(executionToken),
      JSON.stringify(['board:read', 'card:assigned:write', 'comment:create', 'subtask:create', 'artifact:create']),
    ])
    await client.query("update runners set status = 'online', last_seen_at = now() where id = $1", [input.runnerId])
    return {
      envelope: executionEnvelopeSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        organizationId: job.organization_id, projectId: job.project_id, boardId: job.board_id, cardId: job.card_id,
        jobId: job.id, runId: run.rows[0]!.id, attempt: Number(attempt.rows[0]!.attempt), leaseId,
        leaseExpiresAt: run.rows[0]!.lease_expires_at.toISOString(), sourceEventId: job.source_event_id,
        cardVersion: job.snapshot.sourceCardVersion ?? await currentCardVersion(client, job.card_id), policyVersion: Number(job.policy_version),
        executionProfileId: job.execution_profile_id, snapshot: job.snapshot,
      }),
      executionToken,
    }
  })
}

async function currentCardVersion(client: import('../../db/pool.js').DatabaseClient, cardId: string): Promise<number> {
  const result = await client.query<{ version: string }>('select version from cards where id = $1', [cardId])
  return Number(result.rows[0]!.version)
}
