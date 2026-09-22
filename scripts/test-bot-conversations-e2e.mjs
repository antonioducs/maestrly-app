#!/usr/bin/env node
/**
 * End-to-end homologation of the personal bot path, with nothing stubbed on the Maestrly side.
 *
 * The bot endpoint lives inside the desktop application itself, so this run has no server, no database
 * and no relay. The harness builds the real SDK and the real desktop application, then runs the suite
 * that plays the only two actors a person would otherwise supply: the bot that speaks MCP over HTTP, and
 * the provider that answers the conversation. Everything else is the product, including the embedded
 * endpoint, its OAuth authorization with local consent, the native runtime and the worktrees on disk.
 *
 * Nothing here needs an organization, a project, a board, a card or a runner, and the suite never touches
 * a real instance: the endpoint is bound to loopback, the desktop profile and the repositories are
 * temporary directories, and the public address the bot dials is a documentation name carried in the Host
 * header instead of being resolved by DNS.
 */
import { spawnSync } from 'node:child_process'
import { nodeCommand } from './node-command.mjs'

function run(command, args, options = {}) {
  ;({ command, args } = nodeCommand(command, args, options.env ?? process.env))
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'inherit',
    shell: false,
    env: options.env ?? process.env,
  })
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

// This suite must never reuse another worktree's server, database or provider account.
const env = { ...process.env, NODE_ENV: 'test', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
for (const name of [
  'MAESTRLY_SERVER_URL',
  'MAESTRLY_CANONICAL_URL',
  'MAESTRLY_WEB_ORIGIN',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
])
  delete env[name]

// The desktop application under test is the real build, not a stub of it.
run('npm', ['run', 'build:sdk'], { env })
if (!env.MAESTRLY_PACKAGED_EXECUTABLE) run('npm', ['run', 'build:desktop'], { env })

run('npm', ['run', 'test:e2e', '--workspace', '@maestrly/desktop', '--', 'bot-relay-e2e.spec.ts'], {
  env: { ...env, MAESTRLY_BOT_CONVERSATIONS_E2E: '1' },
})
process.stdout.write('[bot-conversations-e2e] a personal bot drove native desktop conversations end to end.\n')
