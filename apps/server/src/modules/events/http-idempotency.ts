import type { Actor } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { withIdempotency } from './idempotency.js'

export async function executeIdempotent<T>(
  pool: DatabasePool,
  input: {
    organizationId: string; actorId: string; actor: Actor; key: string; method: string; path: string; body: unknown
  },
  operation: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor: input.actor }, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.organizationId}:${input.actorId}:${input.key}`,
    ])
    return withIdempotency(client, input, operation)
  })
}
