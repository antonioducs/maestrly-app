import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { linkedBoardToolSchemas, linkedBoardReadTools, type LinkedBoardToolName } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { executeLinkedBoardTool } from '../kanban/agent-routes.js'
import { chatFail, mapSession } from './service.js'
import { tokenHash } from './dispatch.js'

export const chatToolSchemas = linkedBoardToolSchemas
type ToolName = LinkedBoardToolName
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
        if (!linkedBoardReadTools.has(name) && session.mode !== 'agent')
          chatFail('This conversation is read-only.', 403)
        return executeLinkedBoardTool(
          pool,
          {
            ...scope,
            conversationId: session.id,
            // Preserve the historical turn path and input hash for existing callId retries.
            idempotencyPath: '/chat/' + session.id + '/turn/' + row.turnId + '/tools/' + name,
          },
          name,
          input,
          callId
        )
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
        callId: z.string().min(1).max(191).optional(),
        idempotencyKey: z.string().min(1).max(191).optional(),
      })
      .strict()
      .parse(r.body)
    const key = body.idempotencyKey ?? body.callId
    if (!key) chatFail('A callId or idempotencyKey is required.', 400)
    return executeChatTool(pool, org, token, body.name, body.input, key)
  })
}
