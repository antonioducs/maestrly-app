import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  autoProfileBlocker,
  DEV_LAUNCHER_LOCK_FILE,
  INSTANCE_LOCK_FILE,
  removeDeadAutoProfiles,
  removeOwnAutoProfile,
  writeLauncherLock,
} from '../../scripts/instance-shared.mjs'

/** Unnamed `npm run dev` runs remove only their own auto profiles, and only once nothing can still be using them. */

const DEAD = 4_000_001
const LIVE = 4_000_002
const isRunning = (pid) => pid === LIVE
let root = ''
const warnings = []
const warn = (message) => warnings.push(message)

function profile(name, files = {}) {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  return dir
}

const lock = (pid) => JSON.stringify({ pid, instance: 'x', startedAt: 1 })

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'dev-profiles-'))
  warnings.length = 0
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

test('removes only auto profiles whose every lock names a process that is gone', () => {
  profile('maestrly-app-dev-auto-0001', { [INSTANCE_LOCK_FILE]: lock(DEAD), 'db.sqlite': 'x' })
  profile('maestrly-app-dev-auto-0002', { [INSTANCE_LOCK_FILE]: lock(LIVE) })
  profile('maestrly-app-dev-auto-0003', { [DEV_LAUNCHER_LOCK_FILE]: lock(DEAD), [INSTANCE_LOCK_FILE]: lock(LIVE) })
  profile('maestrly-app-dev-auto-0004', { 'db.sqlite': 'x' })
  profile('maestrly-app-dev-auto-0005')
  profile('maestrly-app-dev-auto-0006', { [INSTANCE_LOCK_FILE]: '{not json' })
  profile('maestrly-app-dev-auto-0007', { [INSTANCE_LOCK_FILE]: lock(DEAD), 'worktrees/ws/feature/file': 'x' })
  profile('maestrly-app-dev-auto-0008', { [INSTANCE_LOCK_FILE]: lock(DEAD), 'aggregators/conv/link': 'x' })
  profile('maestrly-app-dev-feature-x', { [INSTANCE_LOCK_FILE]: lock(DEAD) })
  profile('maestrly-app-dev-auto-12345', { [INSTANCE_LOCK_FILE]: lock(DEAD) })
  profile('maestrly-app-dev', { [INSTANCE_LOCK_FILE]: lock(DEAD) })
  profile('maestrly-app', { [INSTANCE_LOCK_FILE]: lock(DEAD) })
  // A link named like a profile is never followed into its target.
  const target = profile('elsewhere', { [INSTANCE_LOCK_FILE]: lock(DEAD), 'keep.txt': 'x' })
  symlinkSync(target, path.join(root, 'maestrly-app-dev-auto-000a'))

  const removed = removeDeadAutoProfiles(root, { isRunning, warn })

  assert.deepEqual(
    removed.map((dir) => path.basename(dir)),
    ['maestrly-app-dev-auto-0001']
  )
  assert.deepEqual(readdirSync(root).sort(), [
    'elsewhere',
    'maestrly-app',
    'maestrly-app-dev',
    'maestrly-app-dev-auto-0002',
    'maestrly-app-dev-auto-0003',
    'maestrly-app-dev-auto-0004',
    'maestrly-app-dev-auto-0005',
    'maestrly-app-dev-auto-0006',
    'maestrly-app-dev-auto-0007',
    'maestrly-app-dev-auto-0008',
    'maestrly-app-dev-auto-000a',
    'maestrly-app-dev-auto-12345',
    'maestrly-app-dev-feature-x',
  ])
  assert.ok(existsSync(path.join(target, 'keep.txt')))
  // Checkouts registered in a repository are reported, not removed.
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /maestrly-app-dev-auto-0007: it has worktrees/)
  assert.match(warnings[1], /maestrly-app-dev-auto-0008: it has aggregators/)
})

test('an empty worktrees folder does not keep a profile', () => {
  const dir = profile('maestrly-app-dev-auto-00aa', { [DEV_LAUNCHER_LOCK_FILE]: lock(DEAD) })
  mkdirSync(path.join(dir, 'worktrees'))
  assert.equal(autoProfileBlocker(dir, { isRunning }), null)
})

test('the launcher removes its own profile on exit only once the app is gone', () => {
  const ownPid = LIVE
  const dir = path.join(root, 'maestrly-app-dev-auto-00bb')
  writeLauncherLock(dir, ownPid)
  writeFileSync(path.join(dir, INSTANCE_LOCK_FILE), lock(LIVE + 1))
  const appRunning = (pid) => pid === ownPid || pid === LIVE + 1

  assert.equal(removeOwnAutoProfile(dir, { isRunning: appRunning, ownPid, warn }), false)
  assert.ok(existsSync(dir))

  // The app released its lock when it quit; the launcher's own lock does not keep the profile.
  rmSync(path.join(dir, INSTANCE_LOCK_FILE))
  assert.equal(removeOwnAutoProfile(dir, { isRunning: appRunning, ownPid, warn }), true)
  assert.ok(!existsSync(dir))
})

