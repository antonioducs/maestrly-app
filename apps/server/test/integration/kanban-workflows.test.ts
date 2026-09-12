import { describe, expect, it } from 'vitest'
import { getBoard, createBoard, listBoards } from '../../src/modules/boards/service.js'
import { createProject } from '../../src/modules/projects/service.js'
import { createCard, updateCard, moveCard, getCardDetail } from '../../src/modules/cards/service.js'
import {
  manageColumns,
  changeBoard,
  lifecycleCard,
  descriptionHistory,
  restoreDescription,
  cardTimeline,
  changeComment,
  transaction,
} from '../../src/modules/kanban/service.js'
import { saveRepository } from '../../src/modules/kanban/repositories.js'
import { createComment } from '../../src/modules/comments/service.js'
import { createExecutionPolicy, assignColumnPolicy } from '../../src/modules/automation/policies.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { claimJob } from '../../src/modules/jobs/claim.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

describe.skipIf(!integrationAvailable)('complete Kanban workflows', () => {
  it('manages concurrent column edits, migrates without dispatch, preserves history and card lifecycle', async () => {
    const pool = runtimePool()
    try {
      const userId = 'kanban-' + crypto.randomUUID()
      const organizationId = await seedOrganization('Kanban', userId)
      const scope = { userId, organizationId }
      const project = await createProject(pool, { organizationId, actorUserId: userId, name: 'Kanban' })
      const boardId = project.boardId
      const initial = await getBoard(pool, { ...scope, boardId })
      const source=await manageColumns(pool,{...scope,boardId,expectedVersion:1,action:'create',name:'Inbox'})
      await expect(manageColumns(pool,{...scope,boardId,expectedVersion:2,action:'rename',columnId:initial.columns[0]!.id,name:'Not allowed'})).rejects.toThrow(/Fixed/)
      const policy = await createExecutionPolicy(pool, {
        ...scope,
        projectId: project.project.id,
        name: 'Review',
        taskType: 'code',
        executionProfileId: 'default',
        requiredCapabilities: [],
        repositoryBindingId: null,
        provider: 'codex',
        model: 'test',
        approvalRequired: false,
        maxDurationSeconds: 60,
        maxLogBytes: 1000,
        delivery: { mode: 'patch', requireHumanApproval: true },
        enabled: true,
      })
      await assignColumnPolicy(pool, {
        ...scope,
        projectId: project.project.id,
        columnId: initial.columns[1]!.id,
        policyId: policy.id,
      })
      const card = await createCard(pool, { ...scope, boardId, columnId:source.columnId,title: 'Parent', description: '# Original' })
      const child = await createCard(pool, { ...scope, boardId, parentCardId: card.id, columnId:source.columnId,title: 'Subtask' })
      await expect(createCard(pool, { ...scope, boardId, parentCardId: child.id, title: 'Too deep' })).rejects.toThrow(
        /top-level/
      )
      const edits = await Promise.allSettled([
        manageColumns(pool, {
          ...scope,
          boardId,
          expectedVersion: 2,
          action: 'rename',
          columnId: source.columnId,
          name: 'Ideas',
        }),
        manageColumns(pool, {
          ...scope,
          boardId,
          expectedVersion: 2,
          action: 'rename',
          columnId: source.columnId,
          name: 'Backlog 2',
        }),
      ])
      expect(edits.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      await expect(manageColumns(pool,{...scope,boardId,expectedVersion:3,action:'delete',columnId:source.columnId,destinationId:initial.columns[1]!.id,expectedCardIds:[card.id]})).rejects.toThrow(/contents changed/)
      await manageColumns(pool, {
        ...scope,
        boardId,
        expectedVersion: 3,
        action: 'delete',
        expectedCardIds:[card.id,child.id],
        columnId: source.columnId,
        destinationId: initial.columns[1]!.id,
      })
      const migrated = await getBoard(pool, { ...scope, boardId })
      expect(migrated.columns).toHaveLength(4)
      expect(migrated.cards.every((c) => c.columnId === initial.columns[1]!.id)).toBe(true)
      const jobs = await transaction(pool, scope, (c) =>
        c.query('select id from jobs where project_id=$1', [project.project.id])
      )
      expect(jobs.rowCount).toBe(0)
      const updated = await updateCard(pool, {
        ...scope,
        cardId: card.id,
        patch: { expectedVersion: 2, description: '# Revised' },
      })
      const history = await descriptionHistory(pool, { ...scope, cardId: card.id })
      expect(history.map((h) => h.body)).toEqual(['# Revised', '# Original'])
      const restored = await restoreDescription(pool, {
        ...scope,
        cardId: card.id,
        expectedVersion: updated.version,
        versionId: history[1]!.id,
      })
      expect(restored.description).toBe('# Original')
      expect(await descriptionHistory(pool, { ...scope, cardId: card.id })).toHaveLength(3)
      const comment = await createComment(pool, { ...scope, cardId: card.id, body: '**Hello**' })
      await changeComment(pool, {
        ...scope,
        cardId: card.id,
        commentId: comment.id,
        expectedVersion: 1,
        body: '**Edited**',
      })
      await expect(
        changeComment(pool, { ...scope, cardId: card.id, commentId: comment.id, expectedVersion: 1, deleted: true })
      ).rejects.toThrow(/comment changed/)
      await lifecycleCard(pool, { ...scope, cardId: card.id, expectedVersion: restored.version, action: 'archive' })
      const archived = await getBoard(pool, { ...scope, boardId })
      expect(archived.cards).toHaveLength(0)
      expect(archived.archivedCards).toHaveLength(2)
      await lifecycleCard(pool, { ...scope, cardId: card.id, expectedVersion: restored.version + 1, action: 'restore' })
      const timeline = await cardTimeline(pool, { ...scope, cardId: card.id, cursor: 0 })
      expect(timeline.items.some((e) => e.type === 'card.column_migrated')).toBe(true)
      await lifecycleCard(pool, { ...scope, cardId: card.id, expectedVersion: restored.version + 2, action: 'delete' })
      await expect(getCardDetail(pool, { ...scope, cardId: card.id })).rejects.toThrow(/not found/)
      expect((await getBoard(pool, { ...scope, boardId })).archivedCards).toHaveLength(0)
      expect(
        (
          await transaction(pool, scope, (c) =>
            c.query('select * from card_description_versions where card_id=$1', [card.id])
          )
        ).rowCount
      ).toBe(3)
      const extra = await createBoard(pool, {
        ...scope,
        projectId: project.project.id,
        name: 'Simple',
        template: 'simple',
      })
      expect((await getBoard(pool, { ...scope, boardId: extra.id })).columns).toHaveLength(2)
      await changeBoard(pool, { ...scope, boardId: extra.id, expectedVersion: 1, archived: true })
      expect((await listBoards(pool, { ...scope, projectId: project.project.id })).map((b) => b.id)).not.toContain(
        extra.id
      )
      await changeBoard(pool, { ...scope, boardId: extra.id, expectedVersion: 2, archived: false })
      expect(await listBoards(pool, { ...scope, projectId: project.project.id })).toHaveLength(2)
    } finally {
      await pool.end()
    }
  })

  it('claims only on an approved repository/branch and blocks deletion while a run is active', async () => {
    const pool = runtimePool()
    try {
      const userId = 'git-' + crypto.randomUUID(),
        organizationId = await seedOrganization('Git', userId),
        scope = { userId, organizationId }
      const created = await createProject(pool, { organizationId, actorUserId: userId, name: 'Git' })
      const projectId = created.project.id,
        boardId = created.boardId
      const repo = await saveRepository(pool, {
        ...scope,
        projectId,
        name: 'Source',
        baseBranch: 'release',
        disabled: false,
        makeDefault: true,
      })
      const board = await getBoard(pool, { ...scope, boardId })
      const parent = await createCard(pool, { ...scope, boardId, title: 'Parent' })
      const card = await createCard(pool, { ...scope, boardId, title: 'Task',parentCardId:parent.id })
      const policy = await createExecutionPolicy(pool, {
        ...scope,
        projectId,
        name: 'Code',
        taskType: 'code',
        executionProfileId: 'default',
        requiredCapabilities: [],
        repositoryBindingId: null,
        provider: 'codex',
        model: 'test',
        approvalRequired: false,
        maxDurationSeconds: 60,
        maxLogBytes: 1000,
        delivery: { mode: 'patch', requireHumanApproval: true },
        enabled: true,
      })
      await assignColumnPolicy(pool, { ...scope, projectId, columnId: board.columns[1]!.id, policyId: policy.id })
      await moveCard(pool, {
        ...scope,
        cardId: card.id,
        move: {
          expectedVersion: 1,
          targetColumnId: board.columns[1]!.id,
          targetPosition: 0,
          source: 'human',
          allowAutomationChain: false,
          chainDepth: 0,
        },
      })
      const enrollment = await createRunnerEnrollment(pool, { ...scope, projectIds: [projectId] })
      const runner = await enrollRunner(pool, {
        organizationId,
        token: enrollment.token,
        name: 'Fixture',
        protocolVersion: '1.0',
        capabilities: [],
        maxConcurrency: 1,
      })
      const identity = { organizationId, ...runner, protocolVersion: '1.0' }
      expect(await claimJob(pool, identity)).toBeNull()
      expect(
        await claimJob(pool, {
          ...identity,
          repositories: [{ bindingId: repo.id, available: true, branches: ['main'] }],
        })
      ).toBeNull()
      const claim = await claimJob(pool, {
        ...identity,
        repositories: [{ bindingId: repo.id, available: true, branches: ['release'] }],
      })
      expect(claim?.envelope.snapshot).toMatchObject({ repositoryBindingId: repo.id, repositoryBranch: 'release' })
      await expect(
        lifecycleCard(pool, { ...scope, cardId: parent.id, expectedVersion: parent.version, action: 'delete' })
      ).rejects.toThrow(/Cancel active/)
      await lifecycleCard(pool, { ...scope, cardId: parent.id, expectedVersion: parent.version, action: 'cancel' })
      expect((await getCardDetail(pool,{...scope,cardId:parent.id})).activeFamilyRuns).toBe(1)
      const state = await transaction(pool, scope, (c) =>
        c.query('select state from runs where id=$1', [claim!.envelope.runId])
      )
      expect(state.rows[0].state).toBe('cancelling')
      const outsider = 'viewer-' + crypto.randomUUID()
      await transaction(pool, scope, async (c) => {
        await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')", [
          organizationId,
          outsider,
        ])
        await c.query(
          "insert into project_members(organization_id,project_id,user_id,role) values($1,$2,$3,'viewer')",
          [organizationId, projectId, outsider]
        )
      })
      await expect(
        manageColumns(pool, {
          organizationId,
          userId: outsider,
          boardId,
          expectedVersion: 1,
          action: 'create',
          name: 'Denied',
        })
      ).rejects.toThrow(/authorized/)
      const foreignOrg = await seedOrganization('Other', 'other-' + crypto.randomUUID())
      await expect(descriptionHistory(pool, { organizationId: foreignOrg, userId, cardId: card.id })).rejects.toThrow(
        /not found/
      )
    } finally {
      await pool.end()
    }
  })
})
