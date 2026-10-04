#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateFile = path.join(root, '.bot-fleet-local/dev-fleet.json')
const composeFile = path.join(root, 'deploy/bot-fleet/compose.yml')
const fakeFile = path.join(root, 'deploy/bot-fleet/test/fake-model.mjs')
const project = 'maestrly-fleet-dev'
const network = project + '-bots'
const fakeName = project + '-model'
const modelKey = 'dev-model-key'
const command = process.argv[2]
if (!['up', 'pair', 'seed', 'down'].includes(command) || process.argv.length !== 3) {
  console.error('Usage: npm run bot-fleet:dev -- <up|pair|seed|down>')
  process.exit(2)
}
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = [],
      err = []
    child.stdout.on('data', (part) => out.push(part))
    child.stderr.on('data', (part) => err.push(part))
    child.once('error', reject)
    child.once('close', (code) => {
      const stdout = Buffer.concat(out).toString()
      const stderr = Buffer.concat(err).toString()
      if (code === 0 || options.allowFailure) resolve({ code, stdout, stderr })
      else reject(new Error(`${file} ${args.join(' ')}: ${stderr.trim()}`))
    })
  })
}
const docker = (args, options) => run('docker', args, options)
let artifactsPort = 4010
const env = (port) => ({
  ...process.env,
  MAESTRLY_GATEWAY_NETWORK: network,
  MAESTRLY_GATEWAY_PORT: String(port),
  MAESTRLY_ARTIFACTS_PORT: String(artifactsPort),
  MAESTRLY_GATEWAY_BIND: '127.0.0.1',
})
const compose = (port, args, options) =>
  docker(['compose', '-p', project, '-f', composeFile, ...args], { env: env(port), ...options })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function poll(label, task, timeout = 120000) {
  const end = Date.now() + timeout
  let error
  while (Date.now() < end) {
    try {
      const result = await task()
      if (result) return result
    } catch (cause) {
      error = cause
    }
    await delay(1000)
  }
  throw new Error(`Timed out waiting for ${label}${error ? ': ' + error.message : ''}`)
}
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
const readState = async () => {
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  artifactsPort = state.artifactsPort ?? 4010
  return state
}
async function saveState(state) {
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}
async function pair(port) {
  const result = await compose(port, [
    'exec',
    '-T',
    'maestrly-bot-gateway',
    'node',
    'apps/bot-gateway/dist/main.js',
    'pair',
  ])
  const code = /[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/.exec(result.stdout)?.[0]
  if (!code) throw new Error('Gateway returned no pairing code: ' + result.stdout)
  return code
}
async function request(state, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${state.port}${route}`, {
    method,
    headers: {
      'X-Maestrly-Fleet-Protocol': '1',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  })
  const value = response.status === 204 ? null : await response.json()
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${JSON.stringify(value)}`)
  return value
}
// Every fleet on a Docker host labels and names its environments alike (apps/bot-gateway/src/lifecycle.ts), so `down`
// never goes by those alone: this dev fleet's environments are the managed containers on its own network and the
// environments its own gateway recorded, archived ones included.
const managedLabel = 'org.maestrly.fleet.managed'
const environmentLabel = 'org.maestrly.fleet.environment-id'
const legacyBotLabel = 'org.maestrly.fleet.bot-id'
const projectLabel = 'com.docker.compose.project'
const words = (text) => text.split(/\s+/).filter(Boolean)
const ownerOf = (labels) => labels?.[environmentLabel] ?? labels?.[legacyBotLabel] ?? null
const nameOf = (container) => String(container.Name).replace(/^\//, '')
const onFleetNetwork = (container) =>
  container.HostConfig?.NetworkMode === network || Object.hasOwn(container.NetworkSettings?.Networks ?? {}, network)
/** Inspects containers, volumes or networks by name, leaving out the ones that do not exist. */
async function inspect(kind, names) {
  if (!names.length) return []
  const result = await docker([kind, 'inspect', ...names], { allowFailure: true })
  // Docker still prints the ones it found when another is missing.
  try {
    return JSON.parse(result.stdout) ?? []
  } catch {
    throw new Error(`docker ${kind} inspect: ${result.stderr.trim()}`)
  }
}
async function containerIds(filters) {
  const args = filters.flatMap((filter) => ['--filter', filter])
  return words((await docker(['ps', '-a', '-q', '--no-trunc', ...args])).stdout)
}
const composeVolumes = async () =>
  words((await docker(['volume', 'ls', '-q', '--filter', `label=${projectLabel}=${project}`])).stdout)
/** Only this fleet's gateway attaches managed containers to its network; stopped ones stay attached. */
async function fleetContainers() {
  return (await inspect('container', await containerIds([`label=${managedLabel}=true`]))).filter(onFleetNetwork)
}
/**
 * The environments the dev gateway recorded, read from a copy of its database: the only record of the home volume of
 * an archived environment. The gateway stops first so that it creates nothing more, and stays stopped. `records` is
 * null when they cannot be read.
 */
async function gatewayRecords() {
  const [gateway] = await containerIds([
    `label=${projectLabel}=${project}`,
    'label=com.docker.compose.service=maestrly-bot-gateway',
  ])
  if (!gateway) {
    const data = await composeVolumes()
    if (!data.length) return { records: [] }
    const retry = 'Run `npm run bot-fleet:dev -- up`, then `down` again'
    return { records: null, reason: `its container is gone but ${data.join(', ')} remains. ${retry}` }
  }
  const copy = await mkdtemp(path.join(os.tmpdir(), 'maestrly-fleet-dev-'))
  let stopped = false
  try {
    await docker(['stop', gateway])
    stopped = true
    await docker(['cp', gateway + ':/data/.', copy])
    return { records: await readRecords(path.join(copy, 'gateway.sqlite')), stopped }
  } catch (error) {
    return { records: null, reason: error.message, stopped }
  } finally {
    // The copy holds the gateway's secrets.
    await rm(copy, { recursive: true, force: true })
  }
}
async function readRecords(file) {
  // A gateway that never started has recorded nothing.
  if (!existsSync(file)) return []
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  try {
    const version = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value)
    const record = (row, container, volume) => ({ id: String(row.id), container, volume, createdAt: row.created_at })
    // Schemas 7–9 add compaction, pending updates and artifact permissions without changing these records.
    if (version >= 6 && version <= 9)
      return db
        .prepare('SELECT id, container_name, volume_name, created_at FROM environments')
        .all()
        .map((row) => record(row, String(row.container_name), String(row.volume_name)))
    // Before environments, the gateway named each bot's container and home volume after the bot.
    if (version >= 1 && version <= 5)
      return db
        .prepare('SELECT id, created_at FROM bots')
        .all()
        .map((row) => record(row, 'maestrly-bot-' + row.id, 'maestrly-bot-' + row.id + '-home'))
    throw new Error('unknown gateway database schema ' + version)
  } finally {
    db.close()
  }
}
/**
 * Docker hands an existing volume to anyone who creates one with its name, so a recorded home volume is this fleet's
 * only when its labels and creation time match the record. A name reused by another fleet later is ambiguous too.
 */
