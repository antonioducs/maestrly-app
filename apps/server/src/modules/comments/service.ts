import { cardScope, fail } from '../kanban/service.js'
import type { Actor, Comment } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { appendDomainEvent } from '../events/store.js'

export async function createComment(
  pool: DatabasePool,
  input: { organizationId: string; cardId: string; userId: string; body: string; actor?: Actor },
): Promise<Comment> {
  const actor = input.actor ?? { type: 'human' as const, userId: input.userId }
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor }, async (client) => {
    const current=await cardScope(client,input,input.cardId,true)
    if(current.archived_at) fail('Restore this card before editing it.')
    const card = await client.query<{ project_id: string; board_id: string }>('select project_id, board_id from cards where organization_id = $1 and id = $2', [input.organizationId, input.cardId])
    const scope = card.rows[0]
    if (!scope) throw new Error('Card not found.')
    await authorizeProject(client, input.organizationId, scope.project_id, input.userId, 'work:write')
    const author = actor.type === 'execution_agent' || actor.type === 'desktop_agent'
      ? { type: 'agent' as const, id: actor.type === 'execution_agent' ? actor.runId : actor.conversationId }
      : { type: 'human' as const, id: input.userId }
    const result = await client.query<{ id: string; created_at: Date }>(`
      insert into comments(organization_id, project_id, board_id, card_id, body, author_type, author_id)
      values ($1,$2,$3,$4,$5,$6,$7) returning id, created_at
    `, [input.organizationId, scope.project_id, scope.board_id, input.cardId, input.body, author.type, author.id])
    await appendDomainEvent(client, {
      organizationId: input.organizationId, projectId: scope.project_id, type: 'comment.created',
      aggregateType: 'card', aggregateId: input.cardId, actor, data: { commentId: result.rows[0]!.id },
    })
    return {
      id: result.rows[0]!.id, organizationId: input.organizationId, projectId: scope.project_id,
      boardId: scope.board_id, cardId: input.cardId, body: input.body, author,
      createdAt: result.rows[0]!.created_at.toISOString(),
    }
  })
}
