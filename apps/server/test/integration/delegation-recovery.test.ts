import { describe, expect, it } from 'vitest'
import { delegationCatalogRevision, delegationModelCatalogSchema, type DelegationModelCatalog } from '@maestrly/protocol'
import { inTenantTransaction } from '../../src/db/transaction.js'
import { applyDelegationCommand } from '../../src/modules/delegations/commands.js'
import { publishDelegationCatalog } from '../../src/modules/delegations/model-catalog.js'
import { reconcileDelegations } from '../../src/modules/delegations/reconcile.js'
import { advanceDelegation, runDelegationScheduler } from '../../src/modules/delegations/scheduler.js'
import { createDelegation, getDelegation } from '../../src/modules/delegations/service.js'
import { reconcileChat } from '../../src/modules/project-chat/dispatch.js'
import { createProject } from '../../src/modules/projects/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createRunnerEnrollment, enrollRunner, revokeRunner } from '../../src/modules/runners/service.js'
import { teamTransaction } from '../../src/modules/access/team.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

const links = { webOrigin: 'http://127.0.0.1:4173' }

const features = {
  checks: [],
  github: { available: false, login: null, issue: null },
  preview: { available: false, issue: null },
  maestro: true,
  subagents: false,
  browserInspect: false,
  browserInteract: false,
}

const model = {
  selectionId: 'sel-opus',
  modelLabel: 'claude-opus-5',
  accountLabel: 'Claude · personal',
  efforts: ['medium', 'high'],
  fastMode: false,
  executionModes: ['standard'],
  delegationProfiles: [],
  harnessProfileId: null,
  harnessHash: null,
}

function catalogFor(projectId: string): DelegationModelCatalog {
  const workspaces = [
    { projectId, key: 'workspace-key', label: 'Repo', branches: ['main'], repositoryBindingId: null },
  ]
  return delegationModelCatalogSchema.parse({
    capability: 'delegation:stages:v1',
    enabled: true,
    revision: delegationCatalogRevision({ models: [model] as never, features, workspaces }),
    generatedAt: new Date().toISOString(),
    workspaces,
    models: [model],
    features,
    issues: [],
  })
}

async function fixture(pool: ReturnType<typeof runtimePool>, name: string) {
  const owner = 'rec-owner-' + crypto.randomUUID()
  const organizationId = await seedOrganization(name, owner)
  const project = await createProject(pool, { organizationId, actorUserId: owner, name })
  const projectId = project.project.id
  const enrollment = await createRunnerEnrollment(pool, { organizationId, userId: owner, projectIds: [projectId] })
  const executor = await enrollRunner(pool, {
    organizationId,
    token: enrollment.token,
    name: 'Executor',
    protocolVersion: '1.0',
    capabilities: [{ name: 'executor:maestrly' }],
    maxConcurrency: 2,
  })
  await inTenantTransaction(pool, { organizationId, actor: { type: 'runner', runnerId: executor.runnerId } }, (client) =>
    publishDelegationCatalog(client, { organizationId, runnerId: executor.runnerId, catalog: catalogFor(projectId) })
  )
  const board = await getBoard(pool, { organizationId, userId: owner, boardId: project.boardId })
  const scope = { organizationId, projectId, userId: owner }
  const task = await createDelegation(
    pool,
    scope,
    {
      boardId: board.board.id,
      title: name,
      objective: '',
      acceptanceCriteria: [],
      executorId: executor.runnerId,
      workspaceKey: 'workspace-key',
      baseBranch: 'main',
      stages: [
        {
          type: 'implement',
          title: 'Implement',
          instructions: '',
          dependsOn: [],
          requiredForCompletion: true,
          settings: { selectionId: 'sel-opus', reasoning: 'high' },
        },
      ],
      dependsOnTaskIds: [],
      start: false,
    },
    links
  )
  await applyDelegationCommand(pool, scope, task.task.id, { type: 'start', expectedVersion: task.task.version }, 'start')
  return { owner, organizationId, projectId, executorId: executor.runnerId, scope, taskId: task.task.id }
}

