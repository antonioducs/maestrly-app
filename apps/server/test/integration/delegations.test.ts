import { describe, expect, it } from 'vitest'
import { delegationCatalogRevision, delegationModelCatalogSchema, type DelegationModelCatalog } from '@maestrly/protocol'
import { inTenantTransaction } from '../../src/db/transaction.js'
import { teamTransaction } from '../../src/modules/access/team.js'
import { applyDelegationCommand } from '../../src/modules/delegations/commands.js'
import { publishDelegationCatalog } from '../../src/modules/delegations/model-catalog.js'
import { listDelegationPresets } from '../../src/modules/delegations/presets.js'
import {
  createDelegation,
  getDelegation,
  listDelegationEvents,
  listDelegations,
} from '../../src/modules/delegations/service.js'
import { createProject } from '../../src/modules/projects/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

const links = { webOrigin: 'http://127.0.0.1:4173' }

const features = {
  checks: [{ id: 'unit', label: 'Unit tests', description: '', required: true, mutatesWorkspace: false }],
  github: { available: true, login: 'octocat', issue: null },
  preview: { available: true, issue: null },
  maestro: true,
  subagents: true,
  browserInspect: true,
  browserInteract: false,
}

function executorCatalog(projectId: string, workspaceKey = 'workspace-key'): DelegationModelCatalog {
  const models = [
    {
      selectionId: 'sel-opus',
      modelLabel: 'claude-opus-5',
      accountLabel: 'Claude · personal',
      efforts: ['low', 'medium', 'high'],
      fastMode: true,
      executionModes: ['standard', 'maestro'],
      delegationProfiles: ['general-purpose'],
      harnessProfileId: null,
      harnessHash: null,
    },
    {
      selectionId: 'sel-astra',
      modelLabel: 'gpt-6-astra',
      accountLabel: 'Codex · personal',
      efforts: ['medium', 'high', 'xhigh'],
      fastMode: false,
      executionModes: ['standard'],
      delegationProfiles: [],
      harnessProfileId: 'openai-gpt-6-astra-v1',
      harnessHash: null,
    },
  ]
  const workspaces = [
    { projectId, key: workspaceKey, label: 'Repo', branches: ['main', 'develop'], repositoryBindingId: null },
  ]
  return delegationModelCatalogSchema.parse({
    capability: 'delegation:stages:v1',
    enabled: true,
    revision: delegationCatalogRevision({ models: models as never, features, workspaces }),
    generatedAt: new Date().toISOString(),
    workspaces,
    models,
    features,
    issues: [],
  })
}

async function fixture(pool: ReturnType<typeof runtimePool>, name: string) {
  const owner = 'deleg-owner-' + crypto.randomUUID()
  const organizationId = await seedOrganization(name, owner)
  const project = await createProject(pool, { organizationId, actorUserId: owner, name })
  const projectId = project.project.id
  const enrollment = await createRunnerEnrollment(pool, { organizationId, userId: owner, projectIds: [projectId] })
  const executor = await enrollRunner(pool, {
    organizationId,
    token: enrollment.token,
    name: 'Team executor',
    protocolVersion: '1.0',
    capabilities: [{ name: 'executor:maestrly' }],
    maxConcurrency: 1,
  })
  await inTenantTransaction(
    pool,
    { organizationId, actor: { type: 'runner', runnerId: executor.runnerId } },
    (client) =>
      publishDelegationCatalog(client, { organizationId, runnerId: executor.runnerId, catalog: executorCatalog(projectId) })
  )
  const board = await getBoard(pool, { organizationId, userId: owner, boardId: project.boardId })
  return { owner, organizationId, projectId, executorId: executor.runnerId, boardId: board.board.id }
}

