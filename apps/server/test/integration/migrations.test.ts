import { describe, expect, it } from 'vitest'
import { migrate } from '../../src/db/migrate.js'
import { integrationAvailable, migrationPool, migrationUrl } from './helpers.js'

describe.skipIf(!integrationAvailable)('migrations', () => {
  it('is mutually serialized and idempotent', async () => {
    await Promise.all([migrate(migrationUrl!), migrate(migrationUrl!)])
    const pool = migrationPool()
    try {
      const result = await pool.query<{ count: string }>('select count(*)::text as count from schema_migrations')
      expect(Number(result.rows[0]!.count)).toBe(10)
    } finally { await pool.end() }
  })
})