const repository = path.resolve(import.meta.dirname, '../..')
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

/**
 * Runs scripts/dev.mjs from a copy whose `electron-vite` is a stand-in: it reports whether the launcher's lock was
 * there, holds the app's instance lock like the app does, and releases it when it quits.
 */
/** Where the copy keeps its profiles: XDG_CONFIG_HOME on Linux, Application Support under HOME on macOS. */
const devProfileRoot = () =>
  process.platform === 'darwin' ? path.join(root, 'home/Library/Application Support') : path.join(root, 'config')

async function runDev(args = []) {
  const copy = path.join(root, 'checkout')
  const config = path.join(root, 'config')
  const home = path.join(root, 'home')
  for (const folder of ['scripts', 'apps/desktop', 'node_modules/.bin'])
    mkdirSync(path.join(copy, folder), { recursive: true })
  for (const name of ['dev.mjs', 'instance-shared.mjs', 'instance-color.mjs']) {
    copyFileSync(path.join(repository, 'scripts', name), path.join(copy, 'scripts', name))
  }
  const report = path.join(root, 'report.json')
  const app = path.join(root, 'fake-app.mjs')
  writeFileSync(
    app,
    `import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const profile = path.join(process.env.PROFILE_ROOT, 'maestrly-app-dev-' + process.env.AGENTS_INSTANCE)
const launcherLock = existsSync(path.join(profile, ${JSON.stringify(DEV_LAUNCHER_LOCK_FILE)}))
mkdirSync(profile, { recursive: true })
const lock = path.join(profile, ${JSON.stringify(INSTANCE_LOCK_FILE)})
writeFileSync(lock, JSON.stringify({ pid: process.pid, instance: process.env.AGENTS_INSTANCE, startedAt: 1 }))
writeFileSync(${JSON.stringify(report)}, JSON.stringify({
  instance: process.env.AGENTS_INSTANCE,
  launcherLock,
}))
rmSync(lock)
`
  )
  writeFileSync(
    path.join(copy, 'node_modules/.bin/electron-vite'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(app)}\n`,
    { mode: 0o755 }
  )
  const profileRoot = devProfileRoot()
  mkdirSync(profileRoot, { recursive: true })
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: config, PROFILE_ROOT: profileRoot }
  const result = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [path.join(copy, 'scripts/dev.mjs'), ...args],
      { cwd: copy, env, timeout: 60_000 },
      (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr })
    )
  )
  return { ...result, profileRoot, report: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null }
}

test('an unnamed run sweeps dead auto profiles, owns its own and removes it when it ends', {
  skip: process.platform === 'win32',
}, async () => {
  const ended = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  const at = path.relative(root, devProfileRoot())
  const dead = profile(`${at}/maestrly-app-dev-auto-0dea`, { [INSTANCE_LOCK_FILE]: lock(Number(ended.stdout)) })
  const unlocked = profile(`${at}/maestrly-app-dev-auto-0fee`, { 'db.sqlite': 'x' })
  const named = profile(`${at}/maestrly-app-dev-feature-x`, { [INSTANCE_LOCK_FILE]: lock(Number(ended.stdout)) })
  const base = profile(`${at}/maestrly-app-dev`, { 'db.sqlite': 'x' })

  const result = await runDev()

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.report.instance, /^auto-[0-9a-f]{4}$/)
  assert.equal(result.report.launcherLock, true)
  assert.ok(!existsSync(path.join(result.profileRoot, `maestrly-app-dev-${result.report.instance}`)))
  assert.ok(!existsSync(dead))
  assert.match(result.stdout, /Removed the unused development profile .*maestrly-app-dev-auto-0dea/)
  for (const kept of [unlocked, named, base]) assert.ok(existsSync(kept), kept)
})

test('a named run keeps its profile', { skip: process.platform === 'win32' }, async () => {
  const result = await runDev(['--', 'feature-y'])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.report.instance, 'feature-y')
  assert.equal(result.report.launcherLock, false)
  assert.ok(existsSync(path.join(result.profileRoot, 'maestrly-app-dev-feature-y')))
})

test('a real process that is gone does not keep a profile, and a running one does', () => {
  const ended = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  const deadPid = Number(ended.stdout)
  assert.ok(Number.isInteger(deadPid) && deadPid > 0)
  const gone = profile('maestrly-app-dev-auto-00cc', { [DEV_LAUNCHER_LOCK_FILE]: lock(deadPid) })
  const running = profile('maestrly-app-dev-auto-00dd', { [DEV_LAUNCHER_LOCK_FILE]: lock(process.pid) })

  assert.deepEqual(removeDeadAutoProfiles(root, { warn }), [gone])
  assert.ok(existsSync(running))
})
