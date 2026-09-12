import type { Project } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeOrganizationAdmin, authorizeProject } from '../access/authorize.js'
import { appendDomainEvent } from '../events/store.js'

interface ProjectRow {
  id: string
  organization_id: string
  name: string
  description: string
  archived_at: Date | null
  created_at: Date
  updated_at: Date
  default_repository_binding_id?: string | null
  current_role?: string
}

export function mapProject(row: ProjectRow): Project & { currentRole?: string } {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    archivedAt: row.archived_at?.toISOString() ?? null,
    defaultRepositoryBindingId: row.default_repository_binding_id ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.current_role ? { currentRole: row.current_role } : {}),
  }
}

export async function createProject(
  pool: DatabasePool,
  input: { organizationId: string; actorUserId: string; name: string; description?: string },
): Promise<{ project: Project; boardId: string }> {
  return inTenantTransaction(pool, {
    organizationId: input.organizationId,
    actor: { type: 'human', userId: input.actorUserId },
  }, async (client) => {
    await authorizeOrganizationAdmin(client, input.organizationId, input.actorUserId)
    const projectResult = await client.query<ProjectRow>(`
      insert into projects(organization_id, name, description) values ($1, $2, $3) returning *
    `, [input.organizationId, input.name, input.description ?? ''])
    const project = projectResult.rows[0]!
    await client.query(`
      insert into project_members(organization_id, project_id, user_id, role)
      values ($1, $2, $3, 'maintainer')
      on conflict do nothing
    `, [input.organizationId, project.id, input.actorUserId])
    const board = await client.query<{ id: string }>(`
      insert into boards(organization_id, project_id, name) values ($1, $2, 'Delivery board') returning id
    `, [input.organizationId, project.id])
    const boardId = board.rows[0]!.id
    await client.query(`
      insert into board_columns(organization_id, project_id, board_id, name, position, role)
      values ($1, $2, $3, 'Backlog', 0,'backlog'), ($1, $2, $3, 'In progress', 1,'normal'), ($1, $2, $3, 'Review', 2,'normal'), ($1, $2, $3, 'Done', 3,'done')
    `, [input.organizationId, project.id, boardId])
    await client.query('update boards set roles_configured=true where id=$1',[boardId])
    await appendDomainEvent(client, {
      organizationId: input.organizationId,
      projectId: project.id,
      type: 'project.created', aggregateType: 'project', aggregateId: project.id,
      actor: { type: 'human', userId: input.actorUserId }, data: { boardId },
    })
    return { project: mapProject(project), boardId }
  })
}

export async function listProjects(pool: DatabasePool, organizationId: string, userId: string): Promise<Project[]> {
  return inTenantTransaction(pool, { organizationId, actor: { type: 'human', userId } }, async (client) => {
    const result = await client.query<ProjectRow>(`
      select distinct p.*, case when om.role in ('owner', 'admin') then 'maintainer' else pm.role end as current_role from projects p
      join organization_members om on om.organization_id = p.organization_id and om.user_id = $2
      left join project_members pm on pm.organization_id = p.organization_id and pm.project_id = p.id and pm.user_id = $2
      where p.organization_id = $1 and (om.role in ('owner', 'admin') or pm.user_id is not null)
      order by p.created_at
    `, [organizationId, userId])
    return result.rows.map(mapProject)
  })
}

export async function getProject(pool: DatabasePool, organizationId: string, projectId: string, userId: string): Promise<Project> {
  return inTenantTransaction(pool, { organizationId, projectId, actor: { type: 'human', userId } }, async (client) => {
    await authorizeProject(client, organizationId, projectId, userId, 'project:read')
    const result = await client.query<ProjectRow>('select * from projects where organization_id = $1 and id = $2', [organizationId, projectId])
    if (!result.rows[0]) throw new Error('Project not found.')
    return mapProject(result.rows[0])
  })
}

export async function updateProject(
  pool: DatabasePool,
  input: { organizationId: string; projectId: string; userId: string; name?: string; description?: string; archived?: boolean },
): Promise<Project> {
  return inTenantTransaction(pool, { organizationId: input.organizationId, projectId: input.projectId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    await authorizeProject(client, input.organizationId, input.projectId, input.userId, 'work:write')
    const current = await client.query<ProjectRow>('select * from projects where organization_id = $1 and id = $2 for update', [input.organizationId, input.projectId])
    if (!current.rows[0]) throw Object.assign(new Error('Project not found.'), { statusCode: 404 })
    const result = await client.query<ProjectRow>(`
      update projects set name = $3, description = $4, archived_at = $5, updated_at = now()
      where organization_id = $1 and id = $2 returning *
    `, [input.organizationId, input.projectId, input.name ?? current.rows[0].name, input.description ?? current.rows[0].description, input.archived === undefined ? current.rows[0].archived_at : input.archived ? new Date() : null])
    await appendDomainEvent(client, { organizationId: input.organizationId, projectId: input.projectId, type: input.archived ? 'project.archived' : 'project.updated', aggregateType: 'project', aggregateId: input.projectId, actor: { type: 'human', userId: input.userId } })
    return mapProject(result.rows[0]!)
  })
}
