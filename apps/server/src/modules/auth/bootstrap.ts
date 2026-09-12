import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadConfig } from '../../config.js'
import { createPool } from '../../db/pool.js'
import { createAuth } from './auth.js'

export async function bootstrapAdministrator(environment: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig({ ...environment, MAESTRLY_BOOTSTRAP_MODE: 'true' })
  const email = environment.MAESTRLY_BOOTSTRAP_EMAIL
  const password = environment.MAESTRLY_BOOTSTRAP_PASSWORD
  const name = environment.MAESTRLY_BOOTSTRAP_NAME ?? 'Maestrly owner'
  const organizationName = environment.MAESTRLY_BOOTSTRAP_ORGANIZATION ?? 'My organization'
  if (!email || !password) throw new Error('MAESTRLY_BOOTSTRAP_EMAIL and MAESTRLY_BOOTSTRAP_PASSWORD are required.')
  const pool = createPool(config.migrationDatabaseUrl ?? config.databaseUrl)
  const auth = createAuth(config, pool)
  try {
    const existing = await pool.query<{ count: string }>('select count(*)::text as count from organizations')
    if (Number(existing.rows[0]!.count) > 0) throw new Error('Bootstrap is disabled after the first organization exists.')
    const signup = await auth.api.signUpEmail({ body: { email, password, name } })
    const userId = signup.user.id
    const client = await pool.connect()
    try {
      await client.query('begin')
      const organization = await client.query<{ id: string }>('insert into organizations(name) values ($1) returning id', [organizationName])
      await client.query("select set_config('app.organization_id', $1, true)", [organization.rows[0]!.id])
      await client.query("select set_config('app.user_id', $1, true)", [userId])
      await client.query("insert into organization_members(organization_id, user_id, role) values ($1,$2,'owner')", [organization.rows[0]!.id, userId])
      await client.query('commit')
      return { userId, organizationId: organization.rows[0]!.id }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await bootstrapAdministrator()
  process.stdout.write(`Bootstrap complete for organization ${result.organizationId}.\n`)
}
