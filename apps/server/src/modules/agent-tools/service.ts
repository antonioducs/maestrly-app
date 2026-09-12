import { createHash } from 'node:crypto'
import type { CardPatch, MoveCardRequest } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { createCard, updateCard, moveCard } from '../cards/service.js'
import { createComment } from '../comments/service.js'

const hash = (token: string) => createHash('sha256').update(token).digest()

export interface ExecutionScope {
  organizationId: string
  projectId: string
  boardId: string
  cardId: string
  runId: string
  runnerId: string
  requestedByUserId: string
  allowedOperations: string[]
}

export async function authenticateExecutionToken(
  pool: DatabasePool,
  organizationId: string,
  token: string,
): Promise<ExecutionScope | null> {
  return inTenantTransaction(pool, { organizationId, actor: { type: 'system', service: 'agent-tool-auth' } }, async (client) => {
    const result = await client.query<{
      organization_id: string; project_id: string; board_id: string; card_id: string; run_id: string;
      runner_id: string; requested_by_user_id: string; allowed_operations: string[]
    }>(`
      select t.organization_id, t.project_id, t.board_id, t.card_id, t.run_id,
        r.runner_id, j.requested_by_user_id, t.allowed_operations
      from execution_tokens t
      join runs r on r.id = t.run_id
      join jobs j on j.id = r.job_id
      where t.organization_id = $1 and t.token_hash = $2 and t.revoked_at is null and t.expires_at > now()
        and r.state in ('claimed', 'running', 'cancelling') and r.lease_expires_at > now()
    `, [organizationId, hash(token)])
    const row = result.rows[0]
    return row ? {
      organizationId: row.organization_id, projectId: row.project_id, boardId: row.board_id, cardId: row.card_id,
      runId: row.run_id, runnerId: row.runner_id, requestedByUserId: row.requested_by_user_id,
      allowedOperations: row.allowed_operations,
    } : null
  })
}

function assertOperation(scope: ExecutionScope, operation: string): void {
  if (!scope.allowedOperations.includes(operation)) throw new Error(`Execution is not allowed to perform ${operation}.`)
}

export async function listAuthorizedCards(pool: DatabasePool, scope: ExecutionScope) {
  assertOperation(scope, 'board:read')
  return inTenantTransaction(pool, {
    organizationId: scope.organizationId, projectId: scope.projectId,
    actor: { type: 'execution_agent', runId: scope.runId, runnerId: scope.runnerId, requestedByUserId: scope.requestedByUserId },
  }, async (client) => {
    const result = await client.query(`
      select id, title, description, acceptance_criteria as "acceptanceCriteria", priority, labels, version, column_id as "columnId"
      from cards where organization_id = $1 and project_id = $2 and board_id = $3 and archived_at is null order by column_id, position
    `, [scope.organizationId, scope.projectId, scope.boardId])
    return result.rows
  })
}

export async function updateAssignedCard(pool: DatabasePool, scope: ExecutionScope, patch: CardPatch) {
  assertOperation(scope, 'card:assigned:write')
  return updateCard(pool, {
    organizationId: scope.organizationId, cardId: scope.cardId, userId: scope.requestedByUserId, patch,
    actor: { type: 'execution_agent', runId: scope.runId, runnerId: scope.runnerId, requestedByUserId: scope.requestedByUserId },
  })
}

export async function commentOnAssignedCard(pool: DatabasePool, scope: ExecutionScope, body: string) {
  assertOperation(scope, 'comment:create')
  return createComment(pool, {
    organizationId: scope.organizationId, cardId: scope.cardId, userId: scope.requestedByUserId, body,
    actor: { type: 'execution_agent', runId: scope.runId, runnerId: scope.runnerId, requestedByUserId: scope.requestedByUserId },
  })
}

export async function moveAssignedCard(pool: DatabasePool, scope: ExecutionScope, move: MoveCardRequest) {
  assertOperation(scope, 'card:assigned:write')
  return moveCard(pool, {
    organizationId: scope.organizationId, cardId: scope.cardId, userId: scope.requestedByUserId,
    move: { ...move, source: 'agent' },
    actor: { type: 'execution_agent', runId: scope.runId, runnerId: scope.runnerId, requestedByUserId: scope.requestedByUserId },
  })
}

export async function createLinkedSubtask(
  pool: DatabasePool,
  scope: ExecutionScope,
  input: { title: string; description?: string },
) {
  assertOperation(scope, 'subtask:create')
  return createCard(pool, {
    organizationId: scope.organizationId, boardId: scope.boardId, parentCardId: scope.cardId,
    userId: scope.requestedByUserId, ...input,
    actor: { type: 'execution_agent', runId: scope.runId, runnerId: scope.runnerId, requestedByUserId: scope.requestedByUserId },
  })
}
