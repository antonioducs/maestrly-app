import { requirePersonalDevice, personalDeviceRows } from '../runners/personal-devices.js'
import { effectiveAutomation, renderAutomationPrompt, resolveAutomationLimits } from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { appendDomainEvent } from '../events/store.js'
import { authorizeProject } from '../access/authorize.js'
import { cardScope, fail, transaction, type Scope } from '../kanban/service.js'
import type { CardRow } from '../cards/service.js'
import { OptimisticConflictError, mapCard } from '../cards/service.js'
import {
  currentConfig,
  projectCatalog,
  resolvedRepository,
  assessAutomationRunner,
  type ColumnConfigRow,
} from './column-service.js'

export async function dispatchColumnAutomation(
  client: DatabaseClient,
  scope: Scope,
  card: CardRow,
  input: { manual: boolean; sourceEventId?: string; expectedPolicyId?: string | null; expectedOverrideVersion?: number; personalDeviceId?:string }
) {
  const columnResult = await client.query<ColumnConfigRow>(
    'select * from board_columns where id=$1 and deleted_at is null',
    [card.column_id]
  )
  const column = columnResult.rows[0]
  if (column?.role !== 'normal') {
    if (input.manual) fail('Fixed columns cannot run automations.', 400)
    return { jobId: null, reason: 'Fixed column' }
  }
  const board = (
    await client.query('select roles_configured,automation_limits from boards where id=$1', [card.board_id])
  ).rows[0]
  if (!board?.roles_configured) {
    if (input.manual) fail('Define the fixed columns before configuring automation.', 400)
    return { jobId: null, reason: 'Fixed columns undefined' }
  }
  if (input.expectedPolicyId !== undefined && input.expectedPolicyId !== column.execution_policy_id)
    fail('The column configuration changed. Reload before saving.')
  const { config, policy } = await currentConfig(client, column)
  if (!policy || !config.enabled || (!input.manual && !config.autoRun)) {
    if (input.manual) fail('The agent is disabled for this column.', 409)
    return { jobId: null, reason: 'Automation disabled' }
  }
  if (card.archived_at) fail('Restore this card before editing it.')
  const active = await client.query(
    "select id,state from jobs where card_id=$1 and state in ('queued','waiting_approval','active') for update",
    [card.id]
  )
  if (input.manual && active.rowCount) fail('An execution is already queued or active for this card.')
  const ov =
    (
      await client.query('select config,version from card_automation_overrides where card_id=$1 and column_id=$2', [
        card.id,
        column.id,
      ])
    ).rows[0]?.config ?? null
  const overrideVersion = Number(
    (
      await client.query('select version from card_automation_overrides where card_id=$1 and column_id=$2', [
        card.id,
        column.id,
      ])
    ).rows[0]?.version ?? 0
  )
  if (input.manual && input.expectedOverrideVersion !== overrideVersion)
    fail('The card override changed. Reload before saving.')
  const selectedDevice=input.personalDeviceId?await requirePersonalDevice(client,{...scope,projectId:card.project_id,deviceId:input.personalDeviceId}):null
  if(selectedDevice&&!input.manual)fail('Personal execution requires an explicit request.',403)
  const effective = effectiveAutomation(config, ov)
  if(selectedDevice){effective.runnerSelector='runner';effective.targetRunnerId=selectedDevice.id}
  const repository = await resolvedRepository(client, scope.organizationId, card.project_id, effective)
  const catalog = selectedDevice ? (await personalDeviceRows(client,scope.organizationId,card.project_id,scope.userId)).filter(row=>row.id===selectedDevice.id) : await projectCatalog(client, scope.organizationId, card.project_id)
  const matches = catalog
    .map((row) => assessAutomationRunner(row, effective, repository, selectedDevice?false:input.manual))
    .filter((row) => row.compatible)
  if ((policy.automation_config || selectedDevice) && !matches.length) {
    if (input.manual) fail(selectedDevice?'This device does not support the configured model, repository or execution options.':'No compatible runner is available for this configuration.')
    await appendDomainEvent(client, {
      organizationId: scope.organizationId,
      projectId: card.project_id,
      type: 'card.automation_unavailable',
      aggregateType: 'card',
      aggregateId: card.id,
      actor: { type: 'human', userId: scope.userId },
      data: { columnId: column.id },
    })
    return { jobId: null, reason: 'No compatible runner' }
  }
  const limits = resolveAutomationLimits(board.automation_limits)
  const guard = (
    await client.query(
      `insert into automation_dispatch_guards(organization_id,project_id,board_id,card_id,column_id)
    values($1,$2,$3,$4,$5) on conflict(card_id,column_id) do update set card_id=excluded.card_id returning *`,
      [scope.organizationId, card.project_id, card.board_id, card.id, column.id]
    )
  ).rows[0]
  const count =
    Date.now() - new Date(guard.window_started_at).getTime() >= limits.breakerWindowMs && !guard.blocked_at
      ? 0
      : guard.dispatch_count
  if (guard.blocked_at || count >= limits.maxPerCardPerColumn) {
    if (!guard.blocked_at) {
      await client.query('update automation_dispatch_guards set blocked_at=now() where card_id=$1 and column_id=$2', [
        card.id,
        column.id,
      ])
      await appendDomainEvent(client, {
        organizationId: scope.organizationId,
        projectId: card.project_id,
        type: 'card.dispatch_blocked',
        aggregateType: 'card',
        aggregateId: card.id,
        actor: { type: 'human', userId: scope.userId },
        data: { columnId: column.id, count, max: limits.maxPerCardPerColumn },
      })
    }
    return { jobId: null, blocked: true, reason: 'Dispatch limit reached. Release this card to continue.' }
  }
  const prompt = renderAutomationPrompt(
    effective.promptTemplate,
    { id: card.id, title: card.title, description: card.description },
    column.name
  )
  if (prompt.length > 200000) fail('Rendered prompt is too long.', 400)
  const sourceEvent =
    input.sourceEventId ??
    (
      await appendDomainEvent(client, {
        organizationId: scope.organizationId,
        projectId: card.project_id,
        type: 'card.agent_requested',
        aggregateType: 'card',
        aggregateId: card.id,
        actor: { type: 'human', userId: scope.userId },
        data: { columnId: column.id, policyId: policy.id, cardVersion: Number(card.version) },
      })
    ).id
  const snapshot = {
    ...(selectedDevice?{personalDevice:{deviceId:selectedDevice.id,ownerUserId:scope.userId,name:selectedDevice.name}}:{}),
    sourceCardVersion: Number(card.version),
    title: card.title,
    description: card.description,
    acceptanceCriteria: card.acceptance_criteria,
    taskType: effective.taskType,
    provider: effective.provider,
    model: effective.model,
    ...(effective.effort && effective.effort !== 'off' ? { effort: effective.effort } : {}),
    ...repository,
    delivery: { mode: 'patch', requireHumanApproval: true },
    renderedPrompt: prompt,
    maxDurationSeconds: effective.maxDurationSeconds ?? limits.maxDurationSeconds,
    maxLogBytes: effective.maxLogBytes ?? limits.maxLogBytes,
    ...(policy.automation_config ? { automationVersion: 1, automation: effective } : {}),
    fastMode: effective.fastMode,
    fastServiceTier: effective.fastMode ? matches[0]?.model?.fastServiceTier : undefined,
    targetRunnerId: effective.runnerSelector === 'runner' ? effective.targetRunnerId : null,
  }
  const state = effective.approvalRequired ? 'waiting_approval' : 'queued'
  const job = await client.query<{ id: string }>(
    `insert into jobs(organization_id,project_id,board_id,card_id,source_event_id,policy_id,policy_version,snapshot,state,requested_by_user_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(source_event_id) do nothing returning id`,
    [
      scope.organizationId,
      card.project_id,
      card.board_id,
      card.id,
      sourceEvent,
      policy.id,
      Number(policy.version),
      snapshot,
      state,
      scope.userId,
    ]
  )
  if (job.rows[0]) {
    await client.query(
      `update automation_dispatch_guards set dispatch_count=$3,window_started_at=case when $4 then now() else window_started_at end where card_id=$1 and column_id=$2`,
      [card.id, column.id, count + 1, count === 0]
    )
    if (effective.approvalRequired)
      await client.query(
        "insert into approvals(organization_id,project_id,job_id,status,requested_by_user_id) values($1,$2,$3,'pending',$4)",
        [scope.organizationId, card.project_id, job.rows[0].id, scope.userId]
      )
  }
  return { jobId: job.rows[0]?.id ?? null, blocked: false }
}
export async function requestColumnAgent(
  pool: DatabasePool,
  scope: Scope & {
    cardId: string
    expectedVersion: number
    expectedPolicyId: string | null
    expectedOverrideVersion: number
    personalDeviceId?:string
  }
) {
  return transaction(pool, scope, async (client) => {
    const card = await cardScope(client, scope, scope.cardId, true)
    await authorizeProject(client, scope.organizationId, card.project_id, scope.userId, 'execution:request')
    if (Number(card.version) !== scope.expectedVersion) throw new OptimisticConflictError(mapCard(card))
    return dispatchColumnAutomation(client, scope, card, {
      manual: true,
      expectedPolicyId: scope.expectedPolicyId,
      expectedOverrideVersion: scope.expectedOverrideVersion,
      personalDeviceId:scope.personalDeviceId,
    })
  })
}
