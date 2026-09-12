import { createHash, randomBytes } from 'node:crypto'
import type { Capability } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'

const hash = (value: string) => createHash('sha256').update(value).digest()

export async function createRunnerEnrollment(
  pool: DatabasePool,
  input: { organizationId: string; projectIds: string[]; userId: string; expiresInMinutes?: number },
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + Math.min(input.expiresInMinutes ?? 15, 60) * 60_000)
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    for (const projectId of input.projectIds) {
      await authorizeProject(client, input.organizationId, projectId, input.userId, 'runner:manage')
    }
    await client.query(`
      insert into runner_enrollments(organization_id, token_hash, project_ids, expires_at, created_by_user_id)
      values ($1,$2,$3,$4,$5)
    `, [input.organizationId, hash(token), JSON.stringify(input.projectIds), expiresAt, input.userId])
    return { token, expiresAt: expiresAt.toISOString() }
  })
}

export async function enrollRunner(
  pool: DatabasePool,
  input: { organizationId: string; token: string; name: string; protocolVersion: string; capabilities: Capability[]; maxConcurrency: number },
): Promise<{ runnerId: string; credential: string }> {
  const credential = randomBytes(32).toString('base64url')
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'system', service: 'runner-enrollment' } }, async (client) => {
    const enrollment = await client.query<{ project_ids: string[] }>(`
      update runner_enrollments set used_at = now()
      where organization_id = $1 and token_hash = $2 and used_at is null and expires_at > now()
      returning project_ids
    `, [input.organizationId, hash(input.token)])
    const row = enrollment.rows[0]
    if (!row) throw new Error('Runner enrollment is invalid, expired, or already used.')
    const runner = await client.query<{ id: string }>(`
      insert into runners(organization_id, name, protocol_version, capabilities, max_concurrency)
      values ($1,$2,$3,$4,$5) returning id
    `, [input.organizationId, input.name, input.protocolVersion, JSON.stringify(input.capabilities), input.maxConcurrency])
    const runnerId = runner.rows[0]!.id
    for (const projectId of row.project_ids) {
      await client.query(`
        insert into runner_project_bindings(organization_id, project_id, runner_id, created_by_user_id)
        select $1,$2,$3,created_by_user_id from runner_enrollments where organization_id = $1 and token_hash = $4
      `, [input.organizationId, projectId, runnerId, hash(input.token)])
    }
    await client.query(`
      insert into runner_credentials(organization_id, runner_id, secret_hash) values ($1,$2,$3)
    `, [input.organizationId, runnerId, hash(credential)])
    return { runnerId, credential }
  })
}

export async function revokeRunner(
  pool: DatabasePool,
  input: { organizationId: string; projectId: string; runnerId: string; userId: string },
): Promise<void> {
  await inTenantTransaction(pool, {
    organizationId: input.organizationId, projectId: input.projectId, actor: { type: 'human', userId: input.userId },
  }, async (client) => {
    await authorizeProject(client, input.organizationId, input.projectId, input.userId, 'runner:manage')
    const target=await client.query('select id from runners where organization_id=$1 and id=$2 and owner_user_id is null and exists(select 1 from runner_project_bindings b where b.runner_id=runners.id and b.project_id=$3) for update',[input.organizationId,input.runnerId,input.projectId])
    if(!target.rowCount)throw Object.assign(new Error('Shared runner not found.'),{statusCode:404})
    await client.query("update runners set status = 'revoked' where organization_id = $1 and id = $2", [input.organizationId, input.runnerId])
    await client.query('update runner_credentials set revoked_at = now() where organization_id = $1 and runner_id = $2 and revoked_at is null', [input.organizationId, input.runnerId])
    await client.query("update runs set state = 'cancelling' where organization_id = $1 and runner_id = $2 and state in ('claimed', 'running')", [input.organizationId, input.runnerId])
  })
}

export async function verifyRunnerCredential(
  pool: DatabasePool,
  input: { organizationId: string; runnerId: string; credential: string },
): Promise<boolean> {
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'runner', runnerId: input.runnerId } }, async (client) => {
    const result = await client.query<{ exists: boolean }>(`
      select exists(
        select 1 from runners r join runner_credentials rc on rc.organization_id = r.organization_id and rc.runner_id = r.id
        where r.organization_id = $1 and r.id = $2 and r.status <> 'revoked' and rc.secret_hash = $3
          and rc.revoked_at is null and (rc.expires_at is null or rc.expires_at > now())
      )
    `, [input.organizationId, input.runnerId, hash(input.credential)])
    return result.rows[0]?.exists === true
  })
}

export async function selfRevokeRunner(
  pool: DatabasePool,
  input: { organizationId: string; runnerId: string; credential: string },
): Promise<void> {
  if (!await verifyRunnerCredential(pool, input)) throw new Error('Runner credential is invalid or revoked.')
  await inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'runner', runnerId: input.runnerId } }, async (client) => {
    await client.query("update runners set status = 'revoked' where organization_id = $1 and id = $2", [input.organizationId, input.runnerId])
    await client.query('update runner_credentials set revoked_at = now() where organization_id = $1 and runner_id = $2', [input.organizationId, input.runnerId])
    await client.query("update runs set state = 'cancelling' where organization_id = $1 and runner_id = $2 and state in ('claimed', 'running')", [input.organizationId, input.runnerId])
  })
}

export async function listProjectRunners(
  pool: DatabasePool,
  input: { organizationId: string; projectId: string; userId: string },
) {
  return inTenantTransaction(pool, { organizationId: input.organizationId, projectId: input.projectId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    await authorizeProject(client, input.organizationId, input.projectId, input.userId, 'project:read')
    const result = await client.query(`
      select r.id, r.name, r.status, r.capabilities, r.automation_capabilities as "automationCapabilities", r.repositories,r.repositories_seen_at as "repositoriesSeenAt", r.last_seen_at as "lastSeenAt", r.max_concurrency as "maxConcurrency"
      from runners r join runner_project_bindings rb on rb.organization_id = r.organization_id and rb.runner_id = r.id
      where rb.organization_id = $1 and rb.project_id = $2 and r.owner_user_id is null order by r.name
    `, [input.organizationId, input.projectId])
    return result.rows
  })
}
