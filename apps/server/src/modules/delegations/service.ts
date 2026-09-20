/**
 * Delegation task domain. The REST API, the MCP connector and the scheduler all call these functions, so
 * authorization, versioning and the stage snapshot rules exist in exactly one place.
 */
import {
  assertAcyclicStageInputs,
  defaultDelegationPolicy,
  delegationCreateSchema,
  delegationTaskViewSchema,
  isAgentStageType,
  mergeDelegationPolicy,
  resolveStageSettings,
  stageDefinitionInputSchema,
  type DelegationCreate,
  type DelegationEvent,
  type DelegationModelCatalog,
  type DelegationPolicy,
  type DelegationTask,
  type DelegationTaskView,
  type StageDefinitionInput,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { createCard } from '../cards/service.js'
import { delegationLinks, type DelegationLinkOptions } from './links.js'
import { executorDelegationCatalog } from './model-catalog.js'
import { loadPreset } from './presets.js'
import {
  appendDelegationEvent,
  delegationFail,
  loadAttempts,
  loadStages,
  loadTaskRow,
  mapDelegationEvent,
  mapStage,
  mapTask,
} from './repository.js'

export interface DelegationScope {
  organizationId: string
  projectId: string
  userId: string
  /** Present when the request arrived through an external connector. */
  connectionId?: string | null
}

export { delegationLinks }
export type { DelegationLinkOptions }

export async function delegationTransaction<T>(
  pool: DatabasePool,
  scope: DelegationScope,
  write: boolean,
  fn: (client: DatabaseClient) => Promise<T>
): Promise<T> {
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, projectId: scope.projectId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await authorizeProject(
        client,
        scope.organizationId,
        scope.projectId,
        scope.userId,
        write ? 'execution:request' : 'project:read'
      )
      return fn(client)
    }
  )
}

/** Only the owner, a project maintainer or an organization administrator may control a task. */
export async function assertTaskControl(client: DatabaseClient, scope: DelegationScope, task: DelegationTask) {
  if (task.ownerUserId === scope.userId) return
  await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'automation:manage')
}

interface PreparedStage {
  input: StageDefinitionInput
  settings: Record<string, unknown> | null
  action: Record<string, unknown> | null
}

/**
 * Resolve each stage against the executor's live catalog before anything is written. A stage whose
 * account/model/effort/Fast combination is unavailable stops creation instead of being approximated.
 */
export function prepareStages(stages: StageDefinitionInput[], catalog: DelegationModelCatalog): PreparedStage[] {
  assertAcyclicStageInputs(stages)
  let inherited: ReturnType<typeof resolveStageSettings>['settings'] | undefined
  return stages.map((stage) => {
    if (!isAgentStageType(stage.type)) {
      if (!stage.action) delegationFail(`Stage "${stage.title}" needs a structured host action.`, 400)
      return { input: stage, settings: null, action: stage.action as Record<string, unknown> }
    }
    if (stage.action) delegationFail(`Stage "${stage.title}" is an agent stage and cannot carry a host action.`, 400)
    const patch = stage.settings ?? {}
    const resolved = resolveStageSettings(catalog, patch, inherited)
    inherited = resolved.settings
    return { input: stage, settings: resolved.settings as unknown as Record<string, unknown>, action: null }
  })
}

