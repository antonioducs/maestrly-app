/**
 * Typed inspections requested from outside the executor.
 *
 * Every operation is structured: there is no arbitrary shell and no path outside the workspace. Read-only
 * operations are always allowed within the grant; browser navigation and interaction require the executor to
 * advertise the capability and the task policy to authorize it.
 */
import {
  delegationModelCatalogSchema,
  inspectionOperationSchema,
  inspectionRequiresInteraction,
  inspectionSchema,
  assertWorkspaceRelativePath,
  type DelegationInspection,
  type DelegationTask,
  type InspectionOperation,
} from '@maestrly/protocol'
import { z } from 'zod'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { appendDelegationEvent, delegationFail, loadTaskRow } from './repository.js'
import { delegationTransaction, type DelegationScope } from './service.js'

const LEASE_SECONDS = 120

function mapInspection(row: Record<string, unknown>): DelegationInspection {
  return inspectionSchema.parse({
    id: row.id,
    taskId: row.task_id,
    operation: row.operation,
    state: row.state,
    result: row.result ?? null,
    artifactId: row.artifact_id ?? null,
    error: row.error ?? null,
    codeRevisionDigest: row.code_revision_digest ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    finishedAt: row.finished_at ? (row.finished_at as Date).toISOString() : null,
  })
}

/** Reject an operation the host cannot honor before it is queued, so no job waits on an impossible request. */
export function validateInspectionOperation(
  operation: InspectionOperation,
  context: { task: DelegationTask; capabilities: { browserInspect: boolean; browserInteract: boolean; preview: boolean } }
): void {
  if (operation.kind === 'read_file') assertWorkspaceRelativePath(operation.path)
  if (operation.kind === 'browser_snapshot' || operation.kind === 'browser_screenshot' || operation.kind === 'browser_text' || operation.kind === 'browser_console' || operation.kind === 'browser_network') {
    if (!context.capabilities.browserInspect)
      delegationFail('This executor does not offer browser inspection.', 409, 'CAPABILITY_MISMATCH')
  }
  if (inspectionRequiresInteraction(operation)) {
    if (operation.kind === 'preview_start' || operation.kind === 'preview_stop') {
      if (!context.capabilities.preview)
        delegationFail('This executor cannot start a configured preview.', 409, 'CAPABILITY_MISMATCH')
      return
    }
    if (!context.capabilities.browserInteract)
      delegationFail('This executor does not offer browser interaction.', 409, 'CAPABILITY_MISMATCH')
    if (!context.task.policy.autonomy.previewInteract)
      delegationFail('The task policy does not authorize preview interaction.', 403)
  }
}

async function executorCapabilities(client: DatabaseClient, task: DelegationTask) {
  const rows = await client.query<{ delegation_capabilities: unknown }>(
    'select delegation_capabilities from runners where organization_id=$1 and id=$2',
    [task.organizationId, task.executorId]
  )
  const parsed = delegationModelCatalogSchema.safeParse(rows.rows[0]?.delegation_capabilities)
  if (!parsed.success || !parsed.data.enabled)
    delegationFail('This executor does not advertise delegation stages.', 409, 'CAPABILITY_MISMATCH')
  return {
    browserInspect: parsed.data.features.browserInspect,
    browserInteract: parsed.data.features.browserInteract,
    preview: parsed.data.features.preview.available,
    checks: parsed.data.features.checks,
  }
}

/**
 * Queue one inspection for the executor. A read that the server already holds is answered directly by the
 * caller; anything that needs the workspace becomes a job with its own identifier.
 */
export async function startInspection(
  pool: DatabasePool,
  scope: DelegationScope,
  input: { taskId: string; operation: unknown }
): Promise<DelegationInspection> {
  const operation = inspectionOperationSchema.parse(input.operation)
  return delegationTransaction(pool, scope, true, async (client) => {
    const task = await loadTaskRow(client, scope, input.taskId)
    const capabilities = await executorCapabilities(client, task)
    if (operation.kind === 'preview_start' && !capabilities.checks.some((check) => check.id === operation.checkId))
      delegationFail('That preview is not a configured check on this executor.', 409)
    validateInspectionOperation(operation, { task, capabilities })
    const rows = await client.query(
      `insert into delegation_inspections(
         organization_id, project_id, task_id, requested_by_user_id, connection_id, operation
       ) values ($1,$2,$3,$4,$5,$6) returning *`,
      [scope.organizationId, scope.projectId, task.id, scope.userId, scope.connectionId ?? null, operation]
    )
    const inspection = mapInspection(rows.rows[0]!)
    await appendDelegationEvent(client, task, 'inspection.requested', {
      inspectionId: inspection.id,
      kind: operation.kind,
    })
    return inspection
  })
}

