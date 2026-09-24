#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
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
const env = (port) => ({
  ...process.env,
  MAESTRLY_GATEWAY_NETWORK: network,
  MAESTRLY_GATEWAY_PORT: String(port),
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
const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'))
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
async function main() {
  if (command === 'up') {
    let state
    try {
      state = await readState()
    } catch {
      state = { port: await freePort(), bots: [] }
    }
    await compose(state.port, ['up', '-d', '--no-build'])
    await poll('gateway', async () => (await request(state, 'GET', '/v1/meta')).protocol === 1, 60000)
    await saveState(state)
    console.log(`Fleet URL: http://127.0.0.1:${state.port}`)
    return
  }
  if (command === 'down') {
    let state
    try {
      state = await readState()
    } catch {
      state = { port: 7443, bots: [] }
    }
    let botIds = state.bots ?? []
    if (state.token) {
      try {
        botIds = (await request(state, 'GET', '/v1/bots')).bots.map((bot) => bot.id)
      } catch {
        /* Gateway may already be down. */
      }
    }
    for (const id of botIds) await docker(['rm', '-f', 'maestrly-bot-' + id], { allowFailure: true })
    await docker(['rm', '-f', fakeName], { allowFailure: true })
    for (const id of botIds) await docker(['volume', 'rm', 'maestrly-bot-' + id + '-home'], { allowFailure: true })
    await compose(state.port, ['down', '-v', '--remove-orphans'], { allowFailure: true })
    await docker(['network', 'rm', network], { allowFailure: true })
    await rm(stateFile, { force: true })
    console.log('Removed dev fleet containers, volumes, and network.')
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
      'node:22.22.0-bookworm-slim',
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
