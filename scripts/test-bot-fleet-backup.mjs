#!/usr/bin/env node
// Backups on the real images: the gateway backs up an environment of bots into an S3-compatible stand-in, restores it
// on the same server once it is deleted, then on a new server (a gateway with no data) with the recovery key.
//
// It runs in a Compose project and containers of its own, removed at the end (kept with --keep), and saves no state;
// a failure leaves its diagnostics in .bot-fleet-local/backup/.
// Images: MAESTRLY_GATEWAY_IMAGE and MAESTRLY_GATEWAY_BOT_IMAGE as Compose reads them, or the `:local` ones.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const composeFile = path.join(root, 'deploy/bot-fleet/compose.yml')
const fakeFile = path.join(root, 'deploy/bot-fleet/test/fake-model.mjs')
const botImage = process.env.MAESTRLY_GATEWAY_BOT_IMAGE || 'maestrly/bot-instance:local'
const keep = process.argv.slice(2).includes('--keep')
if (process.argv.slice(2).some((arg) => arg !== '--keep'))
  throw new Error('Usage: node scripts/test-bot-fleet-backup.mjs [--keep]')
const suffix = randomUUID().slice(0, 8)
const project = 'fleet-backup-e2e-' + suffix
const network = project + '-bots'
const fakeName = project + '-model'
const modelKey = 'e2e-model-key'
// An S3-compatible server on the fleet network, where the gateway's helpers reach it as `backup-s3`.
const s3Name = project + '-s3'
const s3Image = 'versity/versitygw@sha256:89cad13cc981986ee284cbafea4613f9533ce6fd5f37a2c96c4c4fb8adb3a316' // v1.10.0
const s3Access = 'e2e-access'
const s3Secret = 'e2e-secret-key-0123456789'
const bucket = 'e2e-backups'
const prefix = 'maestrly-' + suffix
const destination = {
  provider: 's3',
  endpoint: 'http://backup-s3:7070',
  region: 'us-east-1',
  bucket,
  prefix,
  accessKeyId: s3Access,
  secretAccessKey: s3Secret,
}
// The bot's id and its environment's come from its name; the container and the home volume from the environment's.
const botName = 'E2E Backup ' + suffix
const botId = 'e2e-backup-' + suffix
const container = 'maestrly-env-' + botId
const homeVolume = container + '-home'
const cacheVolume = network + '-backup-cache'
const memoryText = 'E2E backup memory ' + suffix
const routineTitle = 'E2E backup routine ' + suffix
const diagnostics = path.join(root, '.bot-fleet-local/backup')
const started = Date.now()
let stepStarted = started
const results = []
let composeEnv
let base
let token
let dockerReady = false

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0 || options.allowFailure) resolve({ code, stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}
const docker = (args, options) => run('docker', args, options)
const compose = (args, options) =>
  docker(['compose', '-p', project, '-f', composeFile, ...args], { env: composeEnv, ...options })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function poll(label, fn, timeout = 180000) {
  const until = Date.now() + timeout
  let last
  while (Date.now() < until) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(1000)
  }
  throw new Error('Timed out waiting for ' + label + (last ? ': ' + last.message : ''))
}

async function request(method, route, body, options = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      'X-Maestrly-Fleet-Protocol': '1',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(options.timeout ?? 30000),
  })
  const value = response.status === 204 ? null : await response.json()
  if (options.status !== undefined) assert.equal(response.status, options.status, JSON.stringify(value))
  else if (!response.ok)
    throw new Error(method + ' ' + route + ' HTTP ' + response.status + ': ' + JSON.stringify(value))
  return value
}

function pass(name, evidence) {
  const now = Date.now()
  results.push({ name, evidence, durationMs: now - stepStarted })
  stepStarted = now
  console.log('PASS ' + name + ': ' + evidence + ' [' + results.at(-1).durationMs + ' ms]')
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}

const bot = (id) => request('GET', '/v1/bots/' + id)
const environment = async (id) => (await request('GET', '/v1/environments')).environments.find((item) => item.id === id)
const transcript = async (id) => (await request('GET', '/v1/bots/' + id + '/transcript?limit=500')).items
/** A file in the environment's container, read as its own user. */
const inContainer = (script) => docker(['exec', container, 'sh', '-c', script])

