import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { migrate } from '../../src/db/migrate.js'
import { integrationAvailable, migrationPool, migrationUrl } from './helpers.js'

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../migrations')

/** Migrations 010 to 016 built the external agent connection feature; 017 retires it. */
const retiredMigrations = [
  '010_connector_grants.sql',
  '011_delegations.sql',
  '012_delegation_evidence.sql',
  '013_delegation_delivery.sql',
  '014_delegation_events.sql',
  '015_connector_notifications.sql',
  '016_bot_conversations.sql',
]

/** What the retired migrations created or added, read from the files themselves so the list cannot drift. */
function retiredObjects() {
  const sources = retiredMigrations.map((file) => readFileSync(path.join(directory, file), 'utf8'))
  const matches = (pattern: RegExp) => sources.flatMap((sql) => [...sql.matchAll(pattern)].map((match) => match.slice(1)))
  return {
    tables: matches(/^create table (\w+)/gm).map(([table]) => table!),
    columns: matches(/^alter table (\w+) add column (\w+)/gm).map(([table, column]) => ({ table: table!, column: column! })),
    functions: matches(/^create function (\w+)\(/gm).map(([name]) => name!),
  }
}

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

  it('retires the external agent connection feature', async () => {
    const retired = retiredObjects()
    // Guard the parser: an empty list would make the assertions below pass for the wrong reason.
    expect(retired.tables).toEqual(expect.arrayContaining(['connector_connections', 'delegation_tasks', 'bot_conversations']))
    expect(retired.columns).toEqual(
      expect.arrayContaining([
        { table: 'runners', column: 'delegation_capabilities' },
        { table: 'chat_sessions', column: 'delegation_task_id' },
      ]),
    )
    expect(retired.functions).toContain('bot_scope_visible')

    await migrate(migrationUrl!)
    const pool = migrationPool()
    try {
      const applied = await pool.query<{ name: string }>('select name from schema_migrations')
      expect(applied.rows.map((row) => row.name)).toEqual(expect.arrayContaining([...retiredMigrations, '017_retire_external_agents.sql']))

      const tables = await pool.query<{ table_name: string }>(
        'select table_name from information_schema.tables where table_schema = current_schema() and table_name = any($1)',
        [retired.tables],
      )
      expect(tables.rows).toEqual([])

      const columns = await pool.query<{ table_name: string; column_name: string }>(
        'select table_name, column_name from information_schema.columns where table_schema = current_schema() and table_name = any($1) and column_name = any($2)',
        [retired.columns.map((entry) => entry.table), retired.columns.map((entry) => entry.column)],
      )
      expect(columns.rows).toEqual([])

      const functions = await pool.query<{ proname: string }>('select proname from pg_proc where proname = any($1)', [retired.functions])
      expect(functions.rows).toEqual([])

      const policies = await pool.query<{ tablename: string }>('select tablename from pg_policies where tablename = any($1)', [retired.tables])
      expect(policies.rows).toEqual([])

      // Retiring the chat marker must leave the chat tables as isolated as before.
      const chat = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('chat_sessions', 'chat_turns') and relkind = 'r'",
      )
      expect(chat.rows.map((row) => [row.relname, row.relrowsecurity, row.relforcerowsecurity]).sort()).toEqual([
        ['chat_sessions', true, true],
        ['chat_turns', true, true],
      ])
    } finally {
      await pool.end()
    }
  })
})
