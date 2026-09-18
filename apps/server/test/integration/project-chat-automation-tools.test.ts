import { expect, it } from 'vitest'
import { integrationAvailable } from './helpers.js'
import { chatFixture } from './project-chat-fixture.js'
import { claimChat } from '../../src/modules/project-chat/dispatch.js'
import { executeChatTool } from '../../src/modules/project-chat/tools.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createProject } from '../../src/modules/projects/service.js'
import { inTenantTransaction } from '../../src/db/transaction.js'

it.skipIf(!integrationAvailable)(
  'shares the full linked catalog and automation services with audited, scoped retries',
  async () => {
    const f = await chatFixture()
    try {
      const { linkedBoardCatalog, columnAutomationSchema } = await import('@maestrly/protocol')
      const { executeLinkedBoardTool } = await import('../../src/modules/kanban/agent-routes.js')
      const { chatToolSchemas } = await import('../../src/modules/project-chat/tools.js')
      expect(Object.keys(chatToolSchemas).sort()).toEqual(linkedBoardCatalog.map((t) => t.name).sort())
      expect(linkedBoardCatalog).toHaveLength(32)
      await f.send('Configure and inspect this board')
      const claim = (await claimChat(f.pool, f.identity))!
      const run = (name: keyof typeof chatToolSchemas, input: unknown, key: string = crypto.randomUUID()) =>
        executeChatTool(f.pool, f.scope.organizationId, claim.token, name, input, key)
      const board = await getBoard(f.pool, { ...f.scope, boardId: f.boardId })
      const columnId = board.columns.find((c) => c.role === 'normal')!.id
      for (const [name, input] of [
        ['board_list_members', {}],
        ['board_list_boards', {}],
        ['board_get_board', { boardId: f.boardId }],
        ['board_automation_catalog', {}],
        ['board_column_config', { columnId }],
        ['board_column_automation_history', { columnId }],
      ] as const) {
        expect(await run(name, input)).toEqual(
          await executeLinkedBoardTool(f.pool, { ...f.scope, conversationId: f.session.id }, name, input)
        )
      }
      const config = columnAutomationSchema.parse({ enabled: false })
      const key = crypto.randomUUID(),
        input = { columnId, expectedPolicyId: null, config }
      const saved = (await run('board_set_column_agent', input, key)) as { policyId: string }
      expect(await run('board_set_column_agent', input, key)).toEqual(saved)
      await expect(run('board_set_column_agent', input)).rejects.toThrow(/changed/)
      await expect(
        run('board_set_column_agent', { ...input, config: { ...config, promptTemplate: 'Different' } }, key)
      ).rejects.toThrow(/idempotency/i)
      const card = (await run('board_create_card', {
        boardId: f.boardId,
        title: 'Automated card',
        labels: ['chat'],
      })) as { id: string }
      const preview = (await run('board_preview_automation', { cardId: card.id, columnId, promptTemplate: '{task_title}' })) as { prompt: string }
      expect(preview.prompt).toContain(`- Card ID: ${card.id}`)
      expect(preview.prompt.endsWith('## Instructions\nAutomated card')).toBe(true)
      await run('board_set_card_automation_override', { cardId: card.id, columnId, expectedVersion: 0, config: null })
      await expect(
        run('board_set_card_automation_override', { cardId: card.id, columnId, expectedVersion: 0, config: null })
      ).rejects.toThrow(/changed/)
      await run('board_release_card_automation', { cardId: card.id, columnId })
      await expect(run('board_execution_events', { cardId: card.id, runId: crypto.randomUUID() })).rejects.toThrow(
        /Run/
      )
      const other = await createProject(f.pool, {
        organizationId: f.scope.organizationId,
        actorUserId: f.scope.userId,
        name: 'Outside automation',
      })
      const otherBoard = await getBoard(f.pool, { ...f.scope, boardId: other.boardId })
      await expect(run('board_column_config', { columnId: otherBoard.columns[0].id })).rejects.toThrow(/outside/)
      await expect(
        run('board_create_subtask', {
          boardId: f.boardId,
          parentCardId: card.id,
          columnId: otherBoard.columns[0].id,
          title: 'Outside',
        })
      ).rejects.toThrow(/outside/)
      await inTenantTransaction(f.pool, { ...f.scope, actor: { type: 'human', userId: f.scope.userId } }, async (c) => {
        const events = await c.query(
          "select actor from domain_events where aggregate_id=$1 and type='column.automation_saved'",
          [columnId]
        )
        expect(events.rows[0].actor).toMatchObject({
          type: 'desktop_agent',
          userId: f.scope.userId,
          conversationId: f.session.id,
        })
        await c.query("update chat_sessions set mode='ask' where id=$1", [f.session.id])
      })
      await expect(run('board_set_column_agent', input, key)).rejects.toThrow(/read-only/)
      await expect(run('board_column_config', { columnId })).resolves.toBeDefined()
      await inTenantTransaction(f.pool, { ...f.scope, actor: { type: 'human', userId: f.scope.userId } }, async (c) => {
        await c.query("update chat_sessions set mode='agent' where id=$1", [f.session.id])
        await c.query("update organization_members set role='member' where organization_id=$1 and user_id=$2", [
          f.scope.organizationId,
          f.scope.userId,
        ])
        await c.query("update project_members set role='contributor' where project_id=$1 and user_id=$2", [
          f.scope.projectId,
          f.scope.userId,
        ])
      })
      // Contributor still has work:write and execution:request, but cannot replay a management mutation.
      await expect(run('board_set_column_agent', input, key)).rejects.toThrow(/authorized/)
      await expect(run('board_card_automation', { cardId: card.id, columnId })).resolves.toBeDefined()
    } finally {
      await f.pool.end()
    }
  }
)
