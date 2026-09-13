import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'
import { createProject } from '../../src/modules/projects/service.js'
import { executeLinkedBoardTool, registerLinkedBoardToolRoutes } from '../../src/modules/kanban/agent-routes.js'
import { AuthorizationError } from '../../src/modules/access/authorize.js'
import { inTenantTransaction } from '../../src/db/transaction.js'
import type { Board, Card, LinkedBoardToolName } from '@maestrly/protocol'

it.skipIf(!integrationAvailable)(
  'supports audited board operations, idempotency, project isolation and revoked write access',
  async () => {
    const pool = runtimePool(),
      userId = randomUUID()
    const organizationId = await seedOrganization('Linked workspace', userId)
    const { project, boardId } = await createProject(pool, {
      organizationId,
      actorUserId: userId,
      name: 'Linked project',
    })
    const scope = { organizationId, projectId: project.id, userId, conversationId: randomUUID() }
    const run = (name: LinkedBoardToolName, body: unknown, key = randomUUID()) =>
      executeLinkedBoardTool(pool, scope, name, body, key)
    const app = Fastify()
    // Same authorization mapping as the application host; this fixture isolates the new routes.
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AuthorizationError) return reply.code(403).send({ message: error.message })
      return reply.send(error)
    })
    let authenticatedUser = userId
    let scopes: readonly string[] | undefined
    registerLinkedBoardToolRoutes(app, pool, async (_r, requested) => {
      scopes = requested
      return { userId: authenticatedUser }
    })
    try {
      expect(await run('board_list_members', {})).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: userId })])
      )
      const boards = (await run('board_list_boards', {})) as Board[]
      expect(boards.map((b) => b.id)).toContain(boardId)
      const created = (await run('board_create_board', { name: 'Agent board', template: 'simple' })) as Board
      const column = (await run('board_manage_columns', {
        boardId: created.id,
        expectedVersion: created.version,
        action: 'create',
        name: 'Review',
      })) as { version: number; columnId: string }
      await run('board_update_board', { boardId: created.id, expectedVersion: column.version, name: 'Release board' })
      const key = randomUUID(),
        input = {
          boardId,
          title: 'Ship workspace link',
          description: 'Original',
          priority: 'high',
          labels: ['desktop'],
          assigneeUserIds: [userId],
        }
      const card = (await run('board_create_card', input, key)) as Card
      expect(await run('board_create_card', input, key)).toEqual(card)
      await expect(run('board_create_card', { ...input, title: 'Different' }, key)).rejects.toThrow(/idempotency/i)
      expect(card).toMatchObject({ priority: 'high', labels: ['desktop'], assigneeUserIds: [userId] })
      await run('board_create_subtask', { boardId, parentCardId: card.id, title: 'Test the bridge' })
      const comment = (await run('board_comment', { cardId: card.id, body: 'Work requested by the user' })) as {
        id: string
      }
      await run('board_update_comment', {
        cardId: card.id,
        commentId: comment.id,
        expectedVersion: 1,
        body: 'Updated comment',
      })
      const detail = (await run('board_get_card', { cardId: card.id })) as {
        card: Card
        comments: Array<{ authorType: string; body: string }>
        subtasks: unknown[]
      }
      expect(detail.comments[0]).toMatchObject({ authorType: 'agent', body: 'Updated comment' })
      expect(detail.subtasks).toHaveLength(1)
      const updated = (await run('board_update_card', {
        cardId: card.id,
        expectedVersion: 1,
        description: 'Revised',
      })) as Card
      await expect(
        run('board_update_card', { cardId: card.id, expectedVersion: 1, description: 'Stale' })
      ).rejects.toThrow(/changed/)
      const structure = (await run('board_get_board', { boardId })) as { columns: Array<{ id: string }> }
      const moved = (await run('board_move_card', {
        cardId: card.id,
        expectedVersion: updated.version,
        targetColumnId: structure.columns[1].id,
        targetPosition: 0,
      })) as { card: Card }
      await run('board_card_lifecycle', { cardId: card.id, expectedVersion: moved.card.version, action: 'archive' })
      const history = await run('board_card_history', { cardId: card.id })
      expect(history).toBeDefined()
      const archived = (await run('board_search_cards', { archived: true, query: 'workspace' })) as { items: Card[] }
      expect(archived.items.map((c) => c.id)).toContain(card.id)
      const other = await createProject(pool, { organizationId, actorUserId: userId, name: 'Outside' })
      await expect(run('board_create_card', { boardId: other.boardId, title: 'Forbidden' })).rejects.toThrow(/outside/)
      await expect(run('board_search_cards', { boardId: other.boardId })).rejects.toThrow(/outside/)
      await expect(
        run('board_create_subtask', { boardId: other.boardId, parentCardId: card.id, title: 'Forbidden parent' })
      ).rejects.toThrow(/outside/)
      const actor = { type: 'human' as const, userId }
      await inTenantTransaction(pool, { organizationId, actor }, async (client) => {
        const events = await client.query(
          "select actor from domain_events where project_id=$1 and actor->>'conversationId'=$2",
          [project.id, scope.conversationId]
        )
        expect(events.rowCount).toBeGreaterThanOrEqual(8)
        expect(events.rows.every((r) => r.actor.type === 'desktop_agent' && r.actor.userId === userId)).toBe(true)
        const jobs = await client.query('select id from jobs where project_id=$1', [project.id])
        expect(jobs.rows).toHaveLength(0)
      })
      const viewer = randomUUID()
      await inTenantTransaction(pool, { organizationId, actor }, async (client) => {
        await client.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')", [
          organizationId,
          viewer,
        ])
        await client.query(
          "insert into project_members(organization_id,project_id,user_id,role) values($1,$2,$3,'contributor')",
          [organizationId, project.id, viewer]
        )
      })
      const contributorScope = { ...scope, userId: viewer }
      const contributed = (await executeLinkedBoardTool(
        pool,
        contributorScope,
        'board_create_card',
        { boardId, title: 'Contributor work' },
        randomUUID()
      )) as Card
      const ownComment = (await executeLinkedBoardTool(
        pool,
        contributorScope,
        'board_comment',
        { cardId: contributed.id, body: 'Own comment' },
        randomUUID()
      )) as { id: string }
      await executeLinkedBoardTool(
        pool,
        contributorScope,
        'board_update_comment',
        { cardId: contributed.id, commentId: ownComment.id, expectedVersion: 1, body: 'Own update' },
        randomUUID()
      )
      // A conversation identifier alone never grants authorship of another user's agent comment.
      const ownerComment = (await run('board_comment', { cardId: contributed.id, body: 'Owner comment' })) as {
        id: string
      }
      await expect(
        executeLinkedBoardTool(
          pool,
          contributorScope,
          'board_update_comment',
          { cardId: contributed.id, commentId: ownerComment.id, expectedVersion: 1, body: 'Impersonation' },
          randomUUID()
        )
      ).rejects.toThrow(/author/)
      await inTenantTransaction(pool, { organizationId, actor }, async (client) => {
        await client.query("update project_members set role='viewer' where project_id=$1 and user_id=$2", [
          project.id,
          viewer,
        ])
      })
      authenticatedUser = viewer
      const request = {
        method: 'POST' as const,
        url: `/api/v1/organizations/${organizationId}/projects/${project.id}/board-tools`,
        headers: { 'x-maestrly-conversation-id': randomUUID(), 'idempotency-key': randomUUID() },
      }
      expect((await app.inject({ ...request, payload: { name: 'board_list_boards', input: {} } })).statusCode).toBe(200)
      expect(scopes).toBeUndefined()
      expect(
        (
          await app.inject({
            ...request,
            payload: { name: 'board_create_card', input: { boardId, title: 'No write' } },
          })
        ).statusCode
      ).toBe(403)
      expect(scopes).toEqual(['api:write'])
      await inTenantTransaction(pool, { organizationId, actor }, async (client) => {
        await client.query('delete from project_members where project_id=$1 and user_id=$2', [project.id, viewer])
      })
      expect((await app.inject({ ...request, payload: { name: 'board_list_boards', input: {} } })).statusCode).toBe(403)
    } finally {
      await app.close()
      await pool.end()
    }
  }
)
