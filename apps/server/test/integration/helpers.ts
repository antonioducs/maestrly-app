import pg from 'pg'
import { createPool } from '../../src/db/pool.js'

export const runtimeUrl = process.env.MAESTRLY_TEST_DATABASE_URL
export const migrationUrl = process.env.MAESTRLY_TEST_MIGRATION_DATABASE_URL
export const integrationAvailable = Boolean(runtimeUrl && migrationUrl)

export function runtimePool() {
  if (!runtimeUrl) throw new Error('MAESTRLY_TEST_DATABASE_URL is required')
  return createPool(runtimeUrl)
}

export function migrationPool() {
  if (!migrationUrl) throw new Error('MAESTRLY_TEST_MIGRATION_DATABASE_URL is required')
  return new pg.Pool({ connectionString: migrationUrl, max: 4 })
}

export async function seedOrganization(name: string, userId: string) {
  const pool = migrationPool()
  try {
    const organization = await pool.query<{ id: string }>('insert into organizations(name) values ($1) returning id', [name])
    await pool.query("select set_config('app.organization_id', $1, false)", [organization.rows[0]!.id])
    await pool.query("insert into organization_members(organization_id, user_id, role) values ($1,$2,'owner')", [organization.rows[0]!.id, userId])
    return organization.rows[0]!.id
  } finally { await pool.end() }
}
