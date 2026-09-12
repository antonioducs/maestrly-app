import type { Artifact, RunState } from '@maestrly/protocol'
import { isDeepStrictEqual } from 'node:util'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { appendDomainEvent } from '../events/store.js'

export interface CompletionArtifact {
  kind: Artifact['kind']
  name: string
  contentType: string
  sizeBytes: number
  digest: string
  storageKey: string
}

export interface RunCompletion {
  state: Extract<RunState, 'succeeded' | 'failed' | 'cancelled' | 'needs_input'>
  summary?: string
  failure?: string
  question?: string
  artifacts?: CompletionArtifact[]
}

export class LateCompletionError extends Error {
  readonly statusCode = 409
  constructor() {
    super('Completion was rejected because the lease is no longer the active authorization.')
    this.name = 'LateCompletionError'
  }
}

const jobStateFor = (state: RunCompletion['state']) => {
  if (state === 'succeeded') return 'completed'
  if (state === 'needs_input') return 'waiting_input'
  if (state === 'cancelled') return 'cancelled'
  return 'needs_attention'
}

export async function completeRun(
  pool: DatabasePool,
  input: {
    organizationId: string; runnerId: string; runId: string; leaseId: string; completion: RunCompletion
  },
): Promise<{ repeated: boolean }> {
  const decision = await inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'runner', runnerId: input.runnerId } }, async (client) => {
    const result = await client.query<{ job_id: string; project_id: string }>(`
      update runs set state = $5, outcome = $6, finished_at = now()
      where organization_id = $1 and id = $2 and runner_id = $3 and lease_id = $4
        and (state in ('claimed', 'running') or (state = 'cancelling' and $5 = 'cancelled')) and lease_expires_at > now()
      returning job_id, project_id
    `, [input.organizationId, input.runId, input.runnerId, input.leaseId, input.completion.state, input.completion])
    const run = result.rows[0]
    if (!run) {
      const existing = await client.query<{ state: string; lease_id: string; outcome: RunCompletion | null; project_id: string; job_id: string }>(
        'select state, lease_id, outcome, project_id, job_id from runs where organization_id = $1 and id = $2',
        [input.organizationId, input.runId],
      )
      const row = existing.rows[0]
      if (row?.lease_id === input.leaseId && row.state === input.completion.state && isDeepStrictEqual(row.outcome, input.completion)) {
        return { kind: 'repeated' as const }
      }
      if (row) {
        await storeArtifacts(client, input.organizationId, row.project_id, input.runId, input.completion.artifacts ?? [], true)
        if (row.state === 'cancelling') {
          await client.query("update runs set state = 'cancelled', finished_at = now() where id = $1", [input.runId])
          await client.query("update jobs set state = 'cancelled', updated_at = now() where id = $1", [row.job_id])
          await client.query('update execution_tokens set revoked_at = now() where run_id = $1 and revoked_at is null', [input.runId])
        }
      }
      return { kind: 'rejected' as const }
    }

    await storeArtifacts(client, input.organizationId, run.project_id, input.runId, input.completion.artifacts ?? [], false)
    await client.query('update jobs set state = $2, updated_at = now() where id = $1', [run.job_id, jobStateFor(input.completion.state)])
    await client.query('update execution_tokens set revoked_at = now() where run_id = $1 and revoked_at is null', [input.runId])
    if (input.completion.state === 'needs_input' && input.completion.question) {
      await client.query(`
        insert into information_requests(organization_id, project_id, job_id, run_id, question)
        values ($1,$2,$3,$4,$5)
      `, [input.organizationId, run.project_id, run.job_id, input.runId, input.completion.question])
    }
    await appendDomainEvent(client, {
      organizationId: input.organizationId, projectId: run.project_id, type: `run.${input.completion.state}`,
      aggregateType: 'run', aggregateId: input.runId, actor: { type: 'runner', runnerId: input.runnerId },
      data: { jobId: run.job_id, summary: input.completion.summary ?? null },
    })
    return { kind: 'accepted' as const }
  })
  if (decision.kind === 'rejected') throw new LateCompletionError()
  return { repeated: decision.kind === 'repeated' }
}

async function storeArtifacts(
  client: import('../../db/pool.js').DatabaseClient,
  organizationId: string,
  projectId: string,
  runId: string,
  artifacts: CompletionArtifact[],
  orphaned: boolean,
): Promise<void> {
  for (const artifact of artifacts) {
    await client.query(`
      insert into artifacts(organization_id, project_id, run_id, kind, name, content_type, storage_key, size_bytes, digest, orphaned)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (storage_key) do update set
        orphaned = artifacts.orphaned or excluded.orphaned,
        kind = case when excluded.orphaned then 'orphaned_evidence' else artifacts.kind end
    `, [
      organizationId, projectId, runId, orphaned ? 'orphaned_evidence' : artifact.kind, artifact.name,
      artifact.contentType, artifact.storageKey, artifact.sizeBytes, artifact.digest, orphaned,
    ])
  }
}
