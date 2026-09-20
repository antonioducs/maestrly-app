import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { migrate } from '../../src/db/migrate.js'
import { integrationAvailable, migrationPool, migrationUrl } from './helpers.js'

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../migrations')

describe.skipIf(!integrationAvailable)('migrations', () => {
  it('is mutually serialized and idempotent', async () => {
    // Derived from the files on disk: two concurrent runs must apply each migration exactly once, and
    // adding a migration must not require editing this expectation.
    const files = readdirSync(directory).filter((file) => file.endsWith('.sql'))
    await Promise.all([migrate(migrationUrl!), migrate(migrationUrl!)])
    const pool = migrationPool()
    try {
      const result = await pool.query<{ count: string }>('select count(*)::text as count from schema_migrations')
      expect(Number(result.rows[0]!.count)).toBe(files.length)
      const applied = await pool.query<{ name: string }>('select name from schema_migrations order by name')
      expect(applied.rows.map((row) => row.name)).toEqual([...files].sort())
    } finally {
      await pool.end()
    }
  })
})
