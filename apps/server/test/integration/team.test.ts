import { describe, it, expect } from 'vitest'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'
import { createProject } from '../../src/modules/projects/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createCard, updateCard } from '../../src/modules/cards/service.js'
import {
  getTeam,
  changeMember,
  createProjectInvitation,
  changeInvitation,
  teamTransaction,
} from '../../src/modules/access/team.js'
import { acceptInvitation, inspectInvitation } from '../../src/modules/access/invitations.js'
import { authorizeProject } from '../../src/modules/access/authorize.js'
import { listDomainEvents } from '../../src/modules/events/store.js'
import { executeIdempotent } from '../../src/modules/events/http-idempotency.js'
import { verifyPassword } from 'better-auth/crypto'

describe.skipIf(!integrationAvailable)('project team', () => {
  it('enforces roles, inherited access, concurrency, revocation and preserved assignments', async () => {
    const pool = runtimePool()
    try {
      const userId = 'owner-' + crypto.randomUUID(),
        organizationId = await seedOrganization('Team', userId)
      const project = await createProject(pool, { organizationId, actorUserId: userId, name: 'Team project' })
      const scope = { organizationId, projectId: project.project.id, userId },
        maintainer = 'maintainer-' + crypto.randomUUID(),
        member = 'member-' + crypto.randomUUID()
      await teamTransaction(pool, scope, async (c) => {
        for (const id of [maintainer, member])
          await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')", [
            organizationId,
            id,
          ])
      })
      await changeMember(pool, scope, { expectedVersion: 1, userId: maintainer, role: 'maintainer' })
      const manager = { ...scope, userId: maintainer }
      await changeMember(pool, manager, { expectedVersion: 2, userId: member, role: 'contributor' })
      const view = await getTeam(pool, { ...scope, userId: member })
      expect(view).toMatchObject({ canManage: false, candidates: [], invitations: [] })
      expect(view.members.find((m) => m.userId === userId)).toMatchObject({
        inherited: true,
        organizationRole: 'owner',
      })
      await expect(
        changeMember(pool, { ...scope, userId: member }, { expectedVersion: 3, userId: maintainer, role: 'viewer' })
      ).rejects.toThrow(/authorized/)
      await expect(changeMember(pool, manager, { expectedVersion: 3, userId, role: null })).rejects.toThrow(/inherited/)
      const race = await Promise.allSettled(
        ['viewer', 'contributor'].map((role) =>
          changeMember(pool, manager, { expectedVersion: 3, userId: member, role: role as 'viewer' | 'contributor' })
        )
      )
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const board = await getBoard(pool, { organizationId, userId, boardId: project.boardId })
      const card = await createCard(pool, {
        organizationId,
        userId,
        boardId: project.boardId,
        columnId: board.columns[0]!.id,
        title: 'Preserve me',
        assigneeUserIds: [member],
      })
      await changeMember(pool, manager, { expectedVersion: 4, userId: member, role: null })
      await expect(getTeam(pool, { ...scope, userId: member })).rejects.toThrow(/authorized/)
      await expect(
        listDomainEvents(pool, { ...scope, cursor: 0, actor: { type: 'human', userId: member } })
      ).rejects.toThrow(/authorized/)
      const updated = await updateCard(pool, {
        organizationId,
        userId,
        cardId: card.id,
        patch: { expectedVersion: card.version, title: 'Preserved' },
      })
      expect(updated.assigneeUserIds).toContain(member)
      await expect(
        createCard(pool, {
          organizationId,
          userId,
          boardId: project.boardId,
          columnId: board.columns[0]!.id,
          title: 'New',
          assigneeUserIds: [member],
        })
      ).rejects.toThrow(/Assignees/)
      const foreign = await seedOrganization('Other', 'other-' + crypto.randomUUID())
      await expect(getTeam(pool, { ...scope, organizationId: foreign })).rejects.toThrow(/authorized/)
      expect((await getTeam(pool, scope)).history.map((h) => h.type)).toContain('team.member_removed')
    } finally {
      await pool.end()
    }
  })
  it('supports idempotent invites, expiration, renewal, revocation and single acceptance', async () => {
    const pool = runtimePool()
    try {
      const userId = 'owner-' + crypto.randomUUID(),
        organizationId = await seedOrganization('Invites', userId)
      const project = await createProject(pool, { organizationId, actorUserId: userId, name: 'Invites' })
      const scope = { organizationId, projectId: project.project.id, userId },
        email = 'invite-' + crypto.randomUUID() + '@example.test'
      const input = { expectedVersion: 1, email, role: 'viewer' as const, expiresInHours: 24 },
        key = crypto.randomUUID()
      const invoke = () =>
        executeIdempotent(
          pool,
          {
            organizationId,
            actorId: userId,
            actor: { type: 'human', userId },
            key,
            method: 'POST',
            path: '/team/invitations',
            body: input,
          },
          async () => ({ status: 200, body: await createProjectInvitation(pool, scope, input) })
        )
      const first = await invoke(),
        replay = await invoke()
      expect(replay.replayed).toBe(true)
      expect(replay.body).toEqual(first.body)
      await expect(createProjectInvitation(pool, scope, { ...input, expectedVersion: 2 })).rejects.toThrow(/pending/)
      await changeInvitation(pool, scope, {
        expectedVersion: 2,
        invitationId: first.body.id,
        action: 'revoke',
        expiresInHours: 24,
      })
      expect(await inspectInvitation(pool, { organizationId, email, token: first.body.token })).toEqual({
        valid: false,
      })
      const renewed = await changeInvitation(pool, scope, {
        expectedVersion: 3,
        invitationId: first.body.id,
        action: 'renew',
        expiresInHours: 24,
      })
      expect(await inspectInvitation(pool, { organizationId, email, token: first.body.token })).toEqual({
        valid: false,
      })
      await expect(
        acceptInvitation(pool, { organizationId, email: 'wrong@example.test', token: renewed.token!, userId: 'wrong' })
      ).rejects.toThrow(/invalid/)
      const invited = 'invited-' + crypto.randomUUID()
      const race = await Promise.allSettled(
        [1, 2].map(() => acceptInvitation(pool, { organizationId, email, token: renewed.token!, userId: invited }))
      )
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(
        (await getTeam(pool, { ...scope, userId: invited })).members.find((m) => m.userId === invited)
      ).toMatchObject({ role: 'viewer', organizationRole: 'member' })
      await expect(
        teamTransaction(pool, { ...scope, userId: invited }, (c) =>
          authorizeProject(c, organizationId, scope.projectId, invited, 'work:write')
        )
      ).rejects.toThrow(/authorized/)
      await expect(
        changeInvitation(pool, scope, {
          expectedVersion: 5,
          invitationId: first.body.id,
          action: 'renew',
          expiresInHours: 24,
        })
      ).rejects.toThrow(/Accepted/)
      const next = await createProjectInvitation(pool, scope, {
        ...input,
        expectedVersion: 5,
        email: 'expire-' + email,
      })
      await teamTransaction(pool, scope, (c) =>
        c.query("update invitations set expires_at=now()-interval '1 second' where id=$1", [next.id])
      )
      await expect(
        acceptInvitation(pool, { organizationId, email: 'expire-' + email, token: next.token, userId: 'expired' })
      ).rejects.toThrow(/expired/)
    } finally {
      await pool.end()
    }
  })
  it('registers the account and accepts the invitation atomically without paid or external services', async () => {
    const pool = runtimePool()
    try {
      const owner = 'owner-' + crypto.randomUUID(),
        organizationId = await seedOrganization('Registration', owner)
      const p = await createProject(pool, { organizationId, actorUserId: owner, name: 'Registration' })
      const scope = { organizationId, projectId: p.project.id, userId: owner },
        email = 'new-' + crypto.randomUUID() + '@example.test',
        userId = crypto.randomUUID(),
        password = 'fixture-password-12345'
      const invitation = await createProjectInvitation(pool, scope, {
        expectedVersion: 1,
        email,
        role: 'contributor',
        expiresInHours: 24,
      })
      await acceptInvitation(pool, {
        organizationId,
        email,
        userId,
        token: invitation.token,
        registration: { name: 'Invited person', password },
      })
      const account = await teamTransaction(pool, scope, (c) =>
        c.query('select password from account where "userId"=$1', [userId])
      )
      expect(await verifyPassword({ hash: account.rows[0].password, password })).toBe(true)
      expect((await getTeam(pool, { ...scope, userId })).canManage).toBe(false)
      const second = await createProject(pool, { organizationId, actorUserId: owner, name: 'Other project' })
      await expect(getTeam(pool, { ...scope, projectId: second.project.id, userId })).rejects.toThrow(/authorized/)
      const other={...scope,projectId:second.project.id}
      const pending=await createProjectInvitation(pool,other,{expectedVersion:1,email,role:'maintainer',expiresInHours:24})
      const conflictingUser=crypto.randomUUID()
      await expect(acceptInvitation(pool,{organizationId,email,userId:conflictingUser,token:pending.token,registration:{name:'Duplicate account',password}})).rejects.toThrow(/already exists/)
      expect(await inspectInvitation(pool,{organizationId,email,token:pending.token})).toEqual({valid:true})
      expect((await teamTransaction(pool,scope,c=>c.query('select 1 from "user" where id=$1',[conflictingUser]))).rowCount).toBe(0)
      await changeMember(pool,other,{expectedVersion:2,userId,role:'viewer'})
      await changeMember(pool,other,{expectedVersion:3,userId,role:null})
      await expect(acceptInvitation(pool,{organizationId,email,userId,token:pending.token})).rejects.toThrow(/invalid/)
      expect((await getTeam(pool,other)).invitations[0]?.status).toBe('revoked')

    } finally {
      await pool.end()
    }
  })
})