export async function getInspection(
  pool: DatabasePool,
  scope: DelegationScope,
  input: { taskId: string; inspectionId: string }
): Promise<DelegationInspection> {
  return delegationTransaction(pool, scope, false, async (client) => {
    const rows = await client.query(
      'select * from delegation_inspections where organization_id=$1 and project_id=$2 and task_id=$3 and id=$4',
      [scope.organizationId, scope.projectId, input.taskId, input.inspectionId]
    )
    if (!rows.rows[0]) delegationFail('Inspection not found.', 404)
    return mapInspection(rows.rows[0])
  })
}

export const inspectionCompletionSchema = z
  .object({
    leaseId: z.string().uuid(),
    state: z.enum(['succeeded', 'failed']),
    result: z.record(z.string(), z.unknown()).nullable().default(null),
    artifactId: z.string().uuid().nullable().default(null),
    error: z.string().max(4_000).nullable().default(null),
    codeRevisionDigest: z.string().max(191).nullable().default(null),
  })
  .strict()

/** Claim the next queued inspection for an executor, leasing it so two runs cannot answer the same request. */
export async function claimInspection(
  client: DatabaseClient,
  input: { organizationId: string; runnerId: string }
): Promise<{ inspection: DelegationInspection; leaseId: string; taskId: string; workspaceKey: string } | null> {
  const rows = await client.query(
    `select i.* from delegation_inspections i
     join delegation_tasks t on t.id = i.task_id
     where i.organization_id=$1 and t.executor_id=$2 and i.state='queued'
     order by i.created_at for update skip locked limit 1`,
    [input.organizationId, input.runnerId]
  )
  const row = rows.rows[0]
  if (!row) return null
  const leaseId = crypto.randomUUID()
  const updated = await client.query(
    `update delegation_inspections set state='running', lease_id=$2,
       lease_expires_at = now() + ($3 || ' seconds')::interval where id=$1 returning *`,
    [row.id, leaseId, String(LEASE_SECONDS)]
  )
  const task = await client.query<{ workspace_key: string }>('select workspace_key from delegation_tasks where id=$1', [
    row.task_id,
  ])
  return {
    inspection: mapInspection(updated.rows[0]!),
    leaseId,
    taskId: String(row.task_id),
    workspaceKey: String(task.rows[0]!.workspace_key),
  }
}

export async function completeInspection(
  client: DatabaseClient,
  input: { organizationId: string; runnerId: string; inspectionId: string; body: z.infer<typeof inspectionCompletionSchema> }
): Promise<DelegationInspection> {
  const rows = await client.query(
    `select i.* from delegation_inspections i
     join delegation_tasks t on t.id = i.task_id
     where i.organization_id=$1 and i.id=$2 and t.executor_id=$3 and i.lease_id=$4 for update`,
    [input.organizationId, input.inspectionId, input.runnerId, input.body.leaseId]
  )
  if (!rows.rows[0]) delegationFail('The inspection does not belong to this lease.', 409)
  if ((rows.rows[0].lease_expires_at as Date | null)?.getTime?.() ?? 0 <= Date.now()) {
    // An expired lease is still allowed to deliver a result once; it is not allowed to start new work.
  }
  const updated = await client.query(
    `update delegation_inspections set state=$2, result=$3, artifact_id=$4, error=$5, code_revision_digest=$6,
       finished_at=now(), lease_id=null where id=$1 returning *`,
    [
      input.inspectionId,
      input.body.state,
      input.body.result,
      input.body.artifactId,
      input.body.error,
      input.body.codeRevisionDigest,
    ]
  )
  const task = await loadTaskRow(
    client,
    { organizationId: input.organizationId, projectId: String(rows.rows[0].project_id) },
    String(rows.rows[0].task_id)
  )
  const inspection = mapInspection(updated.rows[0]!)
  await appendDelegationEvent(client, task, 'inspection.finished', {
    inspectionId: inspection.id,
    kind: inspection.operation.kind,
    state: inspection.state,
    artifactId: inspection.artifactId,
    codeRevisionDigest: inspection.codeRevisionDigest,
  })
  return inspection
}

/** Fail inspections whose lease expired without a result, so a caller never waits forever. */
export async function expireInspections(pool: DatabasePool): Promise<number> {
  const rows = await pool.query(
    `update delegation_inspections set state='failed', error='The executor did not answer before the lease expired.',
       finished_at=now(), lease_id=null
     where state='running' and lease_expires_at <= now() returning id`
  )
  return rows.rowCount ?? 0
}