function ownsVolume(volume, record) {
  const labels = volume.Labels ?? {}
  const age = Math.abs(Date.parse(volume.CreatedAt) - Date.parse(record.createdAt))
  return labels[managedLabel] === 'true' && ownerOf(labels) === record.id && Number.isFinite(age) && age <= 60000
}
/**
 * Removes this dev fleet and nothing else, and says so only once Docker no longer has any of it. Whatever cannot be
 * removed or attributed is reported with Docker's errors, and the gateway's records, network and the helper state stay
 * so that `down` can finish later. Returns whether the fleet is gone.
 */
async function down() {
  let state
  try {
    state = await readState()
  } catch {
    state = { port: 7443 }
  }
  const info = await docker(['info', '--format', '{{.ServerVersion}}'], { allowFailure: true }).catch((error) => ({
    code: 1,
    stderr: error.message,
  }))
  if (info.code !== 0) {
    console.error('Docker is unavailable, so nothing was removed: ' + info.stderr.trim())
    return false
  }
  const { records, reason, stopped } = await gatewayRecords()
  const containers = new Set(),
    volumes = new Set(),
    foreign = [],
    errors = []
  for (const container of await fleetContainers()) {
    containers.add(nameOf(container))
    const home = container.Mounts?.find((mount) => mount.Type === 'volume' && mount.Destination === '/home/bot')
    if (home?.Name) volumes.add(home.Name)
  }
  const recorded = records ?? []
  const found = await inspect('container', [fakeName, ...recorded.map((record) => record.container)])
  const byName = new Map(found.map((container) => [nameOf(container), container]))
  const recordedHomes = await inspect(
    'volume',
    recorded.map((record) => record.volume)
  )
  const homes = new Map(recordedHomes.map((volume) => [volume.Name, volume]))
  const model = byName.get(fakeName)
  if (model && onFleetNetwork(model)) containers.add(fakeName)
  else if (model) foreign.push(`container ${fakeName}: not on ${network}`)
  for (const record of recorded) {
    const container = byName.get(record.container)
    if (container && onFleetNetwork(container) && ownerOf(container.Config?.Labels) === record.id)
      containers.add(record.container)
    else if (container)
      foreign.push(`container ${record.container}: not a managed container of environment ${record.id} on ${network}`)
    const volume = homes.get(record.volume)
    if (volume && (!container || containers.has(record.container)) && ownsVolume(volume, record))
      volumes.add(record.volume)
    else if (volume) {
      volumes.delete(record.volume)
      foreign.push(`volume ${record.volume}: its labels or creation time do not match environment ${record.id}`)
    }
  }
  const remove = async (args) => {
    const result = await docker(args, { allowFailure: true })
    if (result.code !== 0) errors.push(`docker ${args.join(' ')}: ${result.stderr.trim()}`)
  }
  for (const name of containers) await remove(['rm', '-f', name])
  for (const name of volumes) await remove(['volume', 'rm', name])
  const present = async () => [
    ...new Set([
      ...(await inspect('container', [...containers])).map((item) => 'container ' + nameOf(item)),
      ...(await fleetContainers()).map((item) => 'container ' + nameOf(item)),
      ...(await inspect('volume', [...volumes])).map((item) => 'volume ' + item.Name),
    ]),
  ]
  let remaining = await present()
  // The gateway's records, the network and the helper state go last, once nothing depends on them any more.
  const settled = records !== null && !foreign.length && !remaining.length
  if (settled) {
    const result = await compose(state.port ?? 7443, ['down', '-v', '--remove-orphans'], { allowFailure: true })
    if (result.code !== 0) errors.push('docker compose down: ' + result.stderr.trim())
    if ((await inspect('network', [network])).length) await remove(['network', 'rm', network])
    const composed = await inspect('container', await containerIds([`label=${projectLabel}=${project}`]))
    remaining = [
      ...new Set([
        ...(await present()),
        ...composed.map((item) => 'container ' + nameOf(item)),
        ...(await composeVolumes()).map((name) => 'volume ' + name),
        ...(await inspect('network', [network])).map((item) => 'network ' + item.Name),
      ]),
    ]
  }
  const gone = (kind, names) => [...names].filter((name) => !remaining.includes(kind + ' ' + name))
  for (const [label, names] of [
    ['containers', gone('container', containers)],
    ['volumes', gone('volume', volumes)],
  ])
    if (names.length) console.log(`Removed ${label}: ${names.join(', ')}`)
  const kept = path.relative(root, stateFile)
  if (settled && !remaining.length) {
    await rm(stateFile, { force: true })
    console.log(`Removed the dev fleet: its gateway, gateway data, network ${network} and ${kept}.`)
    return true
  }
  const report = ['The dev fleet was not completely removed.']
  if (records === null)
    report.push(`Could not read the dev gateway's records of its environments: ${reason.replace(/\.?$/, '.')}`)
  if (foreign.length)
    report.push(
      'Left in place because another fleet may own them:',
      ...foreign.map((line) => '  ' + line),
      'If one is a leftover of an earlier dev fleet, remove it yourself, for example with `docker volume rm`, and run `down` again.'
    )
  if (remaining.length) report.push('Still present:', ...remaining.map((line) => '  ' + line))
  if (errors.length) report.push('Docker errors:', ...errors.map((line) => '  ' + line))
  const gateway = stopped ? 'the stopped dev gateway, its data' : "the dev gateway's data"
  report.push(
    settled
      ? `Kept ${kept}.`
      : `Kept ${gateway}, network ${network} and ${kept}, so that \`down\` can finish once this is resolved.`
  )
  console.error(report.join('\n'))
  return false
}
async function main() {
  if (command === 'up') {
    let state
    try {
      state = await readState()
    } catch {
      state = { port: await freePort(), bots: [] }
    }
    state.artifactsPort ??= await freePort()
    artifactsPort = state.artifactsPort
    await compose(state.port, ['up', '-d', '--no-build'])
    await poll('gateway', async () => (await request(state, 'GET', '/v1/meta')).protocol === 1, 60000)
    await saveState(state)
    console.log(`Fleet URL: http://127.0.0.1:${state.port}`)
    console.log(`Artifacts URL: http://127.0.0.1:${state.artifactsPort}`)
    return
  }
  if (command === 'down') {
    if (!(await down())) process.exitCode = 1
    return
  }
  const state = await readState()
  if (command === 'pair') {
    console.log(`Fleet URL: http://127.0.0.1:${state.port}\nPairing code: ${await pair(state.port)}`)
    return
  }
  if (!state.token) {
    const code = await pair(state.port)
    state.token = (
      await request(state, 'POST', '/v1/pair', { code: code.replace('-', ''), deviceName: 'Fleet dev seed' })
    ).token
    await saveState(state)
  }
  if (!state.bots.length) {
    const profiles = [
      { name: 'Dev', instructions: 'Develop and review features.', ceiling: 'full', talksTo: [] },
      {
        name: 'Scout',
        instructions: 'Research with the browser and ask for help when blocked.',
        ceiling: 'ask',
        talksTo: ['dev'],
      },
      { name: 'Ads', instructions: 'Review ad campaigns and report findings.', ceiling: 'auto', talksTo: [] },
    ]
    for (const profile of profiles) {
      const bot = await request(state, 'POST', '/v1/bots', { ...profile, idempotencyKey: randomUUID() })
      state.bots.push(bot.id)
      await saveState(state)
    }
  }
  for (const [id, role] of [
    ['dev', 'Desenvolvimento'],
    ['scout', 'Pesquisa de mercado'],
    ['ads', 'Anúncios'],
  ]) {
    const bot = await request(state, 'GET', `/v1/bots/${id}`)
    if (bot.role !== role) await request(state, 'PATCH', `/v1/bots/${id}`, { role })
  }
  const scoutId = state.bots.find((id) => id === 'scout') ?? state.bots[1]
  await poll(
    'Scout container',
    async () => (await request(state, 'GET', '/v1/bots/' + scoutId)).lifecycle === 'running'
  )
  const inspect = await docker(['inspect', fakeName], { allowFailure: true })
  if (inspect.code !== 0)
    await docker([
      'run',
      '-d',
      '--name',
      fakeName,
      '--network',
      network,
      '-e',
      'E2E_MODEL_KEY=' + modelKey,
      '-e',
      'E2E_DEV_ID=' + state.bots[0],
      '-v',
      fakeFile + ':/app/fake-model.mjs:ro',
      'node:24.21.0-bookworm-slim',
      'node',
      '/app/fake-model.mjs',
    ])
  const scout = await request(state, 'GET', '/v1/bots/' + scoutId)
  if (!scout.accounts.connected)
    await request(state, 'POST', `/v1/bots/${scoutId}/accounts/api-key`, {
      kind: 'openai',
      name: 'Dev fake model',
      key: modelKey,
      baseURL: `http://${fakeName}:8787/v1`,
    })
  const option = await poll('fake model selection', async () =>
    (await request(state, 'GET', `/v1/bots/${scoutId}/selections`)).options.find((item) => item.modelId === 'e2e-model')
  )
  await request(state, 'PATCH', `/v1/bots/${scoutId}`, {
    selection: { providerId: option.providerId, modelId: option.modelId, reasoning: null, fastMode: false },
    compaction: {
      providerId: option.providerId,
      modelId: option.modelId,
      reasoning: null,
      fastMode: false,
      intervalTokens: 100000,
    },
  })
  const routines = (await request(state, 'GET', `/v1/bots/${scoutId}/routines`)).routines
  let routine = routines.find((item) => item.title === 'Morning research')
  if (!routine)
    routine = await request(state, 'POST', `/v1/bots/${scoutId}/routines`, {
      title: 'Morning research',
      prompt: 'E2E routine ping',
      schedule: { kind: 'weekly', time: '08:00', days: [], timezone: 'UTC' },
      enabled: true,
      idempotencyKey: randomUUID(),
    })
  const items = (await request(state, 'GET', `/v1/bots/${scoutId}/transcript?limit=500`)).items
  if (!items.some((item) => item.kind === 'user' && item.text === 'E2E-START')) {
    await request(state, 'POST', `/v1/bots/${scoutId}/routines/${routine.id}/run`)
    await poll(
      'routine transcript',
      async () =>
        (await request(state, 'GET', `/v1/bots/${scoutId}/transcript?limit=500`)).items.some(
          (item) => item.kind === 'assistant' && item.text.includes('E2E-ROUTINE-DONE')
        ),
      90000
    )
    await request(state, 'POST', `/v1/bots/${scoutId}/messages`, { text: 'E2E-START', idempotencyKey: randomUUID() })
    for (const tool of ['computer_screenshot', 'computer_click', 'bot_peers_send', 'request_owner_help']) {
      const item = await poll(
        `${tool} permission`,
        async () =>
          (await request(state, 'GET', '/v1/inbox')).items.find(
            (entry) =>
              entry.botId === scoutId &&
              entry.interaction.kind === 'permission' &&
              entry.interaction.title.includes(tool)
          ),
        90000
      )
      await request(state, 'POST', `/v1/bots/${scoutId}/interactions/${item.interaction.id}`, {
        kind: 'permission',
        reply: 'once',
      })
    }
    await poll(
      'pending help request',
      async () =>
        (await request(state, 'GET', '/v1/inbox')).items.some(
          (entry) => entry.botId === scoutId && entry.interaction.kind === 'help'
        ),
      90000
    )
  }
  console.log(
    `Seeded Dev, Scout, Ads. Scout has a fake model transcript and sample routine. URL: http://127.0.0.1:${state.port}`
  )
}
main().catch((error) => {
  console.error(error.stack ?? error)
  process.exitCode = 1
})
