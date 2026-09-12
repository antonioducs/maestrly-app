import { fail, boardLock } from '../kanban/service.js'
import type { Capability, ExecutionPolicy } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { appendDomainEvent } from '../events/store.js'

interface PolicyRow {
  automation_config?: unknown
  policy_key: string
  repository_branch?: string
  id: string
  organization_id: string
  project_id: string
  version: string
  name: string
  task_type: string
  execution_profile_id: string
  required_capabilities: Capability[]
  repository_binding_id: string | null
  provider: 'codex' | 'claude-agent'
  model: string
  effort: string | null
  approval_required: boolean
  max_duration_seconds: string
  max_log_bytes: string
  delivery: ExecutionPolicy['delivery']
  enabled: boolean
  created_at: Date
  updated_at: Date
}

export const mapPolicy = (row: PolicyRow): ExecutionPolicy => ({
  policyKey: row.policy_key,
  ...(row.automation_config ? { automationConfig: row.automation_config as ExecutionPolicy['automationConfig'] } : {}),
  id: row.id,
  organizationId: row.organization_id,
  projectId: row.project_id,
  version: Number(row.version),
  name: row.name,
  taskType: row.task_type,
  executionProfileId: row.execution_profile_id,
  requiredCapabilities: row.required_capabilities,
  repositoryBindingId: row.repository_binding_id,
  repositoryBranch: row.repository_branch,
  provider: row.provider,
  model: row.model,
  ...(row.effort ? { effort: row.effort } : {}),
  approvalRequired: row.approval_required,
  maxDurationSeconds: Number(row.max_duration_seconds),
  maxLogBytes: Number(row.max_log_bytes),
  delivery: row.delivery,
  enabled: row.enabled,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
})

export async function createExecutionPolicy(
  pool: DatabasePool,
  input: Omit<ExecutionPolicy, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { userId: string; policyKey?: string }
): Promise<ExecutionPolicy> {
  return inTenantTransaction(
    pool,
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { type: 'human', userId: input.userId },
    },
    async (client) => {
      await authorizeProject(client, input.organizationId, input.projectId, input.userId, 'automation:manage')
      if (input.repositoryBindingId) {
        const repo = await client.query(
          'select id from repository_bindings where organization_id=$1 and project_id=$2 and id=$3 and disabled_at is null',
          [input.organizationId, input.projectId, input.repositoryBindingId]
        )
        if (!repo.rowCount) fail('Repository not found.', 404)
      }
      if (input.delivery.mode !== 'patch') fail('Only patch delivery is available.', 400)
      const policyKey = input.policyKey ?? null
      const result = await client.query<PolicyRow>(
        `
      insert into execution_policies(
        organization_id, project_id, policy_key, version, name, task_type, execution_profile_id,
        required_capabilities, repository_binding_id, provider, model, effort, approval_required,
        max_duration_seconds, max_log_bytes, delivery, enabled, repository_branch
      ) values (
        $1,$2,coalesce($3::uuid, gen_random_uuid()),
        coalesce((select max(version) + 1 from execution_policies where organization_id = $1 and project_id = $2 and policy_key = $3::uuid), 1),
        $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
      ) returning *
    `,
        [
          input.organizationId,
          input.projectId,
          policyKey,
          input.name,
          input.taskType,
          input.executionProfileId,
          JSON.stringify(input.requiredCapabilities),
          input.repositoryBindingId,
          input.provider,
          input.model,
          input.effort ?? null,
          input.approvalRequired,
          input.maxDurationSeconds,
          input.maxLogBytes,
          input.delivery,
          input.enabled,
          input.repositoryBranch ?? null,
        ]
      )
      const policy = mapPolicy(result.rows[0]!)
      await appendDomainEvent(client, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: 'execution_policy.created',
        aggregateType: 'execution_policy',
        aggregateId: policy.id,
        actor: { type: 'human', userId: input.userId },
        data: { version: policy.version, enabled: policy.enabled },
      })
      return policy
    }
  )
}

export async function assignColumnPolicy(
  pool: DatabasePool,
  input: { organizationId: string; projectId: string; columnId: string; policyId: string | null; userId: string }
): Promise<void> {
  await inTenantTransaction(
    pool,
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { type: 'human', userId: input.userId },
    },
    async (client) => {
      await authorizeProject(client, input.organizationId, input.projectId, input.userId, 'automation:manage')
      const column = await client.query<{ board_id: string }>(
        'select board_id from board_columns where organization_id=$1 and project_id=$2 and id=$3 and deleted_at is null',
        [input.organizationId, input.projectId, input.columnId]
      )
      if (!column.rows[0]) fail('Column not found.', 404)
      await boardLock(client, input, column.rows[0].board_id)
      const role = (await client.query('select role from board_columns where id=$1', [input.columnId])).rows[0]?.role
      if (role !== 'normal') fail('Fixed columns cannot run automations.', 400)
      const result = await client.query<{ board_id: string }>(
        `
      update board_columns set execution_policy_id = $4, updated_at = now()
      where organization_id = $1 and project_id = $2 and id = $3 returning board_id
    `,
        [input.organizationId, input.projectId, input.columnId, input.policyId]
      )
      if (!result.rows[0]) throw new Error('Column not found.')
      await appendDomainEvent(client, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: 'column.policy_changed',
        aggregateType: 'column',
        aggregateId: input.columnId,
        actor: { type: 'human', userId: input.userId },
        data: { policyId: input.policyId },
      })
    }
  )
}