/** Starts the gateway with no data, or again on what it kept, and pairs this test with it as a new device. */
async function startGateway(deviceName) {
  await compose(['up', '-d', '--no-build', 'maestrly-bot-gateway'])
  token = undefined
  const meta = await poll('gateway /v1/meta', () => request('GET', '/v1/meta'), 60000)
  assert.ok(meta.moreFeatures?.includes('backups'), 'The gateway does not back up environments: ' + meta.moreFeatures)
  assert.ok(!meta.features.includes('backups'), 'backups must stay out of the legacy feature list')
  const pairOutput = (
    await compose(['exec', '-T', 'maestrly-bot-gateway', 'node', 'apps/bot-gateway/dist/main.js', 'pair'])
  ).stdout
  const code = /[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/.exec(pairOutput)?.[0]
  assert.ok(code, 'Pairing code absent from gateway CLI output')
  token = (await request('POST', '/v1/pair', { code: code.replace('-', ''), deviceName })).token
  return meta
}

/** Waits for a backup or restore run to end; it must succeed. */
async function finished(runId, environmentId, timeout = 600000) {
  const ended = await poll(
    'run ' + runId,
    async () => {
      const { runs } = await request('GET', '/v1/backup/runs?environmentId=' + environmentId)
      const found = runs.find((item) => item.id === runId)
      return found && ['succeeded', 'partial', 'failed', 'cancelled'].includes(found.state) && found
    },
    timeout
  )
  assert.equal(ended.state, 'succeeded', 'run ended ' + JSON.stringify(ended))
  return ended
}

/** Restores the environment's newest backup and waits for it and its bot to run again. */
async function restoreLatest(thisServer) {
  const { environments } = await request('GET', '/v1/backup/snapshots', undefined, { timeout: 180000 })
  const group = environments.find((item) => item.environmentId === botId)
  assert.ok(group, 'The backup of ' + botId + ' is not listed: ' + JSON.stringify(environments))
  assert.equal(group.thisServer, thisServer)
  assert.equal(group.taken, false)
  const [latest] = group.snapshots
  const preview = await request('POST', '/v1/backup/restore/preview', { snapshotId: latest.id }, { timeout: 180000 })
  assert.deepEqual(preview.problems, [])
  assert.deepEqual(
    preview.bots.map((item) => [item.id, item.taken]),
    [[botId, false]]
  )
  const restore = await request(
    'POST',
    '/v1/backup/restore',
    { snapshotId: latest.id, keepExistingProjects: false, idempotencyKey: randomUUID() },
    { status: 202, timeout: 180000 }
  )
  await finished(restore.id, botId)
  await poll('restored environment running', async () => {
    const value = await environment(botId)
    if (value?.lifecycle === 'failed') throw new Error('It failed to start: ' + JSON.stringify(value.setup))
    return value?.lifecycle === 'running'
  })
  await poll('restored bot running', async () => (await bot(botId)).lifecycle === 'running')
  return latest
}

async function cleanup() {
  if (!dockerReady) return
  if (keep) {
    console.log('Kept Docker resources for project ' + project)
    return
  }
  // The gateway stops first so that it creates nothing more; every resource of this run carries its suffix.
  if (composeEnv) await compose(['stop'], { allowFailure: true })
  for (const name of [container, s3Name, fakeName]) await docker(['rm', '-f', name], { allowFailure: true })
  const helpers = await docker(['ps', '-aq', '--filter', 'label=org.maestrly.fleet.helper'], { allowFailure: true })
  for (const id of helpers.stdout.split(/\s+/).filter(Boolean)) {
    const inspected = await docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', id], { allowFailure: true })
    if (inspected.stdout.includes(suffix)) await docker(['rm', '-f', id], { allowFailure: true })
  }
  for (const name of [homeVolume, cacheVolume]) await docker(['volume', 'rm', name], { allowFailure: true })
  if (composeEnv) await compose(['down', '-v', '--remove-orphans'], { allowFailure: true })
  await docker(['network', 'rm', network], { allowFailure: true })
  const left = [
    ...(await docker(['ps', '-aq', '--filter', 'name=' + suffix], { allowFailure: true })).stdout.split(/\s+/),
    ...(await docker(['volume', 'ls', '-q', '--filter', 'name=' + suffix], { allowFailure: true })).stdout.split(/\s+/),
  ].filter(Boolean)
  if (left.length) {
    console.error('Could not remove Docker resources of ' + project + ': ' + left.join(', '))
    process.exitCode = 1
  }
}

async function main() {
  const available = await docker(['info', '--format', '{{.ServerVersion}}'], { allowFailure: true }).catch(() => ({
    code: 1,
  }))
  if (available.code !== 0) throw new Error('Docker is unavailable. Start Docker and rerun this test.')
  dockerReady = true
  const port = await freePort()
  base = 'http://127.0.0.1:' + port
  composeEnv = {
    ...process.env,
    MAESTRLY_GATEWAY_NETWORK: network,
    MAESTRLY_GATEWAY_PORT: String(port),
    MAESTRLY_ARTIFACTS_PORT: String(await freePort()),
    MAESTRLY_GATEWAY_BIND: '127.0.0.1',
    MAESTRLY_GATEWAY_BOT_EGRESS: 'public',
    // Bots must not download Claude Code or Codex releases during the test.
    MAESTRLY_GATEWAY_BOT_RUNTIME_UPDATES: 'off',
  }
  const firstMeta = await startGateway('Backup E2E')
  pass('gateway and pairing', 'backups announced past the legacy features; paired device')

  await docker([
    'run',
    '-d',
    '--name',
    s3Name,
    '--network',
    network,
    '--network-alias',
    'backup-s3',
    '--tmpfs',
    '/data',
    s3Image,
    '--access',
    s3Access,
    '--secret',
    s3Secret,
    'posix',
    '/data',
  ])
  // A bucket of the posix backend is a folder at its root.
  await docker(['exec', s3Name, 'mkdir', '-p', '/data/' + bucket])
  await docker([
    'run',
    '-d',
    '--name',
    fakeName,
    '--network',
    network,
    '-e',
    'E2E_MODEL_KEY=' + modelKey,
    '-v',
    fakeFile + ':/app/fake-model.mjs:ro',
    'node:22.22.0-bookworm-slim',
    'node',
    '/app/fake-model.mjs',
  ])

  // An environment of one bot, with a conversation, an owner memory of its own, a routine and files in its home.
  const created = await request('POST', '/v1/bots', {
    name: botName,
    instructions: 'E2E backup bot',
    ceiling: 'ask',
    talksTo: [],
    idempotencyKey: randomUUID(),
  })
  assert.equal(created.id, botId)
  await poll('bot running', async () => {
    const value = await bot(botId)
    if (value.lifecycle === 'failed') throw new Error('It failed to start: ' + JSON.stringify(value.setup))
    return value.lifecycle === 'running'
  })
  const environmentId = (await bot(botId)).environmentId
  assert.equal(environmentId, botId)
  await request('POST', '/v1/bots/' + botId + '/accounts/api-key', {
    kind: 'openai',
    name: 'E2E Model',
    key: modelKey,
    baseURL: 'http://' + fakeName + ':8787/v1',
  })
  await poll('account connected', async () => (await bot(botId)).accounts.connected)
  const selection = await poll('fake model selection', async () => {
    const data = await request('GET', '/v1/bots/' + botId + '/selections')
    return data.options.find((option) => option.modelId === 'e2e-model')
  })
  const chosen = { providerId: selection.providerId, modelId: selection.modelId, reasoning: null, fastMode: false }
  await request('PATCH', '/v1/bots/' + botId, { selection: chosen })
  await request('PATCH', '/v1/bots/' + botId, { compaction: { ...chosen, intervalTokens: 100000 } })
  await poll('bot ready', async () => {
    const state = await bot(botId)
    return state.compactionState?.configured === true && state.status !== 'setup'
  })
  await request('POST', '/v1/bots/' + botId + '/messages', {
    text: 'E2E-ALIVE tag=before-backup',
    idempotencyKey: randomUUID(),
  })
  const answered = (items) =>
    items.some((item) => item.kind === 'assistant' && item.text.includes('E2E-ALIVE-OK tag=before-backup'))
  await poll('answer before the backup', async () => answered(await transcript(botId)), 90000)
  await request(
    'POST',
    '/v1/owner-memory',
    { content: memoryText, environmentId, idempotencyKey: randomUUID() },
    { status: 201 }
  )
  await request(
    'POST',
    '/v1/bots/' + botId + '/routines',
    {
      title: routineTitle,
      prompt: 'E2E backup routine ping',
      schedule: { kind: 'weekly', time: '03:00', days: [], timezone: 'UTC' },
      enabled: true,
      idempotencyKey: randomUUID(),
    },
    { status: 201 }
  )
  // What comes back, and what a backup leaves out: dependencies inside a chat's folder and the browser's cache.
  const appDir = (
    await inContainer(
      [
        'set -e',
        'app=$(ls -d "$HOME"/.config/maestrly-app*/ | head -n 1)',
        'chat="$app/standalone-chats/e2e-backup-chat"',
        `cache="$HOME/.config/maestrly-bots/${botId}/chromium/Default/Cache"`,
        'mkdir -p "$chat/node_modules" "$cache"',
        `printf %s ${suffix} > "$chat/marker.txt"`,
        'printf x > "$chat/node_modules/x"',
        'printf x > "$cache/x"',
        'printf %s "$app"',
      ].join('; ')
    )
  ).stdout
    .trim()
    .replace(/\/+$/, '')
  assert.match(appDir, /^\/home\/bot\/\.config\/maestrly-app/)
  const marker = appDir + '/standalone-chats/e2e-backup-chat/marker.txt'
  pass('environment to back up', `${botId} answered, with an owner memory, a routine and files in its home`)

  // Set up: the destination is empty, a repository is created with a new recovery key, backups run every hour.
  assert.deepEqual(await request('POST', '/v1/backup/probe', { destination }, { timeout: 180000 }), { state: 'empty' })
  const connected = await request(
    'PUT',
    '/v1/backup/destination',
    { mode: 'create', destination, idempotencyKey: randomUUID() },
    { timeout: 180000 }
  )
  assert.equal(connected.ok, true, JSON.stringify(connected))
  const recoveryKey = connected.recoveryKey
  assert.match(recoveryKey, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)
  const configured = await request('PATCH', '/v1/backup', {
    enabled: true,
    selection: { mode: 'all' },
    schedule: { kind: 'interval', everyMinutes: 60 },
  })
  assert.equal(JSON.stringify(configured).includes(s3Secret), false, 'The status must not show the secret key')
  assert.equal(JSON.stringify(configured).includes(recoveryKey), false, 'The status must not show the recovery key')
  const backup = await request(
    'POST',
    '/v1/backup/runs',
    { environmentId, idempotencyKey: randomUUID() },
    { status: 201 }
  )
  const backedUp = await finished(backup.id, environmentId)
  assert.match(backedUp.snapshotId, /^[0-9a-f]{64}$/)
  pass('backup', `snapshot ${backedUp.snapshotId.slice(0, 8)}, ${backedUp.bytesAdded} bytes added`)

  // The snapshot as restic itself lists it, with the key the owner keeps.
  const listed = (
    await docker([
      'run',
      '--rm',
      '--network',
      network,
      '--entrypoint',
      'restic',
      '-e',
      `RESTIC_REPOSITORY=s3:http://backup-s3:7070/${bucket}/${prefix}`,
      '-e',
      'RESTIC_PASSWORD=' + recoveryKey.replaceAll('-', ''),
      '-e',
      'AWS_ACCESS_KEY_ID=' + s3Access,
      '-e',
      'AWS_SECRET_ACCESS_KEY=' + s3Secret,
      '-e',
      'AWS_DEFAULT_REGION=us-east-1',
      botImage,
      '--no-cache',
      'ls',
      'latest',
    ])
  ).stdout
  const paths = new Set(listed.split('\n').map((line) => line.trim()))
  assert.ok(paths.has(marker), 'The snapshot lacks ' + marker)
  assert.ok(paths.has('/tmp/maestrly-backup/gateway.json'), "The snapshot lacks the gateway's part")
  assert.ok(![...paths].some((item) => item.endsWith('/Cache/x')), "The snapshot holds the browser's cache")
  assert.ok(![...paths].some((item) => item.endsWith('/node_modules/x')), "The snapshot holds a chat's dependencies")
  pass('snapshot contents', "the marker and the gateway's part are in; the browser cache and node_modules are out")

  // The same server: once the environment is deleted, its backup brings it back with the same ids.
  await request('POST', '/v1/environments/' + environmentId + '/archive')
  await request('DELETE', '/v1/archived-environments/' + environmentId, undefined, { status: 204, timeout: 120000 })
  await poll('environment deleted', async () => !(await environment(environmentId)))
  await restoreLatest(true)
  assert.equal((await inContainer(`cat '${marker}'`)).stdout, suffix)
  const memory = (await request('GET', '/v1/owner-memory')).entries.find((entry) => entry.content === memoryText)
  assert.equal(memory?.environmentId, environmentId)
  const routines = (await request('GET', '/v1/bots/' + botId + '/routines')).routines
  assert.ok(routines.some((routine) => routine.title === routineTitle && routine.enabled))
  assert.ok(answered(await transcript(botId)), "The bot's conversation did not come back")
  pass('restore on the same server', 'files, owner memory, routine and conversation came back with the ids')

  // A new server: the gateway's data and the environment are gone; the recovery key opens the backups again.
  await compose(['stop', 'maestrly-bot-gateway'])
  await compose(['rm', '-f', 'maestrly-bot-gateway'])
  await docker(['rm', '-f', container])
  await docker(['volume', 'rm', homeVolume])
  await docker(['volume', 'rm', project + '_gateway-data'])
  const secondMeta = await startGateway('Backup E2E (new server)')
  assert.notEqual(secondMeta.serverId, firstMeta.serverId)
  assert.deepEqual(await request('POST', '/v1/backup/probe', { destination }, { timeout: 180000 }), {
    state: 'existing',
  })
  const wrong = await request(
    'PUT',
    '/v1/backup/destination',
    { mode: 'connect', destination, recoveryKey: 'A'.repeat(32), idempotencyKey: randomUUID() },
    { timeout: 180000 }
  )
  assert.equal(wrong.error?.code, 'wrong-key', JSON.stringify(wrong))
  const reconnected = await request(
    'PUT',
    '/v1/backup/destination',
    { mode: 'connect', destination, recoveryKey, idempotencyKey: randomUUID() },
    { timeout: 180000 }
  )
  assert.equal(reconnected.ok, true, JSON.stringify(reconnected))
  await restoreLatest(false)
  assert.equal((await inContainer(`cat '${marker}'`)).stdout, suffix)
  assert.ok(answered(await transcript(botId)), "The bot's conversation did not come back on the new server")
  pass('restore on a new server', 'a wrong key refused; the recovery key restored the environment and its files')

  console.log(JSON.stringify({ result: 'PASS', project, durationMs: Date.now() - started, steps: results }, null, 2))
  // The last line is a summary for a caller that runs this test as one of its steps.
  console.log(JSON.stringify({ result: 'PASS', checks: results.length, durationMs: Date.now() - started }))
}

/** What a failure leaves to look at: the gateway's, the environment's and the storage's logs. */
async function saveDiagnostics(error) {
  mkdirSync(diagnostics, { recursive: true })
  const parts = ['FAIL ' + (error?.stack ?? error)]
  for (const [name, args] of [
    ['gateway', ['compose', '-p', project, '-f', composeFile, 'logs', '--tail', '200']],
    [container, ['logs', '--tail', '120', container]],
    [s3Name, ['logs', '--tail', '60', s3Name]],
    [fakeName, ['logs', '--tail', '20', fakeName]],
  ]) {
    const logs = await docker(args, { allowFailure: true, env: composeEnv }).catch(() => null)
    if (logs) parts.push('--- ' + name + ' ---\n' + logs.stdout + logs.stderr)
  }
  const text = parts.join('\n\n')
  writeFileSync(path.join(diagnostics, project + '.log'), text)
  console.error(text)
}

main()
  .catch(async (error) => {
    if (dockerReady) await saveDiagnostics(error)
    else console.error('FAIL ' + (error?.stack ?? error))
    process.exitCode = 1
  })
  .finally(cleanup)
