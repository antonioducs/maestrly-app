import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'

export async function reconcileExpiredLeases(pool: DatabasePool): Promise<number> {
  const organizations = await pool.query<{ id: string }>('select id from organizations')
  let total = 0
  for (const organization of organizations.rows) {
    total += await inTenantTransaction(pool, {
      organizationId: organization.id,
      actor: { type: 'system', service: 'lease-reconciler' },
    }, async (client) => {
      const expired = await client.query<{ id: string; job_id: string }>(`
        update runs set state = 'interrupted', finished_at = now()
        where organization_id = $1 and state in ('claimed', 'running', 'cancelling') and lease_expires_at <= now()
        returning id, job_id
      `, [organization.id])
      for (const run of expired.rows) {
        await client.query("update jobs set state = 'needs_attention', updated_at = now() where id = $1 and state = 'active'", [run.job_id])
        await client.query('update execution_tokens set revoked_at = now() where run_id = $1 and revoked_at is null', [run.id])
      }
      return expired.rowCount ?? 0
    })
  }
  return total
}
