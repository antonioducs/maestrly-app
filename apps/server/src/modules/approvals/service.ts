import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { appendDomainEvent } from '../events/store.js'

export async function decideApproval(
  pool: DatabasePool,
  input: { organizationId: string; projectId: string; approvalId: string; userId: string; decision: 'approved' | 'rejected' },
): Promise<void> {
  await inTenantTransaction(pool, {
    organizationId: input.organizationId, projectId: input.projectId, actor: { type: 'human', userId: input.userId },
  }, async (client) => {
    await authorizeProject(client, input.organizationId, input.projectId, input.userId, 'automation:manage')
    const approval = await client.query<{ job_id: string }>(`
      update approvals set status = $4, decided_by_user_id = $5, decided_at = now()
      where organization_id = $1 and project_id = $2 and id = $3 and status = 'pending'
      returning job_id
    `, [input.organizationId, input.projectId, input.approvalId, input.decision, input.userId])
    const jobId = approval.rows[0]?.job_id
    if (!jobId) throw new Error('Approval is no longer pending.')
    await client.query(`
      update jobs set state = $2, updated_at = now()
      where id = $1 and state = 'waiting_approval'
    `, [jobId, input.decision === 'approved' ? 'queued' : 'cancelled'])
    await appendDomainEvent(client, {
      organizationId: input.organizationId, projectId: input.projectId, type: `approval.${input.decision}`,
      aggregateType: 'job', aggregateId: jobId, actor: { type: 'human', userId: input.userId },
      data: { approvalId: input.approvalId },
    })
  })
}
