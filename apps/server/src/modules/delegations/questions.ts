/**
 * Questions a stage raised while it ran.
 *
 * A stage executes in its own chat session, so the question lives there. This module exposes only the
 * questions that belong to one delegation task and answers them through the same path the chat uses, so
 * there is a single rule for deciding an interaction. The chat session belongs to the person who owns the
 * task, so only they can see or answer it; anyone else is told so instead of receiving an empty list.
 */
import { chatDecisionSchema, type ChatDecision, type ProjectChatInteraction } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { decideInteraction } from '../project-chat/interactions.js'
import { mapInteraction, mapSession } from '../project-chat/service.js'
import { appendDelegationEvent, delegationFail, loadTaskRow } from './repository.js'
import { delegationTransaction, type DelegationScope } from './service.js'

export interface DelegationQuestion {
  interaction: ProjectChatInteraction
  stageId: string | null
  sessionId: string
}

function assertOwner(scope: DelegationScope, ownerUserId: string) {
  if (scope.userId !== ownerUserId)
    delegationFail('Only the person who owns this task can read or answer the questions it raised.', 403)
}

export async function listDelegationQuestions(
  pool: DatabasePool,
  scope: DelegationScope,
  taskId: string
): Promise<DelegationQuestion[]> {
  return delegationTransaction(pool, scope, false, async (client) => {
    const task = await loadTaskRow(client, scope, taskId)
    assertOwner(scope, task.ownerUserId)
    const rows = await client.query(
      `select i.*, s.delegation_stage_id from chat_interactions i
       join chat_sessions s on s.id = i.session_id
       where i.organization_id=$1 and s.delegation_task_id=$2 and i.state='pending'
       order by i.created_at`,
      [scope.organizationId, task.id]
    )
    return rows.rows.map((row) => ({
      interaction: mapInteraction(row),
      stageId: row.delegation_stage_id ? String(row.delegation_stage_id) : null,
      sessionId: String(row.session_id),
    }))
  })
}

export async function answerDelegationQuestion(
  pool: DatabasePool,
  scope: DelegationScope,
  input: { taskId: string; interactionId: string; expectedVersion: number; decision: ChatDecision }
): Promise<DelegationQuestion> {
  const decision = chatDecisionSchema.parse(input.decision)
  return delegationTransaction(pool, scope, true, async (client) => {
    const task = await loadTaskRow(client, scope, input.taskId)
    assertOwner(scope, task.ownerUserId)
    const rows = await client.query(
      `select i.id, i.session_id, s.delegation_stage_id from chat_interactions i
       join chat_sessions s on s.id = i.session_id
       where i.organization_id=$1 and s.delegation_task_id=$2 and i.id=$3`,
      [scope.organizationId, task.id, input.interactionId]
    )
    const row = rows.rows[0]
    if (!row) delegationFail('Question not found on this task.', 404)
    const sessionRow = await client.query('select * from chat_sessions where id=$1 for update', [row.session_id])
    if (!sessionRow.rows[0]) delegationFail('The execution that raised this question is gone.', 409)
    const decided = await decideInteraction(
      client,
      mapSession(sessionRow.rows[0]),
      input.interactionId,
      input.expectedVersion,
      decision
    )
    await appendDelegationEvent(client, task, 'question.answered', {
      interactionId: input.interactionId,
      stageId: row.delegation_stage_id ?? null,
      decision: decision.type,
    })
    return {
      interaction: decided.interaction,
      stageId: row.delegation_stage_id ? String(row.delegation_stage_id) : null,
      sessionId: String(row.session_id),
    }
  })
}
