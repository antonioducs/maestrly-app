import { hashPassword } from 'better-auth/crypto'
import { lockTeam, teamEvent, teamFail } from './team.js'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { OrganizationRole } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeOrganizationAdmin } from './authorize.js'

const hash = (token: string) => createHash('sha256').update(token).digest()

export async function inspectInvitation(
  pool: DatabasePool,
  input: { organizationId: string; token: string; email: string }
): Promise<{ valid: boolean }> {
  return inTenantTransaction(
    pool,
    { organizationId: input.organizationId, actor: { type: 'system', service: 'invitation-inspection' } },
    async (client) => {
      const result = await client.query<{ exists: boolean }>(
        `
      select exists(
        select 1 from invitations where organization_id = $1 and token_hash = $2 and lower(email) = lower($3)
          and used_at is null and revoked_at is null and expires_at > now()
      )
    `,
        [input.organizationId, hash(input.token), input.email]
      )
      return { valid: result.rows[0]?.exists === true }
    }
  )
}

export async function createInvitation(
  pool: DatabasePool,
  input: { organizationId: string; email: string; role: OrganizationRole; expiresAt: Date; createdByUserId: string }
): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString('base64url')
  return inTenantTransaction(
    pool,
    { organizationId: input.organizationId, actor: { type: 'human', userId: input.createdByUserId } },
    async (client) => {
      await authorizeOrganizationAdmin(client, input.organizationId, input.createdByUserId)
      const result = await client.query<{ id: string }>(
        `
      insert into invitations(organization_id, email, role, token_hash, expires_at, created_by_user_id)
      values ($1, lower($2), $3, $4, $5, $6)
      returning id
    `,
        [input.organizationId, input.email, input.role, hash(token), input.expiresAt, input.createdByUserId]
      )
      return { id: result.rows[0]!.id, token }
    }
  )
}

export async function acceptInvitation(
  pool: DatabasePool,
  input: {
    organizationId: string
    token: string
    userId: string
    email: string
    registration?: { name: string; password: string }
  }
): Promise<void> {
  const password = input.registration ? await hashPassword(input.registration.password) : null
  await inTenantTransaction(
    pool,
    { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } },
    async (client) => {
      const lookup = (
        await client.query(
          'select project_id from invitations where organization_id=$1 and token_hash=$2 and lower(email)=lower($3)',
          [input.organizationId, hash(input.token), input.email]
        )
      ).rows[0]
      if (!lookup) teamFail('Invitation is invalid, expired, or already used.')
      const scope = { organizationId: input.organizationId, projectId: lookup.project_id, userId: input.userId }
      if (lookup.project_id) await lockTeam(client, scope)
      const row = (
        await client.query(
          `select * from invitations where organization_id=$1 and token_hash=$2 and lower(email)=lower($3) and used_at is null and revoked_at is null and expires_at>now() for update`,
          [input.organizationId, hash(input.token), input.email]
        )
      ).rows[0]
      if (!row) teamFail('Invitation is invalid, expired, or already used.')
      if (input.registration) {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          'registration:' + input.email.toLowerCase(),
        ])
        if ((await client.query('select 1 from "user" where lower(email)=lower($1)', [input.email])).rowCount)
          teamFail('An account already exists. Sign in to accept the invitation.', 409)
        await client.query(
          'insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$2,$3,false,now(),now())',
          [input.userId, input.registration.name, input.email.toLowerCase()]
        )
        await client.query(
          `insert into account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") values($1,$2,'credential',$2,$3,now(),now())`,
          [randomUUID(), input.userId, password]
        )
      }
      await client.query(
        'insert into organization_members(organization_id,user_id,role) values($1,$2,$3) on conflict(organization_id,user_id) do nothing',
        [input.organizationId, input.userId, row.role]
      )
      if (row.project_id) {
        // An old invitation cannot overwrite access subsequently granted by a maintainer.
        await client.query(
          'insert into project_members(organization_id,project_id,user_id,role) values($1,$2,$3,$4) on conflict(organization_id,project_id,user_id) do nothing',
          [input.organizationId, row.project_id, input.userId, row.project_role]
        )
        await teamEvent(client, scope, 'team.invitation_accepted', {
          invitationId: row.id,
          userId: input.userId,
          email: row.email,
          role: row.project_role,
        })
      }
      await client.query('update invitations set used_at=now() where id=$1', [row.id])
    }
  )
}
