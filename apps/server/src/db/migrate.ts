import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.js'
import { createPool } from './pool.js'

export async function migrate(connectionString: string): Promise<void> {
  const pool = createPool(connectionString)
  const client = await pool.connect()
  const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url))
  try {
    await client.query("select pg_advisory_lock(hashtext('maestrly-schema-migrations'))")
    await client.query(`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`)
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort()
    for (const file of files) {
      const exists = await client.query<{ exists: boolean }>('select exists(select 1 from schema_migrations where name = $1)', [file])
      if (exists.rows[0]?.exists) continue
      const sql = await readFile(path.join(migrationsDirectory, file), 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into schema_migrations(name) values ($1)', [file])
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('maestrly-schema-migrations'))").catch(() => undefined)
    client.release()
    await pool.end()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig()
  await migrate(config.migrationDatabaseUrl ?? config.databaseUrl)
  process.stdout.write('Maestrly migrations applied.\n')
}
