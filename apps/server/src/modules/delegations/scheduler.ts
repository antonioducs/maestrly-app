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
  type StageAttempt,
  type StageDefinition,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { executorDelegationCatalog } from './model-catalog.js'
import {
  appendDelegationEvent,
  delegationFail,
  loadAttempts,
  loadStages,
  loadTaskRow,
  mapStage,
  mapTask,
  setTaskState,
} from './repository.js'
import { findingsSignature } from './findings.js'
import { pullRequestFacts } from './pull-requests.js'
import { appendFixStage, appendVerifyStage, evaluateCompletion, planFixRound, qualityContext } from './quality.js'
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

/**
 * Append the quality stage the review loop needs next: a fix round for open findings, or a re-review when the
 * code changed after the last verdict. Returns null when nothing else can be planned.
 */
async function planQualityStage(
  client: DatabaseClient,
  task: DelegationTask,
  stages: StageDefinition[],
  attempts: StageAttempt[]
): Promise<{ appended: StageDefinition | null; blocked: DelegationBlocker | null }> {
  const context = await qualityContext(client, task, stages, attempts)
  // Required checks come before a review: a reviewer should not judge code whose checks never ran.
  const missingChecks = context.checkGaps.filter((gap) => gap.reason === 'missing').map((gap) => gap.checkId)
  if (missingChecks.length && context.currentRevisionDigest) {
    const alreadyQueued = stages.some(
      (stage) =>
        stage.type === 'verify' &&
        ['pending', 'queued', 'running'].includes(stage.state) &&
        stage.action?.kind === 'checks'
    )
    if (!alreadyQueued) return { appended: await appendVerifyStage(client, task, missingChecks), blocked: null }
  }
  const failedChecks = context.checkGaps.filter((gap) => gap.reason === 'failed')
  if (failedChecks.length)
    return {
      appended: null,
      blocked: blocker(
        'check_setup_incomplete',
        `Required check(s) failed on the current revision: ${failedChecks.map((gap) => gap.checkId).join(', ')}.`
      ),
    }
  // A fix round is only planned from a review of the CURRENT revision. After a fix changes the code, the
  // findings must be re-evaluated before another round is queued.
  const reviewIsCurrent =
    !!context.review &&
    !!context.currentRevisionDigest &&
    context.review.codeRevisionDigest === context.currentRevisionDigest
  if (task.policy.requireReview && !reviewIsCurrent) {
    const template = [...stages].reverse().find((stage) => stage.type === 'review' && stage.settings)
    if (!template)
      return {
        appended: null,
        blocked: blocker('awaiting_human_decision', 'A review is required but no review stage is configured.'),
      }
    return { appended: await cloneReviewStage(client, task, template), blocked: null }
  }
  const fix = planFixRound({
    task,
    stages,
    findings: context.findings,
    previousSignature: await previousFixSignature(client, task.id),
  })
  if (fix.create) {
    const appended = await appendFixStage(client, task, fix.create)
    await rememberFixSignature(client, task.id, findingsSignature(context.findings))
    return { appended, blocked: null }
  }
  if (fix.reason === 'limit_reached' || fix.reason === 'no_progress')
    return {
      appended: null,
      blocked: blocker(
        'review_findings_open',
        fix.reason === 'no_progress'
          ? 'The last fix round did not change the review findings. They are published for a person to decide.'
          : 'The configured number of fix rounds was reached with findings still open.'
      ),
    }
  return { appended: null, blocked: null }
}

async function previousFixSignature(client: DatabaseClient, taskId: string): Promise<string | null> {
  const rows = await client.query<{ data: { signature?: string } }>(
    "select data from delegation_events where task_id=$1 and type='review.fix_signature' order by sequence desc limit 1",
    [taskId]
  )
  return rows.rows[0]?.data.signature ?? null
}

async function rememberFixSignature(client: DatabaseClient, taskId: string, signature: string) {
  const task = await client.query<{ organization_id: string; project_id: string }>(
    'select organization_id, project_id from delegation_tasks where id=$1',
    [taskId]
  )
  const row = task.rows[0]!
  await appendDelegationEvent(
    client,
    { id: taskId, organizationId: row.organization_id, projectId: row.project_id },
    'review.fix_signature',
    { signature }
  )
}

/** A new review round is a new stage; the previous verdict keeps its own history. */
async function cloneReviewStage(
  client: DatabaseClient,
  task: DelegationTask,
  template: StageDefinition
): Promise<StageDefinition> {
  const position = Number(
    (
      await client.query<{ position: string }>(
        'select coalesce(max(position)+1,0)::text as position from delegation_stages where task_id=$1',
        [task.id]
      )
    ).rows[0]!.position
  )
  const inserted = await client.query(
    `insert into delegation_stages(
       organization_id, project_id, task_id, type, title, instructions, position, depends_on, settings, action,
       required_for_completion, settings_revision
     ) values ($1,$2,$3,'review',$4,$5,$6,'[]'::jsonb,$7,null,true,$8) returning *`,
    [
      task.organizationId,
      task.projectId,
      task.id,
      `${template.title} (again)`,
      template.instructions,
      position,
      template.settings,
      task.settingsRevision,
    ]
  )
  const stage = mapStage(inserted.rows[0]!)
  await appendDelegationEvent(client, task, 'review.rerun_planned', { stageId: stage.id, from: template.id })
  return stage
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
      let ready = readyStages(stages)
      if (!ready.length) {
        if (live > 0) {
          task = await setTaskState(client, task.organizationId, task.id, 'running')
          return { state: task.state, admitted: [], blocked: null }
        }
        const attempts = await loadAttempts(client, task.id)
        const context = await qualityContext(client, task, stages, attempts)
        const decision = evaluateCompletion({
          task,
          stages,
          attempts,
          findings: context.findings,
          review: context.review,
          currentRevisionDigest: context.currentRevisionDigest,
          checkGaps: context.checkGaps,
          pullRequest: await pullRequestFacts(client, task.id),
        })
        if (decision.satisfied) {
          task = await setTaskState(client, task.organizationId, task.id, 'completed')
          await appendDelegationEvent(client, task, 'task.completed', {
            completionTarget: task.policy.completionTarget,
            codeRevisionDigest: context.currentRevisionDigest,
          })
          return { state: task.state, admitted: [], blocked: null }
        }
        // The review loop may still be able to plan a fix round or a re-review by itself.
        const planned = await planQualityStage(client, task, stages, attempts)
        if (planned.appended) {
          stages = await loadStages(client, task.id)
          ready = readyStages(stages)
        } else {
          task = await setTaskState(
            client,
            task.organizationId,
            task.id,
            'needs_attention',
            planned.blocked ??
              blocker(
                'awaiting_human_decision',
                decision.missing.map((item) => `${item.reason}: ${item.detail}`).join(' ') ||
                  'The completion target is not satisfied.'
              )
          )
          await appendDelegationEvent(client, task, 'task.needs_attention', { missing: decision.missing })
          return { state: task.state, admitted: [], blocked: task.blocker }
        }
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
