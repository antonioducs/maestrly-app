#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('npm', ['run', 'build:protocol'])
run('npm', ['run', 'build:sdk'])
run('npm', ['run', 'build:server'])
run('npm', ['run', 'build:runner'])
run('npm', ['run', 'build:web'])
run('npm', ['run', 'test:integration'])

const runnerPackage = readFileSync('apps/runner/package.json', 'utf8')
if (runnerPackage.includes('"electron"')) throw new Error('Runner distribution contains Electron.')
process.stdout.write('[smoke-platform] real PostgreSQL card → job → scoped runner → evidence → human review flow passed.\n')
