import { dispatchColumnAutomation } from '../automation/dispatch.js'
import { boardLock, fail } from '../kanban/service.js'
import type { Actor, Card, CardPatch, MoveCardRequest } from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { appendDomainEvent } from '../events/store.js'

export interface CardRow {
  dispatch_blocked?:boolean
  dispatch_count?:number
  id: string
  organization_id: string
  project_id: string
  board_id: string
  column_id: string
  parent_card_id: string | null
  title: string
  description: string
  acceptance_criteria: string[]
  priority: Card['priority']
  labels: string[]
  assignee_user_ids: string[]
  position: string
  version: string
  archived_at: Date | null
  deleted_at?: Date | null
  created_at: Date
  updated_at: Date
}

export function mapCard(row: CardRow): Card {
  return {
    id: row.id, organizationId: row.organization_id, projectId: row.project_id, boardId: row.board_id,
    columnId: row.column_id, parentCardId: row.parent_card_id, title: row.title, description: row.description,
    acceptanceCriteria: row.acceptance_criteria, priority: row.priority, labels: row.labels,
    assigneeUserIds: row.assignee_user_ids, position: Number(row.position), version: Number(row.version),
    archivedAt: row.archived_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    automationBlocked:row.dispatch_blocked??false,automationDispatchCount:Number(row.dispatch_count??0),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  }
}

export class OptimisticConflictError extends Error {
  readonly current: Card
  constructor(current: Card) {
    super('The card changed after it was loaded.')
    this.name = 'OptimisticConflictError'
    this.current = current
  }
}

async function lockedCard(client: DatabaseClient, organizationId: string, cardId: string, userId: string): Promise<CardRow> {
  const scope = await client.query<{board_id:string}>('select board_id from cards where organization_id=$1 and id=$2 and deleted_at is null',[organizationId,cardId])
  if (!scope.rows[0]) fail('Card not found.',404)
  await boardLock(client,{organizationId,userId},scope.rows[0].board_id)
  const result = await client.query<CardRow>('select * from cards where organization_id = $1 and id = $2 and deleted_at is null for update', [organizationId, cardId])
  if (!result.rows[0]) throw new Error('Card not found.')
  return result.rows[0]
}

export async function createCard(
  pool: DatabasePool,
  input: {
    organizationId: string; boardId: string; columnId?: string; userId: string; title: string; description?: string;
    acceptanceCriteria?: string[]; priority?: Card['priority']; labels?: string[]; assigneeUserIds?: string[]; parentCardId?: string | null
    actor?: Actor
  },
): Promise<Card> {
  const actor = input.actor ?? { type: 'human' as const, userId: input.userId }
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor }, async (client) => {
    const board = await client.query<{ project_id: string }>('select project_id from boards where organization_id = $1 and id = $2 and archived_at is null for update', [input.organizationId, input.boardId])
    const projectId = board.rows[0]?.project_id
    if (!projectId) throw new Error('Board not found.')
    await authorizeProject(client, input.organizationId, projectId, input.userId, 'work:write')
    const column = input.columnId
      ? await client.query<{ id: string }>('select id from board_columns where organization_id = $1 and board_id = $2 and id = $3 and deleted_at is null', [input.organizationId, input.boardId, input.columnId])
      : await client.query<{ id: string }>('select id from board_columns where organization_id = $1 and board_id = $2 and deleted_at is null order by position limit 1', [input.organizationId, input.boardId])
    if (!column.rows[0]) throw new Error('Column not found.')
    if (input.parentCardId) {
      const parent = await client.query<CardRow>('select * from cards where organization_id=$1 and board_id=$2 and id=$3 and deleted_at is null and archived_at is null for update',[input.organizationId,input.boardId,input.parentCardId])
      if (!parent.rows[0] || parent.rows[0].parent_card_id) fail('Subtasks must belong to a top-level card in this board.',400)
    }
    await validateAssignees(client,input.organizationId,projectId,input.assigneeUserIds ?? [])
    const position = await client.query<{ position: string }>(`
      select coalesce(max(position) + 1, 0)::text as position from cards
      where organization_id = $1 and board_id = $2 and column_id = $3 and archived_at is null
    `, [input.organizationId, input.boardId, column.rows[0].id])
    const result = await client.query<CardRow>(`
      insert into cards(
        organization_id, project_id, board_id, column_id, parent_card_id, title, description,
        acceptance_criteria, priority, labels, assignee_user_ids, position
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *
    `, [
      input.organizationId, projectId, input.boardId, column.rows[0].id, input.parentCardId ?? null,
      input.title, input.description ?? '', JSON.stringify(input.acceptanceCriteria ?? []), input.priority ?? 'none',
      JSON.stringify(input.labels ?? []), JSON.stringify(input.assigneeUserIds ?? []), Number(position.rows[0]!.position),
    ])
    const card = result.rows[0]!
    await appendDomainEvent(client, {
      organizationId: input.organizationId, projectId, type: 'card.created', aggregateType: 'card', aggregateId: card.id,
      actor, data: { boardId: input.boardId, columnId: card.column_id, version: 1 },
    })
    return mapCard(card)
  })
}

