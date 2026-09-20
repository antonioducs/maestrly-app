import {
  connectorConnectionSchema,
  connectorGrantSchema,
  type ConnectorAction,
  type ConnectorConnection,
  type ConnectorConnectionCreate,
  type ConnectorConnectionPatch,
  type ConnectorGrant,
  type ConnectorPrincipal,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'

import { randomUUID } from 'node:crypto'
import { DESKTOP_CLIENT_ID } from '../auth/desktop-client.js'

export class ConnectorAuthorizationError extends Error {
  readonly statusCode: number
  constructor(message = 'The connector is not authorized for this project action.', statusCode = 403) {
    super(message)
    this.name = 'ConnectorAuthorizationError'
    this.statusCode = statusCode
  }
}

export function connectorFail(message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { statusCode })
}

interface ConnectionRow {
  id: string
  organization_id: string
  owner_user_id: string
  client_id: string
  name: string
  cancel_on_revoke: boolean
  version: string
  revoked_at: Date | null
  last_used_at: Date | null
  created_at: Date
  updated_at: Date
}

function mapConnection(row: ConnectionRow, grants: ConnectorGrant[]): ConnectorConnection {
  return connectorConnectionSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    ownerUserId: row.owner_user_id,
    clientId: row.client_id,
    name: row.name,
    grants,
    cancelOnRevoke: row.cancel_on_revoke,
    version: Number(row.version),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  })
}

async function readGrants(client: DatabaseClient, organizationId: string, connectionId: string) {
  const rows = await client.query<{ project_id: string; actions: unknown }>(
    'select project_id, actions from connector_project_grants where organization_id=$1 and connection_id=$2 order by project_id',
    [organizationId, connectionId]
  )
  return rows.rows.map((row) => connectorGrantSchema.parse({ projectId: row.project_id, actions: row.actions }))
}

/** The owner must still hold the project permission each granted action requires. */
const actionPermission: Record<ConnectorAction, Parameters<typeof authorizeProject>[4]> = {
  'tasks:read': 'project:read',
  'tasks:write': 'work:write',
  'execution:control': 'execution:request',
  'evidence:read': 'project:read',
  'inspect:read': 'project:read',
  'inspect:interact': 'execution:request',
  'delivery:manage': 'execution:request',
  'interactions:answer': 'execution:request',
}

async function assertOwnerMayGrant(
  client: DatabaseClient,
  organizationId: string,
  ownerUserId: string,
  grants: ConnectorGrant[]
) {
  for (const grant of grants) {
    for (const action of grant.actions) {
      await authorizeProject(client, organizationId, grant.projectId, ownerUserId, actionPermission[action])
    }
  }
}

/**
 * Narrow a connector OAuth client to the MCP resource. The client keeps no link to the REST audience, so
 * its tokens cannot act on `/api/v1` with the owner's full authority. These rows belong to the OAuth
 * provider's own storage and are not tenant-scoped.
 */
export async function bindConnectorClientResource(
  pool: DatabasePool,
  input: { clientId: string; mcpResource: string; apiResource: string }
): Promise<void> {
  if (input.clientId === DESKTOP_CLIENT_ID)
    connectorFail('The Maestrly desktop client cannot be reused as an external connector.', 400)
  const registered = await pool.query('select 1 from "oauthClient" where "clientId"=$1', [input.clientId])
  if (!registered.rowCount) connectorFail('Register the OAuth client before connecting it.', 400)
  await pool.query(
    'insert into "oauthResource"(id,identifier,name,"createdAt",disabled) values($1,$2,$3,now(),false) on conflict(identifier) do nothing',
    [randomUUID(), input.mcpResource, 'Maestrly MCP']
  )
  await pool.query(
    'insert into "oauthClientResource"(id,"clientId","resourceId","createdAt") select $1,$2,$3,now() where not exists(select 1 from "oauthClientResource" where "clientId"=$2 and "resourceId"=$3)',
    [randomUUID(), input.clientId, input.mcpResource]
  )
  await pool.query('delete from "oauthClientResource" where "clientId"=$1 and "resourceId"=$2', [
    input.clientId,
    input.apiResource,
  ])
}

export async function listConnectorConnections(
  pool: DatabasePool,
  scope: { organizationId: string; userId: string }
): Promise<ConnectorConnection[]> {
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      const rows = await client.query<ConnectionRow>(
        'select * from connector_connections where organization_id=$1 and owner_user_id=$2 order by created_at desc',
        [scope.organizationId, scope.userId]
      )
      const connections: ConnectorConnection[] = []
      for (const row of rows.rows)
        connections.push(mapConnection(row, await readGrants(client, scope.organizationId, row.id)))
      return connections
    }
  )
}

export async function createConnectorConnection(
  pool: DatabasePool,
  scope: { organizationId: string; userId: string },
  input: ConnectorConnectionCreate
): Promise<ConnectorConnection> {
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await assertOwnerMayGrant(client, scope.organizationId, scope.userId, input.grants)
      const existing = await client.query(
        'select id from connector_connections where organization_id=$1 and owner_user_id=$2 and client_id=$3',
        [scope.organizationId, scope.userId, input.clientId]
      )
      if (existing.rowCount) connectorFail('This client is already connected for your account.')
      const created = await client.query<ConnectionRow>(
        `insert into connector_connections(organization_id, owner_user_id, client_id, name, cancel_on_revoke)
         values($1,$2,$3,$4,$5) returning *`,
        [scope.organizationId, scope.userId, input.clientId, input.name, input.cancelOnRevoke]
      )
      const row = created.rows[0]!
      for (const grant of input.grants)
        await client.query(
          'insert into connector_project_grants(organization_id, connection_id, project_id, actions) values($1,$2,$3,$4)',
          [scope.organizationId, row.id, grant.projectId, JSON.stringify(grant.actions)]
        )
      return mapConnection(row, await readGrants(client, scope.organizationId, row.id))
    }
  )
}

