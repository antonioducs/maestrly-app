import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { makeWorkspace } from '../helpers/factories'
import { freshDb, closeDb } from '../helpers/db'
import { platformProjectBindings } from '../../src/main/platform/project-bindings'
import {
  workspaceKanbanLinks,
  validateWorkspaceBinding,
  refreshWorkspaceLinkLabels,
} from '../../src/main/platform/workspace-links'

const h = vi.hoisted(() => ({ projects: vi.fn(), state: 'connected' }))
vi.mock('../../src/main/platform/connection-service', () => ({
  platformConnections: {
    list: () => [{ id: 'connection', url: 'https://kanban.test', state: h.state }],
    listProjects: h.projects,
  },
}))
beforeEach(() => {
  freshDb()
  h.state = 'connected'
  h.projects.mockReset()
})
afterEach(closeDb)

it('validates project and repository ownership, hydrates old labels and retains them offline', async () => {
  const workspace = makeWorkspace(),
    binding = {
      workspaceId: workspace.id,
      connectionId: 'connection',
      organizationId: randomUUID(),
      projectId: randomUUID(),
      boardId: randomUUID(),
    }
  const project = {
    organizationId: binding.organizationId,
    projectId: binding.projectId,
    projectName: 'Maestrly',
    organizationName: 'Team',
    boards: [{ id: binding.boardId, name: 'Roadmap' }],
    repositories: [],
  }
  h.projects.mockResolvedValue([project])
  await expect(validateWorkspaceBinding({ ...binding, repositoryBindingId: randomUUID() })).rejects.toThrow(
    /repository/
  )
  await expect(validateWorkspaceBinding({ ...binding, projectId: randomUUID() })).rejects.toThrow(/no longer available/)
  platformProjectBindings.set(binding)
  await refreshWorkspaceLinkLabels()
  expect(workspaceKanbanLinks()[0]).toMatchObject({ projectName: 'Maestrly', boardName: 'Roadmap', state: 'connected' })
  const url = new URL(workspaceKanbanLinks()[0].url)
  expect(url.searchParams.get('project')).toBe(binding.projectId)
  expect(url.searchParams.get('organization')).toBe(binding.organizationId)
  expect(url.searchParams.get('board')).toBe(binding.boardId)
  h.state = 'disconnected'
  h.projects.mockRejectedValue(new Error('offline'))
  await refreshWorkspaceLinkLabels()
  expect(workspaceKanbanLinks()[0]).toMatchObject({ projectName: 'Maestrly', state: 'disconnected' })
  platformProjectBindings.remove(workspace.id)
  expect(workspaceKanbanLinks()).toEqual([])
})