describe.skipIf(!integrationAvailable)('delegation recovery', () => {
  it('does not start a second attempt over the same workspace after a restart', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Recovery duplicate')
      await advanceDelegation(pool, { organizationId: context.organizationId, taskId: context.taskId })
      const first = await getDelegation(pool, context.scope, context.taskId, links)
      expect(first.attempts).toHaveLength(1)

      // Two concurrent schedulers, as if two API instances restarted at once.
      await Promise.all([runDelegationScheduler(pool, { organizationId: context.organizationId }),
        runDelegationScheduler(pool, { organizationId: context.organizationId }),
        reconcileDelegations(pool, { organizationId: context.organizationId })])
      const after = await getDelegation(pool, context.scope, context.taskId, links)
      expect(after.attempts).toHaveLength(1)
      expect(after.attempts[0]!.id).toBe(first.attempts[0]!.id)
      expect(after.stages[0]!.attempts).toBe(1)
    } finally {
      await pool.end()
    }
  })

  it('turns an expired lease into an interrupted stage that needs attention', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Recovery lease')
      await advanceDelegation(pool, { organizationId: context.organizationId, taskId: context.taskId })
      const claimed = await getDelegation(pool, context.scope, context.taskId, links)
      const turnId = claimed.attempts[0]!.turnId!
      await inTenantTransaction(
        pool,
        { organizationId: context.organizationId, actor: { type: 'runner', runnerId: context.executorId } },
        async (client) => {
          await client.query(
            "update chat_turns set state='running', lease_id=gen_random_uuid(), lease_expires_at=now()-interval '1 minute' where id=$1",
            [turnId]
          )
          await client.query("update delegation_attempts set state='running', started_at=now() where turn_id=$1", [turnId])
          await client.query("update delegation_stages set state='running' where id=$1", [claimed.stages[0]!.id])
        }
      )
      // The existing chat reconciler expires the lease; the delegation reconciler then settles the stage.
      await reconcileChat(pool)
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      await runDelegationScheduler(pool, { organizationId: context.organizationId })
      const after = await getDelegation(pool, context.scope, context.taskId, links)
      expect(after.attempts[0]!.state).toBe('interrupted')
      expect(after.stages[0]!.state).toBe('interrupted')
      expect(after.task.state).toBe('needs_attention')
      expect(after.task.blocker?.reason).toBe('awaiting_human_decision')
    } finally {
      await pool.end()
    }
  })

  it('blocks a task whose executor was revoked and one whose owner lost project access', async () => {
    const pool = runtimePool()
    try {
      const revokedContext = await fixture(pool, 'Recovery revoked executor')
      await revokeRunner(pool, {
        organizationId: revokedContext.organizationId,
        projectId: revokedContext.projectId,
        userId: revokedContext.owner,
        runnerId: revokedContext.executorId,
      })
      await reconcileDelegations(pool, { organizationId: revokedContext.organizationId })
      const revoked = await getDelegation(pool, revokedContext.scope, revokedContext.taskId, links)
      expect(revoked.task.state).toBe('needs_attention')
      expect(revoked.task.blocker?.reason).toBe('executor_offline')

      const accessContext = await fixture(pool, 'Recovery lost access')
      const contributor = 'rec-contributor-' + crypto.randomUUID()
      await teamTransaction(
        pool,
        { organizationId: accessContext.organizationId, projectId: accessContext.projectId, userId: accessContext.owner },
        async (client) => {
          await client.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')", [
            accessContext.organizationId,
            contributor,
          ])
          await client.query(
            "insert into project_members(organization_id,project_id,user_id,role) values($1,$2,$3,'contributor')",
            [accessContext.organizationId, accessContext.projectId, contributor]
          )
          // Reassign the task to the contributor, then remove that person's project access.
          await client.query('update delegation_tasks set owner_user_id=$2 where id=$1', [
            accessContext.taskId,
            contributor,
          ])
          await client.query('delete from project_members where organization_id=$1 and project_id=$2 and user_id=$3', [
            accessContext.organizationId,
            accessContext.projectId,
            contributor,
          ])
        }
      )
      await runDelegationScheduler(pool, { organizationId: accessContext.organizationId })
      const blocked = await getDelegation(pool, accessContext.scope, accessContext.taskId, links)
      expect(blocked.task.state).toBe('needs_attention')
      expect(blocked.task.blocker?.reason).toBe('permission_lost')
      expect(blocked.attempts).toHaveLength(0)
    } finally {
      await pool.end()
    }
  })

  it('marks a command that never applied as unresolved instead of replaying it', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Recovery pending command')
      await inTenantTransaction(
        pool,
        { organizationId: context.organizationId, actor: { type: 'human', userId: context.owner } },
        async (client) => {
          await client.query(
            `insert into delegation_commands(organization_id, project_id, task_id, idempotency_key, actor_user_id, command, expected_version, state, created_at)
             values($1,$2,$3,'stuck-key',$4,$5,1,'pending', now() - interval '10 minutes')`,
            [
              context.organizationId,
              context.projectId,
              context.taskId,
              context.owner,
              { type: 'start', expectedVersion: 1 },
            ]
          )
        }
      )
      await reconcileDelegations(pool, { organizationId: context.organizationId })
      const after = await getDelegation(pool, context.scope, context.taskId, links)
      expect(after.task.state).toBe('needs_attention')
      expect(after.task.blocker?.detail).toContain('did not complete')
      // The recorded key is refused instead of being replayed as a fresh command.
      await expect(
        applyDelegationCommand(
          pool,
          context.scope,
          context.taskId,
          { type: 'start', expectedVersion: 1 },
          'stuck-key'
        )
      ).rejects.toThrow(/already failed/)
    } finally {
      await pool.end()
    }
  })
})
