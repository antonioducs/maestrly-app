#!/usr/bin/env node
/**
 * Fast check of the external agent paths, for a change that only touches them.
 *
 * It builds the contracts, runs the personal bot and the delegation integration suites against a real
 * PostgreSQL, and enforces the boundaries of both. It is not a substitute for
 * `test:e2e:bot-conversations` or `test:e2e:grok-connector`, which also exercise OAuth, the MCP
 * endpoints, a real desktop or executor, and — for delegation — the signed callback.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const suites = [
  // The personal bot path: owner REST, the outbound desktop transport, and the /mcp/bots endpoint.
  'test/integration/bot-conversations.test.ts',
  'test/integration/bot-conversation-dispatch.test.ts',
  'test/integration/bot-mcp.test.ts',
  // The delegation path.
  'test/integration/connector-auth.test.ts',
  'test/integration/connector-mcp.test.ts',
  'test/integration/connector-tools.test.ts',
  'test/integration/connector-notifications.test.ts',
  'test/integration/delegations.test.ts',
  'test/integration/delegation-subscriptions.test.ts',
]

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const missing = suites.filter((suite) => !existsSync(`apps/server/${suite}`))
if (missing.length > 0) {
  process.stderr.write(`[smoke-grok-connector] missing integration suite(s): ${missing.join(', ')}\n`)
  process.exit(1)
}

run('npm', ['run', 'build:sdk'])
run('npm', ['run', 'typecheck', '--workspace', '@maestrly/server'])
run(process.execPath, ['scripts/test-integration.mjs', ...suites])
run(process.execPath, [
  '--test',
  'tests/policy/bot-conversations-boundaries.test.mjs',
  'tests/policy/grok-connector-boundaries.test.mjs',
])

process.stdout.write('[smoke-grok-connector] contracts, bot and connector suites, and both boundaries passed.\n')
