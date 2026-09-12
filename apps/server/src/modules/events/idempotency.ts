import { createHash } from 'node:crypto'
import type { DatabaseClient } from '../../db/pool.js'

export class IdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key was already used with different content.')
    this.name = 'IdempotencyConflictError'
  }
}

function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(JSON.stringify({ method, path, body })).digest('hex')
}

export async function withIdempotency<T>(
  client: DatabaseClient,
  input: {
    organizationId: string
    actorId: string
    key: string
    method: string
    path: string
    body: unknown
  },
  operation: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  const digest = requestHash(input.method, input.path, input.body)
  const inserted = await client.query(`
    insert into idempotency_records(
      organization_id, actor_id, idempotency_key, request_hash, response_status, response_body, expires_at
    ) values ($1, $2, $3, $4, 0, '{}'::jsonb, now() + interval '24 hours')
    on conflict (organization_id, actor_id, idempotency_key) do nothing
    returning idempotency_key
  `, [input.organizationId, input.actorId, input.key, digest])
  if (inserted.rowCount === 0) {
    const existing = await client.query<{ request_hash: string; response_status: string; response_body: T }>(`
      select request_hash, response_status, response_body from idempotency_records
      where organization_id = $1 and actor_id = $2 and idempotency_key = $3
    `, [input.organizationId, input.actorId, input.key])
    const row = existing.rows[0]
    if (!row || row.request_hash !== digest) throw new IdempotencyConflictError()
    return { status: Number(row.response_status), body: row.response_body, replayed: true }
  }
  const result = await operation()
  await client.query(`
    update idempotency_records set response_status = $4, response_body = $5
    where organization_id = $1 and actor_id = $2 and idempotency_key = $3
  `, [input.organizationId, input.actorId, input.key, result.status, result.body])
  return { ...result, replayed: false }
}
