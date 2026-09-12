import { randomUUID } from 'node:crypto'
import type { ChatDecision, ProjectChatSession } from '@maestrly/protocol'
import type { DatabaseClient } from '../../db/pool.js'
import { appendChatEvent, sameJson } from './events.js'
import { chatFail, enqueueMessage, mapInteraction, mapTurn } from './service.js'

export async function decideInteraction(
  c: DatabaseClient,
  s: ProjectChatSession,
  id: string,
  version: number,
  decision: ChatDecision
) {
  const row = (await c.query('select * from chat_interactions where session_id=$1 and id=$2 for update', [s.id, id]))
    .rows[0]
  if (!row) chatFail('Interaction not found.', 404)
  const interaction = mapInteraction(row)
  if (interaction.version !== version || interaction.payload.type !== decision.type)
    chatFail('This interaction has changed.')
  if (interaction.state === 'decided') {
    if (!sameJson(interaction.decision, decision)) chatFail('This interaction was already decided differently.')
    return { interaction }
  }
  if (interaction.state !== 'pending') chatFail('This interaction has expired.')
  const turn = mapTurn((await c.query('select * from chat_turns where id=$1', [interaction.turnId])).rows[0])
  if (decision.type === 'plan') {
    if (turn.state !== 'succeeded') chatFail('Wait for the plan turn to finish.')
    if (decision.action === 'revise' && !decision.feedback?.trim()) chatFail('Describe the requested changes.', 400)
  } else if (
    !['running', 'waiting_input'].includes(turn.state) ||
    !turn.leaseExpiresAt ||
    Date.parse(turn.leaseExpiresAt) <= Date.now()
  )
    chatFail('The execution was interrupted.')
  if (
    decision.type === 'question' &&
    interaction.payload.type === 'question' &&
    decision.answers.length !== interaction.payload.questions.length
  )
    chatFail('Answer each question.', 400)
  await c.query("update chat_interactions set state='decided',decision=$2 where id=$1", [id, decision])
  const resolved = { ...interaction, state: 'decided' as const, decision }
  await appendChatEvent(
    c,
    s,
    { type: 'interaction', interaction: resolved },
    'decision-' + id + '-' + version,
    interaction.turnId
  )
  if (decision.type === 'plan' && decision.action !== 'discard') {
    const text =
      decision.action === 'approve' ? 'Implement the approved plan.' : 'Revise the plan: ' + decision.feedback
    const next = await enqueueMessage(c, s, text, randomUUID(), { interaction, decision })
    return { interaction: resolved, turn: next }
  }
  return { interaction: resolved }
}
