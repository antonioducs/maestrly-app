import { describe, expect, it } from 'vitest'
import { createProject } from '../../src/modules/projects/service.js'
import {
  authorizeConnector,
  ConnectorAuthorizationError,
  connectorVisibleProjects,
  createConnectorConnection,
  listConnectorConnections,
  loadConnectorGrants,
  patchConnectorConnection,
} from '../../src/modules/connectors/grants.js'
import { teamTransaction } from '../../src/modules/access/team.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

const principal = (input: {
  organizationId: string
  userId: string
  connectionId: string
  grants: Array<{ projectId: string; actions: string[] }>
}) => ({
  organizationId: input.organizationId,
  connectionId: input.connectionId,
  clientId: 'grok-test-client',
  userId: input.userId,
  scopes: ['api:read', 'api:write'],
  grants: input.grants as never,
  cancelOnRevoke: true,
  origin: { address: '127.0.0.1', userAgent: null },
  clientLabel: 'Grok Bot',
})

describe.skipIf(!integrationAvailable)('connector connections and grants', () => {
  it('binds grants to the owner, rechecks them on every action and stops immediately after revocation', async () => {
    const pool = runtimePool()
    try {
      const owner = 'connector-owner-' + crypto.randomUUID()
      const stranger = 'connector-stranger-' + crypto.randomUUID()
      const organizationId = await seedOrganization('Connector grants', owner)
      const granted = await createProject(pool, { organizationId, actorUserId: owner, name: 'Granted project' })
      const other = await createProject(pool, { organizationId, actorUserId: owner, name: 'Ungranted project' })
      const clientId = 'grok-test-client'

      const connection = await createConnectorConnection(
        pool,
        { organizationId, userId: owner },
        {
          clientId,
          name: 'Grok Bot',
          cancelOnRevoke: true,
          grants: [{ projectId: granted.project.id, actions: ['tasks:read', 'tasks:write', 'execution:control'] }],
        }
      )
      expect(connection.version).toBe(1)
      expect(connection.revokedAt).toBeNull()

      // A duplicate client for the same owner is a conflict, not a second silent grant.
      await expect(
        createConnectorConnection(
          pool,
          { organizationId, userId: owner },
          { clientId, name: 'Grok Bot again', cancelOnRevoke: true, grants: [{ projectId: granted.project.id, actions: ['tasks:read'] }] }
        )
      ).rejects.toThrow(/already connected/)

      const live = await loadConnectorGrants(pool, { organizationId, userId: owner, clientId })
      expect(live?.connectionId).toBe(connection.id)
      expect(live?.grants).toEqual([
        { projectId: granted.project.id, actions: ['tasks:read', 'tasks:write', 'execution:control'] },
      ])
      // Another user's token never resolves this connection.
      expect(await loadConnectorGrants(pool, { organizationId, userId: stranger, clientId })).toBeNull()

      const actor = principal({
        organizationId,
        userId: owner,
        connectionId: connection.id,
        grants: [{ projectId: granted.project.id, actions: ['tasks:read', 'tasks:write', 'execution:control'] }],
      })
      await expect(authorizeConnector(pool, actor, granted.project.id, 'tasks:read')).resolves.toBeUndefined()
      // Action outside the grant and project outside the grant are both refused.
      await expect(authorizeConnector(pool, actor, granted.project.id, 'delivery:manage')).rejects.toBeInstanceOf(
        ConnectorAuthorizationError
      )
      await expect(authorizeConnector(pool, actor, other.project.id, 'tasks:read')).rejects.toBeInstanceOf(
        ConnectorAuthorizationError
      )
      expect((await connectorVisibleProjects(pool, actor)).map((row) => row.projectId)).toEqual([granted.project.id])

      // A stale in-memory grant cannot outlive the persisted one.
      const narrowed = await patchConnectorConnection(
        pool,
        { organizationId, userId: owner, connectionId: connection.id },
        { expectedVersion: connection.version, grants: [{ projectId: granted.project.id, actions: ['tasks:read'] }] }
      )
      expect(narrowed.version).toBe(2)
      await expect(authorizeConnector(pool, actor, granted.project.id, 'tasks:write')).rejects.toThrow(/changed or revoked/)

      await expect(
        patchConnectorConnection(
          pool,
          { organizationId, userId: owner, connectionId: connection.id },
          { expectedVersion: connection.version, name: 'Stale write' }
        )
      ).rejects.toThrow(/changed after it was loaded/)

      const revoked = await patchConnectorConnection(
        pool,
        { organizationId, userId: owner, connectionId: connection.id },
        { expectedVersion: narrowed.version, revoked: true }
      )
      expect(revoked.revokedAt).not.toBeNull()
      expect(await loadConnectorGrants(pool, { organizationId, userId: owner, clientId })).toBeNull()
      await expect(authorizeConnector(pool, actor, granted.project.id, 'tasks:read')).rejects.toThrow(
        /changed or revoked/
      )
      expect((await listConnectorConnections(pool, { organizationId, userId: owner })).map((row) => row.id)).toEqual([
        connection.id,
      ])
      expect(await listConnectorConnections(pool, { organizationId, userId: stranger })).toEqual([])
    } finally {
      await pool.end()
    }
  })

  it('refuses to grant an action the owner cannot perform on that project', async () => {
    const pool = runtimePool()
    try {
      const owner = 'connector-admin-' + crypto.randomUUID()
      const viewer = 'connector-viewer-' + crypto.randomUUID()
      const organizationId = await seedOrganization('Connector least privilege', owner)
      const project = await createProject(pool, { organizationId, actorUserId: owner, name: 'Read only project' })
      await teamTransaction(pool, { organizationId, projectId: project.project.id, userId: owner }, async (client) => {
        await client.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')", [
          organizationId,
          viewer,
        ])
        await client.query(
          "insert into project_members(organization_id,project_id,user_id,role) values($1,$2,$3,'viewer')",
          [organizationId, project.project.id, viewer]
        )
      })
      await expect(
        createConnectorConnection(
          pool,
          { organizationId, userId: viewer },
          {
            clientId: 'viewer-client',
            name: 'Viewer bot',
            cancelOnRevoke: true,
            grants: [{ projectId: project.project.id, actions: ['tasks:write'] }],
          }
        )
      ).rejects.toThrow()
      const readOnly = await createConnectorConnection(
        pool,
        { organizationId, userId: viewer },
        {
          clientId: 'viewer-client',
          name: 'Viewer bot',
          cancelOnRevoke: true,
          grants: [{ projectId: project.project.id, actions: ['tasks:read'] }],
        }
      )
      expect(readOnly.grants[0]!.actions).toEqual(['tasks:read'])
    } finally {
      await pool.end()
    }
  })
})
