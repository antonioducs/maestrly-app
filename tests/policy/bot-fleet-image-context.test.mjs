import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const builder = fileURLToPath(new URL('../../scripts/bot-fleet-images.mjs', import.meta.url))

for (const mask of [0o022, 0o077]) {
  test(`HEAD image context preserves readable and executable modes with umask ${mask.toString(8)}`, {
    skip: process.platform === 'win32',
  }, () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'fleet image context-'))
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    try {
      for (const dir of ['scripts', 'apps/desktop', 'deploy/bot-fleet', 'bin']) {
        mkdirSync(path.join(fixture, dir), { recursive: true })
      }
      copyFileSync(builder, path.join(fixture, 'scripts/bot-fleet-images.mjs'))
      writeFileSync(path.join(fixture, 'package.json'), '{"version":"0.0.0"}\n')
      writeFileSync(path.join(fixture, 'apps/desktop/package.json'), '{"name":"synthetic-bot"}\n')
      writeFileSync(path.join(fixture, 'probe.sh'), '#!/bin/sh\nexit 0\n')
      chmodSync(path.join(fixture, 'apps/desktop/package.json'), 0o644)
      chmodSync(path.join(fixture, 'probe.sh'), 0o755)
      git('init', '-q')
      git('add', '--', 'package.json', 'apps/desktop/package.json', 'probe.sh')
      git(
        '-c',
        'user.name=Maestrly fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'test: synthetic image context'
      )
      const docker = path.join(fixture, 'bin/docker')
      writeFileSync(
        docker,
        `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === 'buildx') {
  const context = args.at(-1)
  const readable = fs.statSync(path.join(context, 'apps/desktop/package.json')).mode & 0o444
  const executable = fs.statSync(path.join(context, 'probe.sh')).mode & 0o111
  if (readable !== 0o444 || executable !== 0o111) {
    console.error('The bot user cannot read or execute archived application files.')
    process.exit(9)
  }
} else if (args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write('1\\n')
} else process.exit(8)
`
      )
      chmodSync(docker, 0o755)
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `process.umask(${mask}); await import(process.argv[1])`,
          pathToFileURL(path.join(fixture, 'scripts/bot-fleet-images.mjs')).href,
          '--from-head',
          '--only',
          'bot',
        ],
        {
          cwd: fixture,
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, PATH: path.join(fixture, 'bin') + path.delimiter + process.env.PATH },
        }
      )
      assert.equal(result.status, 0, result.stderr || result.error?.message)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
}
