import { createProject } from '../../src/modules/projects/service.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { runnerTransaction } from '../../src/modules/project-chat/dispatch.js'
import { chatTransaction, createSession, enqueueMessage, ownedSession } from '../../src/modules/project-chat/service.js'
import { runtimePool, seedOrganization } from './helpers.js'

export async function chatFixture() {
  const pool = runtimePool(),
    userId = 'chat-' + crypto.randomUUID()
  const organizationId = await seedOrganization('Chat test', userId)
  const { project, boardId } = await createProject(pool, { organizationId, actorUserId: userId, name: 'Chat project' })
  const scope = { organizationId, projectId: project.id, userId }
  const enrollment = await createRunnerEnrollment(pool, { ...scope, projectIds: [project.id] })
  const runner = await enrollRunner(pool, {
    organizationId,
    token: enrollment.token,
    name: 'Fixture executor',
    protocolVersion: '1.0',
    maxConcurrency: 1,
    capabilities: [],
  })
  const identity = { organizationId, ...runner }
  await runnerTransaction(pool, identity, (c) =>
    c.query("update runners set chat_capabilities=$2,status='online',last_seen_at=now() where id=$1", [
      runner.runnerId,
      {
        capability: 'chat:interactive:v1',
        enabled: true,
        workspaces: [{ key: 'local', projectId: project.id, label: 'Fixture', branches: ['main'] }],
        models: [{ id: 'fixture', label: 'Fixture model' }],
        integrations: { memory: true, skills: true, mcp: true },
      },
    ])
  )
  const session = await createSession(pool, scope, {
    runnerId: runner.runnerId,
    workspaceKey: 'local',
    model: 'fixture',
    title: 'Project chat',
    baseBranch: 'main',
    mode: 'agent',
    boardId,
    cardId: null,
  })
  const send = (text: string, id = crypto.randomUUID()) =>
    chatTransaction(pool, scope, true, async (c) =>
      enqueueMessage(c, await ownedSession(c, scope, session.id, true), text, id)
    )
  return { pool, scope, identity, session, boardId, send }
}
