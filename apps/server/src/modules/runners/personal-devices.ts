import { createHash, randomBytes } from 'node:crypto'
import { PROTOCOL_VERSION, runnerAutomationCapabilitiesSchema, type PersonalDevice } from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { fail } from '../kanban/service.js'

interface Scope {
  organizationId: string
  userId: string
}
const hash = (value: string) => createHash('sha256').update(value).digest()
export async function registerPersonalDevice(
  pool: DatabasePool,
  input: Scope & { projectIds: string[]; name: string; deviceId?: string }
) {
  return inTenantTransaction(
    pool,
    { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } },
    async (client) => {
      for (const id of [...new Set(input.projectIds)].sort())
        await authorizeProject(client, input.organizationId, id, input.userId, 'execution:request')
      let runnerId = input.deviceId,
        credential: string | undefined
      if (runnerId) {
        const device = await client.query(
          "select id from runners where organization_id=$1 and id=$2 and owner_user_id=$3 and status<>'revoked' for update",
          [input.organizationId, runnerId, input.userId]
        )
        if (!device.rowCount) fail('Personal device unavailable or owned by another user.', 403)
        await client.query(
          "update runners set name=$2,personal_enabled=true,status='offline',last_seen_at=null where id=$1",
          [runnerId, input.name]
        )
        // The locally approved binding set replaces previous grants. Removed projects cannot be claimed.
        await client.query(
          'delete from runner_project_bindings where runner_id=$1 and not (project_id=any($2::uuid[]))',
          [runnerId, input.projectIds]
        )
      } else {
        credential = randomBytes(32).toString('base64url')
        const row = await client.query<{ id: string }>(
          "insert into runners(organization_id,name,protocol_version,capabilities,max_concurrency,owner_user_id,personal_enabled) values($1,$2,$3,'[]',1,$4,true) returning id",
          [input.organizationId, input.name, PROTOCOL_VERSION, input.userId]
        )
        runnerId = row.rows[0]!.id
        await client.query('insert into runner_credentials(organization_id,runner_id,secret_hash) values($1,$2,$3)', [
          input.organizationId,
          runnerId,
          hash(credential),
        ])
      }
      for (const id of new Set(input.projectIds))
        await client.query(
          'insert into runner_project_bindings(organization_id,project_id,runner_id,created_by_user_id) values($1,$2,$3,$4) on conflict do nothing',
          [input.organizationId, id, runnerId, input.userId]
        )
      return { runnerId, ...(credential ? { credential } : {}), ownerUserId: input.userId }
    }
  )
}

export async function personalDeviceRows(
  client: DatabaseClient,
  organizationId: string,
  projectId: string,
  userId: string
) {
  const rows = await client.query(
    `select r.id,r.name,r.status,r.personal_enabled as enabled,r.last_seen_at as "lastSeenAt",r.repositories,r.automation_capabilities as capabilities
 from runners r join runner_project_bindings b on b.runner_id=r.id and b.organization_id=r.organization_id
 where r.organization_id=$1 and b.project_id=$2 and r.owner_user_id=$3 and r.status<>'revoked' order by r.name,r.id`,
    [organizationId, projectId, userId]
  )
  return rows.rows.map((row) => {
    const caps = runnerAutomationCapabilitiesSchema.safeParse(row.capabilities)
    return { ...row, capabilities: caps.success ? caps.data : null }
  })
}
export async function listPersonalDevices(
  pool: DatabasePool,
  input: Scope & { projectId: string }
): Promise<PersonalDevice[]> {
  return inTenantTransaction(pool, { ...input, actor: { type: 'human', userId: input.userId } }, async (client) => {
    await authorizeProject(client, input.organizationId, input.projectId, input.userId, 'project:read')
    return (await personalDeviceRows(client, input.organizationId, input.projectId, input.userId)).map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      online:
        row.enabled &&
        row.status === 'online' &&
        !!row.lastSeenAt &&
        Date.now() - new Date(row.lastSeenAt).getTime() < 60000,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      repositories: row.repositories ?? [],
      capabilities: row.capabilities,
    }))
  })
}
export async function requirePersonalDevice(
  client: DatabaseClient,
  input: Scope & { projectId: string; deviceId: string }
) {
  const row = (
    await client.query(
      `select r.id,r.name from runners r join runner_project_bindings b on b.runner_id=r.id and b.organization_id=r.organization_id
 where r.organization_id=$1 and b.project_id=$2 and r.id=$3 and r.owner_user_id=$4 and r.personal_enabled and r.status<>'revoked' for share of r`,
      [input.organizationId, input.projectId, input.deviceId, input.userId]
    )
  ).rows[0]
  if (!row) fail('Personal device unavailable or owned by another user.', 403)
  await authorizeProject(client, input.organizationId, input.projectId, input.userId, 'execution:request')
  return row as { id: string; name: string }
}
export async function disablePersonalDevice(pool: DatabasePool, input: Scope & { deviceId: string }) {
  return inTenantTransaction(
    pool,
    { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } },
    async (client) => {
      const row = await client.query(
        "update runners set personal_enabled=false,status='revoked',last_seen_at=null where organization_id=$1 and id=$2 and owner_user_id=$3 returning id",
        [input.organizationId, input.deviceId, input.userId]
      )
      if (!row.rowCount) fail('Personal device unavailable or owned by another user.', 403)
      await client.query('update runner_credentials set revoked_at=now() where runner_id=$1', [input.deviceId])
      await client.query("update runs set state='cancelling' where runner_id=$1 and state in ('claimed','running')", [
        input.deviceId,
      ])
      await client.query(
        "update jobs set state='cancelled',updated_at=now() where organization_id=$1 and snapshot->'personalDevice'->>'deviceId'=$2 and state in ('queued','waiting_approval','waiting_input','needs_attention')",
        [input.organizationId, input.deviceId]
      )
      await client.query(
        "update approvals set status='revoked',decided_at=now(),decided_by_user_id=$2 where status='pending' and job_id in(select id from jobs where organization_id=$1 and state='cancelled' and snapshot->'personalDevice'->>'deviceId'=$3)",
        [input.organizationId, input.userId, input.deviceId]
      )
      return { ok: true }
    }
  )
}
export async function personalDevicePresence(
  pool: DatabasePool,
  input: { organizationId: string; runnerId: string; credential: string; online: boolean }
) {
  return inTenantTransaction(
    pool,
    { organizationId: input.organizationId, actor: { type: 'runner', runnerId: input.runnerId } },
    async (client) => {
      const row = await client.query(
        `update runners r set status=case when $4 and personal_enabled then 'online' else 'offline' end,last_seen_at=case when $4 then now() else null end,
  personal_enabled=case when $4 then personal_enabled else false end
  where r.organization_id=$1 and r.id=$2 and r.owner_user_id is not null and r.status<>'revoked' and exists(select 1 from runner_credentials rc where rc.runner_id=r.id and rc.secret_hash=$3 and rc.revoked_at is null and (rc.expires_at is null or rc.expires_at>now())) returning personal_enabled`,
        [input.organizationId, input.runnerId, hash(input.credential), input.online]
      )
      if (!row.rowCount) fail('Personal device credential is invalid or revoked.', 401)
      return { enabled: row.rows[0].personal_enabled as boolean }
    }
  )
}
