import { describe, expect, it } from 'vitest'
import {
  delegationCatalogRevision,
  delegationModelCatalogSchema,
  resolveStageSettings,
  type DelegationModelCatalog,
} from '@maestrly/protocol'
import { createProject } from '../../src/modules/projects/service.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { registerPersonalDevice } from '../../src/modules/runners/personal-devices.js'
import { teamTransaction } from '../../src/modules/access/team.js'
import {
  executorDelegationCatalog,
  listDelegationExecutors,
  publishDelegationCatalog,
} from '../../src/modules/delegations/model-catalog.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'
import { inTenantTransaction } from '../../src/db/transaction.js'

const features = {
  checks: [{ id: 'unit', label: 'Unit tests', description: '', required: true, mutatesWorkspace: false }],
  github: { available: true, login: 'octocat', issue: null },
  preview: { available: true, issue: null },
  maestro: true,
  subagents: true,
  browserInspect: true,
  browserInteract: false,
}

function catalog(projectId: string, models: Array<Record<string, unknown>>): DelegationModelCatalog {
  const parsedModels = models.map((model) => ({
    selectionId: 'sel',
    modelLabel: 'model',
    accountLabel: 'Account',
    efforts: [],
    fastMode: false,
    executionModes: ['standard'],
    delegationProfiles: [],
    harnessProfileId: null,
    harnessHash: null,
    ...model,
  }))
  const workspaces = [
    { projectId, key: 'workspace-key', label: 'Repo', branches: ['main'], repositoryBindingId: null },
  ]
  return delegationModelCatalogSchema.parse({
    capability: 'delegation:stages:v1',
    enabled: true,
    revision: delegationCatalogRevision({ models: parsedModels as never, features, workspaces }),
    generatedAt: new Date().toISOString(),
    workspaces,
    models: parsedModels,
    features,
    issues: [],
  })
}

describe.skipIf(!integrationAvailable)('delegation catalog', () => {
  it('serves each executor inventory to authorized users only and refuses foreign workspaces', async () => {
    const pool = runtimePool()
    try {
      const owner = 'catalog-owner-' + crypto.randomUUID()
      const developer = 'catalog-dev-' + crypto.randomUUID()
      const outsider = 'catalog-outsider-' + crypto.randomUUID()
      const organizationId = await seedOrganization('Delegation catalog', owner)
      const project = await createProject(pool, { organizationId, actorUserId: owner, name: 'Catalog project' })
      const other = await createProject(pool, { organizationId, actorUserId: owner, name: 'Other project' })
      const projectId = project.project.id
      await teamTransaction(pool, { organizationId, projectId, userId: owner }, async (client) => {
        for (const user of [developer, outsider]) {
          await client.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')", [
            organizationId,
            user,
          ])
        }
        await client.query(
          "insert into project_members(organization_id,project_id,user_id,role) values($1,$2,$3,'contributor')",
          [organizationId, projectId, developer]
        )
      })

      const enrollment = await createRunnerEnrollment(pool, { organizationId, userId: owner, projectIds: [projectId] })
      const shared = await enrollRunner(pool, {
        organizationId,
        token: enrollment.token,
        name: 'Team executor',
        protocolVersion: '1.0',
        capabilities: [{ name: 'executor:maestrly' }],
        maxConcurrency: 1,
      })
      const personal = await registerPersonalDevice(pool, {
        organizationId,
        userId: developer,
        projectIds: [projectId],
        name: 'Dev laptop',
      })

      const opus = {
        selectionId: 'sel-opus',
        modelLabel: 'claude-opus-5',
        accountLabel: 'Claude · personal',
        efforts: ['low', 'medium', 'high'],
        fastMode: true,
        executionModes: ['standard', 'maestro'],
        delegationProfiles: ['general-purpose'],
      }
      const astra = {
        selectionId: 'sel-astra',
        modelLabel: 'gpt-6-astra',
        accountLabel: 'Codex · personal',
        efforts: ['medium', 'high', 'xhigh'],
      }
      const runnerContext = (runnerId: string) => ({
        organizationId,
        actor: { type: 'runner' as const, runnerId },
      })
      await inTenantTransaction(pool, runnerContext(shared.runnerId), (client) =>
        publishDelegationCatalog(client, {
          organizationId,
          runnerId: shared.runnerId,
          catalog: catalog(projectId, [opus, astra]),
        })
      )
      await inTenantTransaction(pool, runnerContext(personal.runnerId), (client) =>
        publishDelegationCatalog(client, {
          organizationId,
          runnerId: personal.runnerId,
          catalog: catalog(projectId, [astra]),
        })
      )

      // Publishing a workspace outside the executor's project scope is refused.
      await expect(
        inTenantTransaction(pool, runnerContext(shared.runnerId), (client) =>
          publishDelegationCatalog(client, {
            organizationId,
            runnerId: shared.runnerId,
            catalog: catalog(other.project.id, [astra]),
          })
        )
      ).rejects.toThrow(/outside this executor project scope/)

      const forDeveloper = await listDelegationExecutors(pool, { organizationId, projectId, userId: developer })
      expect(forDeveloper.map((executor) => executor.executorId).sort()).toEqual(
        [shared.runnerId, personal.runnerId].sort()
      )
      // The owner does not see another person's personal computer.
      const forOwner = await listDelegationExecutors(pool, { organizationId, projectId, userId: owner })
      expect(forOwner.map((executor) => executor.executorId)).toEqual([shared.runnerId])
      await expect(
        listDelegationExecutors(pool, { organizationId, projectId, userId: outsider })
      ).rejects.toThrow()

      const sharedCatalog = forDeveloper.find((executor) => executor.executorId === shared.runnerId)!.catalog
      expect(sharedCatalog.models.map((model) => model.selectionId)).toEqual(['sel-opus', 'sel-astra'])
      const resolved = resolveStageSettings(sharedCatalog, { selectionId: 'sel-opus', reasoning: 'high', fastMode: true })
      expect(resolved.settings).toMatchObject({ reasoning: 'high', fastMode: true })
      // The personal executor never offers the model it did not publish.
      const personalCatalog = forDeveloper.find((executor) => executor.executorId === personal.runnerId)!.catalog
      expect(() => resolveStageSettings(personalCatalog, { selectionId: 'sel-opus' })).toThrowError(
        /no longer available/
      )

      await inTenantTransaction(
        pool,
        { organizationId, projectId, actor: { type: 'human', userId: developer } },
        async (client) => {
          const live = await executorDelegationCatalog(client, {
            organizationId,
            projectId,
            executorId: shared.runnerId,
            userId: developer,
          })
          expect(live.revision).toBe(sharedCatalog.revision)
          await expect(
            executorDelegationCatalog(client, {
              organizationId,
              projectId: other.project.id,
              executorId: shared.runnerId,
              userId: developer,
            })
          ).rejects.toThrow(/not available for this project/)
        }
      )
    } finally {
      await pool.end()
    }
  })
})
