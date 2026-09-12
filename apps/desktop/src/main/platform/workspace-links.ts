import { z } from 'zod'
import type { WorkspaceKanbanLink } from '../../shared/platform'
import { getWorkspace } from '../store'
import { platformConnections } from './connection-service'
import { platformProjectBindings } from './project-bindings'

const id = z.string().min(1).max(191)
const bindingSchema = z.object({
  workspaceId: id,
  connectionId: id,
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  boardId: z.string().uuid(),
  cardId: z.string().uuid().optional(),
  repositoryBindingId: z.string().uuid().optional(),
})

export async function validateWorkspaceBinding(input: unknown) {
  const binding = bindingSchema.parse(input)
  if (!getWorkspace(binding.workspaceId)) throw new Error('Local workspace not found.')
  const projects = await platformConnections.listProjects(binding.connectionId)
  const project = projects.find((p) => p.organizationId === binding.organizationId && p.projectId === binding.projectId)
  const board = project?.boards.find((b) => b.id === binding.boardId)
  if (!project || !board) throw new Error('The Kanban project or board is no longer available.')
  if (binding.repositoryBindingId && !project.repositories?.some((r) => r.id === binding.repositoryBindingId))
    throw new Error('The repository does not belong to this Kanban project.')
  return {
    ...binding,
    projectName: project.projectName,
    boardName: board.name,
    organizationName: project.organizationName,
  }
}

export function workspaceKanbanLinks(): WorkspaceKanbanLink[] {
  const connections = platformConnections.list()
  return platformProjectBindings.list().map((binding) => {
    const connection = connections.find((c) => c.id === binding.connectionId)
    let url = ''
    if (connection) {
      const target = new URL(connection.url)
      target.searchParams.set('organization', binding.organizationId)
      target.searchParams.set('project', binding.projectId)
      target.searchParams.set('board', binding.boardId)
      url = target.toString()
    }
    return {
      ...binding,
      url,
      state:
        connection?.state === 'connected'
          ? 'connected'
          : connection?.state === 'disconnected'
            ? 'disconnected'
            : 'unavailable',
    }
  })
}

/** Hydrate labels for links created by older desktops without blocking offline navigation. */
export async function refreshWorkspaceLinkLabels() {
  const ids = [...new Set(platformProjectBindings.list().map((b) => b.connectionId))]
  await Promise.allSettled(
    ids.map(async (connectionId) => {
      if (platformConnections.list().find((c) => c.id === connectionId)?.state !== 'connected') return
      const projects = await platformConnections.listProjects(connectionId)
      for (const binding of platformProjectBindings.list().filter((b) => b.connectionId === connectionId)) {
        const p = projects.find((p) => p.organizationId === binding.organizationId && p.projectId === binding.projectId)
        if (p)
          platformProjectBindings.set({
            ...binding,
            projectName: p.projectName,
            organizationName: p.organizationName,
            boardName: p.boards.find((b) => b.id === binding.boardId)?.name,
          })
      }
    })
  )
}
