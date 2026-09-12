import { z } from 'zod'
import type { DatabasePool } from '../../db/pool.js'
import { authorizeProject } from '../access/authorize.js'
import { transaction, fail, type Scope } from './service.js'
import { appendDomainEvent } from '../events/store.js'

// Branches are ref names, never shell options or revision expressions.
export const branchSchema = z
  .string()
  .min(1)
  .max(250)
  .refine(
    (value) =>
      value !== '@' &&
      !value.startsWith('-') &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.includes('..') &&
      !value.includes('@{') &&
      !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value) &&
      value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock')),
    'Invalid Git branch.'
  )
export const repoBody = z.object({
  name: z.string().trim().min(1).max(160),
  cloneUrl: z
    .string()
    .max(2000)
    .optional()
    .refine(
      (value) =>
        !value ||
        /^git@[\w.-]+:[^\s]+$/.test(value) ||
        (() => {
          try {
            const url = new URL(value)
            return (
              ['https:', 'http:', 'ssh:'].includes(url.protocol) &&
              !url.password &&
              (!url.username || url.protocol === 'ssh:')
            )
          } catch {
            return false
          }
        })(),
      'Use an HTTPS or SSH Git URL.'
    ),
  baseBranch: branchSchema,
  disabled: z.boolean().default(false),
  makeDefault: z.boolean().default(false),
})
export function mapRepository(row: Record<string, any>) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    name: row.name,
    cloneUrl: row.clone_url ?? undefined,
    baseBranch: row.base_branch,
    deliveryMode: row.delivery_mode,
    disabledAt: row.disabled_at?.toISOString() ?? null,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
  }
}
export async function repositories(pool: DatabasePool, scope: Scope & { projectId: string }) {
  return transaction(pool, scope, async (client) => {
    await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'project:read')
    const rows = await client.query(
      'select * from repository_bindings where organization_id=$1 and project_id=$2 order by created_at',
      [scope.organizationId, scope.projectId]
    )
    return rows.rows.map(mapRepository)
  })
}
export async function saveRepository(
  pool: DatabasePool,
  scope: Scope & { projectId: string; repositoryId?: string; expectedVersion?: number } & z.infer<typeof repoBody>
) {
  return transaction(pool, scope, async (client) => {
    await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'automation:manage')
    await client.query('select id from projects where id=$1 for update', [scope.projectId])
    let row: Record<string, any>
    if (scope.repositoryId) {
      const found = await client.query(
        'select * from repository_bindings where organization_id=$1 and project_id=$2 and id=$3 for update',
        [scope.organizationId, scope.projectId, scope.repositoryId]
      )
      if (!found.rows[0]) fail('Repository not found.', 404)
      if (Number(found.rows[0].version) !== scope.expectedVersion)
        fail('The repository changed. Reload before trying again.')
      row = (
        await client.query(
          `update repository_bindings set name=$2,clone_url=$3,base_branch=$4,
        disabled_at=case when $5 then now() else null end,version=version+1,updated_at=now() where id=$1 returning *`,
          [scope.repositoryId, scope.name, scope.cloneUrl || null, scope.baseBranch, scope.disabled]
        )
      ).rows[0]
    } else {
      row = (
        await client.query(
          `insert into repository_bindings(organization_id,project_id,name,clone_url,base_branch)
        values($1,$2,$3,$4,$5) returning *`,
          [scope.organizationId, scope.projectId, scope.name, scope.cloneUrl || null, scope.baseBranch]
        )
      ).rows[0]
    }
    if (scope.makeDefault && !scope.disabled)
      await client.query('update projects set default_repository_binding_id=$2 where id=$1', [scope.projectId, row.id])
    if (!scope.makeDefault || scope.disabled)
      await client.query(
        'update projects set default_repository_binding_id=null where id=$1 and default_repository_binding_id=$2',
        [scope.projectId, row.id]
      )
    await appendDomainEvent(client, {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      type: 'repository.updated',
      aggregateType: 'repository',
      aggregateId: row.id,
      actor: { type: 'human', userId: scope.userId },
      data: { disabled: scope.disabled, baseBranch: scope.baseBranch },
    })
    return mapRepository(row)
  })
}
