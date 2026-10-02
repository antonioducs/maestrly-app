import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

// What the bot image copies from the repository must reach the build context. Docker applies the .dockerignore file to
// paths relative to the context root; `**/` matches any depth and a match excludes everything below it.
const root = fileURLToPath(new URL('../../', import.meta.url))
function ignored(file, patterns) {
  const regex = (pattern) =>
    new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replaceAll('**/', '\u0000')
          .replaceAll('**', '\u0001')
          .replaceAll('*', '[^/]*')
          .replaceAll('?', '[^/]')
          .replaceAll('\u0000', '(?:.*/)?')
          .replaceAll('\u0001', '.*') +
        '$'
    )
  const parts = file.split('/')
  return patterns.some((pattern) =>
    parts.some((_, index) => regex(pattern.replace(/^\/+/, '')).test(parts.slice(0, index + 1).join('/')))
  )
}

test('the bot image build context holds every file its Dockerfile copies from the repository', () => {
  const ignore = readFileSync(path.join(root, 'deploy/bot-fleet/bot-instance.Dockerfile.dockerignore'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
  const sources = [
    ...readFileSync(path.join(root, 'deploy/bot-fleet/bot-instance.Dockerfile'), 'utf8').matchAll(
      /^COPY (?!--from)(\S+) /gm
    ),
  ].map((match) => match[1].replace(/\/$/, ''))
  for (const source of [
    'deploy/bot-fleet/desktop',
    'deploy/bot-fleet/desktop/theme/Maestrly',
    'deploy/bot-fleet/desktop/applications',
    'deploy/bot-fleet/tint2rc',
    'deploy/bot-fleet/openbox-rc.xml',
  ])
    assert.ok(sources.includes(source), `the Dockerfile copies ${source}`)
  for (const source of sources) {
    assert.ok(existsSync(path.join(root, source)), `${source} exists`)
    assert.equal(ignored(source, ignore), false, `${source} is not ignored`)
  }
  // The desktop files themselves, at every depth, as a pattern aimed at some other folder might catch them.
  for (const file of [
    'deploy/bot-fleet/desktop/theme/Maestrly/openbox-3/themerc',
    'deploy/bot-fleet/desktop/theme/Maestrly/openbox-3/close.xbm',
    'deploy/bot-fleet/desktop/icons/browser.svg',
    'deploy/bot-fleet/desktop/applications/maestrly-url.desktop',
  ])
    assert.equal(ignored(file, ignore), false, `${file} is not ignored`)
  // The matcher itself: it must see the folders the build leaves out.
  for (const file of [
    'node_modules/x',
    'apps/desktop/node_modules/x',
    'apps/desktop/out/main',
    '.bot-fleet-local/x',
    '.git/HEAD',
  ])
    assert.equal(ignored(file, ignore), true, `${file} is ignored`)
})

test('a HEAD image context carries the uncommitted desktop files of the image definitions', {
  skip: process.platform === 'win32',
}, () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'fleet desktop context-'))
  try {
    for (const dir of ['scripts', 'apps/desktop', 'deploy/bot-fleet', 'bin'])
      mkdirSync(path.join(fixture, dir), { recursive: true })
    copyFileSync(builder, path.join(fixture, 'scripts/bot-fleet-images.mjs'))
    writeFileSync(path.join(fixture, 'package.json'), '{"version":"0.0.0"}\n')
    writeFileSync(path.join(fixture, 'apps/desktop/package.json'), '{"name":"synthetic-bot"}\n')
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    git('init', '-q')
    git('add', '--', 'package.json', 'apps/desktop/package.json')
    git(
      '-c',
      'user.name=Maestrly fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'test: synthetic desktop context'
    )
    // Image definitions are never committed in this fixture: only the builder's copy of deploy/bot-fleet can deliver them.
    const desktop = [
      'theme/Maestrly/openbox-3/themerc',
      'theme/Maestrly/openbox-3/close.xbm',
      'icons/browser.svg',
      'applications/maestrly-browser.desktop',
    ]
    for (const file of desktop) {
      mkdirSync(path.dirname(path.join(fixture, 'deploy/bot-fleet/desktop', file)), { recursive: true })
      writeFileSync(path.join(fixture, 'deploy/bot-fleet/desktop', file), 'synthetic ' + file + '\n')
    }
    const docker = path.join(fixture, 'bin/docker')
    writeFileSync(
      docker,
      `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === 'buildx') {
  const context = args.at(-1)
  const missing = ${JSON.stringify(desktop)}.filter((file) => !fs.existsSync(path.join(context, 'deploy/bot-fleet/desktop', file)))
  if (missing.length) {
    console.error('Missing from the build context: ' + missing.join(', '))
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
      [path.join(fixture, 'scripts/bot-fleet-images.mjs'), '--from-head', '--only', 'bot'],
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
