/**
 * Stage scheduler. It decides what runs next for a task and admits it; it is not a second execution
 * engine. Transactions stay short, use `SKIP LOCKED`, and never hold a lock across an external effect.
 */
import {
  DelegationSettingsError,
  isAgentStageType,
  type DelegationBlocker,
  type DelegationModelCatalog,
  type DelegationTask,
  type StageDefinition,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { executorDelegationCatalog } from './model-catalog.js'
import {
  appendDelegationEvent,
  delegationFail,
  loadStages,
  loadTaskRow,
  mapTask,
  setTaskState,
} from './repository.js'
import { admitStage } from './stage-admission.js'

const LIVE_STAGE_STATES = ['queued', 'running', 'waiting_input'] as const

function blocker(reason: DelegationBlocker['reason'], detail: string): DelegationBlocker {
  return { reason, detail: detail.slice(0, 2000), since: new Date().toISOString() }
}

async function liveStages(client: DatabaseClient, taskId: string) {
  const rows = await client.query<{ count: string }>(
    'select count(*)::text as count from delegation_stages where task_id=$1 and state = any($2::text[])',
    [taskId, [...LIVE_STAGE_STATES]]
  )
  return Number(rows.rows[0]!.count)
}

async function dependenciesSatisfied(client: DatabaseClient, taskId: string): Promise<boolean> {
  const rows = await client.query<{ pending: string }>(
    `select count(*)::text as pending from delegation_dependencies d
     join delegation_tasks t on t.id = d.depends_on_task_id
     where d.task_id=$1 and t.state <> 'completed'`,
    [taskId]
  )
  return Number(rows.rows[0]!.pending) === 0
}

function readyStages(stages: StageDefinition[]): StageDefinition[] {
  const byId = new Map(stages.map((stage) => [stage.id, stage]))
  return stages.filter(
    (stage) =>
      stage.state === 'pending' &&
      stage.dependsOn.every((id) => {
        const dependency = byId.get(id)
        // A dependency that was cancelled or superseded no longer blocks; a live one does.
        return !dependency || ['succeeded', 'cancelled', 'superseded'].includes(dependency.state)
      }) &&
      stage.dependsOn.every((id) => byId.get(id)?.state !== 'failed')
  )
}

function completionSatisfied(stages: StageDefinition[]): boolean {
  return stages
    .filter((stage) => stage.requiredForCompletion)
    .every((stage) => ['succeeded', 'superseded', 'cancelled'].includes(stage.state))
}

async function catalogFor(client: DatabaseClient, task: DelegationTask): Promise<DelegationModelCatalog> {
  return executorDelegationCatalog(client, {
    organizationId: task.organizationId,
    projectId: task.projectId,
    executorId: task.executorId,
    userId: task.ownerUserId,
  })
}

export interface AdvanceResult {
  state: DelegationTask['state']
  admitted: string[]
  blocked: DelegationBlocker | null
}

export interface TaskIdentity {
  projectId: string
  ownerUserId: string
  state: DelegationTask['state']
}

/**
 * Resolve the owner and project of a task using the tenant-scoped delegation tables only. The heavier work
 * then runs under that owner's identity.
 */
export async function taskIdentity(
  pool: DatabasePool,
  organizationId: string,
  taskId: string
): Promise<TaskIdentity | null> {
  return inTenantTransaction(
    pool,
    { organizationId, actor: { type: 'system', service: 'delegation-scheduler' } },
    async (client) => {
      const rows = await client.query<{ project_id: string; owner_user_id: string; state: DelegationTask['state'] }>(
        'select project_id, owner_user_id, state from delegation_tasks where organization_id=$1 and id=$2',
        [organizationId, taskId]
      )
      const row = rows.rows[0]
      return row ? { projectId: row.project_id, ownerUserId: row.owner_user_id, state: row.state } : null
    }
  )
}

/**
 * Move one task forward. Safe to call concurrently: the task row is locked with `SKIP LOCKED`, so a second
 * scheduler simply observes no work instead of admitting a duplicate stage.
 */
export async function advanceDelegation(pool: DatabasePool, input: { organizationId: string; taskId: string }) {
  // The scheduler acts as the task owner, so chat-session RLS and project permission are enforced normally
  // instead of widening the system-context bypass.
  const identity = await taskIdentity(pool, input.organizationId, input.taskId)
  if (!identity) return null
  return inTenantTransaction(
    pool,
    {
      organizationId: input.organizationId,
      projectId: identity.projectId,
      actor: { type: 'human', userId: identity.ownerUserId },
    },
    async (client): Promise<AdvanceResult | null> => {
      try {
        await authorizeProject(
          client,
          input.organizationId,
          identity.projectId,
          identity.ownerUserId,
          'execution:request'
        )
      } catch {
        const blocked = await setTaskState(
          client,
          input.organizationId,
          input.taskId,
          'needs_attention',
          blocker('permission_lost', 'The task owner no longer has permission to execute in this project.')
        )
        return { state: blocked.state, admitted: [], blocked: blocked.blocker }
      }

      const locked = await client.query(
        'select * from delegation_tasks where organization_id=$1 and id=$2 for update skip locked',
        [input.organizationId, input.taskId]
      )
      if (!locked.rows[0]) return null
      let task = mapTask(locked.rows[0])
      let stages = await loadStages(client, task.id)

      if (task.state === 'cancelling') {
        if ((await liveStages(client, task.id)) > 0) return { state: task.state, admitted: [], blocked: task.blocker }
        task = await setTaskState(client, task.organizationId, task.id, 'cancelled')
        return { state: task.state, admitted: [], blocked: null }
      }
      if (task.state === 'pausing') {
        if ((await liveStages(client, task.id)) > 0) return { state: task.state, admitted: [], blocked: task.blocker }
        task = await setTaskState(client, task.organizationId, task.id, 'paused')
        return { state: task.state, admitted: [], blocked: null }
      }
      if (!['queued', 'running', 'waiting_review'].includes(task.state))
        return { state: task.state, admitted: [], blocked: task.blocker }

      const control = await client.query<{
        pause_requested: boolean
        interrupt_requested: boolean
        interrupt_stage_id: string | null
      }>('select pause_requested, interrupt_requested, interrupt_stage_id from delegation_tasks where id=$1', [task.id])
      if (control.rows[0]?.pause_requested) {
        const live = await liveStages(client, task.id)
        task = await setTaskState(client, task.organizationId, task.id, live > 0 ? 'pausing' : 'paused')
        return { state: task.state, admitted: [], blocked: null }
      }
      // An interrupt only clears once the previous attempt reached a terminal state; the stage is then
      // reopened so the replacement configuration can be admitted as a new attempt.
      if (control.rows[0]?.interrupt_requested) {
        if ((await liveStages(client, task.id)) > 0)
          return {
            state: task.state,
            admitted: [],
            blocked: blocker('executor_error', 'Waiting for the interrupted stage to stop.'),
          }
        const interruptedStageId = control.rows[0].interrupt_stage_id
        if (interruptedStageId)
          await client.query(
            "update delegation_stages set state='pending', version=version+1, updated_at=now() where id=$1 and state in ('cancelled','interrupted','failed')",
            [interruptedStageId]
          )
        await client.query(
          'update delegation_tasks set interrupt_requested=false, interrupt_stage_id=null where id=$1',
          [task.id]
        )
        stages = await loadStages(client, task.id)
      }

      if (!(await dependenciesSatisfied(client, task.id))) {
        const waiting = await setTaskState(
          client,
          task.organizationId,
          task.id,
          'queued',
          blocker('awaiting_information', 'A task this one depends on has not completed yet.')
        )
        return { state: waiting.state, admitted: [], blocked: waiting.blocker }
      }

      if (stages.some((stage) => stage.state === 'failed' && stage.requiredForCompletion)) {
        task = await setTaskState(
          client,
          task.organizationId,
          task.id,
          'needs_attention',
          blocker('executor_error', 'A required stage failed. Inspect the attempt before continuing.')
        )
        return { state: task.state, admitted: [], blocked: task.blocker }
      }

      const live = await liveStages(client, task.id)
      const slots = Math.max(0, task.policy.limits.maxParallelStages - live)
      const ready = readyStages(stages)
      if (!ready.length) {
        if (live > 0) {
          task = await setTaskState(client, task.organizationId, task.id, 'running')
          return { state: task.state, admitted: [], blocked: null }
        }
        if (completionSatisfied(stages)) {
          task = await setTaskState(client, task.organizationId, task.id, 'completed')
          await appendDelegationEvent(client, task, 'task.completed', {
            completionTarget: task.policy.completionTarget,
          })
          return { state: task.state, admitted: [], blocked: null }
        }
        task = await setTaskState(
          client,
          task.organizationId,
          task.id,
          'needs_attention',
          blocker('awaiting_human_decision', 'No stage can run and the completion target is not satisfied.')
        )
        return { state: task.state, admitted: [], blocked: task.blocker }
      }
      if (slots === 0) {
        task = await setTaskState(client, task.organizationId, task.id, 'running')
        return { state: task.state, admitted: [], blocked: null }
      }

      let catalog: DelegationModelCatalog
      try {
        catalog = await catalogFor(client, task)
      } catch (error) {
        const reason = error instanceof DelegationSettingsError ? 'selection_unavailable' : 'executor_offline'
        task = await setTaskState(
          client,
          task.organizationId,
          task.id,
          'needs_attention',
          blocker(reason, error instanceof Error ? error.message : 'The executor inventory is unavailable.')
        )
        return { state: task.state, admitted: [], blocked: task.blocker }
      }

      const admitted: string[] = []
      for (const stage of ready.slice(0, slots)) {
        try {
          const attempt = await admitStage(client, { task, stage, catalog })
          admitted.push(attempt.id)
        } catch (error) {
          if (error instanceof DelegationSettingsError) {
            task = await setTaskState(
              client,
              task.organizationId,
              task.id,
              'needs_attention',
              blocker(error.code === 'SELECTION_UNAVAILABLE' ? 'selection_unavailable' : 'catalog_changed', error.message)
            )
            return { state: task.state, admitted, blocked: task.blocker }
          }
          throw error
        }
      }
      task = await setTaskState(client, task.organizationId, task.id, 'running')
      return { state: task.state, admitted, blocked: null }
    }
  )
}

/**
 * Finish a stage attempt from the outcome of its chat turn. Only a terminal turn concludes a stage, and a
 * successful turn still needs its receipt before the stage counts as succeeded.
 */
export async function settleStageFromTurn(
  client: DatabaseClient,
  input: { organizationId: string; turnId: string }
): Promise<{ taskId: string } | null> {
  const rows = await client.query(
    `select a.*, t.state as turn_state, t.error as turn_error, s.required_for_completion
     from delegation_attempts a
     join chat_turns t on t.id = a.turn_id
     join delegation_stages s on s.id = a.stage_id
     where a.organization_id=$1 and a.turn_id=$2 and a.state = any($3::text[]) for update`,
    [input.organizationId, input.turnId, [...LIVE_STAGE_STATES]]
  )
  const row = rows.rows[0]
  if (!row) return null
  const turnState = String(row.turn_state)
  if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(turnState)) return null
  const receipt = row.receipt as { result?: string; selectionHonored?: boolean } | null
  // A finished turn is not a finished stage: the executor must have reported a receipt.
  const stageState =
    turnState !== 'succeeded'
      ? turnState
      : receipt?.result === 'succeeded' && receipt.selectionHonored !== false
        ? 'succeeded'
        : 'failed'
  await client.query('update delegation_attempts set state=$2, finished_at=now() where id=$1', [row.id, stageState])
  await client.query(
    'update delegation_stages set state=$2, version=version+1, updated_at=now() where id=$1',
    [row.stage_id, stageState]
  )
  const task = await loadTaskRow(
    client,
    { organizationId: input.organizationId, projectId: String(row.project_id) },
    String(row.task_id)
  )
  await appendDelegationEvent(client, task, 'stage.finished', {
    stageId: row.stage_id,
    attemptId: row.id,
    state: stageState,
    turnState,
    selectionHonored: receipt?.selectionHonored ?? null,
    error: row.turn_error ?? null,
  })
  return { taskId: task.id }
}

/** Scan every organization for tasks that can move. Used by the server loop and by tests. */
export async function runDelegationScheduler(pool: DatabasePool, limit = 50): Promise<number> {
  let moved = 0
  for (const organization of (await pool.query<{ id: string }>('select id from organizations')).rows) {
    const candidates = await inTenantTransaction(
      pool,
      { organizationId: organization.id, actor: { type: 'system', service: 'delegation-scheduler' } },
      async (client) => {
        const rows = await client.query<{ id: string }>(
          `select id from delegation_tasks
           where organization_id=$1 and state in ('queued','running','pausing','cancelling','waiting_review')
           order by updated_at limit $2`,
          [organization.id, limit]
        )
        return rows.rows.map((row) => row.id)
      }
    )
    for (const taskId of candidates) {
      const result = await advanceDelegation(pool, { organizationId: organization.id, taskId })
      if (result?.admitted.length) moved += result.admitted.length
    }
  }
  return moved
}

export function assertSchedulerAdmissible(stage: StageDefinition) {
  if (isAgentStageType(stage.type) && !stage.settings)
    delegationFail('An agent stage without settings can never be admitted.', 409)
}