describe.skipIf(!integrationAvailable)('delegation tasks', () => {
  it('creates a card-linked pipeline with resolved per-stage settings and survives a reload', async () => {
    const pool = runtimePool()
    try {
      const { owner, organizationId, projectId, executorId, boardId } = await fixture(pool, 'Delegation domain')
      const scope = { organizationId, projectId, userId: owner }
      const view = await createDelegation(
        pool,
        scope,
        {
          boardId,
          title: 'Implement with Opus and review with Astra',
          objective: 'Deliver the feature',
          acceptanceCriteria: ['Tests pass'],
          executorId,
          workspaceKey: 'workspace-key',
          baseBranch: 'main',
          stages: [
            {
              type: 'implement',
              title: 'Implement',
              instructions: 'Implement the card',
              dependsOn: [],
              requiredForCompletion: true,
              settings: { selectionId: 'sel-opus', reasoning: 'high', fastMode: false },
            },
            {
              type: 'review',
              title: 'Independent review',
              instructions: '',
              dependsOn: [0],
              requiredForCompletion: true,
              settings: { selectionId: 'sel-astra', reasoning: 'xhigh' },
            },
            {
              type: 'verify',
              title: 'Run checks',
              instructions: '',
              dependsOn: [1],
              requiredForCompletion: true,
              action: { kind: 'checks', checkIds: ['unit'] },
            },
          ],
          dependsOnTaskIds: [],
          start: false,
        },
        links
      )
      expect(view.task.state).toBe('draft')
      expect(view.task.version).toBe(1)
      expect(view.stages).toHaveLength(3)
      expect(view.stages[0]!.settings).toMatchObject({ selectionId: 'sel-opus', reasoning: 'high', fastMode: false })
      expect(view.stages[1]!.settings).toMatchObject({ selectionId: 'sel-astra', reasoning: 'xhigh' })
      expect(view.stages[1]!.dependsOn).toEqual([view.stages[0]!.id])
      expect(view.stages[2]!.settings).toBeNull()
      expect(view.stages[2]!.action).toEqual({ kind: 'checks', checkIds: ['unit'] })
      expect(view.links.card).toContain(view.task.cardId)

      // A fresh read after the transaction closed returns the same pipeline.
      const reloaded = await getDelegation(pool, scope, view.task.id, links)
      expect(reloaded.stages.map((stage) => stage.title)).toEqual(['Implement', 'Independent review', 'Run checks'])
      const listed = await listDelegations(pool, scope, {}, links)
      expect(listed.items.map((item) => item.task.id)).toContain(view.task.id)
      const events = await listDelegationEvents(pool, scope, view.task.id, 0)
      expect(events.map((event) => event.type)).toEqual(['task.created'])
    } finally {
      await pool.end()
    }
  })

  it('refuses an unavailable selection, branch, workspace or cycle', async () => {
    const pool = runtimePool()
    try {
      const { owner, organizationId, projectId, executorId, boardId } = await fixture(pool, 'Delegation validation')
      const scope = { organizationId, projectId, userId: owner }
      const base = {
        boardId,
        title: 'Validation',
        objective: '',
        acceptanceCriteria: [],
        executorId,
        workspaceKey: 'workspace-key',
        baseBranch: 'main',
        dependsOnTaskIds: [],
        start: false,
      }
      const stage = (settings: Record<string, unknown>) => ({
        type: 'implement' as const,
        title: 'Implement',
        instructions: '',
        dependsOn: [],
        requiredForCompletion: true,
        settings,
      })
      await expect(
        createDelegation(pool, scope, { ...base, stages: [stage({ selectionId: 'ghost' })] }, links)
      ).rejects.toThrow(/no longer available/)
      await expect(
        createDelegation(pool, scope, { ...base, stages: [stage({ selectionId: 'sel-astra', reasoning: 'low' })] }, links)
      ).rejects.toThrow(/unavailable for this model/)
      await expect(
        createDelegation(pool, scope, { ...base, stages: [stage({ selectionId: 'sel-astra', fastMode: true })] }, links)
      ).rejects.toThrow(/Fast mode is unavailable/)
      await expect(
        createDelegation(
          pool,
          scope,
          { ...base, baseBranch: 'missing', stages: [stage({ selectionId: 'sel-opus' })] },
          links
        )
      ).rejects.toThrow(/base branch is not available/)
      await expect(
        createDelegation(
          pool,
          scope,
          { ...base, workspaceKey: 'other', stages: [stage({ selectionId: 'sel-opus' })] },
          links
        )
      ).rejects.toThrow(/workspace is not available/)
      await expect(
        createDelegation(
          pool,
          scope,
          {
            ...base,
            stages: [
              { ...stage({ selectionId: 'sel-opus' }), dependsOn: [1] },
              stage({ selectionId: 'sel-opus' }),
            ],
          },
          links
        )
      ).rejects.toThrow(/earlier stage/)
    } finally {
      await pool.end()
    }
  })

  it('applies commands once per idempotency key and refuses a stale version', async () => {
    const pool = runtimePool()
    try {
      const { owner, organizationId, projectId, executorId, boardId } = await fixture(pool, 'Delegation commands')
      const scope = { organizationId, projectId, userId: owner }
      const view = await createDelegation(
        pool,
        scope,
        {
          boardId,
          title: 'Command flow',
          objective: '',
          acceptanceCriteria: [],
          executorId,
          workspaceKey: 'workspace-key',
          baseBranch: 'main',
          stages: [
            {
              type: 'implement',
              title: 'Implement',
              instructions: '',
              dependsOn: [],
              requiredForCompletion: true,
              settings: { selectionId: 'sel-opus', reasoning: 'medium' },
            },
          ],
          dependsOnTaskIds: [],
          start: false,
        },
        links
      )
      const started = await applyDelegationCommand(
        pool,
        scope,
        view.task.id,
        { type: 'start', expectedVersion: view.task.version },
        'start-once'
      )
      expect(started.state).toBe('queued')
      // The same key replays the recorded result instead of starting twice.
      const replay = await applyDelegationCommand(
        pool,
        scope,
        view.task.id,
        { type: 'start', expectedVersion: view.task.version },
        'start-once'
      )
      expect(replay).toEqual(started)
      // A different body under the same key is a conflict.
      await expect(
        applyDelegationCommand(
          pool,
          scope,
          view.task.id,
          { type: 'pause', expectedVersion: view.task.version, immediate: false },
          'start-once'
        )
      ).rejects.toThrow(/already used with different content/)
      // A stale expected version is refused.
      await expect(
        applyDelegationCommand(
          pool,
          scope,
          view.task.id,
          { type: 'pause', expectedVersion: view.task.version, immediate: false },
          'pause-stale'
        )
      ).rejects.toThrow(/changed after it was loaded/)

      const current = await getDelegation(pool, scope, view.task.id, links)
      const configured = await applyDelegationCommand(
        pool,
        scope,
        view.task.id,
        {
          type: 'configure',
          expectedVersion: current.task.version,
          target: 'stage',
          stageId: current.stages[0]!.id,
          settingsPatch: { selectionId: 'sel-astra', reasoning: 'high' },
          apply: 'after_current',
        },
        'configure-1'
      )
      expect(configured.settingsRevision).toBe(2)
      const afterConfigure = await getDelegation(pool, scope, view.task.id, links)
      expect(afterConfigure.stages[0]!.settings).toMatchObject({ selectionId: 'sel-astra', reasoning: 'high' })
      expect(afterConfigure.stages[0]!.settingsRevision).toBe(2)

      // Delivery modes the policy does not authorize are refused before any stage is created.
      await expect(
        applyDelegationCommand(
          pool,
          scope,
          view.task.id,
          { type: 'deliver', expectedVersion: afterConfigure.task.version, mode: 'ready_pr', expectedCodeRevision: null },
          'deliver-denied'
        )
      ).rejects.toThrow(/does not authorize ready_pr/)

      const cancelled = await applyDelegationCommand(
        pool,
        scope,
        view.task.id,
        { type: 'cancel', expectedVersion: afterConfigure.task.version, reason: 'no longer needed' },
        'cancel-1'
      )
      expect(cancelled.state).toBe('cancelled')
      await expect(
        applyDelegationCommand(
          pool,
          scope,
          view.task.id,
          { type: 'resume', expectedVersion: cancelled.version },
          'resume-after-cancel'
        )
      ).rejects.toThrow(/no longer accepts commands/)
      const events = await listDelegationEvents(pool, scope, view.task.id, 0)
      expect(events.map((event) => event.type)).toEqual([
        'task.created',
        'task.started',
        'task.configured',
        'task.cancelled',
      ])
    } finally {
      await pool.end()
    }
  })

  it('isolates tasks from users without project access and seeds built-in presets once', async () => {
    const pool = runtimePool()
    try {
      const { owner, organizationId, projectId, executorId, boardId } = await fixture(pool, 'Delegation access')
      const outsider = 'deleg-outsider-' + crypto.randomUUID()
      await teamTransaction(pool, { organizationId, projectId, userId: owner }, async (client) => {
        await client.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')", [
          organizationId,
          outsider,
        ])
      })
      const scope = { organizationId, projectId, userId: owner }
      const view = await createDelegation(
        pool,
        scope,
        {
          boardId,
          title: 'Private work',
          objective: '',
          acceptanceCriteria: [],
          executorId,
          workspaceKey: 'workspace-key',
          baseBranch: 'main',
          stages: [
            {
              type: 'implement',
              title: 'Implement',
              instructions: '',
              dependsOn: [],
              requiredForCompletion: true,
              settings: { selectionId: 'sel-opus' },
            },
          ],
          dependsOnTaskIds: [],
          start: false,
        },
        links
      )
      await expect(
        getDelegation(pool, { organizationId, projectId, userId: outsider }, view.task.id, links)
      ).rejects.toThrow()
      await expect(
        applyDelegationCommand(
          pool,
          { organizationId, projectId, userId: outsider },
          view.task.id,
          { type: 'start', expectedVersion: view.task.version },
          'outsider-start'
        )
      ).rejects.toThrow()

      const first = await listDelegationPresets(pool, scope)
      expect(first.filter((preset) => preset.builtIn).map((preset) => preset.name)).toEqual([
        'Follow a pull request',
        'Implement and review',
        'Reproduce and fix a bug',
        'Review an existing pull request',
      ])
      const second = await listDelegationPresets(pool, scope)
      expect(second.map((preset) => preset.id).sort()).toEqual(first.map((preset) => preset.id).sort())

      const preset = first.find((item) => item.name === 'Implement and review')!
      const fromPreset = await createDelegation(
        pool,
        scope,
        {
          boardId,
          title: 'Preset task',
          objective: '',
          acceptanceCriteria: [],
          executorId,
          workspaceKey: 'workspace-key',
          baseBranch: 'main',
          presetId: preset.id,
          stages: [
            {
              type: 'implement',
              title: 'Implement',
              instructions: '',
              dependsOn: [],
              requiredForCompletion: true,
              settings: { selectionId: 'sel-opus' },
            },
            {
              type: 'review',
              title: 'Review',
              instructions: '',
              dependsOn: [0],
              requiredForCompletion: true,
              settings: { selectionId: 'sel-astra' },
            },
          ],
          dependsOnTaskIds: [view.task.id],
          start: false,
        },
        links
      )
      expect(fromPreset.task.presetId).toBe(preset.id)
      expect(fromPreset.task.policy.completionTarget).toBe('patch_ready')
      // A cycle between tasks is rejected.
      await expect(
        applyDelegationCommand(
          pool,
          scope,
          fromPreset.task.id,
          { type: 'start', expectedVersion: fromPreset.task.version },
          'preset-start'
        )
      ).resolves.toMatchObject({ state: 'queued' })
    } finally {
      await pool.end()
    }
  })
})