export async function updateCard(
  pool: DatabasePool,
  input: { organizationId: string; cardId: string; userId: string; patch: CardPatch; actor?: Actor },
): Promise<Card> {
  const actor = input.actor ?? { type: 'human' as const, userId: input.userId }
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor }, async (client) => {
    const existing = await lockedCard(client, input.organizationId, input.cardId, input.userId)
    await authorizeProject(client, input.organizationId, existing.project_id, input.userId, 'work:write')
    if (Number(existing.version) !== input.patch.expectedVersion) throw new OptimisticConflictError(mapCard(existing))
    if (existing.archived_at && input.patch.archived !== false) fail('Restore this card before editing it.')
    await validateAssignees(client,input.organizationId,existing.project_id,(input.patch.assigneeUserIds ?? []).filter(id=>!existing.assignee_user_ids.includes(id)))
    if(input.patch.archived === false && existing.parent_card_id) {
      const parent=await client.query('select id from cards where id=$1 and deleted_at is null and archived_at is null',[existing.parent_card_id])
      if(!parent.rowCount)fail('Restore the parent card first.')
    }
    if(input.patch.archived !== undefined) {
      const family=await client.query<{id:string}>('select id from cards where id=$1 or parent_card_id=$1 order by id for update',[existing.id])
      const ids=family.rows.map(c=>c.id)
      await client.query('select id from jobs where card_id=any($1::uuid[]) order by id for update',[ids])
      const active=await client.query("select r.id from runs r join jobs j on j.id=r.job_id where j.card_id=any($1::uuid[]) and r.state in ('claimed','running','cancelling')",[ids])
      if(input.patch.archived && active.rowCount) fail('Cancel active executions before removing this card.')
      if(input.patch.archived) await client.query("update jobs set state='cancelled',updated_at=now() where card_id=any($1::uuid[]) and state <> 'completed'",[ids])
      await client.query('update cards set archived_at=case when $2 then now() else null end,version=version+1,updated_at=now() where parent_card_id=$1 and deleted_at is null',[existing.id,input.patch.archived])
    }
    const result = await client.query<CardRow>(`
      update cards set
        title = $3, description = $4, acceptance_criteria = $5, priority = $6, labels = $7,
        assignee_user_ids = $8, archived_at = $9, version = version + 1, updated_at = now()
      where organization_id = $1 and id = $2 returning *
    `, [
      input.organizationId, input.cardId,
      input.patch.title ?? existing.title,
      input.patch.description ?? existing.description,
      JSON.stringify(input.patch.acceptanceCriteria ?? existing.acceptance_criteria),
      input.patch.priority ?? existing.priority,
      JSON.stringify(input.patch.labels ?? existing.labels),
      JSON.stringify(input.patch.assigneeUserIds ?? existing.assignee_user_ids),
      input.patch.archived === undefined ? existing.archived_at : input.patch.archived ? new Date() : null,
    ])
    const updated = result.rows[0]!
    if (input.patch.archived === true) {
      await client.query(`update runs set state = 'cancelling' where job_id in (
        select id from jobs where organization_id = $1 and card_id = $2
      ) and state in ('claimed', 'running')`, [input.organizationId, input.cardId])
    }
    await appendDomainEvent(client, {
      organizationId: input.organizationId, projectId: existing.project_id,
      type: input.patch.archived === true ? 'card.archived' : 'card.updated', aggregateType: 'card', aggregateId: input.cardId,
      actor, data: { previousVersion: Number(existing.version), version: Number(updated.version) },
    })
    return mapCard(updated)
  })
}

