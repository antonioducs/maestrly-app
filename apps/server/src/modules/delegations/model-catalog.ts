/**
 * Server view of the delegation catalog. The server never invents a model: it reads the inventory each
 * executor published and intersects it with the requester's live project access.
 */
import {
  delegationModelCatalogSchema,
  DelegationSettingsError,
  type DelegationExecutor,
  type DelegationModelCatalog,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'

export interface DelegationScope {
  organizationId: string
  projectId: string
  userId: string
}

interface ExecutorRow {
  id: string
  name: string
  online: boolean
  owner_user_id: string | null
  delegation_capabilities: unknown
}

function mapExecutor(row: ExecutorRow, projectId: string): DelegationExecutor | null {
  const parsed = delegationModelCatalogSchema.safeParse(row.delegation_capabilities)
  if (!parsed.success) return null
  return {
    executorId: row.id,
    name: row.name,
    online: row.online,
    personal: !!row.owner_user_id,
    catalog: {
      ...parsed.data,
      workspaces: parsed.data.workspaces.filter((workspace) => workspace.projectId === projectId),
    },
  }
}

/** Executors bound to this project that the requester may use, with their advertised catalogs. */
export async function listDelegationExecutors(
  pool: DatabasePool,
  scope: DelegationScope
): Promise<DelegationExecutor[]> {
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, projectId: scope.projectId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'project:read')
      const rows = await client.query<ExecutorRow>(
        `select r.id, r.name, r.owner_user_id, r.delegation_capabilities,
                (r.status='online' and r.last_seen_at > now() - interval '45 seconds') as online
         from runners r
         join runner_project_bindings b on b.runner_id=r.id and b.organization_id=r.organization_id
         where r.organization_id=$1 and b.project_id=$2 and r.status<>'revoked'
           and (r.owner_user_id is null or (r.owner_user_id=$3 and r.personal_enabled))
         order by r.name, r.id`,
        [scope.organizationId, scope.projectId, scope.userId]
      )
      return rows.rows.flatMap((row) => {
        const executor = mapExecutor(row, scope.projectId)
        return executor ? [executor] : []
      })
    }
  )
}

/**
 * Load one executor's catalog inside an existing transaction. Used by admission and claim so the same
 * inventory is revalidated instead of trusting the queued snapshot.
 */
export async function executorDelegationCatalog(
  client: DatabaseClient,
  input: { organizationId: string; projectId: string; executorId: string; userId: string }
): Promise<DelegationModelCatalog> {
  const rows = await client.query<ExecutorRow>(
    `select r.id, r.name, r.owner_user_id, r.delegation_capabilities,
            (r.status='online' and r.last_seen_at > now() - interval '45 seconds') as online
     from runners r
     join runner_project_bindings b on b.runner_id=r.id and b.organization_id=r.organization_id
     where r.id=$1 and r.organization_id=$2 and b.project_id=$3 and r.status<>'revoked'
       and (r.owner_user_id is null or (r.owner_user_id=$4 and r.personal_enabled))`,
    [input.executorId, input.organizationId, input.projectId, input.userId]
  )
  const row = rows.rows[0]
  if (!row)
    throw new DelegationSettingsError(
      'SELECTION_UNAVAILABLE',
      'That executor is not available for this project and user.',
      { executorId: input.executorId }
    )
  const parsed = delegationModelCatalogSchema.safeParse(row.delegation_capabilities)
  if (!parsed.success || !parsed.data.enabled)
    throw new DelegationSettingsError('SELECTION_UNAVAILABLE', 'This executor does not offer delegation stages.', {
      executorId: input.executorId,
    })
  return parsed.data
}

/** Persist the inventory an authenticated executor publishes for itself. */
export async function publishDelegationCatalog(
  client: DatabaseClient,
  input: { organizationId: string; runnerId: string; catalog: DelegationModelCatalog }
): Promise<void> {
  for (const workspace of input.catalog.workspaces) {
    const bound = await client.query(
      'select 1 from runner_project_bindings where organization_id=$1 and runner_id=$2 and project_id=$3',
      [input.organizationId, input.runnerId, workspace.projectId]
    )
    if (!bound.rowCount)
      throw Object.assign(new Error('Workspace is outside this executor project scope.'), { statusCode: 403 })
  }
  await client.query(
    'update runners set delegation_capabilities=$3, delegation_seen_at=now(), last_seen_at=now() where organization_id=$1 and id=$2',
    [input.organizationId, input.runnerId, input.catalog]
  )
}
