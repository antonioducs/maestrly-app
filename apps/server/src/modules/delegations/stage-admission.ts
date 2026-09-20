/**
 * Stage admission. One transaction records the attempt, its immutable snapshot, the chat session/turn that
 * carries the execution and the durable event, so a crash can never leave a queued stage without an
 * attempt or an attempt without a turn.
 */
import { randomUUID } from 'node:crypto'
import {
  assertStageSettingsStillValid,
  isAgentStageType,
  stageAttemptSchema,
  type DelegationModelCatalog,
  type DelegationTask,
  type StageAttempt,
  type StageDefinition,
} from '@maestrly/protocol'
import type { DatabaseClient } from '../../db/pool.js'
import { enqueueMessage, mapSession } from '../project-chat/service.js'
import { appendDelegationEvent, delegationFail, mapAttempt } from './repository.js'

const STAGE_GUIDANCE: Record<string, string> = {
  plan: 'Investigate and produce a concrete plan. Do not change files in this stage.',
  implement:
    'Implement the work end to end and verify it. Report what changed, what you verified and any blocker you could not resolve.',
  review:
    'Review the delivered change against the objective and acceptance criteria. You have read-only access: report structured findings instead of editing.',
  fix: 'Resolve the reported findings and verify the correction. Do not widen the change beyond the findings and the objective.',
  qa: 'Exercise the behaviour a user would see and report what you observed, with evidence.',
}

export function renderStagePrompt(task: DelegationTask, stage: StageDefinition): string {
  const lines = [
    '## Delegated task context',
    `- Task ID: ${task.id}`,
    `- Card ID: ${task.cardId} (use this exact id with the board tools)`,
    `- Project ID: ${task.projectId}`,
    `- Stage: ${stage.title} (${stage.type})`,
    `- Base branch: ${task.baseBranch}`,
    `- Completion target: ${task.policy.completionTarget}`,
  ]
  if (task.acceptanceCriteria.length)
    lines.push('', '### Acceptance criteria', ...task.acceptanceCriteria.map((item) => `- ${item}`))
  lines.push('', '### Objective', task.objective.trim() || task.title)
  const guidance = STAGE_GUIDANCE[stage.type]
  if (guidance) lines.push('', '### Stage contract', guidance)
  lines.push('', '## Instructions', stage.instructions.trim() || 'Complete this stage for the task above.')
  const prompt = lines.join('\n')
  if (prompt.length > 200_000) delegationFail('The rendered stage prompt is too long.', 400)
  return prompt
}

/** Review and inspect stages never receive write tools; the mode is part of the frozen snapshot. */
function chatModeFor(stage: StageDefinition): 'agent' | 'ask' {
  return stage.type === 'review' || stage.type === 'plan' || stage.type === 'inspect' ? 'ask' : 'agent'
}

function permissionModeFor(task: DelegationTask): 'ask' | 'auto' | 'full' {
  const autonomy = task.policy.autonomy
  if (autonomy.edit && autonomy.runChecks) return 'full'
  if (autonomy.edit) return 'auto'
  return 'ask'
}