async function reorderColumn(
  client: DatabaseClient,
  organizationId: string,
  boardId: string,
  columnId: string,
  cardId: string,
  targetPosition: number,
): Promise<void> {
  const rows = await client.query<{ id: string }>(`
    select id from cards
    where organization_id = $1 and board_id = $2 and column_id = $3 and archived_at is null and deleted_at is null and id <> $4
    order by position, id for update
  `, [organizationId, boardId, columnId, cardId])
  const ids = rows.rows.map((row) => row.id)
  ids.splice(Math.min(targetPosition, ids.length), 0, cardId)
  for (let position = 0; position < ids.length; position += 1) {
    await client.query('update cards set position = $3, version=version+case when id=$4 then 0 else 1 end where organization_id = $1 and id = $2 and position <> $3', [organizationId, ids[position], position,cardId])
  }
}

interface PolicyRow {
  id: string; version: string; task_type: string; execution_profile_id: string; required_capabilities: unknown[];
  repository_branch?: string | null; repository_binding_id: string | null; provider: 'codex' | 'claude-agent'; model: string; effort: string | null;
  approval_required: boolean; max_duration_seconds: string; max_log_bytes: string; delivery: Record<string, unknown>; enabled: boolean
}

export async function moveCard(
  pool: DatabasePool,
  input: { organizationId: string; cardId: string; userId: string; move: MoveCardRequest; actor?: Actor },
): Promise<{ card: Card; jobId?: string }> {
  const actor = input.actor ?? { type: 'human' as const, userId: input.userId }
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor }, async (client) => {
    const existing = await lockedCard(client, input.organizationId, input.cardId, input.userId)
    await authorizeProject(client, input.organizationId, existing.project_id, input.userId, 'work:write')
    if(existing.archived_at) fail('Restore this card before moving it.')
    if (Number(existing.version) !== input.move.expectedVersion) throw new OptimisticConflictError(mapCard(existing))
    const target = await client.query<{ id: string; execution_policy_id: string | null }>(`
      select id, execution_policy_id from board_columns
      where organization_id = $1 and project_id = $2 and board_id = $3 and id = $4 and deleted_at is null for update
    `, [input.organizationId, existing.project_id, existing.board_id, input.move.targetColumnId])
    const targetColumn = target.rows[0]
    if (!targetColumn) throw new Error('Target column not found.')

    const transition = existing.column_id !== targetColumn.id
    if (transition) {
      await client.query("update jobs set state='cancelled',updated_at=now() where card_id=$1 and state in ('queued','waiting_approval','waiting_input','needs_attention')",[input.cardId])
      await client.query("update approvals set status='revoked',decided_at=now(),decided_by_user_id=$2 where job_id in(select id from jobs where card_id=$1 and state='cancelled') and status='pending'",[input.cardId,input.userId])
      await client.query(`update runs set state = 'cancelling' where job_id in (
        select id from jobs where organization_id = $1 and card_id = $2
      ) and state in ('claimed', 'running')`, [input.organizationId, input.cardId])
      await client.query('update cards set column_id = $3 where organization_id = $1 and id = $2', [input.organizationId, input.cardId, targetColumn.id])
    }
    await reorderColumn(client, input.organizationId, existing.board_id, targetColumn.id, input.cardId, input.move.targetPosition)
    const updatedResult = await client.query<CardRow>(`
      update cards set version = version + 1, updated_at = now()
      where organization_id = $1 and id = $2 returning *
    `, [input.organizationId, input.cardId])
    const updated = updatedResult.rows[0]!
    const event = await appendDomainEvent(client, {
      organizationId: input.organizationId, projectId: existing.project_id,
      type: transition ? 'card.transitioned' : 'card.reordered', aggregateType: 'card', aggregateId: input.cardId,
      actor, data: { fromColumnId: existing.column_id, toColumnId: targetColumn.id, position: input.move.targetPosition, version: Number(updated.version) },
    })

    let jobId:string|undefined
    const personal=input.move.personalExecution
    if(personal&&(actor.type!=='human'||input.move.source!=='human'))fail('Personal execution requires an explicit human request.',403)
    if(personal){
      await authorizeProject(client,input.organizationId,existing.project_id,input.userId,'execution:request')
      const dispatch=await dispatchColumnAutomation(client,{organizationId:input.organizationId,userId:input.userId},updated,{manual:true,sourceEventId:event.id,expectedPolicyId:personal.expectedPolicyId,expectedOverrideVersion:personal.expectedOverrideVersion,personalDeviceId:personal.deviceId})
      if(!dispatch.jobId)fail(dispatch.reason??'Execution could not be requested.',409)
      jobId=dispatch.jobId
    }
    const automationAllowed=input.move.source!=='agent'||input.move.allowAutomationChain&&input.move.chainDepth<5
    if(!personal&&transition&&automationAllowed) {
      const dispatch=await dispatchColumnAutomation(client,{organizationId:input.organizationId,userId:input.userId},updated,{manual:false,sourceEventId:event.id})
      jobId=dispatch.jobId??undefined
    }
    return { card: mapCard(updated), ...(jobId ? { jobId } : {}) }
  })
}

