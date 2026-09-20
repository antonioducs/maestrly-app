/**
 * Commands are the single write path for a delegation task. Each one is durable, idempotent and
 * version-checked, so the connector, the web app and the desktop can never race into two writers.
 */
import {
  DELEGATION_ACTIVE_TASK_STATES,
  delegationCommandResultSchema,
  delegationCommandSchema,
  isAgentStageType,
  resolveStageSettings,
  stageDefinitionInputSchema,
  type AgentStageSettings,
  type DelegationCommand,
  type DelegationCommandResult,
  type DelegationModelCatalog,
  type DelegationTask,
  type StageDefinition,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { executorDelegationCatalog } from './model-catalog.js'
import {
  appendDelegationEvent,
  bumpTaskVersion,
  delegationFail,
  loadStages,
  loadTaskRow,
  mapStage,
  setTaskState,
} from './repository.js'
import { assertTaskControl, delegationTransaction, type DelegationScope } from './service.js'

const TERMINAL_TASK_STATES = ['completed', 'cancelled', 'failed'] as const
const ACTIVE_STAGE_STATES = ['queued', 'running', 'waiting_input'] as const

function assertMutable(task: DelegationTask) {
  if ((TERMINAL_TASK_STATES as readonly string[]).includes(task.state))
    delegationFail(`This task is ${task.state} and no longer accepts commands.`, 409)
}

async function nextSettingsRevision(
  client: DatabaseClient,
  scope: DelegationScope,
  task: DelegationTask,
  settings: Record<string, AgentStageSettings>,
  reason: string
): Promise<number> {
  const revision = task.settingsRevision + 1
  await client.query(
    `insert into delegation_settings_revisions(organization_id, project_id, task_id, revision, settings, reason, created_by_user_id)
     values($1,$2,$3,$4,$5,$6,$7)`,
    [scope.organizationId, scope.projectId, task.id, revision, settings, reason.slice(0, 500), scope.userId]
  )
  await client.query('update delegation_tasks set settings_revision=$2 where organization_id=$1 and id=$3', [
    scope.organizationId,
    revision,
    task.id,
  ])
  return revision
}

async function activeAttemptFor(client: DatabaseClient, taskId: string) {
  const rows = await client.query(
    `select a.*, s.type as stage_type from delegation_attempts a
     join delegation_stages s on s.id = a.stage_id
     where a.task_id=$1 and a.state = any($2::text[]) order by a.created_at limit 1`,
    [taskId, [...ACTIVE_STAGE_STATES]]
  )
  return rows.rows[0] ?? null
}

async function stageOf(client: DatabaseClient, taskId: string, stageId: string): Promise<StageDefinition> {
  const rows = await client.query('select * from delegation_stages where task_id=$1 and id=$2 for update', [
    taskId,
    stageId,
  ])
  if (!rows.rows[0]) delegationFail('Stage not found in this task.', 404)
  return mapStage(rows.rows[0])
}

interface CommandOutcome {
  appliesFromStageId: string | null
  appliesFromAttempt: number | null
  stageIds: string[]
  settingsRevision: number
  pendingInterrupt: boolean
  state: DelegationTask['state']
}

async function applyConfigure(
  client: DatabaseClient,
  scope: DelegationScope,
  task: DelegationTask,
  catalog: DelegationModelCatalog,
  command: Extract<DelegationCommand, { type: 'configure' }>
): Promise<CommandOutcome> {
  const stages = await loadStages(client, task.id)
  const active = await activeAttemptFor(client, task.id)
  const targets: StageDefinition[] =
    command.target === 'task_defaults'
      ? stages.filter((stage) => isAgentStageType(stage.type) && stage.state === 'pending')
      : [await stageOf(client, task.id, command.stageId ?? delegationFail('stageId is required for this target.', 400))]
  if (!targets.length) delegationFail('There is no pending stage left to configure.', 409)
  const settingsMap: Record<string, AgentStageSettings> = {}
  for (const stage of targets) {
    if (!isAgentStageType(stage.type))
      delegationFail(`Stage "${stage.title}" is a host action and has no agent configuration.`, 400)
    const resolved = resolveStageSettings(catalog, command.settingsPatch, stage.settings ?? undefined)
    settingsMap[stage.id] = resolved.settings
  }
  const revision = await nextSettingsRevision(client, scope, task, settingsMap, `configure:${command.target}`)

  let pendingInterrupt = false
  let appliesFromAttempt: number | null = null
  const stageIds = targets.map((stage) => stage.id)
  for (const stage of targets) {
    const activeHere = active && active.stage_id === stage.id
    if (activeHere && command.apply === 'interrupt_and_restart') {
      // The successor attempt is only admitted after the running one reaches a terminal state.
      await client.query(
        'update delegation_tasks set interrupt_requested=true where organization_id=$1 and id=$2',
        [scope.organizationId, task.id]
      )
      await client.query("update delegation_attempts set state='cancelled', finished_at=now() where id=$1 and state <> 'succeeded'", [
        active.id,
      ])
      pendingInterrupt = true
      appliesFromAttempt = Number(active.attempt) + 1
      await client.query(
        "update delegation_stages set settings=$3, settings_revision=$4, state='pending', version=version+1, updated_at=now() where task_id=$1 and id=$2",
        [task.id, stage.id, settingsMap[stage.id]!, revision]
      )
      continue
    }
    if (activeHere && command.apply !== 'interrupt_and_restart') {
      // The running attempt keeps the snapshot it was admitted with; only the next attempt changes.
      appliesFromAttempt = Number(active.attempt) + 1
      await client.query(
        'update delegation_stages set settings=$3, settings_revision=$4, version=version+1, updated_at=now() where task_id=$1 and id=$2',
        [task.id, stage.id, settingsMap[stage.id]!, revision]
      )
      continue
    }
    if (stage.state === 'queued' && command.apply !== 'replace_queued')
      delegationFail(
        'This stage is already queued. Use apply="replace_queued" to replace it before a claim.',
        409
      )
    const updated = await client.query(
      `update delegation_stages set settings=$3, settings_revision=$4, version=version+1, updated_at=now()
       where task_id=$1 and id=$2 and version=$5 returning id`,
      [task.id, stage.id, settingsMap[stage.id]!, revision, stage.version]
    )
    if (!updated.rowCount) delegationFail('The stage changed after it was loaded.', 409)
    if (stage.state === 'queued') {
      const claimed = await client.query(
        "select 1 from delegation_attempts where stage_id=$1 and state = any($2::text[])",
        [stage.id, [...ACTIVE_STAGE_STATES]]
      )
      if (claimed.rowCount) delegationFail('The stage was claimed while the change was being applied.', 409)
    }
  }
  await appendDelegationEvent(client, task, 'task.configured', {
    target: command.target,
    apply: command.apply,
    stageIds,
    settingsRevision: revision,
  })
  return {
    appliesFromStageId: stageIds[0] ?? null,
    appliesFromAttempt,
    stageIds,
    settingsRevision: revision,
    pendingInterrupt,
    state: task.state,
  }
}

async function appendStage(
  client: DatabaseClient,
  scope: DelegationScope,
  task: DelegationTask,
  catalog: DelegationModelCatalog,
  input: Parameters<typeof stageDefinitionInputSchema.parse>[0],
  settingsPatchFallback?: AgentStageSettings
) {
  const stage = stageDefinitionInputSchema.parse(input)
  const position = Number(
    (await client.query<{ position: string }>('select coalesce(max(position)+1,0)::text as position from delegation_stages where task_id=$1', [task.id]))
      .rows[0]!.position
  )
  let settings: AgentStageSettings | null = null
  if (isAgentStageType(stage.type)) {
    const resolved = resolveStageSettings(catalog, stage.settings ?? {}, settingsPatchFallback)
    settings = resolved.settings
  } else if (!stage.action) delegationFail('A host stage needs a structured action.', 400)
  const row = await client.query(
    `insert into delegation_stages(
       organization_id, project_id, task_id, type, title, instructions, position, depends_on, settings, action,
       required_for_completion, settings_revision
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [
      scope.organizationId,
      scope.projectId,
      task.id,
      stage.type,
      stage.title,
      stage.instructions,
      position,
      JSON.stringify([]),
      settings,
      stage.action ?? null,
      stage.requiredForCompletion,
      task.settingsRevision,
    ]
  )
  return mapStage(row.rows[0]!)
}

/** Latest agent settings on the pipeline, used as the base when a follow-up stage omits them. */
function latestAgentSettings(stages: StageDefinition[]): AgentStageSettings | undefined {
  for (const stage of [...stages].reverse()) if (stage.settings) return stage.settings
  return undefined
}

export async function applyDelegationCommand(
  pool: DatabasePool,
  scope: DelegationScope,
  taskId: string,
  rawCommand: DelegationCommand,
  idempotencyKey: string
): Promise<DelegationCommandResult> {
  const command = delegationCommandSchema.parse(rawCommand)
  return delegationTransaction(pool, scope, true, async (client) => {
    // Lock order: task, then stage, then attempt. Idempotency is recorded on the task row itself.
    const task = await loadTaskRow(client, scope, taskId, 'update')
    await assertTaskControl(client, scope, task)
    const recorded = await client.query<{ state: string; result: unknown; command: unknown }>(
      'select state, result, command from delegation_commands where task_id=$1 and idempotency_key=$2',
      [task.id, idempotencyKey]
    )
    const previous = recorded.rows[0]
    if (previous) {
      if (JSON.stringify(previous.command) !== JSON.stringify(command))
        delegationFail('The idempotency key was already used with different content.', 409)
      if (previous.state === 'applied') return delegationCommandResultSchema.parse(previous.result)
      if (previous.state === 'failed') delegationFail('This command already failed. Send a new idempotency key.', 409)
    }
    if (task.version !== command.expectedVersion)
      delegationFail('The task changed after it was loaded. Reload before sending this command.', 409)
    assertMutable(task)
    const commandRow = await client.query<{ id: string }>(
      `insert into delegation_commands(organization_id, project_id, task_id, idempotency_key, actor_user_id, connection_id, command, expected_version, state)
       values($1,$2,$3,$4,$5,$6,$7,$8,'pending')
       on conflict (task_id, idempotency_key) do update set state='pending' returning id`,
      [
        scope.organizationId,
        scope.projectId,
        task.id,
        idempotencyKey,
        scope.userId,
        scope.connectionId ?? null,
        command,
        command.expectedVersion,
      ]
    )
    const commandId = commandRow.rows[0]!.id

    const catalogFor = async () =>
      executorDelegationCatalog(client, {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        executorId: task.executorId,
        userId: task.ownerUserId,
      })

    let outcome: CommandOutcome
    switch (command.type) {
      case 'start': {
        if (task.state !== 'draft' && task.state !== 'paused')
          delegationFail(`A task in state ${task.state} cannot be started.`, 409)
        await client.query(
          'update delegation_tasks set pause_requested=false, interrupt_requested=false where organization_id=$1 and id=$2',
          [scope.organizationId, task.id]
        )
        const started = await setTaskState(client, scope.organizationId, task.id, 'queued')
        await appendDelegationEvent(client, task, 'task.started', {})
        outcome = {
          appliesFromStageId: null,
          appliesFromAttempt: null,
          stageIds: (await loadStages(client, task.id)).map((stage) => stage.id),
          settingsRevision: started.settingsRevision,
          pendingInterrupt: false,
          state: started.state,
        }
        break
      }
      case 'configure':
        outcome = await applyConfigure(client, scope, task, await catalogFor(), command)
        break
      case 'follow_up': {
        const stages = await loadStages(client, task.id)
        const created = command.stage
          ? await appendStage(client, scope, task, await catalogFor(), command.stage, latestAgentSettings(stages))
          : await appendStage(
              client,
              scope,
              task,
              await catalogFor(),
              { type: 'fix', title: 'Follow-up', instructions: command.text, dependsOn: [], requiredForCompletion: true },
              latestAgentSettings(stages)
            )
        await appendDelegationEvent(client, task, 'task.follow_up', { stageId: created.id, chars: command.text.length })
        const resumed =
          task.state === 'paused' || task.state === 'draft'
            ? task
            : await setTaskState(client, scope.organizationId, task.id, 'queued')
        outcome = {
          appliesFromStageId: created.id,
          appliesFromAttempt: null,
          stageIds: [created.id],
          settingsRevision: task.settingsRevision,
          pendingInterrupt: false,
          state: resumed.state,
        }
        break
      }
      case 'pause': {
        await client.query('update delegation_tasks set pause_requested=true where organization_id=$1 and id=$2', [
          scope.organizationId,
          task.id,
        ])
        const active = await activeAttemptFor(client, task.id)
        if (command.immediate && active) {
          await client.query("update delegation_attempts set state='cancelled', finished_at=now() where id=$1", [
            active.id,
          ])
          await client.query("update delegation_stages set state='pending', version=version+1 where id=$1", [
            active.stage_id,
          ])
        }
        const paused = await setTaskState(
          client,
          scope.organizationId,
          task.id,
          active && !command.immediate ? 'pausing' : 'paused'
        )
        await appendDelegationEvent(client, task, 'task.paused', { immediate: command.immediate })
        outcome = {
          appliesFromStageId: null,
          appliesFromAttempt: null,
          stageIds: [],
          settingsRevision: paused.settingsRevision,
          pendingInterrupt: !!(command.immediate && active),
          state: paused.state,
        }
        break
      }
      case 'resume': {
        if (!['paused', 'pausing', 'needs_attention', 'watching'].includes(task.state))
          delegationFail(`A task in state ${task.state} cannot be resumed.`, 409)
        await client.query('update delegation_tasks set pause_requested=false where organization_id=$1 and id=$2', [
          scope.organizationId,
          task.id,
        ])
        const resumed = await setTaskState(client, scope.organizationId, task.id, 'queued')
        await appendDelegationEvent(client, task, 'task.resumed', {})
        outcome = {
          appliesFromStageId: null,
          appliesFromAttempt: null,
          stageIds: [],
          settingsRevision: resumed.settingsRevision,
          pendingInterrupt: false,
          state: resumed.state,
        }
        break
      }
      case 'cancel': {
        const active = await activeAttemptFor(client, task.id)
        await client.query(
          "update delegation_stages set state='cancelled', version=version+1 where task_id=$1 and state in ('pending','queued')",
          [task.id]
        )
        const cancelled = await setTaskState(
          client,
          scope.organizationId,
          task.id,
          active ? 'cancelling' : 'cancelled',
          active ? { reason: 'executor_error', detail: 'Waiting for the running stage to stop.', since: new Date().toISOString() } : null
        )
        await appendDelegationEvent(client, task, 'task.cancelled', { reason: command.reason, active: !!active })
        outcome = {
          appliesFromStageId: null,
          appliesFromAttempt: null,
          stageIds: [],
          settingsRevision: cancelled.settingsRevision,
          pendingInterrupt: !!active,
          state: cancelled.state,
        }
        break
      }
      case 'request_review': {
        const stages = await loadStages(client, task.id)
        const created = await appendStage(
          client,
          scope,
          task,
          await catalogFor(),
          {
            type: 'review',
            title: 'Requested review',
            instructions: command.instructions,
            dependsOn: [],
            requiredForCompletion: true,
            ...(command.settingsPatch ? { settings: command.settingsPatch } : {}),
          },
          latestAgentSettings(stages)
        )
        await appendDelegationEvent(client, task, 'task.review_requested', { stageId: created.id })
        const queued = await setTaskState(client, scope.organizationId, task.id, task.state === 'draft' ? 'draft' : 'queued')
        outcome = {
          appliesFromStageId: created.id,
          appliesFromAttempt: null,
          stageIds: [created.id],
          settingsRevision: queued.settingsRevision,
          pendingInterrupt: false,
          state: queued.state,
        }
        break
      }
      case 'request_checks': {
        const created = await appendStage(client, scope, task, await catalogFor(), {
          type: 'verify',
          title: 'Requested checks',
          instructions: '',
          dependsOn: [],
          requiredForCompletion: true,
          action: { kind: 'checks', checkIds: command.checkIds },
        })
        await appendDelegationEvent(client, task, 'task.checks_requested', {
          stageId: created.id,
          checkIds: command.checkIds,
        })
        const queued = await setTaskState(client, scope.organizationId, task.id, task.state === 'draft' ? 'draft' : 'queued')
        outcome = {
          appliesFromStageId: created.id,
          appliesFromAttempt: null,
          stageIds: [created.id],
          settingsRevision: queued.settingsRevision,
          pendingInterrupt: false,
          state: queued.state,
        }
        break
      }
      case 'deliver': {
        const autonomy = task.policy.autonomy
        const allowed: Record<typeof command.mode, boolean> = {
          patch: true,
          commit: autonomy.commit,
          push: autonomy.push,
          draft_pr: autonomy.openPullRequest,
          ready_pr: autonomy.openPullRequest,
          merge: autonomy.merge,
        }
        if (!allowed[command.mode])
          delegationFail(`The task policy does not authorize ${command.mode} delivery.`, 403)
        const created = await appendStage(client, scope, task, await catalogFor(), {
          type: 'deliver',
          title: command.title ?? `Deliver (${command.mode})`,
          instructions: '',
          dependsOn: [],
          requiredForCompletion: true,
          action: { kind: 'deliver', mode: command.mode, expectedCodeRevision: command.expectedCodeRevision },
        })
        await appendDelegationEvent(client, task, 'task.delivery_requested', {
          stageId: created.id,
          mode: command.mode,
        })
        const queued = await setTaskState(client, scope.organizationId, task.id, task.state === 'draft' ? 'draft' : 'queued')
        outcome = {
          appliesFromStageId: created.id,
          appliesFromAttempt: null,
          stageIds: [created.id],
          settingsRevision: queued.settingsRevision,
          pendingInterrupt: false,
          state: queued.state,
        }
        break
      }
    }

    const final = await bumpTaskVersion(client, scope.organizationId, task.id)
    const result = delegationCommandResultSchema.parse({
      commandId,
      taskId: task.id,
      accepted: true,
      version: final.version,
      settingsRevision: final.settingsRevision,
      appliesFromStageId: outcome.appliesFromStageId,
      appliesFromAttempt: outcome.appliesFromAttempt,
      stageIds: outcome.stageIds,
      state: final.state,
      pendingInterrupt: outcome.pendingInterrupt,
    })
    await client.query(
      "update delegation_commands set state='applied', result=$2, applied_at=now() where id=$1",
      [commandId, result]
    )
    return result
  })
}

export function taskIsActive(task: DelegationTask): boolean {
  return (DELEGATION_ACTIVE_TASK_STATES as readonly string[]).includes(task.state)
}
