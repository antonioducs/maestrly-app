/**
 * Row mapping and the few primitives every delegation service shares. Nothing here authorizes: callers
 * establish the tenant transaction and the project permission first.
 */
import {
  delegationEventSchema,
  delegationTaskSchema,
  stageAttemptSchema,
  stageDefinitionSchema,
  type DelegationEvent,
  type DelegationTask,
  type StageAttempt,
  type StageDefinition,
} from '@maestrly/protocol'
import type { DatabaseClient } from '../../db/pool.js'
import { enqueueConnectorNotifications } from '../connectors/notifications.js'

export function delegationFail(message: string, statusCode = 409, code?: string): never {
  throw Object.assign(new Error(message), { statusCode, ...(code ? { delegationCode: code } : {}) })
}

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

export function mapTask(row: Record<string, unknown>): DelegationTask {
  return delegationTaskSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    boardId: row.board_id,
    cardId: row.card_id,
    ownerUserId: row.owner_user_id,
    connectionId: row.connection_id ?? null,
    title: row.title,
    objective: row.objective,
    acceptanceCriteria: row.acceptance_criteria,
    executorId: row.executor_id,
    workspaceKey: row.workspace_key,
    baseBranch: row.base_branch,
    repositoryBindingId: row.repository_binding_id ?? null,
    presetId: row.preset_id ?? null,
    policy: row.policy,
    state: row.state,
    blocker: row.blocker ?? null,
    settingsRevision: Number(row.settings_revision),
    version: Number(row.version),
    eventSequence: Number(row.event_sequence),
    completedAt: iso(row.completed_at as Date | null),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  })
}

export function mapStage(row: Record<string, unknown>): StageDefinition {
  return stageDefinitionSchema.parse({
    id: row.id,
    type: row.type,
    title: row.title,
    instructions: row.instructions,
    position: Number(row.position),
    dependsOn: row.depends_on,
    settings: row.settings ?? null,
    action: row.action ?? null,
    requiredForCompletion: row.required_for_completion,
    state: row.state,
    attempts: Number(row.attempts),
    settingsRevision: Number(row.settings_revision),
    version: Number(row.version),
  })
}

export function mapAttempt(row: Record<string, unknown>): StageAttempt {
  return stageAttemptSchema.parse({
    id: row.id,
    taskId: row.task_id,
    stageId: row.stage_id,
    attempt: Number(row.attempt),
    state: row.state,
    snapshot: row.snapshot,
    sessionId: row.session_id ?? null,
    turnId: row.turn_id ?? null,
    receipt: row.receipt ?? null,
    codeRevision: row.code_revision ?? null,
    startedAt: iso(row.started_at as Date | null),
    finishedAt: iso(row.finished_at as Date | null),
    createdAt: (row.created_at as Date).toISOString(),
  })
}

export function mapDelegationEvent(row: Record<string, unknown>): DelegationEvent {
  return delegationEventSchema.parse({
    id: row.id,
    taskId: row.task_id,
    sequence: Number(row.sequence),
    type: row.type,
    data: row.data,
    createdAt: (row.created_at as Date).toISOString(),
  })
}

/**
 * Append a durable task event. The sequence is allocated from the task row in the same transaction, so a
 * later commit can never publish ahead of an earlier one.
 */
export async function appendDelegationEvent(
  client: DatabaseClient,
  task: Pick<DelegationTask, 'id' | 'organizationId' | 'projectId'>,
  type: string,
  data: Record<string, unknown> = {}
): Promise<DelegationEvent> {
  const sequence = Number(
    (
      await client.query<{ event_sequence: string }>(
        'update delegation_tasks set event_sequence = event_sequence + 1, updated_at = now() where organization_id=$1 and id=$2 returning event_sequence',
        [task.organizationId, task.id]
      )
    ).rows[0]!.event_sequence
  )
  const inserted = await client.query(
    'insert into delegation_events(organization_id, project_id, task_id, sequence, type, data) values($1,$2,$3,$4,$5,$6) returning *',
    [task.organizationId, task.projectId, task.id, sequence, type, data]
  )
  const event = mapDelegationEvent(inserted.rows[0]!)
  // Outbox: a connector notification is written in the same transaction as the event it describes.
  await enqueueConnectorNotifications(client, task, event)
  return event
}

export async function loadTaskRow(
  client: DatabaseClient,
  scope: { organizationId: string; projectId: string },
  taskId: string,
  lock: 'none' | 'share' | 'update' = 'none'
) {
  const rows = await client.query(
    `select * from delegation_tasks where organization_id=$1 and project_id=$2 and id=$3 ${
      lock === 'update' ? 'for update' : lock === 'share' ? 'for share' : ''
    }`,
    [scope.organizationId, scope.projectId, taskId]
  )
  if (!rows.rows[0]) delegationFail('Delegation task not found.', 404)
  return mapTask(rows.rows[0])
}

export async function loadStages(client: DatabaseClient, taskId: string): Promise<StageDefinition[]> {
  const rows = await client.query('select * from delegation_stages where task_id=$1 order by position', [taskId])
  return rows.rows.map(mapStage)
}

export async function loadAttempts(client: DatabaseClient, taskId: string, limit = 200): Promise<StageAttempt[]> {
  const rows = await client.query(
    'select * from delegation_attempts where task_id=$1 order by created_at, attempt limit $2',
    [taskId, limit]
  )
  return rows.rows.map(mapAttempt)
}

/** Bump the optimistic version after any change a client may have loaded. */
export async function bumpTaskVersion(client: DatabaseClient, organizationId: string, taskId: string) {
  const rows = await client.query(
    'update delegation_tasks set version = version + 1, updated_at = now() where organization_id=$1 and id=$2 returning *',
    [organizationId, taskId]
  )
  return mapTask(rows.rows[0]!)
}

export async function setTaskState(
  client: DatabaseClient,
  organizationId: string,
  taskId: string,
  state: DelegationTask['state'],
  blocker: DelegationTask['blocker'] = null
) {
  const rows = await client.query(
    `update delegation_tasks set state=$3, blocker=$4,
       completed_at = case when $3 in ('completed','cancelled','failed') then coalesce(completed_at, now()) else null end,
       version = version + 1, updated_at = now()
     where organization_id=$1 and id=$2 returning *`,
    [organizationId, taskId, state, blocker]
  )
  return mapTask(rows.rows[0]!)
}
