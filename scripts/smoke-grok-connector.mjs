#!/usr/bin/env node
/**
 * Fast check of the external agent path, for a change that only touches it.
 *
 * It builds the contracts, runs the connector and delegation integration suites against a real PostgreSQL,
 * and enforces the connector boundaries. It is not a substitute for `test:e2e:grok-connector`, which also
 * exercises OAuth, the MCP endpoint, a real executor and the signed callback.
 */
import { spawnSync } from 'node:child_process'

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('npm', ['run', 'build:sdk'])
run('npm', ['run', 'typecheck', '--workspace', '@maestrly/server'])
run(process.execPath, [
  'scripts/test-integration.mjs',
  'test/integration/connector-auth.test.ts',
  'test/integration/connector-mcp.test.ts',
  'test/integration/connector-tools.test.ts',
  'test/integration/connector-notifications.test.ts',
  'test/integration/delegations.test.ts',
  'test/integration/delegation-subscriptions.test.ts',
])
run(process.execPath, ['--test', 'tests/policy/grok-connector-boundaries.test.mjs'])

process.stdout.write('[smoke-grok-connector] contracts, connector suites and boundaries passed.\n')
