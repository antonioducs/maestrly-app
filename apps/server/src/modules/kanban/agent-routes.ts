import { requirePersonalDevice } from '../runners/personal-devices.js'
import { columnAutomationHistory } from '../automation/column-service.js'
import { executeAutomationTool } from './automation-tools.js'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  linkedBoardToolSchemas as schemas,
  linkedBoardReadTools,
  linkedBoardAutomationManageTools,
  linkedBoardExecutionTools,
  type LinkedBoardToolName,
} from '@maestrly/protocol'
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

type Scope = {
  organizationId: string
  projectId: string
  userId: string
  conversationId: string
  idempotencyPath?: string
}

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
    const grants = await authorizeProject(
      client,
      scope.organizationId,
      scope.projectId,
      scope.userId,
      write ? 'work:write' : 'project:read'
    )
    if (linkedBoardAutomationManageTools.has(name))
      await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'automation:manage')
    if (linkedBoardExecutionTools.has(name))
      await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'execution:request')
    // Check all resource ownership and relationships before even an idempotent replay.
    const values = body as Record<string, unknown>
    let boardId = values.boardId as string | undefined
    for (const field of ['boardId', 'cardId', 'parentCardId'] as const) {
      if (!values[field]) continue
      const table = field === 'boardId' ? 'boards' : 'cards'
      const found = await client.query(`select * from ${table} where organization_id=$1 and project_id=$2 and id=$3`, [
        scope.organizationId,
        scope.projectId,
        values[field],
      ])
      const resource = found.rows[0]
      if (!resource) fail('Resource is outside the linked project.', 404)
      if (field !== 'boardId') {
        if (boardId && boardId !== resource.board_id) fail('Card belongs to another board.', 400)
        boardId = resource.board_id
      }
    }
    const columnIds = ['columnId', 'targetColumnId', 'destinationId', 'backlogId', 'doneId'].flatMap((field) =>
      values[field] ? [values[field]] : []
    )
    if (Array.isArray(values.order)) columnIds.push(...values.order)
    for (const columnId of columnIds) {
      const found = await client.query(
        'select board_id from board_columns where organization_id=$1 and project_id=$2 and id=$3',
        [scope.organizationId, scope.projectId, columnId]
      )
      if (!found.rows[0]) fail('Column is outside the linked project.', 404)
      if (boardId && found.rows[0].board_id !== boardId) fail('Column belongs to another board.', 400)
    }
    for (const [field, table] of [
      ['commentId', 'comments'],
      ['versionId', 'card_description_versions'],
    ] as const) {
      if (!values[field]) continue
      if (
        !(
          await client.query(`select id from ${table} where organization_id=$1 and card_id=$2 and id=$3`, [
            scope.organizationId,
            values.cardId,
            values[field],
          ])
        ).rowCount
      )
        fail('Resource does not belong to this card.', 404)
    }
    if (
      values.runId &&
      !(
        await client.query(
          'select r.id from runs r join jobs j on j.id=r.job_id where r.organization_id=$1 and j.project_id=$2 and j.card_id=$3 and r.id=$4',
          [scope.organizationId, scope.projectId, values.cardId, values.runId]
        )
      ).rowCount
    )
      fail('Run does not belong to this card.', 404)
    if (name === 'board_update_comment') {
      const row = (
        await client.query('select author_type,author_id from comments where id=$1 and card_id=$2', [
          values.commentId,
          values.cardId,
        ])
      ).rows[0]
      const ownAgentComment =
        row?.author_type === 'agent' &&
        row.author_id === scope.conversationId &&
        !!(
          await client.query(
            `select 1 from domain_events where organization_id=$1 and aggregate_id=$2 and type='comment.created' and data->>'commentId'=$3 and actor->>'userId'=$4 and actor->>'conversationId'=$5 limit 1`,
            [scope.organizationId, values.cardId, values.commentId, scope.userId, scope.conversationId]
          )
        ).rowCount
      if (
        !(row?.author_type === 'human' && row.author_id === scope.userId) &&
        !ownAgentComment &&
        !['owner', 'admin'].includes(grants.organizationRole) &&
        grants.projectRole !== 'maintainer'
      )
        fail('Only the author or a maintainer can change this comment.', 403)
    }
    if (values.personalDeviceId)
      await requirePersonalDevice(client, { ...scope, deviceId: values.personalDeviceId as string })
    if (
      values.expectedPolicyId &&
      !(
        await client.query('select id from execution_policies where organization_id=$1 and project_id=$2 and id=$3', [
          scope.organizationId,
          scope.projectId,
          values.expectedPolicyId,
        ])
      ).rowCount
    )
      fail('Policy is outside the linked project.', 404)
    const config = values.config as Record<string, unknown> | null | undefined
    if (
      config?.repositoryBindingId &&
      !(
        await client.query('select id from repository_bindings where organization_id=$1 and project_id=$2 and id=$3', [
          scope.organizationId,
          scope.projectId,
          config.repositoryBindingId,
        ])
      ).rowCount
    )
      fail('Repository is outside the linked project.', 404)
    if (
      config?.targetRunnerId &&
      !(
        await client.query(
          'select runner_id from runner_project_bindings where organization_id=$1 and project_id=$2 and runner_id=$3',
          [scope.organizationId, scope.projectId, config.targetRunnerId]
        )
      ).rowCount
    )
      fail('Runner is outside the linked project.', 404)
    if (values.policyId) {
      const history = await columnAutomationHistory(pool, { ...scope, actor, columnId: values.columnId as string })
      if (!history.some((policy) => policy.id === values.policyId)) fail('Configuration version not found.', 404)
    }
    if (Array.isArray(values.expectedCardIds)) {
      for (const cardId of values.expectedCardIds) {
        if (
          !(
            await client.query(
              'select id from cards where organization_id=$1 and project_id=$2 and board_id=$3 and id=$4',
              [scope.organizationId, scope.projectId, values.boardId, cardId]
            )
          ).rowCount
        )
          fail('Card belongs to another board.', 404)
      }
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
        default:
          return executeAutomationTool(pool, s, name, body)
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
          path: s.idempotencyPath ?? `/projects/${s.projectId}/conversations/${s.conversationId}/board-tools/${name}`,
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
