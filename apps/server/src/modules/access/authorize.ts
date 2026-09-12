import type { OrganizationRole, ProjectRole } from '@maestrly/protocol'
import type { DatabaseClient } from '../../db/pool.js'

export type ProjectPermission =
  | 'project:read'
  | 'work:write'
  | 'execution:request'
  | 'automation:manage'
  | 'runner:manage'
  | 'members:manage'

const projectGrants: Record<ProjectRole, ReadonlySet<ProjectPermission>> = {
  viewer: new Set(['project:read']),
  contributor: new Set(['project:read', 'work:write', 'execution:request']),
  maintainer: new Set(['project:read', 'work:write', 'execution:request', 'automation:manage', 'runner:manage', 'members:manage']),
}

export class AuthorizationError extends Error {
  constructor(message = 'The actor is not authorized for this project.') {
    super(message)
    this.name = 'AuthorizationError'
  }
}

export async function authorizeProject(
  client: DatabaseClient,
  organizationId: string,
  projectId: string,
  userId: string,
  permission: ProjectPermission,
): Promise<{ organizationRole: OrganizationRole; projectRole: ProjectRole | null }> {
  const result = await client.query<{ organization_role: OrganizationRole; project_role: ProjectRole | null }>(`
    select om.role as organization_role, pm.role as project_role
    from organization_members om
    left join project_members pm
      on pm.organization_id = om.organization_id and pm.user_id = om.user_id and pm.project_id = $2
    where om.organization_id = $1 and om.user_id = $3
  `, [organizationId, projectId, userId])
  const membership = result.rows[0]
  if (!membership) throw new AuthorizationError()
  if (membership.organization_role === 'owner' || membership.organization_role === 'admin') {
    return { organizationRole: membership.organization_role, projectRole: membership.project_role }
  }
  if (!membership.project_role || !projectGrants[membership.project_role].has(permission)) {
    throw new AuthorizationError()
  }
  return { organizationRole: membership.organization_role, projectRole: membership.project_role }
}

export async function authorizeOrganizationAdmin(
  client: DatabaseClient,
  organizationId: string,
  userId: string,
): Promise<OrganizationRole> {
  const result = await client.query<{ role: OrganizationRole }>(
    'select role from organization_members where organization_id = $1 and user_id = $2',
    [organizationId, userId],
  )
  const role = result.rows[0]?.role
  if (role !== 'owner' && role !== 'admin') throw new AuthorizationError('Organization administrator access is required.')
  return role
}