export async function createDelegation(
  pool: DatabasePool,
  scope: DelegationScope,
  raw: DelegationCreate,
  links: DelegationLinkOptions
): Promise<DelegationTaskView> {
  const input = delegationCreateSchema.parse(raw)
  return delegationTransaction(pool, scope, true, async (client) => {
    const catalog = await executorDelegationCatalog(client, {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      executorId: input.executorId,
      userId: scope.userId,
    })
    const workspace = catalog.workspaces.find((candidate) => candidate.key === input.workspaceKey)
    if (!workspace) delegationFail('That workspace is not available on the selected executor.', 409)
    if (!workspace.branches.includes(input.baseBranch))
      delegationFail('That base branch is not available in the selected workspace.', 409)

    let policy: DelegationPolicy = defaultDelegationPolicy()
    let stages: StageDefinitionInput[] = input.stages.map((stage) => stageDefinitionInputSchema.parse(stage))
    let presetId: string | null = null
    if (input.presetId) {
      const preset = await loadPreset(client, scope, input.presetId)
      presetId = preset.id
      policy = preset.policy
      // An explicit pipeline overrides the preset's stages; the policy still comes from the preset.
      if (!raw.stages?.length) stages = preset.stages
    }
    policy = mergeDelegationPolicy(policy, input.policy)

    let cardId = input.cardId ?? null
    let boardId = input.boardId ?? null
    let title = input.title ?? ''
    let objective = input.objective
    let acceptanceCriteria = input.acceptanceCriteria
    if (cardId) {
      const card = await client.query<{
        board_id: string
        title: string
        description: string
        acceptance_criteria: string[]
      }>(
        'select board_id, title, description, acceptance_criteria from cards where organization_id=$1 and project_id=$2 and id=$3 and deleted_at is null',
        [scope.organizationId, scope.projectId, cardId]
      )
      const found = card.rows[0]
      if (!found) delegationFail('Card not found in this project.', 404)
      if (boardId && boardId !== found.board_id) delegationFail('The card belongs to another board.', 409)
      boardId = found.board_id
      title = title || found.title
      objective = objective || found.description
      if (!acceptanceCriteria.length) acceptanceCriteria = found.acceptance_criteria
    } else {
      const created = await createCard(pool, {
        organizationId: scope.organizationId,
        boardId: boardId!,
        userId: scope.userId,
        title,
        description: objective,
        acceptanceCriteria,
      })
      cardId = created.id
      boardId = created.boardId
    }

    const prepared = prepareStages(stages, catalog)
    const inserted = await client.query(
      `insert into delegation_tasks(
         organization_id, project_id, board_id, card_id, owner_user_id, connection_id, title, objective,
         acceptance_criteria, executor_id, workspace_key, base_branch, repository_binding_id, preset_id, policy, state
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'draft') returning *`,
      [
        scope.organizationId,
        scope.projectId,
        boardId,
        cardId,
        scope.userId,
        scope.connectionId ?? null,
        title,
        objective,
        JSON.stringify(acceptanceCriteria),
        input.executorId,
        input.workspaceKey,
        input.baseBranch,
        workspace.repositoryBindingId,
        presetId,
        policy,
      ]
    )
    const task = (await loadTaskRow(client, scope, inserted.rows[0]!.id, 'update'))
    const stageIds: string[] = []
    for (const [index, stage] of prepared.entries()) {
      const row = await client.query(
        `insert into delegation_stages(
           organization_id, project_id, task_id, type, title, instructions, position, depends_on, settings, action,
           required_for_completion
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [
          scope.organizationId,
          scope.projectId,
          task.id,
          stage.input.type,
          stage.input.title,
          stage.input.instructions,
          index,
          JSON.stringify([]),
          stage.settings,
          stage.action,
          stage.input.requiredForCompletion,
        ]
      )
      stageIds.push(mapStage(row.rows[0]!).id)
    }
    // Dependencies reference positions in the request; rewrite them to persisted stage ids.
    for (const [index, stage] of prepared.entries()) {
      if (!stage.input.dependsOn.length) continue
      await client.query('update delegation_stages set depends_on=$2 where id=$1', [
        stageIds[index],
        JSON.stringify(stage.input.dependsOn.map((position) => stageIds[position])),
      ])
    }
    const settingsMap = Object.fromEntries(
      prepared.flatMap((stage, index) => (stage.settings ? [[stageIds[index]!, stage.settings]] : []))
    )
    await client.query(
      `insert into delegation_settings_revisions(organization_id, project_id, task_id, revision, settings, reason, created_by_user_id)
       values($1,$2,$3,1,$4,'created',$5)`,
      [scope.organizationId, scope.projectId, task.id, settingsMap, scope.userId]
    )
    for (const dependency of input.dependsOnTaskIds) {
      if (dependency === task.id) delegationFail('A task cannot depend on itself.', 400)
      const exists = await client.query(
        'select id from delegation_tasks where organization_id=$1 and project_id=$2 and id=$3',
        [scope.organizationId, scope.projectId, dependency]
      )
      if (!exists.rowCount) delegationFail('Dependency task not found in this project.', 404)
      if (await createsCycle(client, task.id, dependency)) delegationFail('Task dependencies must stay acyclic.', 400)
      await client.query(
        'insert into delegation_dependencies(organization_id, project_id, task_id, depends_on_task_id) values($1,$2,$3,$4) on conflict do nothing',
        [scope.organizationId, scope.projectId, task.id, dependency]
      )
    }
    await appendDelegationEvent(client, task, 'task.created', {
      stageCount: prepared.length,
      executorId: input.executorId,
      catalogRevision: catalog.revision,
    })
    return buildView(client, scope, task.id, links)
  })
}

/** Depth-bounded reachability check so a dependency edge can never close a cycle. */
async function createsCycle(client: DatabaseClient, taskId: string, dependency: string): Promise<boolean> {
  const seen = new Set<string>([dependency])
  let frontier = [dependency]
  for (let depth = 0; depth < 50 && frontier.length; depth += 1) {
    const rows = await client.query<{ depends_on_task_id: string }>(
      'select depends_on_task_id from delegation_dependencies where task_id = any($1::uuid[])',
      [frontier]
    )
    const next: string[] = []
    for (const row of rows.rows) {
      if (row.depends_on_task_id === taskId) return true
      if (seen.has(row.depends_on_task_id)) continue
      seen.add(row.depends_on_task_id)
      next.push(row.depends_on_task_id)
    }
    frontier = next
  }
  return false
}

export async function buildView(
  client: DatabaseClient,
  scope: DelegationScope,
  taskId: string,
  links: DelegationLinkOptions
): Promise<DelegationTaskView> {
  const task = await loadTaskRow(client, scope, taskId)
  return delegationTaskViewSchema.parse({
    task,
    stages: await loadStages(client, taskId),
    attempts: await loadAttempts(client, taskId),
    links: delegationLinks(links, task),
  })
}

export async function getDelegation(
  pool: DatabasePool,
  scope: DelegationScope,
  taskId: string,
  links: DelegationLinkOptions
): Promise<DelegationTaskView> {
  return delegationTransaction(pool, scope, false, (client) => buildView(client, scope, taskId, links))
}

export interface DelegationListFilter {
  state?: DelegationTask['state']
  cardId?: string
  limit?: number
  after?: string
}

export async function listDelegations(
  pool: DatabasePool,
  scope: DelegationScope,
  filter: DelegationListFilter,
  links: DelegationLinkOptions
) {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100)
  return delegationTransaction(pool, scope, false, async (client) => {
    const rows = await client.query(
      `select * from delegation_tasks
       where organization_id=$1 and project_id=$2
         and ($3::text is null or state = $3)
         and ($4::uuid is null or card_id = $4)
         and ($5::uuid is null or (created_at, id) < (select created_at, id from delegation_tasks where id = $5))
       order by created_at desc, id desc limit $6`,
      [scope.organizationId, scope.projectId, filter.state ?? null, filter.cardId ?? null, filter.after ?? null, limit + 1]
    )
    const tasks = rows.rows.slice(0, limit).map((row) => {
      const task = mapTask(row)
      return { task, links: delegationLinks(links, task) }
    })
    return { items: tasks, more: rows.rows.length > limit }
  })
}

export async function listDelegationEvents(
  pool: DatabasePool,
  scope: DelegationScope,
  taskId: string,
  cursor: number,
  limit = 100
): Promise<DelegationEvent[]> {
  return delegationTransaction(pool, scope, false, async (client) => {
    await loadTaskRow(client, scope, taskId)
    const rows = await client.query(
      'select * from delegation_events where task_id=$1 and sequence > $2 order by sequence limit $3',
      [taskId, cursor, Math.min(limit, 200)]
    )
    return rows.rows.map(mapDelegationEvent)
  })
}

export async function listDelegationAttempts(pool: DatabasePool, scope: DelegationScope, taskId: string) {
  return delegationTransaction(pool, scope, false, async (client) => {
    await loadTaskRow(client, scope, taskId)
    return loadAttempts(client, taskId)
  })
}
