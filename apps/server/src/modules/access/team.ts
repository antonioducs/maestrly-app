import { randomBytes, createHash, randomUUID } from 'node:crypto'
import type { ProjectRole, ProjectTeam, TeamMember } from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from './authorize.js'
import { appendDomainEvent } from '../events/store.js'
export type TeamScope = { organizationId: string; projectId: string; userId: string }
export const tokenHash = (value: string) => createHash('sha256').update(value).digest()
export function teamFail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode })
}
export async function lockTeam(client: DatabaseClient, scope: TeamScope, expectedVersion?: number) {
  const row = (
    await client.query('select team_version,archived_at from projects where organization_id=$1 and id=$2 for update', [
      scope.organizationId,
      scope.projectId,
    ])
  ).rows[0]
  if (!row) teamFail('Project not found.', 404)
  if (row.archived_at) teamFail('Archived projects cannot change their team.')
  if (expectedVersion !== undefined && Number(row.team_version) !== expectedVersion)
    teamFail('The team changed. Refresh and try again.', 409)
}
export async function teamEvent(client: DatabaseClient, scope: TeamScope, type: string, data: Record<string, unknown>) {
  await client.query('update projects set team_version=team_version+1 where organization_id=$1 and id=$2', [
    scope.organizationId,
    scope.projectId,
  ])
  await appendDomainEvent(client, {
    ...scope,
    type,
    aggregateType: 'project_team',
    aggregateId: scope.projectId,
    actor: { type: 'human', userId: scope.userId },
    data,
  })
}
export function teamTransaction<T>(
  pool: DatabasePool,
  scope: TeamScope,
  operation: (client: DatabaseClient) => Promise<T>
) {
  return inTenantTransaction(pool, { ...scope, actor: { type: 'human', userId: scope.userId } }, operation)
}
export async function getTeam(pool: DatabasePool, scope: TeamScope): Promise<ProjectTeam> {
  return teamTransaction(pool, scope, async (client) => {
    await client.query('select id from projects where organization_id=$1 and id=$2 for share',[scope.organizationId,scope.projectId])
    const auth = await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'project:read')
    const canManage = ['owner', 'admin'].includes(auth.organizationRole) || auth.projectRole === 'maintainer'
    const project = (
      await client.query('select team_version from projects where organization_id=$1 and id=$2', [
        scope.organizationId,
        scope.projectId,
      ])
    ).rows[0]
    if (!project) teamFail('Project not found.', 404)
    const people = await client.query(
      `select om.user_id as "userId",coalesce(u.name,om.user_id) as name,coalesce(u.email,'') as email,pm.role,om.role as "organizationRole",om.role in ('owner','admin') as inherited
   from organization_members om left join "user" u on u.id=om.user_id left join project_members pm on pm.organization_id=om.organization_id and pm.project_id=$2 and pm.user_id=om.user_id
   where om.organization_id=$1 and ($3 or pm.user_id is not null or om.role in ('owner','admin')) order by lower(coalesce(u.name,om.user_id)),om.user_id`,
      [scope.organizationId, scope.projectId, canManage]
    )
    const members = people.rows.filter((r) => r.role || r.inherited) as TeamMember[]
    const invitations = canManage
      ? (
          await client.query(
            `select i.id,i.email,i.project_role as role,case when i.used_at is not null then 'accepted' when i.revoked_at is not null then 'revoked' when i.expires_at<=now() then 'expired' else 'pending' end as status,i.created_at as "createdAt",i.expires_at as "expiresAt",coalesce(u.name,i.created_by_user_id) as "createdBy" from invitations i left join "user" u on u.id=i.created_by_user_id where organization_id=$1 and project_id=$2 order by i.created_at desc limit 200`,
            [scope.organizationId, scope.projectId]
          )
        ).rows
      : []
    const history = canManage
      ? (
          await client.query(
            `select e.id,e.type,e.created_at as "createdAt",e.data,coalesce(u.name,e.actor->>'userId','') as "actorName" from domain_events e left join "user" u on u.id=e.actor->>'userId' where e.organization_id=$1 and e.project_id=$2 and e.aggregate_type='project_team' order by e.sequence desc limit 100`,
            [scope.organizationId, scope.projectId]
          )
        ).rows
      : []
    return {
      version: Number(project.team_version),
      canManage,
      members,
      candidates: canManage ? people.rows.filter((r) => !r.role && !r.inherited) : [],
      invitations,
      history,
    }
  })
}
export async function changeMember(
  pool: DatabasePool,
  scope: TeamScope,
  input: { expectedVersion: number; userId: string; role: ProjectRole | null }
) {
  return teamTransaction(pool, scope, async (client) => {
    await lockTeam(client, scope, input.expectedVersion)
    await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'members:manage')
    const target = (
      await client.query(`select om.role,u.name,u.email from organization_members om left join "user" u on u.id=om.user_id where om.organization_id=$1 and om.user_id=$2`, [
        scope.organizationId,
        input.userId,
      ])
    ).rows[0]
    if (!target) teamFail('Choose a member of this organization.')
    if (target.role !== 'member') teamFail('This access is inherited from the organization.')
    const previous =
      (
        await client.query(
          'select role from project_members where organization_id=$1 and project_id=$2 and user_id=$3',
          [scope.organizationId, scope.projectId, input.userId]
        )
      ).rows[0]?.role ?? null
    if (input.role === null) {
      if (!previous) teamFail('Project member not found.', 404)
      // Removing access must also invalidate an older, unconsumed way back into this project.
      const pending=await client.query('update invitations set revoked_at=now() where organization_id=$1 and project_id=$2 and lower(email)=lower($3) and used_at is null and revoked_at is null returning id',[scope.organizationId,scope.projectId,target.email??''])
      for(const invite of pending.rows)await teamEvent(client,scope,'team.invitation_revoked',{invitationId:invite.id,email:target.email,reason:'member_removed'})
      await client.query('delete from project_members where organization_id=$1 and project_id=$2 and user_id=$3', [
        scope.organizationId,
        scope.projectId,
        input.userId,
      ])
    } else
      await client.query(
        'insert into project_members(organization_id,project_id,user_id,role) values($1,$2,$3,$4) on conflict(organization_id,project_id,user_id) do update set role=excluded.role',
        [scope.organizationId, scope.projectId, input.userId, input.role]
      )
    await teamEvent(
      client,
      scope,
      input.role === null ? 'team.member_removed' : previous ? 'team.member_role_changed' : 'team.member_added',
      { userId: input.userId, name:target.name??input.userId, email:target.email??undefined, previousRole: previous, role: input.role }
    )
    return { ok: true }
  })
}
export async function createProjectInvitation(
  pool: DatabasePool,
  scope: TeamScope,
  input: { expectedVersion: number; email: string; role: ProjectRole; expiresInHours: number }
) {
  return teamTransaction(pool, scope, async (client) => {
    await lockTeam(client, scope, input.expectedVersion)
    await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'members:manage')
    const email = input.email.trim().toLowerCase()
    const existing = (
      await client.query(
        `select 1 from "user" u join organization_members om on om.user_id=u.id and om.organization_id=$1 left join project_members pm on pm.organization_id=om.organization_id and pm.user_id=u.id and pm.project_id=$2 where lower(u.email)=$3 and (pm.user_id is not null or om.role in ('owner','admin'))`,
        [scope.organizationId, scope.projectId, email]
      )
    ).rowCount
    if (existing) teamFail('This person already has access to the project.', 409)
    const pending = (
      await client.query(
        'select 1 from invitations where organization_id=$1 and project_id=$2 and lower(email)=$3 and used_at is null and revoked_at is null and expires_at>now()',
        [scope.organizationId, scope.projectId, email]
      )
    ).rowCount
    if (pending) teamFail('A pending invitation already exists for this email.', 409)
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url')
    await client.query(
      `insert into invitations(id,organization_id,project_id,email,role,project_role,token_hash,expires_at,created_by_user_id) values($1,$2,$3,$4,'member',$5,$6,now()+$7*interval '1 hour',$8)`,
      [
        id,
        scope.organizationId,
        scope.projectId,
        email,
        input.role,
        tokenHash(token),
        input.expiresInHours,
        scope.userId,
      ]
    )
    await teamEvent(client, scope, 'team.invitation_created', { invitationId: id, email, role: input.role })
    return { id, token, email }
  })
}
export async function changeInvitation(
  pool: DatabasePool,
  scope: TeamScope,
  input: { expectedVersion: number; invitationId: string; action: 'revoke' | 'renew'; expiresInHours: number }
) {
  return teamTransaction(pool, scope, async (client) => {
    await lockTeam(client, scope, input.expectedVersion)
    await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'members:manage')
    const row = (
      await client.query('select * from invitations where organization_id=$1 and project_id=$2 and id=$3 for update', [
        scope.organizationId,
        scope.projectId,
        input.invitationId,
      ])
    ).rows[0]
    if (!row) teamFail('Invitation not found.', 404)
    if (row.used_at) teamFail('Accepted invitations cannot be changed.', 409)
    const token = input.action === 'renew' ? randomBytes(32).toString('base64url') : null
    if (token) {
      const duplicate = (
        await client.query(
          'select 1 from invitations where organization_id=$1 and project_id=$2 and lower(email)=lower($3) and id<>$4 and used_at is null and revoked_at is null and expires_at>now()',
          [scope.organizationId, scope.projectId, row.email, row.id]
        )
      ).rowCount
      if (duplicate) teamFail('A pending invitation already exists for this email.', 409)
      await client.query(
        "update invitations set token_hash=$2,revoked_at=null,expires_at=now()+$3*interval '1 hour' where id=$1",
        [row.id, tokenHash(token), input.expiresInHours]
      )
    } else await client.query('update invitations set revoked_at=now() where id=$1', [row.id])
    await teamEvent(client, scope, token ? 'team.invitation_renewed' : 'team.invitation_revoked', {
      invitationId: row.id,
      email: row.email,
      role: row.project_role,
    })
    return { id: row.id, email: row.email, token }
  })
}