async function sessionForStage(
  client: DatabaseClient,
  task: DelegationTask,
  stage: StageDefinition,
  selectionId: string
) {
  const existing = await client.query(
    'select * from chat_sessions where delegation_stage_id=$1 for update',
    [stage.id]
  )
  if (existing.rows[0]) {
    // Keep the session aligned with the configuration the new attempt was admitted with.
    const updated = await client.query(
      'update chat_sessions set model=$2, mode=$3, reasoning=$4, fast_mode=$5, perm_mode=$6, version=version+1, updated_at=now() where id=$1 returning *',
      [
        existing.rows[0].id,
        selectionId,
        chatModeFor(stage),
        stage.settings?.reasoning ?? null,
        stage.settings?.fastMode ?? false,
        permissionModeFor(task),
      ]
    )
    return mapSession(updated.rows[0]!)
  }
  const created = await client.query(
    `insert into chat_sessions(
       organization_id, project_id, owner_user_id, runner_id, workspace_key, title, model, mode, reasoning,
       fast_mode, perm_mode, base_branch, board_id, card_id, delegation_task_id, delegation_stage_id
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
    [
      task.organizationId,
      task.projectId,
      task.ownerUserId,
      task.executorId,
      task.workspaceKey,
      `${task.title.slice(0, 120)} · ${stage.title}`.slice(0, 160),
      selectionId,
      chatModeFor(stage),
      stage.settings?.reasoning ?? null,
      stage.settings?.fastMode ?? false,
      permissionModeFor(task),
      task.baseBranch,
      task.boardId,
      task.cardId,
      task.id,
      stage.id,
    ]
  )
  return mapSession(created.rows[0]!)
}

export interface AdmitStageInput {
  task: DelegationTask
  stage: StageDefinition
  catalog: DelegationModelCatalog
}

/**
 * Admit one stage. Agent stages revalidate their selection against the executor's live catalog; host
 * stages carry their structured action. The caller already holds the task lock.
 */
export async function admitStage(client: DatabaseClient, input: AdmitStageInput): Promise<StageAttempt> {
  const { task, stage, catalog } = input
  if (!['pending', 'queued'].includes(stage.state))
    delegationFail(`Stage "${stage.title}" is ${stage.state} and cannot be admitted.`, 409)
  const active = await client.query(
    "select 1 from delegation_attempts where stage_id=$1 and state in ('queued','running','waiting_input')",
    [stage.id]
  )
  if (active.rowCount) delegationFail('This stage already has a live attempt.', 409, 'STAGE_ALREADY_CLAIMED')

  const isAgent = isAgentStageType(stage.type)
  if (isAgent && !stage.settings) delegationFail('An agent stage needs resolved settings before admission.', 409)
  if (isAgent) assertStageSettingsStillValid(catalog, stage.settings!, catalog.revision)
  if (!isAgent && !stage.action) delegationFail('A host stage needs a structured action before admission.', 409)

  const attemptNumber = stage.attempts + 1
  const snapshot = {
    stageType: stage.type,
    title: stage.title,
    prompt: renderStagePrompt(task, stage),
    settings: stage.settings,
    action: stage.action,
    catalogRevision: catalog.revision,
    executorId: task.executorId,
    workspaceKey: task.workspaceKey,
    baseBranch: task.baseBranch,
    repositoryBindingId: task.repositoryBindingId,
    autonomy: task.policy.autonomy,
    limits: task.policy.limits,
  }

  const selectionId = stage.settings?.selectionId ?? `host:${stage.type}`
  const session = await sessionForStage(client, task, stage, selectionId)
  const turn = await enqueueMessage(client, session, snapshot.prompt, randomUUID())

  const inserted = await client.query(
    `insert into delegation_attempts(
       organization_id, project_id, task_id, stage_id, attempt, state, snapshot, session_id, turn_id
     ) values ($1,$2,$3,$4,$5,'queued',$6,$7,$8) returning *`,
    [
      task.organizationId,
      task.projectId,
      task.id,
      stage.id,
      attemptNumber,
      snapshot,
      session.id,
      turn.id,
    ]
  )
  await client.query(
    "update delegation_stages set state='queued', attempts=$2, version=version+1, updated_at=now() where id=$1",
    [stage.id, attemptNumber]
  )
  const attempt = mapAttempt(inserted.rows[0]!)
  await appendDelegationEvent(client, task, 'stage.queued', {
    stageId: stage.id,
    stageType: stage.type,
    attempt: attemptNumber,
    attemptId: attempt.id,
    selectionId: stage.settings?.selectionId ?? null,
    reasoning: stage.settings?.reasoning ?? null,
    fastMode: stage.settings?.fastMode ?? null,
    catalogRevision: catalog.revision,
  })
  return stageAttemptSchema.parse(attempt)
}
