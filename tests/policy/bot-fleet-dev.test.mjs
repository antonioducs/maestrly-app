import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

// `npm run bot-fleet:dev -- down` runs here against a fake `docker` only: a copy of the helper in a temporary root
// (so the real `.bot-fleet-local` is never read or removed) with PATH holding nothing but the fake.
const root = path.resolve(import.meta.dirname, '../..')
const helper = path.join(root, 'scripts/bot-fleet-dev.mjs')
const fakeDocker = path.join(root, 'tests/policy/support/fake-docker.mjs')
const skip = process.platform === 'win32' && 'the fake docker command is a POSIX shell script'
const project = 'maestrly-fleet-dev'
const devNetwork = project + '-bots'
const dataVolume = project + '_gateway-data'
const recordedAt = '2026-09-26T10:00:00.000Z'
const createdAt = '2026-09-26T10:00:04Z'
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"

function owner(id, legacy = false) {
  const label = legacy ? 'org.maestrly.fleet.bot-id' : 'org.maestrly.fleet.environment-id'
  return { 'org.maestrly.fleet.managed': 'true', [label]: id }
}
/** An environment container as a gateway creates it: managed, labelled with its owner, on its fleet network. */
function environment(name, id, network, { legacy = false, running = true } = {}) {
  return {
    id: 'id-' + name,
    name,
    labels: owner(id, legacy),
    networkMode: network,
    networks: [network],
    mounts: [{ Type: 'volume', Name: name + '-home', Destination: '/home/bot' }],
    running,
  }
}
const home = (name, id, { legacy = false, at = createdAt } = {}) => ({ name, labels: owner(id, legacy), createdAt: at })
function gateway(composeProject, network, data = null) {
  const labels = { 'com.docker.compose.project': composeProject, 'com.docker.compose.service': 'maestrly-bot-gateway' }
  return {
    id: 'id-' + composeProject + '-gateway',
    name: composeProject + '-maestrly-bot-gateway-1',
    labels,
    networkMode: network,
    networks: [network],
    mounts: [{ Type: 'volume', Name: composeProject + '_gateway-data', Destination: '/data' }],
    running: false,
    data,
  }
}
const composeVolume = (composeProject) => ({
  name: composeProject + '_gateway-data',
  labels: { 'com.docker.compose.project': composeProject, 'com.docker.compose.volume': 'gateway-data' },
  createdAt: '2026-09-20T09:00:00Z',
})
const composeNetwork = (composeProject, name) => ({
  name,
  labels: { 'com.docker.compose.project': composeProject, 'com.docker.compose.network': 'bots' },
})
function sidecar(name, network) {
  return { id: 'id-' + name, name, labels: {}, networkMode: network, networks: [network], mounts: [], running: true }
}
/** Another fleet on the same Docker host, for example production or an end-to-end run, with the same kinds of names. */
function otherFleets() {
  const e2e = 'fleet-e2e-1a2b3c4d'
  return {
    containers: [
      environment('maestrly-env-sales', 'sales', 'maestrly-bots'),
      environment('maestrly-bot-support', 'support', 'maestrly-bots', { legacy: true, running: false }),
      { ...gateway('bot-fleet', 'maestrly-bots'), running: true },
      environment('maestrly-env-e2e-dev-1a2b3c4d', 'e2e-dev-1a2b3c4d', e2e + '-bots'),
      { ...gateway(e2e, e2e + '-bots'), running: true },
      sidecar(e2e + '-model', e2e + '-bots'),
    ],
    volumes: [
      home('maestrly-env-sales-home', 'sales', { at: '2026-09-01T08:00:00Z' }),
      home('maestrly-bot-support-home', 'support', { legacy: true, at: '2026-08-01T08:00:00Z' }),
      home('maestrly-env-finance-home', 'finance', { at: '2026-09-02T08:00:00Z' }),
      composeVolume('bot-fleet'),
      home('maestrly-env-e2e-dev-1a2b3c4d-home', 'e2e-dev-1a2b3c4d'),
      composeVolume(e2e),
    ],
    networks: [composeNetwork('bot-fleet', 'maestrly-bots'), composeNetwork(e2e, e2e + '-bots')],
  }
}
/**
 * Writes a gateway data directory whose rows are still only in the write-ahead log, as a gateway that stopped without
 * a checkpoint leaves it. Schema 6 records environments; older schemas record bots, whose names the gateway derives.
 */