export async function requestCardPreparation(
  pool: DatabasePool,
  input: { organizationId: string; cardId: string; userId: string; expectedVersion: number },
): Promise<{ jobId: string }> {
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    const card = await lockedCard(client, input.organizationId, input.cardId, input.userId)
    await authorizeProject(client, input.organizationId, card.project_id, input.userId, 'execution:request')
    if (Number(card.version) !== input.expectedVersion) throw new OptimisticConflictError(mapCard(card))
    const policy = await client.query<PolicyRow>(`
      select * from execution_policies
      where organization_id = $1 and project_id = $2 and task_type = 'analysis'
        and repository_binding_id is null and enabled = true
      order by version desc limit 1
    `, [input.organizationId, card.project_id])
    const selected = policy.rows[0]
    if (!selected) throw Object.assign(new Error('No enabled repository-free analysis policy is configured.'), { statusCode: 409 })
    const event = await appendDomainEvent(client, {
      organizationId: input.organizationId, projectId: card.project_id, type: 'card.preparation_requested',
      aggregateType: 'card', aggregateId: card.id, actor: { type: 'human', userId: input.userId }, data: { cardVersion: Number(card.version) },
    })
    const snapshot = {
      title: `Prepare: ${card.title}`,
      description: `Propose a clearer description, decomposition and acceptance criteria. Do not access a repository.\n\nCurrent description:\n${card.description}`,
      acceptanceCriteria: card.acceptance_criteria, taskType: 'analysis', provider: selected.provider, model: selected.model,
      ...(selected.effort ? { effort: selected.effort } : {}), repositoryBindingId: null,
      delivery: { mode: 'patch', requireHumanApproval: true },
    }
    const job = await client.query<{ id: string }>(`
      insert into jobs(organization_id, project_id, board_id, card_id, source_event_id, policy_id, policy_version, snapshot, state, requested_by_user_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id
    `, [
      input.organizationId, card.project_id, card.board_id, card.id, event.id, selected.id, Number(selected.version), snapshot,
      selected.approval_required ? 'waiting_approval' : 'queued', input.userId,
    ])
    if (selected.approval_required) {
      await client.query("insert into approvals(organization_id, project_id, job_id, status, requested_by_user_id) values ($1,$2,$3,'pending',$4)", [input.organizationId, card.project_id, job.rows[0]!.id, input.userId])
    }
    return { jobId: job.rows[0]!.id }
  })
}