export async function patchConnectorConnection(
  pool: DatabasePool,
  scope: { organizationId: string; userId: string; connectionId: string },
  input: ConnectorConnectionPatch
): Promise<ConnectorConnection> {
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      const found = await client.query<ConnectionRow>(
        'select * from connector_connections where organization_id=$1 and owner_user_id=$2 and id=$3 for update',
        [scope.organizationId, scope.userId, scope.connectionId]
      )
      const current = found.rows[0]
      if (!current) connectorFail('Connection not found.', 404)
      if (Number(current.version) !== input.expectedVersion)
        connectorFail('The connection changed after it was loaded.')
      if (input.grants) await assertOwnerMayGrant(client, scope.organizationId, scope.userId, input.grants)
      const revokedAt = input.revoked === undefined ? undefined : input.revoked ? new Date() : null
      const updated = await client.query<ConnectionRow>(
        `update connector_connections set
           name = coalesce($4, name),
           cancel_on_revoke = coalesce($5, cancel_on_revoke),
           revoked_at = case when $6::boolean then $7::timestamptz else revoked_at end,
           version = version + 1,
           updated_at = now()
         where organization_id=$1 and owner_user_id=$2 and id=$3 returning *`,
        [
          scope.organizationId,
          scope.userId,
          scope.connectionId,
          input.name ?? null,
          input.cancelOnRevoke ?? null,
          revokedAt !== undefined,
          revokedAt ?? null,
        ]
      )
      if (input.grants) {
        await client.query('delete from connector_project_grants where organization_id=$1 and connection_id=$2', [
          scope.organizationId,
          scope.connectionId,
        ])
        for (const grant of input.grants)
          await client.query(
            'insert into connector_project_grants(organization_id, connection_id, project_id, actions) values($1,$2,$3,$4)',
            [scope.organizationId, scope.connectionId, grant.projectId, JSON.stringify(grant.actions)]
          )
      }
      return mapConnection(updated.rows[0]!, await readGrants(client, scope.organizationId, scope.connectionId))
    }
  )
}

/**
 * Load the live connection for an authenticated token. Returns null when the connection is missing or
 * revoked so the caller can answer 401/403 without leaking whether a client id exists.
 */
export async function loadConnectorGrants(
  pool: DatabasePool,
  input: { organizationId: string; userId: string; clientId: string }
): Promise<{ connectionId: string; grants: ConnectorGrant[]; cancelOnRevoke: boolean } | null> {
  return inTenantTransaction(
    pool,
    { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } },
    async (client) => {
      const rows = await client.query<ConnectionRow>(
        `select * from connector_connections
         where organization_id=$1 and owner_user_id=$2 and client_id=$3 and revoked_at is null`,
        [input.organizationId, input.userId, input.clientId]
      )
      const row = rows.rows[0]
      if (!row) return null
      await client.query('update connector_connections set last_used_at=now() where organization_id=$1 and id=$2', [
        input.organizationId,
        row.id,
      ])
      return {
        connectionId: row.id,
        grants: await readGrants(client, input.organizationId, row.id),
        cancelOnRevoke: row.cancel_on_revoke,
      }
    }
  )
}

/**
 * Recheck the persisted grant and the owner's current project permission for one action. Both checks run
 * on every call, including retries and idempotent replays.
 */
export async function authorizeConnector(
  pool: DatabasePool,
  principal: ConnectorPrincipal,
  projectId: string,
  action: ConnectorAction
): Promise<void> {
  const grant = principal.grants.find((candidate) => candidate.projectId === projectId)
  if (!grant?.actions.includes(action))
    throw new ConnectorAuthorizationError(`The connection is not authorized for ${action} on this project.`)
  await inTenantTransaction(
    pool,
    { organizationId: principal.organizationId, projectId, actor: { type: 'human', userId: principal.userId } },
    async (client) => {
      const live = await client.query<{ actions: unknown }>(
        `select g.actions from connector_project_grants g
         join connector_connections c on c.organization_id=g.organization_id and c.id=g.connection_id
         where g.organization_id=$1 and g.connection_id=$2 and g.project_id=$3 and c.revoked_at is null`,
        [principal.organizationId, principal.connectionId, projectId]
      )
      const actions = live.rows[0] ? connectorGrantSchema.parse({ projectId, actions: live.rows[0].actions }).actions : []
      if (!actions.includes(action))
        throw new ConnectorAuthorizationError('The connection grant was changed or revoked.')
      await authorizeProject(client, principal.organizationId, projectId, principal.userId, actionPermission[action])
    }
  )
}

/** Projects the connection can currently see, intersected with the owner's live project access. */
export async function connectorVisibleProjects(pool: DatabasePool, principal: ConnectorPrincipal) {
  return inTenantTransaction(
    pool,
    { organizationId: principal.organizationId, actor: { type: 'human', userId: principal.userId } },
    async (client) => {
      const visible: Array<{ projectId: string; name: string; actions: ConnectorAction[] }> = []
      for (const grant of principal.grants) {
        try {
          await authorizeProject(client, principal.organizationId, grant.projectId, principal.userId, 'project:read')
        } catch {
          continue
        }
        const project = await client.query<{ name: string }>(
          'select name from projects where organization_id=$1 and id=$2 and archived_at is null',
          [principal.organizationId, grant.projectId]
        )
        if (!project.rows[0]) continue
        visible.push({ projectId: grant.projectId, name: project.rows[0].name, actions: grant.actions })
      }
      return visible
    }
  )
}