function gatewayData(directory, schema, rows) {
  const data = path.join(directory, 'gateway-data')
  const scratch = path.join(directory, 'gateway-live')
  mkdirSync(data)
  mkdirSync(scratch)
  const db = new DatabaseSync(path.join(scratch, 'gateway.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(schema))
  if (schema === 6) {
    db.exec(
      'CREATE TABLE environments (id TEXT PRIMARY KEY, name TEXT NOT NULL, lifecycle TEXT NOT NULL, setup_json TEXT NOT NULL, container_name TEXT NOT NULL UNIQUE, volume_name TEXT NOT NULL UNIQUE, memory_limit_bytes INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT)'
    )
    const insert = db.prepare(
      "INSERT INTO environments VALUES(?, ?, ?, '{}', ?, ?, NULL, ?, ?, CASE WHEN ? = 'archived' THEN ? END)"
    )
    for (const row of rows)
      insert.run(
        row.id,
        row.id,
        row.lifecycle,
        row.container,
        row.container + '-home',
        recordedAt,
        recordedAt,
        row.lifecycle,
        recordedAt
      )
  } else {
    db.exec(
      'CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, lifecycle TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT)'
    )
    const insert = db.prepare("INSERT INTO bots VALUES(?, ?, ?, ?, ?, CASE WHEN ? = 'archived' THEN ? END)")
    for (const row of rows) insert.run(row.id, row.id, row.lifecycle, recordedAt, recordedAt, row.lifecycle, recordedAt)
  }
  for (const name of ['gateway.sqlite', 'gateway.sqlite-wal', 'gateway.sqlite-shm'])
    copyFileSync(path.join(scratch, name), path.join(data, name))
  db.close()
  return data
}
async function closedPort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}
/** Runs `down` on the Docker host and helper state that `setup` builds in a temporary directory. */
async function down(setup) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fleet-dev-down-'))
  try {
    const { docker, fleet } = await setup(directory)
    const script = path.join(directory, 'scripts/bot-fleet-dev.mjs')
    const fleetFile = path.join(directory, '.bot-fleet-local/dev-fleet.json')
    const bin = path.join(directory, 'bin')
    const dockerFile = path.join(directory, 'docker.json')
    const temporary = path.join(directory, 'tmp')
    for (const folder of [path.dirname(script), path.dirname(fleetFile), bin, temporary]) mkdirSync(folder)
    copyFileSync(helper, script)
    writeFileSync(fleetFile, JSON.stringify(fleet))
    writeFileSync(dockerFile, JSON.stringify(docker))
    writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeDocker)} "$@"\n`, {
      mode: 0o755,
    })
    const env = { PATH: bin, FAKE_DOCKER_STATE: dockerFile, TMPDIR: temporary }
    const result = await new Promise((resolve) =>
      execFile(process.execPath, [script, 'down'], { cwd: directory, env, timeout: 60000 }, (error, stdout, stderr) =>
        resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr })
      )
    )
    const calls = readFileSync(dockerFile + '.calls', 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
    return {
      ...result,
      calls,
      docker: JSON.parse(readFileSync(dockerFile, 'utf8')),
      fleetKept: existsSync(fleetFile),
      temporary: readdirSync(temporary),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
const names = (docker) => ({
  containers: docker.containers.map((item) => item.name).sort(),
  volumes: docker.volumes.map((item) => item.name).sort(),
  networks: docker.networks.map((item) => item.name).sort(),
})
const combine = (...hosts) => ({
  containers: hosts.flatMap((host) => host.containers ?? []),
  volumes: hosts.flatMap((host) => host.volumes ?? []),
  networks: hosts.flatMap((host) => host.networks ?? []),
  failures: Object.assign({}, ...hosts.map((host) => host.failures)),
})
/** The calls that change something, which must name nothing outside the dev fleet. */
function changes(calls) {
  return calls.filter(
    ([command, action]) =>
      ['rm', 'stop', 'compose'].includes(command) || (['volume', 'network'].includes(command) && action === 'rm')
  )
}
function assertOthersUntouched(result) {
  const others = otherFleets()
  const foreign = [
    ...others.containers.flatMap((item) => [item.id, item.name]),
    ...others.volumes.map((item) => item.name),
  ]
  for (const network of others.networks) foreign.push(network.name)
  for (const call of changes(result.calls))
    for (const arg of call) assert.ok(!foreign.includes(arg), 'changed another fleet: docker ' + call.join(' '))
  for (const kind of ['containers', 'volumes', 'networks'])
    for (const item of others[kind])
      assert.ok(names(result.docker)[kind].includes(item.name), item.name + ' was removed')
}

test('down removes every environment of the dev fleet, archived ones included, while its gateway is offline', {
  skip,
}, async () => {
  const result = await down(async (directory) => ({
    fleet: { port: await closedPort(), token: 'dev-token', bots: ['dev'] },
    docker: combine(otherFleets(), {
      containers: [
        gateway(
          project,
          devNetwork,
          gatewayData(directory, 6, [
            { id: 'dev', container: 'maestrly-bot-dev', lifecycle: 'running' },
            { id: 'scout', container: 'maestrly-env-scout', lifecycle: 'running' },
            { id: 'notes', container: 'maestrly-env-notes', lifecycle: 'stopped' },
            { id: 'lab', container: 'maestrly-env-lab', lifecycle: 'archived' },
            { id: 'ghost', container: 'maestrly-env-ghost', lifecycle: 'failed' },
          ])
        ),
        environment('maestrly-bot-dev', 'dev', devNetwork, { legacy: true }),
        environment('maestrly-env-scout', 'scout', devNetwork),
        environment('maestrly-env-notes', 'notes', devNetwork, { running: false }),
        // Left by an earlier `down` that lost the gateway's records: only its network tells whose it is.
        environment('maestrly-env-orphan', 'orphan', devNetwork),
        sidecar(project + '-model', devNetwork),
      ],
      volumes: [
        home('maestrly-bot-dev-home', 'dev', { legacy: true }),
        home('maestrly-env-scout-home', 'scout'),
        home('maestrly-env-notes-home', 'notes'),
        home('maestrly-env-lab-home', 'lab'),
        home('maestrly-env-orphan-home', 'orphan'),
        composeVolume(project),
      ],
      networks: [composeNetwork(project, devNetwork)],
    }),
  }))
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(names(result.docker), names(otherFleets()))
  assertOthersUntouched(result)
  assert.equal(result.fleetKept, false)
  assert.deepEqual(result.temporary, [], 'the copy of the gateway database was not deleted')
  for (const name of ['maestrly-bot-dev', 'maestrly-env-notes', 'maestrly-env-orphan-home', 'maestrly-env-lab-home'])
    assert.match(result.stdout, new RegExp(name))
})

test('down removes the bots of a gateway from before environments, archived ones included', { skip }, async () => {
  const result = await down((directory) => ({
    fleet: { port: 7443, bots: [] },
    docker: combine(otherFleets(), {
      containers: [
        {
          ...gateway(
            project,
            devNetwork,
            gatewayData(directory, 5, [
              { id: 'dev', lifecycle: 'running' },
              { id: 'ads', lifecycle: 'archived' },
            ])
          ),
          running: true,
        },
        environment('maestrly-bot-dev', 'dev', devNetwork, { legacy: true }),
      ],
      volumes: [
        home('maestrly-bot-dev-home', 'dev', { legacy: true }),
        home('maestrly-bot-ads-home', 'ads', { legacy: true }),
        composeVolume(project),
      ],
      networks: [composeNetwork(project, devNetwork)],
    }),
  }))
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(names(result.docker), names(otherFleets()))
  assertOthersUntouched(result)
  assert.equal(result.fleetKept, false)
  // A running gateway stops before its database is copied, so that it records and creates nothing more.
  const stop = result.calls.findIndex(([command]) => command === 'stop')
  assert.ok(stop >= 0 && stop < result.calls.findIndex(([command]) => command === 'cp'))
})

test('down leaves names the dev gateway recorded but another fleet owns, and says so', { skip }, async () => {
  const result = await down((directory) => ({
    fleet: { port: 7443, bots: [] },
    docker: combine(otherFleets(), {
      containers: [
        gateway(
          project,
          devNetwork,
          gatewayData(directory, 6, [
            { id: 'scout', container: 'maestrly-env-scout', lifecycle: 'running' },
            // Creating these failed or was archived, because another fleet on this host already used the names.
            { id: 'sales', container: 'maestrly-env-sales', lifecycle: 'failed' },
            { id: 'finance', container: 'maestrly-env-finance', lifecycle: 'archived' },
          ])
        ),
        environment('maestrly-env-scout', 'scout', devNetwork),
      ],
      volumes: [home('maestrly-env-scout-home', 'scout'), composeVolume(project)],
      networks: [composeNetwork(project, devNetwork)],
    }),
  }))
  assert.equal(result.status, 1)
  assertOthersUntouched(result)
  assert.ok(!names(result.docker).containers.includes('maestrly-env-scout'))
  assert.ok(!names(result.docker).volumes.includes('maestrly-env-scout-home'))
  for (const name of ['maestrly-env-sales', 'maestrly-env-sales-home', 'maestrly-env-finance-home'])
    assert.match(result.stderr, new RegExp(name + '\\b'))
  // The gateway's records stay, so that `down` can finish once those names are sorted out.
  assert.ok(names(result.docker).volumes.includes(dataVolume))
  assert.equal(result.fleetKept, true)
})

test('down keeps the gateway data and reports what is left when it cannot read the records', { skip }, async () => {
  const result = await down(() => ({
    fleet: { port: 7443, token: 'dev-token', bots: ['scout'] },
    docker: combine(otherFleets(), {
      // The gateway container was removed by hand: its data volume is the only record of archived environments.
      containers: [environment('maestrly-env-scout', 'scout', devNetwork), sidecar(project + '-model', devNetwork)],
      volumes: [home('maestrly-env-scout-home', 'scout'), home('maestrly-env-lab-home', 'lab'), composeVolume(project)],
      networks: [composeNetwork(project, devNetwork)],
    }),
  }))
  assert.equal(result.status, 1)
  assertOthersUntouched(result)
  const left = names(result.docker)
  assert.ok(!left.containers.includes('maestrly-env-scout'))
  assert.ok(!left.containers.includes(project + '-model'))
  assert.ok(!left.volumes.includes('maestrly-env-scout-home'))
  assert.ok(left.volumes.includes(dataVolume))
  assert.ok(left.volumes.includes('maestrly-env-lab-home'))
  assert.match(result.stderr, new RegExp(dataVolume))
  assert.doesNotMatch(result.stdout, /Removed the dev fleet/)
  assert.equal(result.fleetKept, true)
})

test('down preserves names reused by a different fleet after the dev record was created', { skip }, async () => {
  const foreignModel = project + '-model'
  const reusedVolume = 'maestrly-env-reused-home'
  const result = await down((directory) => ({
    fleet: { port: 7443, bots: [] },
    docker: combine(otherFleets(), {
      containers: [
        gateway(
          project,
          devNetwork,
          gatewayData(directory, 6, [{ id: 'reused', container: 'maestrly-env-reused', lifecycle: 'archived' }])
        ),
        sidecar(foreignModel, 'maestrly-bots'),
      ],
      volumes: [home(reusedVolume, 'reused', { at: '2026-09-27T10:00:00Z' }), composeVolume(project)],
      networks: [composeNetwork(project, devNetwork)],
    }),
  }))
  assert.equal(result.status, 1)
  assert.ok(names(result.docker).containers.includes(foreignModel))
  assert.ok(names(result.docker).volumes.includes(reusedVolume))
  assert.ok(!changes(result.calls).some((args) => args.includes(foreignModel) || args.includes(reusedVolume)))
  assert.equal(result.fleetKept, true)
})

test('down reports a removal Docker refuses and keeps what is needed to retry it', { skip }, async () => {
  const refusal = 'Error response from daemon: remove maestrly-env-lab-home: synthetic refusal'
  const result = await down((directory) => ({
    fleet: { port: 7443, bots: [] },
    docker: combine(otherFleets(), {
      containers: [
        gateway(
          project,
          devNetwork,
          gatewayData(directory, 6, [
            { id: 'scout', container: 'maestrly-env-scout', lifecycle: 'running' },
            { id: 'lab', container: 'maestrly-env-lab', lifecycle: 'archived' },
          ])
        ),
        environment('maestrly-env-scout', 'scout', devNetwork),
      ],
      volumes: [home('maestrly-env-scout-home', 'scout'), home('maestrly-env-lab-home', 'lab'), composeVolume(project)],
      networks: [composeNetwork(project, devNetwork)],
      failures: { 'volume rm maestrly-env-lab-home': refusal },
    }),
  }))
  assert.equal(result.status, 1)
  assertOthersUntouched(result)
  assert.ok(result.stderr.includes(refusal), result.stderr)
  const left = names(result.docker)
  assert.ok(!left.containers.includes('maestrly-env-scout'))
  assert.ok(left.volumes.includes('maestrly-env-lab-home'))
  assert.ok(left.containers.includes(project + '-maestrly-bot-gateway-1'))
  assert.ok(left.volumes.includes(dataVolume))
  assert.doesNotMatch(result.stdout, /Removed the dev fleet/)
  assert.equal(result.fleetKept, true)
  assert.deepEqual(result.temporary, [])
})

test('down changes nothing when Docker is unavailable', { skip }, async () => {
  const docker = { ...combine(otherFleets()), unavailable: true }
  const result = await down(() => ({ fleet: { port: 7443, bots: ['dev'] }, docker }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Docker/)
  assert.deepEqual(changes(result.calls), [])
  assert.equal(result.fleetKept, true)
})