export async function getCardDetail(
  pool: DatabasePool,
  input: { organizationId: string; cardId: string; userId: string },
) {
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    const card = await client.query<CardRow>('select * from cards where organization_id = $1 and id = $2 and deleted_at is null', [input.organizationId, input.cardId])
    if (!card.rows[0]) throw Object.assign(new Error('Card not found.'), { statusCode: 404 })
    await authorizeProject(client, input.organizationId, card.rows[0].project_id, input.userId, 'project:read')
    const comments = await client.query(`select id, body, author_type as "authorType", author_id as "authorId", created_at as "createdAt",version::int,updated_at as "updatedAt" from comments where organization_id = $1 and card_id = $2 and deleted_at is null order by created_at`, [input.organizationId, input.cardId])
    const attachments = await client.query(`select id, filename, content_type as "contentType", size_bytes::int as "sizeBytes", created_at as "createdAt" from attachments where organization_id = $1 and card_id = $2 order by created_at`, [input.organizationId, input.cardId])
    const executions = await client.query(`select j.id as "jobId", j.state as "jobState", j.snapshot->'personalDevice' as "personalDevice", r.id as "runId", r.state as "runState", r.outcome, r.finished_at as "finishedAt" from jobs j left join lateral (select * from runs where job_id = j.id order by attempt desc limit 1) r on true where j.organization_id = $1 and j.card_id = $2 order by j.created_at desc`, [input.organizationId, input.cardId])
    const artifacts = await client.query(`select a.id, a.kind, a.name, a.content_type as "contentType", a.size_bytes::int as "sizeBytes", a.orphaned, a.created_at as "createdAt" from artifacts a join runs r on r.id = a.run_id join jobs j on j.id = r.job_id where a.organization_id = $1 and j.card_id = $2 order by a.created_at desc`, [input.organizationId, input.cardId])
    const subtasks=await client.query<CardRow>('select * from cards where parent_card_id=$1 and deleted_at is null order by created_at',[input.cardId])
    const parent=card.rows[0].parent_card_id ? await client.query<CardRow>('select * from cards where id=$1 and deleted_at is null',[card.rows[0].parent_card_id]) : null
    const column=await client.query<{name:string}>('select name from board_columns where id=$1',[card.rows[0].column_id])
    const grants=await authorizeProject(client,input.organizationId,card.rows[0].project_id,input.userId,'project:read')
    const attempts=await client.query('select r.id,r.job_id as "jobId",r.attempt,r.state,r.outcome,r.started_at as "startedAt",r.finished_at as "finishedAt" from runs r join jobs j on j.id=r.job_id where j.card_id=$1 order by r.created_at desc',[input.cardId])
    const requests=await client.query(`select j.id as "jobId",a.id as "approvalId",a.status as "approvalStatus",i.id as "informationRequestId",i.question
      from jobs j left join approvals a on a.job_id=j.id and a.status='pending'
      left join information_requests i on i.job_id=j.id and i.response is null where j.card_id=$1 and j.state not in ('completed','cancelled')`,[input.cardId])
    const guard=await client.query('select blocked_at,dispatch_count from automation_dispatch_guards where card_id=$1 and column_id=$2',[input.cardId,card.rows[0].column_id])
    card.rows[0].dispatch_blocked=!!guard.rows[0]?.blocked_at
    card.rows[0].dispatch_count=guard.rows[0]?.dispatch_count??0
    const activeFamily=await client.query<{count:number}>(`select count(*)::int as count from runs r join jobs j on j.id=r.job_id join cards c on c.id=j.card_id
      where (c.id=$1 or c.parent_card_id=$1) and r.state in ('claimed','running','cancelling')`,[input.cardId])
    return { activeFamilyRuns:activeFamily.rows[0]!.count, columnName:column.rows[0]?.name, userId:input.userId, canModerate:['owner','admin'].includes(grants.organizationRole)||grants.projectRole==='maintainer',
      subtasks:subtasks.rows.map(mapCard),parent:parent?.rows[0]?mapCard(parent.rows[0]):null,attempts:attempts.rows,requests:requests.rows,
      card: mapCard(card.rows[0]), comments: comments.rows, attachments: attachments.rows, executions: executions.rows, artifacts: artifacts.rows }
  })
}

async function validateAssignees(client: DatabaseClient, organizationId: string, projectId: string, ids: string[]) {
  if (!ids.length) return
  const members=await client.query<{user_id:string}>("select om.user_id from organization_members om left join project_members pm on pm.organization_id=om.organization_id and pm.project_id=$2 and pm.user_id=om.user_id where om.organization_id=$1 and om.user_id=any($3::text[]) and (pm.user_id is not null or om.role in ('owner','admin'))",[organizationId,projectId,ids])
  if(new Set(members.rows.map(m=>m.user_id)).size!==new Set(ids).size) fail('Assignees must be members of this project.',400)
}
