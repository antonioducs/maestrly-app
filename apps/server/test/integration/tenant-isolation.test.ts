import { describe, expect, it } from 'vitest'
import { inTenantTransaction } from '../../src/db/transaction.js'
import { authorizeProject } from '../../src/modules/access/authorize.js'
import { createProject } from '../../src/modules/projects/service.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

describe.skipIf(!integrationAvailable)('tenant isolation', () => {
  it('blocks guessed IDs across organizations and private projects on reused pool connections', async () => {
    const pool = runtimePool()
    try {
      const suffix = crypto.randomUUID()
      const ownerA = `owner-a-${suffix}`; const ownerB = `owner-b-${suffix}`
      const orgA = await seedOrganization(`Org A ${suffix}`, ownerA)
      const orgB = await seedOrganization(`Org B ${suffix}`, ownerB)
      const projectA = await createProject(pool, { organizationId: orgA, actorUserId: ownerA, name: 'Private A' })
      const projectB = await createProject(pool, { organizationId: orgB, actorUserId: ownerB, name: 'Private B' })

      const leaked = await inTenantTransaction(pool, { organizationId: orgA, actor: { type: 'human', userId: ownerA } }, async (client) => {
        return client.query('select id from projects where id = $1', [projectB.project.id])
      })
      expect(leaked.rowCount).toBe(0)

      const member = `member-${suffix}`
      await inTenantTransaction(pool, { organizationId: orgA, projectId: projectA.project.id, actor: { type: 'human', userId: ownerA } }, async (client) => {
        await client.query("insert into organization_members(organization_id, user_id, role) values ($1,$2,'member')", [orgA, member])
        await client.query("insert into project_members(organization_id, project_id, user_id, role) values ($1,$2,$3,'viewer')", [orgA, projectA.project.id, member])
      })
      await expect(inTenantTransaction(pool, { organizationId: orgA, projectId: projectA.project.id, actor: { type: 'human', userId: member } },
        (client) => authorizeProject(client, orgA, projectA.project.id, member, 'project:read'))).resolves.toMatchObject({ projectRole: 'viewer' })
      await inTenantTransaction(pool, { organizationId: orgA, projectId: projectA.project.id, actor: { type: 'human', userId: ownerA } },
        (client) => client.query('delete from project_members where organization_id = $1 and project_id = $2 and user_id = $3', [orgA, projectA.project.id, member]))
      await expect(inTenantTransaction(pool, { organizationId: orgA, projectId: projectA.project.id, actor: { type: 'human', userId: member } },
        (client) => authorizeProject(client, orgA, projectA.project.id, member, 'project:read'))).rejects.toThrow(/authorized/)

      await expect(inTenantTransaction(pool, {
        organizationId: orgA, projectId: projectA.project.id, actor: { type: 'human', userId: `stranger-${suffix}` },
      }, (client) => authorizeProject(client, orgA, projectA.project.id, `stranger-${suffix}`, 'project:read'))).rejects.toThrow(/authorized/)

      const visibleAgain = await inTenantTransaction(pool, { organizationId: orgB, actor: { type: 'human', userId: ownerB } }, (client) => client.query('select id from projects where id = $1', [projectB.project.id]))
      expect(visibleAgain.rowCount).toBe(1)
    } finally { await pool.end() }
  })
})
