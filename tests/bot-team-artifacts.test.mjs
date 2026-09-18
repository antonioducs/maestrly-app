import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(path.join(root, relative), 'utf8')

test('the packaged runtime carries the collaboration tools and depends on no fixture', async () => {
  const builder = await read('scripts/build-bot-runtime.mjs')
  // Collaboration is reached from the supervisor, so the existing entry point bundles it.
  assert.match(builder, /'main': |main: /)
  assert.doesNotMatch(builder, /fixture/i)
  const supervisor = await read('apps/bot-runtime/src/runtime-supervisor.ts')
  assert.match(supervisor, /CollaborationClient/)
  assert.match(supervisor, /TEAM_CAPABILITY/)
  const client = await read('apps/bot-runtime/src/teams/client.ts')
  // The only way out is the Host channel: no shell, no HTTP, no administrative RPC.
  assert.doesNotMatch(client, /fetch\(|http:\/\/|https:\/\/|child_process|exec\(|spawn\(/)
  const tools = await read('apps/bot-runtime/src/teams/tools.ts')
  assert.doesNotMatch(tools, /fetch\(|child_process/)
  for (const file of await readdir(path.join(root, 'apps/bot-runtime/src/teams'))) assert.match(file, /\.ts$/)
})

test('team collaboration never travels outside the private control channel', async () => {
  const session = await read('apps/bot-runtime/src/control/session.ts')
  assert.match(session, /collaboration\.request/)
  assert.match(session, /collaboration\.response/)
  // Bounded in flight so it cannot starve account renewal, leases or the live screen.
  assert.match(session, /requestsInFlightMax/)
  const guest = await read('packages/host-protocol/src/team-runtime.ts')
  // The frame has no origin field at all: the Host decides who is acting.
  assert.doesNotMatch(guest, /sourceBotId|actingBotId/)
  assert.match(guest, /authenticated session/)
  const hostTools = await read('packages/host-core/src/teams/guest-tools.ts')
  assert.match(hostTools, /access\.origin\(/)
  assert.doesNotMatch(hostTools, /params\.botId|params\.teamId|params\.role/)
})

test('the teams domain keeps a distinct schema version and a preserving migration', async () => {
  const migrations = await read('packages/host-core/src/bots/migrations.ts')
  // The teams domain arrived at schema 6; later phases keep migrating past it, and the team
  // migration below must keep refusing to run against anything but schema 5.
  assert.ok(Number(/HOST_DB_VERSION = (\d+)/.exec(migrations)?.[1]) >= 6)
  const teams = await read('packages/host-core/src/teams/migrations.ts')
  assert.match(teams, /requires host schema version 5/)
  assert.match(teams, /BEGIN IMMEDIATE/)
  assert.match(teams, /ROLLBACK/)
  // Nothing that already exists is rewritten by the team migration.
  for (const forbidden of [/UPDATE bots/, /DELETE FROM bots/, /DROP TABLE bot_/, /ALTER TABLE bot_turns/])
    assert.doesNotMatch(teams, forbidden)
  const store = await read('packages/host-core/src/persistence/store.ts')
  // A consistent backup is taken before any in-place upgrade, including 5 → 6.
  assert.match(store, /backupBeforeMigration\(this\.db, this\.stateDirectory, version\)/)
  assert.match(store, /migrateToV6\(this\.db\)/)
  assert.match(store, /Unsupported host database version/)
})

test('the team capability is advertised on both sides and gated in the application', async () => {
  const protocol = await read('packages/host-protocol/src/teams.ts')
  assert.match(protocol, /TEAM_CAPABILITY = 'bot\.teams\.v1'/)
  assert.match(protocol, /TEAM_HOST_CAPABILITY = 'teams\.v1'/)
  const service = await read('packages/host-core/src/service.ts')
  assert.match(service, /TEAM_HOST_CAPABILITY/)
  const main = await read('apps/bot-desktop/src/main/index.ts')
  // An older Host is told to update instead of failing obscurely.
  assert.match(main, /Atualize este computador para usar equipes/)
  assert.match(main, /hostCapabilities\.includes\(TEAM_HOST_CAPABILITY\)/)
})

test('versions advance so an existing environment is offered the update', async () => {
  // What matters is that nothing goes backwards from what phase 4 shipped: an installed
  // environment compares versions to decide whether an update exists. Pinning exact literals made
  // this test fail on every release instead of catching the regression it is named after.
  const baseline = {
    'apps/bot-runtime/package.json': '0.2.0',
    'packages/host-protocol/package.json': '0.3.0',
    'packages/host-core/package.json': '0.3.0',
    'apps/host/package.json': '0.3.0',
    'apps/bot-desktop/package.json': '0.3.0',
  }
  const compare = (a, b) =>
    a
      .split('.')
      .map(Number)
      .reduce((acc, part, index) => acc || part - Number(b.split('.')[index] ?? 0), 0)
  for (const [file, floor] of Object.entries(baseline)) {
    const version = JSON.parse(await read(file)).version
    assert.match(version, /^\d+\.\d+\.\d+$/, file)
    assert.ok(compare(version, floor) >= 0, `${file}: ${version} is older than ${floor}`)
  }
})

test('shared team files never become a writable shared folder or a Host path in public shapes', async () => {
  const artifacts = await read('packages/host-core/src/teams/artifacts.ts')
  // Copies are verified and promoted; nothing is mounted and nothing is executed.
  assert.match(artifacts, /createHash\('sha256'\)/)
  assert.match(artifacts, /FILE_CHANGED/)
  assert.doesNotMatch(artifacts, /mount|symlink\(|execFile|spawn\(/)
  const schema = await read('packages/host-protocol/src/teams.ts')
  // The public artifact shape names identity, version and digest, never a Host path.
  assert.doesNotMatch(schema, /hostPath|absolutePath|stateDirectory/)
  const grants = /teamArtifactGrantSchema[\s\S]*?\}\)/.exec(schema)?.[0] ?? ''
  assert.match(grants, /workspace-relative/)
})

test('aggregated checks and lab scripts for the teams phase exist', async () => {
  const manifest = JSON.parse(await read('package.json'))
  for (const script of ['check:bot-phase4', 'test:bot-phase4', 'test:e2e:bot-teams', 'lab:bot:teams']) assert.ok(manifest.scripts[script], script)
  // The lab refuses effects unless explicitly authorised.
  assert.match(manifest.scripts['lab:bot:teams'], /doctor/)
  assert.doesNotMatch(manifest.scripts['lab:bot:teams'], /authorize-team-smoke/)
  assert.match(manifest.scripts['check:bot-phase4'], /build:host-protocol/)
  assert.match(manifest.scripts['test:bot-phase4'], /host-core/)
})
