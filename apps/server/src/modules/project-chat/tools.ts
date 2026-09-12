import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { cardPatchSchema } from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { createCard, updateCard, moveCard, getCardDetail } from '../cards/service.js'
import { createComment } from '../comments/service.js'
import { descriptionHistory } from '../kanban/service.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import { chatCardSearchSchema, searchProjectCards } from '../cards/search.js'
import { chatFail, mapSession } from './service.js'
import { tokenHash } from './dispatch.js'

const id = z.string().uuid(),
  empty = z.object({}).strict()
export const chatToolSchemas = {
  board_list_boards: empty,
  board_get_board: z.object({ boardId: id }).strict(),
  board_list_cards: chatCardSearchSchema,
  board_search_cards: chatCardSearchSchema,
  board_get_card: z.object({ cardId: id }).strict(),
  board_card_history: z.object({ cardId: id }).strict(),
  board_create_card: z
    .object({
      boardId: id,
      columnId: id.optional(),
      parentCardId: id.optional(),
      title: z.string().min(1).max(500),
      description: z.string().max(100000).optional(),
    })
    .strict(),
  board_update_card: cardPatchSchema.omit({ archived: true }).extend({ cardId: id }).strict(),
  board_comment: z.object({ cardId: id, body: z.string().min(1).max(100000) }).strict(),
  board_move_card: z
    .object({
      cardId: id,
      expectedVersion: z.number().int().positive(),
      targetColumnId: id,
      targetPosition: z.number().int().nonnegative(),
    })
    .strict(),
}
type ToolName = keyof typeof chatToolSchemas
const writes = new Set<ToolName>(['board_create_card', 'board_update_card', 'board_comment', 'board_move_card'])
async function projectResource(c: DatabaseClient, table: 'cards' | 'boards', projectId: string, id: string) {
  if (
    !(
      await c.query(
        `select id from ${table} where project_id=$1 and id=$2 ${table === 'cards' ? 'and deleted_at is null' : ''}`,
        [projectId, id]
      )
    ).rowCount
  )
    chatFail('Resource is outside this conversation project.', 404)
}
export async function executeChatTool(
  pool: DatabasePool,
  organizationId: string,
  token: string,
  name: ToolName,
  input: unknown,
  callId: string
) {
  return inTenantTransaction(
    pool,
    { organizationId, actor: { type: 'system', service: 'chat-reconcile' } },
    async (c) => {
      const row = (
        await c.query(
          `select s.*,t.id as "turnId" from chat_turn_tokens ct join chat_turns t on t.id=ct.turn_id join chat_sessions s on s.id=t.session_id
      join runners r on r.id=t.runner_id where ct.token_hash=$1 and ct.organization_id=$2 and ct.revoked_at is null and ct.expires_at>now()
      and t.lease_id=ct.lease_id and t.lease_expires_at>now() and t.state in ('running','waiting_input')
      and r.status<>'revoked' and (r.owner_user_id is null or (r.personal_enabled and r.owner_user_id=s.owner_user_id))
      and exists(select 1 from runner_project_bindings b where b.runner_id=r.id and b.project_id=s.project_id)
      and r.chat_capabilities->>'enabled'='true' for share of t`,
          [tokenHash(token), organizationId]
        )
      ).rows[0]
      if (!row) chatFail('Chat execution token is invalid or expired.', 401)
      const session = mapSession(row),
        scope = { organizationId, projectId: session.projectId, userId: session.ownerUserId }
      const actor = { type: 'desktop_agent' as const, userId: session.ownerUserId, conversationId: session.id }
      return inTenantTransaction(pool, { organizationId, projectId: session.projectId, actor }, async (c) => {
        await authorizeProject(c, organizationId, session.projectId, session.ownerUserId, 'execution:request')
        if (writes.has(name)) {
          if (session.mode !== 'agent') chatFail('This conversation is read-only.', 403)
          await authorizeProject(c, organizationId, session.projectId, session.ownerUserId, 'work:write')
        }
        const body = chatToolSchemas[name].parse(input)
        if ('cardId' in body) await projectResource(c, 'cards', session.projectId, body.cardId)
        if ('boardId' in body && body.boardId) await projectResource(c, 'boards', session.projectId, body.boardId)
        const run = async () => {
          switch (name) {
            case 'board_list_boards':
              return (
                await c.query(
                  'select id,name,archived_at as "archivedAt" from boards where project_id=$1 order by name,id',
                  [session.projectId]
                )
              ).rows
            case 'board_get_board':
              return (
                await c.query(
                  'select id,name,role,position,execution_policy_id as "executionPolicyId" from board_columns where board_id=$1 and deleted_at is null order by position',
                  [chatToolSchemas.board_get_board.parse(body).boardId]
                )
              ).rows
            case 'board_list_cards':
            case 'board_search_cards':
              return searchProjectCards(c, organizationId, session.projectId, chatCardSearchSchema.parse(body))
            case 'board_get_card':
              return getCardDetail(pool, {
                organizationId,
                cardId: chatToolSchemas.board_get_card.parse(body).cardId,
                userId: session.ownerUserId,
              })
            case 'board_card_history':
              return descriptionHistory(pool, {
                ...scope,
                cardId: chatToolSchemas.board_card_history.parse(body).cardId,
              })
            case 'board_create_card':
              return createCard(pool, {
                ...chatToolSchemas.board_create_card.parse(body),
                organizationId,
                userId: session.ownerUserId,
                actor,
              })
            case 'board_update_card': {
              const { cardId, ...patch } = chatToolSchemas.board_update_card.parse(body)
              return updateCard(pool, { organizationId, cardId, userId: session.ownerUserId, patch, actor })
            }
            case 'board_comment':
              return createComment(pool, {
                ...chatToolSchemas.board_comment.parse(body),
                organizationId,
                userId: session.ownerUserId,
                actor,
              })
            case 'board_move_card': {
              const { cardId, ...move } = chatToolSchemas.board_move_card.parse(body)
              return moveCard(pool, {
                organizationId,
                cardId,
                userId: session.ownerUserId,
                actor,
                move: { ...move, source: 'agent', allowAutomationChain: false, chainDepth: 0 },
              })
            }
          }
        }
        if (!writes.has(name)) return run()
        return (
          await executeIdempotent(
            pool,
            {
              organizationId,
              actorId: session.ownerUserId,
              actor,
              key: callId,
              method: 'POST',
              path: '/chat/' + session.id + '/turn/' + row.turnId + '/tools/' + name,
              body,
            },
            async () => ({ status: 200, body: await run() })
          )
        ).body
      })
    }
  )
}
export function registerChatToolRoutes(app: FastifyInstance, pool: DatabasePool) {
  app.post('/api/v1/runners/chat/tools', async (r) => {
    const org = z.string().uuid().parse(r.headers['x-maestrly-organization-id'])
    const token = r.headers.authorization?.startsWith('Chat ') ? r.headers.authorization.slice(5) : ''
    const body = z
      .object({
        name: z.enum(Object.keys(chatToolSchemas) as [ToolName, ...ToolName[]]),
        input: z.unknown(),
        callId: z.string().min(1).max(191),
      })
      .strict()
      .parse(r.body)
    return executeChatTool(pool, org, token, body.name, body.input, body.callId)
  })
}
