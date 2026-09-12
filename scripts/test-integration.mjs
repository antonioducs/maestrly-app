#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const name = `maestrly-integration-pg-${process.pid}`
const password = 'maestrly_integration_owner'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit', shell: false, env: options.env ?? process.env })
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited with ${result.status}`)
  return result.stdout?.trim() ?? ''
}

let started = false
try {
  run('npm', ['run', 'build:protocol'])
  run('docker', ['run', '--rm', '-d', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=maestrly', '-p', '127.0.0.1::5432', 'postgres:17-alpine'], { capture: true })
  started = true
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'maestrly'], { stdio: 'ignore', shell: false })
    if (ready.status === 0) break
    if (attempt === 59) throw new Error('PostgreSQL integration container did not become ready.')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const port = run('docker', ['port', name, '5432/tcp'], { capture: true }).split(':').at(-1)
  if (!port) throw new Error('Could not resolve the PostgreSQL integration port.')
  run('docker', ['exec', name, 'psql', '-U', 'postgres', '-d', 'maestrly', '-v', 'ON_ERROR_STOP=1', '-c', "create role maestrly_runtime login password 'maestrly_integration_runtime' nosuperuser nocreatedb nocreaterole noinherit nobypassrls; grant connect on database maestrly to maestrly_runtime;"])
  const migrationUrl = `postgres://postgres:${password}@127.0.0.1:${port}/maestrly`
  const runtimeUrl = `postgres://maestrly_runtime:maestrly_integration_runtime@127.0.0.1:${port}/maestrly`
  const env = { ...process.env, MIGRATION_DATABASE_URL: migrationUrl, DATABASE_URL: runtimeUrl, MAESTRLY_TEST_DATABASE_URL: runtimeUrl, MAESTRLY_TEST_MIGRATION_DATABASE_URL: migrationUrl, BETTER_AUTH_SECRET: randomBytes(32).toString('hex') }
  run(process.execPath, ['--import', 'tsx', 'apps/server/src/db/migrate.ts'], { env })
  run('npm', ['run', 'test:integration', '--workspace', '@maestrly/server'], { env })
} finally {
  if (started) spawnSync('docker', ['stop', name], { stdio: 'ignore', shell: false })
}