import Fastify from 'fastify'
import {registerTeamRoutes} from '../../src/modules/access/team-routes.js'
import {loadConfig} from '../../src/config.js'
import {AuthorizationError} from '../../src/modules/access/authorize.js'
describe.skipIf(!integrationAvailable)('team HTTP authorization',()=>{
 it('rechecks permission before replaying an invitation response and rejects role escalation',async()=>{
  const pool=runtimePool(),app=Fastify()
  try{
   const owner='owner-'+crypto.randomUUID(),organizationId=await seedOrganization('HTTP team',owner)
   const p=await createProject(pool,{organizationId,actorUserId:owner,name:'HTTP team'}),scope={organizationId,projectId:p.project.id,userId:owner},manager='manager-'+crypto.randomUUID()
   await teamTransaction(pool,scope,c=>c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')",[organizationId,manager]))
   await changeMember(pool,scope,{expectedVersion:1,userId:manager,role:'maintainer'})
   registerTeamRoutes(app,pool,loadConfig(),async r=>({userId:String(r.headers['x-test-user']??''),scopes:['api:read','api:write']}))
   app.setErrorHandler((error,_request,reply)=>reply.status(error instanceof AuthorizationError?403:Number((error as {statusCode?:number}).statusCode??400)).send({message:error.message}))
   const url=`/api/v1/organizations/${organizationId}/projects/${p.project.id}/team/invitations`,headers={'x-test-user':manager,'idempotency-key':crypto.randomUUID()},payload={expectedVersion:2,email:'http-'+crypto.randomUUID()+'@example.test',role:'viewer',expiresInHours:24}
   const first=await app.inject({method:'POST',url,headers,payload});expect(first.statusCode).toBe(200)
   const replay=await app.inject({method:'POST',url,headers,payload});expect(replay.json()).toEqual(first.json());expect(replay.headers['idempotency-replayed']).toBe('true')
   await changeMember(pool,scope,{expectedVersion:3,userId:manager,role:'viewer'})
   expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(403)
   const invalid=await app.inject({method:'POST',url,headers:{'x-test-user':owner,'idempotency-key':crypto.randomUUID()},payload:{...payload,expectedVersion:4,role:'owner'}})
   expect(invalid.statusCode).toBe(400)
  }finally{await app.close();await pool.end()}
 })
})
