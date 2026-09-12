import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { linkedBoardToolSchemas as schemas, linkedBoardReadTools, type LinkedBoardToolName } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import type { HumanIdentity } from '../auth/routes.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import { createBoard, getBoard, listBoards } from '../boards/service.js'
import { createCard, getCardDetail, moveCard, updateCard } from '../cards/service.js'
import { chatCardSearchSchema, searchProjectCards } from '../cards/search.js'
import { createComment } from '../comments/service.js'
import {
  changeBoard,
  manageColumns,
  lifecycleCard,
  cardTimeline,
  descriptionHistory,
  restoreDescription,
  changeComment,
  fail,
} from './service.js'

type Scope = { organizationId: string; projectId: string; userId: string; conversationId: string }

/** The desktop supplies only its explicitly linked project; every resource is checked again on the server. */
export async function executeLinkedBoardTool(
  pool: DatabasePool,
  scope: Scope,
  name: LinkedBoardToolName,
  input: unknown,
  callId?: string
) {
  const actor = { type: 'desktop_agent' as const, userId: scope.userId, conversationId: scope.conversationId }
  const write = !linkedBoardReadTools.has(name)
  const body = schemas[name].parse(input)
  return inTenantTransaction(pool, { ...scope, actor }, async (client) => {
    await authorizeProject(
      client,
      scope.organizationId,
      scope.projectId,
      scope.userId,
      write ? 'work:write' : 'project:read'
    )
    // These resources are immutable in project ownership. Validate before any domain read or mutation.
    for (const field of ['boardId', 'cardId', 'parentCardId'] as const) {
      const resourceId = field in body ? (body as Record<string, unknown>)[field] : undefined
      if (!resourceId) continue
      const table = field === 'boardId' ? 'boards' : 'cards'
      const found = await client.query(`select id from ${table} where organization_id=$1 and project_id=$2 and id=$3`, [
        scope.organizationId,
        scope.projectId,
        resourceId,
      ])
      if (!found.rowCount) fail('Resource is outside the linked project.', 404)
    }
    const s = { ...scope, actor }
    const run = async () => {
      switch (name) {
        case 'board_list_members':
          return (
            await client.query(
              `
          select om.user_id as id,coalesce(u.name,om.user_id) as name,coalesce(pm.role,'maintainer') as role
          from organization_members om left join "user" u on u.id=om.user_id
          left join project_members pm on pm.organization_id=om.organization_id and pm.project_id=$2 and pm.user_id=om.user_id
          where om.organization_id=$1 and (pm.user_id is not null or om.role in ('owner','admin')) order by name`,
              [s.organizationId, s.projectId]
            )
          ).rows
        case 'board_list_boards':
          return listBoards(pool, { ...s, ...schemas.board_list_boards.parse(body) })
        case 'board_get_board': {
          const { board, columns } = await getBoard(pool, { ...s, ...schemas.board_get_board.parse(body) })
          return { board, columns }
        }
        case 'board_list_cards':
        case 'board_search_cards':
          return searchProjectCards(client, s.organizationId, s.projectId, chatCardSearchSchema.parse(body))
        case 'board_get_card':
          return getCardDetail(pool, { ...s, ...schemas.board_get_card.parse(body) })
        case 'board_card_history':
          return descriptionHistory(pool, { ...s, ...schemas.board_card_history.parse(body) })
        case 'board_card_events':
          return cardTimeline(pool, { ...s, ...schemas.board_card_events.parse(body) })
        case 'board_create_card':
        case 'board_create_subtask':
          return createCard(pool, { ...s, ...schemas.board_create_card.parse(body) })
        case 'board_update_card': {
          const { cardId, ...patch } = schemas.board_update_card.parse(body)
          return updateCard(pool, { ...s, cardId, patch })
        }
        case 'board_move_card': {
          const { cardId, ...move } = schemas.board_move_card.parse(body)
          return moveCard(pool, {
            ...s,
            cardId,
            move: { ...move, source: 'agent', allowAutomationChain: false, chainDepth: 0 },
          })
        }
        case 'board_comment':
          return createComment(pool, { ...s, ...schemas.board_comment.parse(body) })
        case 'board_update_comment':
          return changeComment(pool, { ...s, ...schemas.board_update_comment.parse(body) })
        case 'board_card_lifecycle':
          return lifecycleCard(pool, { ...s, ...schemas.board_card_lifecycle.parse(body) })
        case 'board_restore_description':
          return restoreDescription(pool, { ...s, ...schemas.board_restore_description.parse(body) })
        case 'board_create_board':
          return createBoard(pool, { ...s, ...schemas.board_create_board.parse(body) })
        case 'board_update_board':
          return changeBoard(pool, { ...s, ...schemas.board_update_board.parse(body) })
        case 'board_manage_columns':
          return manageColumns(pool, { ...s, ...schemas.board_manage_columns.parse(body) })
      }
    }
    if (!write) return run()
    if (!callId) fail('An idempotency key is required for changes.', 400)
    return (
      await executeIdempotent(
        pool,
        {
          organizationId: s.organizationId,
          actorId: s.userId,
          actor,
          key: callId,
          method: 'POST',
          path: `/projects/${s.projectId}/conversations/${s.conversationId}/board-tools/${name}`,
          body,
        },
        async () => ({ status: 200, body: await run() })
      )
    ).body
  })
}

export function registerLinkedBoardToolRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  authenticate: (r: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>
) {
  app.post('/api/v1/organizations/:organizationId/projects/:projectId/board-tools', async (request) => {
    const params = z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid() }).parse(request.params)
    const body = z
      .object({
        name: z.enum(Object.keys(schemas) as [LinkedBoardToolName, ...LinkedBoardToolName[]]),
        input: z.unknown(),
      })
      .strict()
      .parse(request.body)
    const human = await authenticate(request, linkedBoardReadTools.has(body.name) ? undefined : ['api:write'])
    if (!human) fail('Authentication required.', 401)
    const conversationId = z.string().min(1).max(191).parse(request.headers['x-maestrly-conversation-id'])
    const callId = z.string().min(8).max(128).optional().parse(request.headers['idempotency-key'])
    return executeLinkedBoardTool(
      pool,
      { ...params, userId: human.userId, conversationId },
      body.name,
      body.input,
      callId
    )
  })
}
