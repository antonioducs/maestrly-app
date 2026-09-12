import { personalDeviceRows } from '../runners/personal-devices.js'
import {
  columnAutomationSchema,
  effectiveAutomation,
  modelSupports,
  renderAutomationPrompt,
  resolveAutomationLimits,
  runnerAutomationCapabilitiesSchema,
  type ColumnAutomation,
  type CardAutomationOverride,
  type AutomationLimits,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { boardLock, cardScope, fail, transaction, type Scope } from '../kanban/service.js'
import { authorizeProject } from '../access/authorize.js'
import { appendDomainEvent } from '../events/store.js'
import { branchSchema } from '../kanban/repositories.js'

export interface ColumnConfigRow {
  id: string
  board_id: string
  project_id: string
  role: string
  name: string
  execution_policy_id: string | null
  deleted_at: Date | null
}
export async function columnScope(client: DatabaseClient, scope: Scope, columnId: string, write = false) {
  const rows = await client.query<ColumnConfigRow>(
    'select * from board_columns where organization_id=$1 and id=$2 and deleted_at is null',
    [scope.organizationId, columnId]
  )
  const column = rows.rows[0]
  if (!column) fail('Column not found.', 404)
  await authorizeProject(
    client,
    scope.organizationId,
    column.project_id,
    scope.userId,
    write ? 'automation:manage' : 'project:read'
  )
  if (write) await boardLock(client, scope, column.board_id)
  if (write && column.role !== 'normal') fail('Fixed columns cannot run automations.', 400)
  return column
}
export function configFromPolicy(row: any): ColumnAutomation {
  return columnAutomationSchema.parse(
    row?.automation_config ?? {
      enabled: row?.enabled ?? false,
      autoRun: row?.enabled ?? false,
      provider: row?.provider ?? 'codex',
      model: row?.model ?? '',
      effort: row?.effort ?? null,
      repositoryBindingId: row?.repository_binding_id ?? null,
      repositoryBranch: row?.repository_branch ?? null,
      taskType: row?.task_type === 'analysis' ? 'analysis' : 'code',
      approvalRequired: row?.approval_required ?? true,
      maxDurationSeconds: row ? Number(row.max_duration_seconds) : null,
      maxLogBytes: row ? Number(row.max_log_bytes) : null,
    }
  )
}
export async function currentConfig(client: DatabaseClient, column: ColumnConfigRow) {
  const rows = column.execution_policy_id
    ? await client.query('select * from execution_policies where id=$1', [column.execution_policy_id])
    : null
  const policy = rows?.rows[0]
  return { policy, config: configFromPolicy(policy) }
}
export async function projectCatalog(client: DatabaseClient, organizationId: string, projectId: string, ownerUserId?:string) {
  const rows = await client.query(
    `select r.id,r.name,r.status,r.last_seen_at as "lastSeenAt",r.repositories,
    r.automation_capabilities as capabilities from runners r join runner_project_bindings b
    on b.runner_id=r.id and b.organization_id=r.organization_id where b.organization_id=$1 and b.project_id=$2 and r.status<>'revoked' and r.owner_user_id is null`,
    [organizationId, projectId]
  )
  const shared = rows.rows.map((row) => {
    const parsed = runnerAutomationCapabilitiesSchema.safeParse(row.capabilities)
    return { ...row, capabilities: parsed.success ? parsed.data : null }
  })
  return ownerUserId ? [...shared,...(await personalDeviceRows(client,organizationId,projectId,ownerUserId)).filter(r=>r.enabled).map(r=>({...r,personal:true}))] : shared
}
export async function resolvedRepository(
  client: DatabaseClient,
  organizationId: string,
  projectId: string,
  config: ColumnAutomation
) {
  const project = await client.query(
    'select default_repository_binding_id from projects where id=$1 and organization_id=$2',
    [projectId, organizationId]
  )
  const id =
    config.taskType === 'analysis'
      ? null
      : (config.repositoryBindingId ?? project.rows[0]?.default_repository_binding_id ?? null)
  if (!id) return { repositoryBindingId: null, repositoryBranch: undefined }
  const repo = await client.query(
    'select base_branch from repository_bindings where organization_id=$1 and project_id=$2 and id=$3 and disabled_at is null',
    [organizationId, projectId, id]
  )
  if (!repo.rows[0]) fail('The repository is disabled or unavailable.')
  return { repositoryBindingId: id, repositoryBranch: config.repositoryBranch ?? repo.rows[0].base_branch }
}
export function assessAutomationRunner(
  row: any,
  config: ColumnAutomation,
  repository: { repositoryBindingId: string | null; repositoryBranch?: string },
  requireOnline = true
) {
  const reasons: string[] = []
  const caps = row.capabilities
  if (
    requireOnline &&
    (!row.lastSeenAt || Date.now() - new Date(row.lastSeenAt).getTime() > 60000 || row.status !== 'online')
  )
    reasons.push('Runner offline')
  if (!caps) reasons.push('Runner upgrade required')
  const model = caps?.models.find((m: any) => modelSupports(config, m))
  if (!model) reasons.push('Provider, model or options unavailable')
  if (config.mode === 'maestro' && !caps?.maestro) reasons.push('Maestro unavailable')
  if (config.subagentsEnabled && !caps?.subagents) reasons.push('Subagents unavailable')
  if (config.preCommands.length && !caps?.preCommands) reasons.push('Isolated pre-commands unavailable')
  if (config.runnerSelector === 'runner' && config.targetRunnerId !== row.id) reasons.push('Different target runner')
  if (
    repository.repositoryBindingId &&
    !row.repositories?.some(
      (r: any) =>
        r.bindingId === repository.repositoryBindingId &&
        r.available &&
        r.branches.includes(repository.repositoryBranch)
    )
  )
    reasons.push('Repository or branch unavailable')
  return { runnerId: row.id, name: row.name, compatible: reasons.length === 0, reasons, model }
}
export async function getColumnAutomation(pool: DatabasePool, scope: Scope & { columnId: string }) {
  return transaction(pool, scope, async (client) => {
    const column = await columnScope(client, scope, scope.columnId)
    const { policy, config } = await currentConfig(client, column)
    const board = await client.query('select name,version,automation_limits,roles_configured from boards where id=$1', [
      column.board_id,
    ])
    const project = await client.query('select name from projects where id=$1', [column.project_id])
    return {
      column: {
        id: column.id,
        name: column.name,
        boardId: column.board_id,
        projectId: column.project_id,
        role: column.role,
      },
      projectName: project.rows[0].name,
      boardName: board.rows[0].name,
      boardVersion: Number(board.rows[0].version),
      rolesConfigured: board.rows[0].roles_configured,
      policyId: policy?.id ?? null,
      version: policy ? Number(policy.version) : 0,
      config,
      limits: resolveAutomationLimits(board.rows[0].automation_limits),
    }
  })
}
export async function saveColumnAutomation(
  pool: DatabasePool,
  scope: Scope & { columnId: string; expectedPolicyId: string | null; config: ColumnAutomation }
) {
  return transaction(pool, scope, async (client) => {
    const column = await columnScope(client, scope, scope.columnId, true)
    // Reread after the board lock; another editor may have committed while we waited.
    const latest = await client.query<ColumnConfigRow>('select * from board_columns where id=$1 for update', [
      column.id,
    ])
    if (latest.rows[0]!.role !== 'normal') fail('Fixed columns cannot run automations.', 400)
    if (latest.rows[0]!.execution_policy_id !== scope.expectedPolicyId)
      fail('The column configuration changed. Reload before saving.')
    const board = await client.query('select roles_configured,automation_limits from boards where id=$1', [
      column.board_id,
    ])
    if (!board.rows[0].roles_configured) fail('Define the fixed columns before configuring automation.', 400)
    const config = columnAutomationSchema.parse(scope.config)
    if (config.mode === 'maestro' && !config.subagentsEnabled) fail('Maestro requires Maestrly subagents.', 400)
    if (config.repositoryBranch) branchSchema.parse(config.repositoryBranch)
    if (config.runnerSelector === 'runner' && !config.targetRunnerId) fail('Select a target runner.', 400)
    if (config.preCommands.length && config.taskType === 'analysis') fail('Pre-commands require a code workspace.', 400)
    if (config.repositoryBindingId) {
      const binding = await client.query(
        'select id from repository_bindings where organization_id=$1 and project_id=$2 and id=$3',
        [scope.organizationId, column.project_id, config.repositoryBindingId]
      )
      if (!binding.rowCount) fail('Repository not found.', 404)
    }
    const repository = config.enabled
      ? await resolvedRepository(client, scope.organizationId, column.project_id, config)
      : { repositoryBindingId: null }
    const catalog = await projectCatalog(client, scope.organizationId, column.project_id, !config.autoRun&&config.runnerSelector==='pool'?scope.userId:undefined)
    if (config.enabled) {
      if (!config.model.trim()) fail('Select an available model.', 400)
      if (!catalog.some((row) => assessAutomationRunner(row, config, repository, false).compatible))
        fail('No runner supports this configuration.', 409)
    }
    const previous = column.execution_policy_id
      ? (await client.query('select policy_key from execution_policies where id=$1', [column.execution_policy_id]))
          .rows[0]
      : null
    const policyKey = previous?.policy_key ?? crypto.randomUUID()
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', ['policy:' + policyKey])
    const limits = resolveAutomationLimits(board.rows[0].automation_limits)
    const rows = await client.query(
      `insert into execution_policies(organization_id,project_id,policy_key,version,name,task_type,
      execution_profile_id,required_capabilities,repository_binding_id,repository_branch,provider,model,effort,approval_required,max_duration_seconds,
      max_log_bytes,delivery,enabled,automation_config)
      values($1,$2,$3,(select coalesce(max(version),0)+1 from execution_policies where policy_key=$3),$4,$5,'default',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id,version`,
      [
        scope.organizationId,
        column.project_id,
        policyKey,
        column.name + ' automation',
        config.taskType,
        JSON.stringify([{ name: 'executor:' + config.provider }, { name: 'delivery:patch' }]),
        config.repositoryBindingId,
        config.repositoryBranch,
        config.provider,
        config.model || 'unconfigured',
        config.effort,
        config.approvalRequired,
        config.maxDurationSeconds ?? limits.maxDurationSeconds,
        config.maxLogBytes ?? limits.maxLogBytes,
        { mode: 'patch', requireHumanApproval: true },
        config.enabled,
        config,
      ]
    )
    await client.query('update board_columns set execution_policy_id=$2,updated_at=now() where id=$1', [
      column.id,
      rows.rows[0].id,
    ])
    await client.query('update boards set version=version+1,updated_at=now() where id=$1', [column.board_id])
    await appendDomainEvent(client, {
      organizationId: scope.organizationId,
      projectId: column.project_id,
      type: 'column.automation_saved',
      aggregateType: 'column',
      aggregateId: column.id,
      actor: { type: 'human', userId: scope.userId },
      data: { policyId: rows.rows[0].id, version: Number(rows.rows[0].version) },
    })
    return { policyId: rows.rows[0].id, version: Number(rows.rows[0].version), config }
  })
}
export async function columnAutomationHistory(pool: DatabasePool, scope: Scope & { columnId: string }) {
  return transaction(pool, scope, async (client) => {
    const column = await columnScope(client, scope, scope.columnId)
    const rows = await client.query(
      `select p.* from execution_policies p where p.organization_id=$1 and p.project_id=$2 and (
      p.policy_key=(select policy_key from execution_policies where id=$3) or p.id in (
        select (data->>'policyId')::uuid from domain_events where aggregate_type='column' and aggregate_id=$4 and data->>'policyId' is not null
      )) order by p.created_at desc limit 100`,
      [scope.organizationId, column.project_id, column.execution_policy_id, column.id]
    )
    return rows.rows.map((row) => ({
      id: row.id,
      version: Number(row.version),
      createdAt: row.created_at,
      config: configFromPolicy(row),
    }))
  })
}
export async function cardAutomationContext(pool: DatabasePool, scope: Scope & { cardId: string; columnId?: string }) {
  return transaction(pool, scope, async (client) => {
    const card = await cardScope(client, scope, scope.cardId)
    const column = await columnScope(client, scope, scope.columnId ?? card.column_id)
    if (column.board_id !== card.board_id) fail('Column belongs to another board.', 400)
    const { config, policy } = await currentConfig(client, column)
    const override = await client.query(
      'select config,version from card_automation_overrides where card_id=$1 and column_id=$2',
      [card.id, column.id]
    )
    const effective = effectiveAutomation(config, override.rows[0]?.config ?? null)
    const catalog = await projectCatalog(client, scope.organizationId, card.project_id)
    let repository: { repositoryBindingId: string | null; repositoryBranch?: string } = { repositoryBindingId: null }
    let error: string | undefined
    try {
      repository = await resolvedRepository(client, scope.organizationId, card.project_id, effective)
    } catch (caught) {
      error = (caught as Error).message
    }
    const guard = await client.query(
      'select dispatch_count,blocked_at from automation_dispatch_guards where card_id=$1 and column_id=$2',
      [card.id, column.id]
    )
    const active = await client.query(
      "select id from jobs where card_id=$1 and state in ('waiting_approval','queued','active')",
      [card.id]
    )
    return {
      cardVersion: Number(card.version),
      column: {
        id: column.id,
        name: column.name,
        boardId: column.board_id,
        projectId: column.project_id,
        role: column.role,
      },
      policyId: policy?.id ?? null,
      config,
      effective,
      override: override.rows[0]?.config ?? null,
      overrideVersion: Number(override.rows[0]?.version ?? 0),
      renderedPrompt: renderAutomationPrompt(
        effective.promptTemplate,
        { id: card.id, title: card.title, description: card.description },
        column.name
      ),
      personalDevices: (await personalDeviceRows(client,scope.organizationId,card.project_id,scope.userId)).map(row=>({
        id:row.id,enabled:row.enabled,online:row.enabled&&row.status==='online'&&!!row.lastSeenAt&&Date.now()-new Date(row.lastSeenAt).getTime()<60000,
        ...assessAutomationRunner(row,{...effective,runnerSelector:'runner',targetRunnerId:row.id},repository,false),
      })),
      runners: catalog.map((row) => assessAutomationRunner(row, effective, repository)),
      error,
      blocked: !!guard.rows[0]?.blocked_at,
      dispatchCount: guard.rows[0]?.dispatch_count ?? 0,
      active: !!active.rowCount,
    }
  })
}
export async function saveCardOverride(
  pool: DatabasePool,
  scope: Scope & { cardId: string; columnId: string; expectedVersion: number; config: CardAutomationOverride | null }
) {
  return transaction(pool, scope, async (client) => {
    const card = await cardScope(client, scope, scope.cardId, true)
    await authorizeProject(client, scope.organizationId, card.project_id, scope.userId, 'execution:request')
    const column = await columnScope(client, scope, scope.columnId)
    if (column.role !== 'normal' || column.board_id !== card.board_id)
      fail('Overrides require a normal column in this board.', 400)
    const existing = await client.query(
      'select * from card_automation_overrides where card_id=$1 and column_id=$2 for update',
      [card.id, column.id]
    )
    if (Number(existing.rows[0]?.version ?? 0) !== scope.expectedVersion)
      fail('The card override changed. Reload before saving.')
    const current = await currentConfig(client, column)
    const effective = effectiveAutomation(current.config, scope.config)
    if (current.config.enabled && scope.config) {
      const repository = await resolvedRepository(client, scope.organizationId, card.project_id, effective)
      const runners = await projectCatalog(client, scope.organizationId, card.project_id, !effective.autoRun&&effective.runnerSelector==='pool'?scope.userId:undefined)
      if (!runners.some((row) => assessAutomationRunner(row, effective, repository, false).compatible))
        fail('No runner supports this configuration.')
    }
    // Keep tombstones/version monotonic to prevent delete/recreate ABA races.
    await client.query(
      `insert into card_automation_overrides(organization_id,project_id,board_id,card_id,column_id,config,version)
      values($1,$2,$3,$4,$5,$6,1) on conflict(card_id,column_id) do update set config=$6,version=card_automation_overrides.version+1,updated_at=now()`,
      [scope.organizationId, card.project_id, card.board_id, card.id, column.id, scope.config ?? {}]
    )
    await appendDomainEvent(client, {
      organizationId: scope.organizationId,
      projectId: card.project_id,
      type: 'card.automation_override_changed',
      aggregateType: 'card',
      aggregateId: card.id,
      actor: { type: 'human', userId: scope.userId },
      data: { columnId: column.id, cleared: !scope.config },
    })
    return { ok: true }
  })
}
export async function releaseDispatch(pool: DatabasePool, scope: Scope & { cardId: string; columnId: string }) {
  return transaction(pool, scope, async (client) => {
    const card = await cardScope(client, scope, scope.cardId, true)
    await authorizeProject(client, scope.organizationId, card.project_id, scope.userId, 'execution:request')
    await client.query(
      'update automation_dispatch_guards set dispatch_count=0,window_started_at=now(),blocked_at=null where card_id=$1 and column_id=$2',
      [card.id, scope.columnId]
    )
    await appendDomainEvent(client, {
      organizationId: scope.organizationId,
      projectId: card.project_id,
      type: 'card.dispatch_released',
      aggregateType: 'card',
      aggregateId: card.id,
      actor: { type: 'human', userId: scope.userId },
      data: { columnId: scope.columnId },
    })
    return { ok: true }
  })
}
export async function saveBoardAutomationLimits(
  pool: DatabasePool,
  scope: Scope & { boardId: string; expectedVersion: number; limits: AutomationLimits }
) {
  return transaction(pool, scope, async (client) => {
    const board = await boardLock(client, scope, scope.boardId, scope.expectedVersion)
    await authorizeProject(client, scope.organizationId, board.project_id, scope.userId, 'automation:manage')
    await client.query('update boards set automation_limits=$2,version=version+1,updated_at=now() where id=$1', [
      scope.boardId,
      scope.limits,
    ])
    await appendDomainEvent(client, {
      organizationId: scope.organizationId,
      projectId: board.project_id,
      type: 'board.automation_limits_changed',
      aggregateType: 'board',
      aggregateId: scope.boardId,
      actor: { type: 'human', userId: scope.userId },
      data: { limits: scope.limits },
    })
    return { limits: resolveAutomationLimits(scope.limits) }
  })
}
