#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const composeFile = path.join(root, 'deploy/bot-fleet/compose.yml')
const fakeFile = path.join(root, 'deploy/bot-fleet/test/fake-model.mjs')
const keep = process.argv.slice(2).includes('--keep')
if (process.argv.slice(2).some((arg) => arg !== '--keep'))
  throw new Error('Usage: node scripts/test-bot-fleet-e2e.mjs [--keep]')
const suffix = randomUUID().slice(0, 8)
const project = 'fleet-e2e-' + suffix
const network = project + '-bots'
const devId = 'e2e-dev-' + suffix
const scoutId = 'e2e-scout-' + suffix
const fakeName = project + '-model'
const modelKey = 'e2e-model-key'
const botNames = [devId, scoutId].map((id) => 'maestrly-bot-' + id)
const started = Date.now()
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    interrupted = true
  })
const events = []
const timings = {}
const results = []
let port
let base
let token
let dockerReady = false
let sseAbort
let sseTask
let composeEnv

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    const out = [],
      err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      const stdout = Buffer.concat(out).toString()
      const stderr = Buffer.concat(err).toString()
      if (code === 0 || options.allowFailure) resolve({ code, stdout, stderr })
      else reject(new Error(command + ' ' + args.join(' ') + ' exited ' + code + ': ' + stderr.slice(-3000)))
    })
  })
}
const docker = (args, options) => run('docker', args, options)
const compose = (args, options) =>
  docker(['compose', '-p', project, '-f', composeFile, ...args], { env: composeEnv, ...options })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function poll(label, fn, timeout = 120000) {
  const until = Date.now() + timeout
  let last
  while (Date.now() < until) {
    if (interrupted) throw new Error('Interrupted; cleaning up isolated fleet resources')
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
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(options.timeout ?? 30000),
  })
  const value = response.status === 204 ? null : await response.json()
  if (options.status !== undefined) {
    assert.equal(response.status, options.status, JSON.stringify(value))
  } else if (!response.ok) {
    throw new Error(method + ' ' + route + ' HTTP ' + response.status + ': ' + JSON.stringify(value))
  }
  return value
}
function pass(name, evidence) {
  results.push({ name, evidence })
  console.log('PASS ' + name + ': ' + evidence)
}
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}
async function subscribe() {
  sseAbort = new AbortController()
  const response = await fetch(base + '/v1/events', {
    headers: { Authorization: 'Bearer ' + token, 'X-Maestrly-Fleet-Protocol': '1' },
    signal: sseAbort.signal,
  })
  assert.equal(response.status, 200)
  sseTask = (async () => {
    let pending = ''
    for await (const chunk of response.body) {
      pending += Buffer.from(chunk).toString()
      let end
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end)
        pending = pending.slice(end + 2)
        const data = frame.split('\n').find((line) => line.startsWith('data: '))
        if (data) events.push(JSON.parse(data.slice(6)))
      }
    }
  })().catch((error) => {
    if (!sseAbort.signal.aborted) console.error('SSE error: ' + error.message)
  })
  await poll('SSE hello', () => events.some((event) => event.type === 'hello'), 10000)
}
const bot = (id) => request('GET', '/v1/bots/' + id)
const transcript = async (id) => (await request('GET', '/v1/bots/' + id + '/transcript?limit=500')).items
async function fleetImage(botId, imageId) {
  const response = await fetch(base + '/v1/bots/' + botId + '/images/' + imageId, {
    headers: { Authorization: 'Bearer ' + token, 'X-Maestrly-Fleet-Protocol': '1' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  return Buffer.from(await response.arrayBuffer())
}
const inbox = async () => (await request('GET', '/v1/inbox')).items
async function approve(name) {
  const item = await poll(
    name + ' permission',
    async () =>
      (await inbox()).find(
        (entry) =>
          entry.botId === scoutId && entry.interaction.kind === 'permission' && entry.interaction.title.includes(name)
      ),
    90000
  )
  assert.ok(
    (await request('GET', '/v1/activity')).entries.some(
      (entry) => entry.botId === scoutId && entry.kind === 'needs_you'
    )
  )
  await request('POST', '/v1/bots/' + scoutId + '/interactions/' + item.interaction.id, {
    kind: 'permission',
    reply: 'once',
  })
  return item
}
async function mouse(name) {
  const value = (await docker(['exec', name, 'xdotool', 'getmouselocation', '--shell'])).stdout
  return { x: Number(/^X=(\d+)/m.exec(value)?.[1]), y: Number(/^Y=(\d+)/m.exec(value)?.[1]) }
}

class Rfb {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.chunks = []
    this.waiters = []
    this.bytes = 0
    this.closed = null
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', async (event) => {
      const data = Buffer.from(await event.data.arrayBuffer())
      this.chunks.push(data)
      this.bytes += data.length
      this.flush()
    })
    this.ws.addEventListener('close', (event) => {
      this.closed = event.code
      this.flush()
    })
  }
  flush() {
    for (const wake of this.waiters.splice(0)) wake()
  }
  send(data) {
    this.ws.send(data)
  }
  async read(length) {
    while (this.bytes < length) {
      if (this.closed !== null) throw new Error('RFB closed: ' + this.closed)
      await Promise.race([
        new Promise((resolve) => this.waiters.push(resolve)),
        sleep(10000).then(() => {
          throw new Error('RFB read timeout')
        }),
      ])
    }
    const value = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const first = this.chunks[0]
      const amount = Math.min(length - offset, first.length)
      first.copy(value, offset, 0, amount)
      if (amount === first.length) this.chunks.shift()
      else this.chunks[0] = first.subarray(amount)
      offset += amount
    }
    this.bytes -= length
    return value
  }
  async handshake() {
    assert.equal((await this.read(12)).toString(), 'RFB 003.008\n')
    this.send(Buffer.from('RFB 003.008\n'))
    const count = (await this.read(1))[0]
    assert.ok(count > 0)
    assert.ok((await this.read(count)).includes(1))
    this.send(Buffer.from([1]))
    assert.equal((await this.read(4)).readUInt32BE(0), 0)
    this.send(Buffer.from([1]))
    const init = await this.read(24)
    this.width = init.readUInt16BE(0)
    this.height = init.readUInt16BE(2)
    this.bpp = init[4]
    await this.read(init.readUInt32BE(20))
    assert.equal(this.width, 1280)
    assert.equal(this.height, 800)
    const encodings = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])
    this.send(encodings)
  }
  async pixels() {
    const ask = Buffer.alloc(10)
    ask[0] = 3
    ask.writeUInt16BE(this.width, 6)
    ask.writeUInt16BE(this.height, 8)
    this.send(ask)
    assert.equal((await this.read(1))[0], 0)
    const header = await this.read(3)
    const count = header.readUInt16BE(1)
    assert.ok(count > 0)
    let pixelCount = 0
    for (let i = 0; i < count; i++) {
      const rect = await this.read(12)
      assert.equal(rect.readInt32BE(8), 0, 'Expected raw RFB pixels')
      const size = rect.readUInt16BE(4) * rect.readUInt16BE(6) * (this.bpp / 8)
      const pixels = await this.read(size)
      assert.ok(pixels.some((value) => value !== pixels[0]) || size > 0)
      pixelCount += size
    }
    return pixelCount
  }
  pointer(x, y) {
    this.send(Buffer.from([5, 0, x >> 8, x & 255, y >> 8, y & 255]))
  }
  async closeCode() {
    await poll('RFB socket close', () => this.closed !== null && this.closed, 10000)
    return this.closed
  }
  close() {
    this.ws.close()
  }
}
async function screenTicket(id, mode) {
  return request('POST', '/v1/bots/' + id + '/screen-tickets', { mode })
}
async function capture(name) {
  const target = path.join(root, '.bot-fleet-local/screens/e2e-scout.png')
  mkdirSync(path.dirname(target), { recursive: true })
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', name, 'import', '-window', 'root', 'png:-'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const file = createWriteStream(target)
    let stderr = ''
    child.stdout.pipe(file)
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error('Screen capture: ' + stderr))))
  })
  return target
}
async function cleanup() {
  if (sseAbort) sseAbort.abort()
  await sseTask
  if (!dockerReady) return
  if (keep) {
    console.log('Kept Docker resources for project ' + project)
    return
  }
  for (const name of [...botNames, fakeName]) await docker(['rm', '-f', name], { allowFailure: true })
  for (const name of botNames) await docker(['volume', 'rm', name + '-home'], { allowFailure: true })
  if (composeEnv) await compose(['down', '-v', '--remove-orphans'], { allowFailure: true })
  await docker(['network', 'rm', network], { allowFailure: true })
}
async function main() {
  const available = await docker(['info', '--format', '{{.ServerVersion}}'], { allowFailure: true }).catch(() => ({
    code: 1,
  }))
  if (available.code !== 0) throw new Error('Docker is unavailable. Start Docker and rerun npm run test:e2e:bot-fleet.')
  dockerReady = true
  port = await freePort()
  base = 'http://127.0.0.1:' + port
  composeEnv = {
    ...process.env,
    MAESTRLY_GATEWAY_NETWORK: network,
    MAESTRLY_GATEWAY_PORT: String(port),
    MAESTRLY_GATEWAY_BIND: '127.0.0.1',
  }
  await compose(['up', '-d', '--no-build'])
  const meta = await poll('gateway /v1/meta', () => request('GET', '/v1/meta'), 30000)
  assert.equal(meta.protocol, 1)
  const missing = await fetch(base + '/v1/bots')
  assert.equal(missing.status, 426)
  await request('GET', '/v1/meta', undefined, { headers: { Origin: 'https://example.test' }, status: 403 })
  const pairOutput = (
    await compose(['exec', '-T', 'maestrly-bot-gateway', 'node', 'apps/bot-gateway/dist/main.js', 'pair'])
  ).stdout
  const code = /[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/.exec(pairOutput)?.[0]
  assert.ok(code, 'Pairing code absent from gateway CLI output')
  token = (await request('POST', '/v1/pair', { code: code.replace('-', ''), deviceName: 'Fleet E2E' })).token
  pass('gateway and pairing', 'protocol 1; missing header 426; Origin 403; paired device')
  await subscribe()
  pass('SSE subscription', 'hello event received')
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
    'E2E_DEV_ID=' + devId,
    '-v',
    fakeFile + ':/app/fake-model.mjs:ro',
    'node:22.22.0-bookworm-slim',
    'node',
    '/app/fake-model.mjs',
  ])
  const devCreated = Date.now()
  await request('POST', '/v1/bots', {
    name: 'E2E Dev ' + suffix,
    instructions: 'E2E development bot',
    ceiling: 'full',
    talksTo: [],
    idempotencyKey: randomUUID(),
  })
  const scoutCreated = Date.now()
  await request('POST', '/v1/bots', {
    name: 'E2E Scout ' + suffix,
    instructions: 'Follow the E2E model steps',
    ceiling: 'ask',
    talksTo: [devId],
    idempotencyKey: randomUUID(),
  })
  const dev = await poll('Dev running', async () => {
    const value = await bot(devId)
    return value.lifecycle === 'running' && value
  })
  timings.devCreateToRunningMs = Date.now() - devCreated
  const scout = await poll('Scout running', async () => {
    const value = await bot(scoutId)
    return value.lifecycle === 'running' && value
  })
  timings.scoutCreateToRunningMs = Date.now() - scoutCreated
  const version = JSON.parse(
    (await import('node:fs')).readFileSync(path.join(root, 'apps/desktop/package.json'))
  ).version
  for (const value of [dev, scout]) {
    assert.equal(value.status, 'setup')
    assert.equal(value.appVersion, version)
  }
  pass('two bot containers', 'running, setup, appVersion ' + version)
  const toolchainStarted = Date.now()
  const binaries =
    'node npm npx corepack pnpm python python3 pip uv uvx mise git ssh gcc make rg fd jq sqlite3 zip unzip'.split(' ')
  const plainShell = (
    await docker([
      'exec',
      botNames[1],
      '/bin/sh',
      '-c',
      `set -eu; for binary in ${binaries.join(' ')}; do command -v "$binary"; done; node -v; npm config get prefix; python3 -m venv /tmp/e2e-venv; /tmp/e2e-venv/bin/python -c 'print(42)'`,
    ])
  ).stdout
    .trim()
    .split('\n')
  assert.equal(plainShell.length, binaries.length + 3)
  for (const line of plainShell.slice(0, binaries.length)) assert.ok(line.startsWith('/'))
  const nodeVersion = plainShell[binaries.length]
  assert.match(nodeVersion, /^v22\./)
  assert.equal(plainShell[binaries.length + 1], '/home/bot/.local')
  assert.equal(plainShell[binaries.length + 2], '42')
  const loginShell = (
    await docker(['exec', botNames[1], 'bash', '-lc', 'command -v node uv mise; echo $NPM_CONFIG_PREFIX'])
  ).stdout
    .trim()
    .split('\n')
  assert.equal(loginShell.length, 4)
  for (const line of loginShell.slice(0, 3)) assert.ok(line.startsWith('/'))
  assert.equal(loginShell[3], '/home/bot/.local')
  timings.botToolchainMs = Date.now() - toolchainStarted
  pass(
    'bot toolchain',
    'node ' + nodeVersion + ', python venv, uv, mise, git and gcc on PATH in plain and login shells'
  )

  for (const vncPort of [5900, 5901]) {
    const attempt = await docker(
      ['exec', botNames[0], 'bash', '-c', `timeout 3 bash -c 'echo >/dev/tcp/${botNames[1]}/${vncPort}'`],
      { allowFailure: true }
    )
    assert.notEqual(attempt.code, 0, `Bot reached another bot's VNC port ${vncPort}`)
  }
  const gatewayFromBot = await docker([
    'exec',
    botNames[0],
    'curl',
    '-sS',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    'http://maestrly-bot-gateway:7443/v1/meta',
  ])
  assert.equal(gatewayFromBot.stdout.trim(), '403')
  pass('bot network isolation', 'cross-bot VNC ports refuse connections; gateway public API returns 403')
  for (const name of botNames) {
    const stat = await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', name])
    timings[name + 'StartupMemory'] = stat.stdout.trim()
  }
  await request('POST', '/v1/bots/' + scoutId + '/accounts/api-key', {
    kind: 'openai',
    name: 'E2E Model',
    key: modelKey,
    baseURL: 'http://' + fakeName + ':8787/v1',
  })
  await poll('Scout account connected', async () => (await bot(scoutId)).accounts.connected)
  const selection = await poll('fake model selection', async () => {
    const data = await request('GET', '/v1/bots/' + scoutId + '/selections')
    return data.options.find((option) => option.modelId === 'e2e-model')
  })
  await request('PATCH', '/v1/bots/' + scoutId, {
    selection: { providerId: selection.providerId, modelId: selection.modelId, reasoning: null, fastMode: false },
  })
  pass('model account and selection', selection.id)
  await poll('Scout needs compaction model', async () => {
    const state = await bot(scoutId)
    return (
      state.status === 'setup' &&
      state.activity?.kind === 'setup' &&
      state.activity.need === 'compaction' &&
      state.compactionState?.problem === 'missing'
    )
  })
  await request('PATCH', '/v1/bots/' + scoutId, {
    compaction: {
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoning: null,
      fastMode: false,
      intervalTokens: 100000,
    },
  })
  await poll('Scout compaction ready', async () => {
    const state = await bot(scoutId)
    return state.compactionState?.configured === true && state.status !== 'setup'
  })
  const conversationCall = (op, args = []) =>
    request('POST', '/v1/bots/' + scoutId + '/conversation/call', { op, args })
  const initialTools = (await conversationCall('chatGetConvTools')).result
  assert.equal(typeof initialTools.imageGen, 'boolean')
  const skillsState = (await conversationCall('chatSkillsState')).result
  assert.ok(Array.isArray(skillsState.skills))
  const commands = (await conversationCall('chatCommands')).result
  assert.ok(Array.isArray(commands.skills))
  await conversationCall('chatSetConvTools', [{ imageGen: false }])
  assert.equal((await conversationCall('chatGetConvTools')).result.imageGen, false)
  await conversationCall('chatSetConvTools', [{ imageGen: true }])
  assert.equal((await conversationCall('chatGetConvTools')).result.imageGen, true)
  pass(
    'conversation tools, skills, commands and image generation toggle',
    `${skillsState.skills.length} skills, ${commands.skills.length} skill commands, imageGen off/on round trip`
  )

  const turnStart = Date.now()
  await request('POST', '/v1/bots/' + scoutId + '/messages', { text: 'E2E-START', idempotencyKey: randomUUID() })
  await approve('computer_screenshot')
  const screenshot = await poll(
    'screenshot tool done',
    async () =>
      (await transcript(scoutId)).find(
        (item) => item.kind === 'tool' && item.name.endsWith('computer_screenshot') && item.state === 'done'
      ),
    90000
  )
  assert.match(screenshot.output ?? '', /1280\s*[×x]\s*800/)
  assert.ok(screenshot.images?.length, 'screenshot tool has an image ref')
  const screenshotBytes = await fleetImage(scoutId, screenshot.images[0].id)
  assert.equal(screenshotBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(screenshotBytes.readUInt32BE(16), 1280)
  assert.equal(screenshotBytes.readUInt32BE(20), 800)
  timings.firstToolMs = Date.now() - turnStart
  await approve('computer_click')
  await poll(
    'click moved pointer',
    async () => {
      const location = await mouse(botNames[1])
      return location.x === 640 && location.y === 400
    },
    90000
  )
  await approve('bot_peers_send')
  const peer = await poll(
    'peer message',
    async () =>
      (await request('GET', '/v1/peer-messages')).messages.find(
        (item) => item.from === scoutId && item.to === devId && item.text === 'hello from scout'
      ),
    90000
  )
  await poll('peer SSE event', () =>
    events.some((event) => event.type === 'peer.message' && event.message.id === peer.id)
  )
  await poll('Dev peer queue', async () =>
    (await transcript(devId)).some((item) => item.kind === 'user' && item.source === 'peer' && item.queued)
  )
  await approve('request_owner_help')
  await poll(
    'help inbox item',
    async () => (await inbox()).find((item) => item.botId === scoutId && item.interaction.kind === 'help'),
    90000
  )
  await poll(
    'first turn answer',
    async () =>
      (await transcript(scoutId)).some((item) => item.kind === 'assistant' && item.text.includes('E2E-START-DONE')),
    90000
  )
  timings.firstTurnMs = Date.now() - turnStart
  pass('model tool chain', 'screenshot 1280x800, approved click (640,400), peer delivered and queued, help pending')
  const viewTicket = await screenTicket(scoutId, 'view')
  const view = new Rfb('ws://127.0.0.1:' + port + viewTicket.path)
  await view.open()
  await view.handshake()
  const pixels = await view.pixels()
  assert.ok(pixels > 0)
  const before = await mouse(botNames[1])
  view.pointer(220, 180)
  await sleep(500)
  assert.deepEqual(await mouse(botNames[1]), before)
  const png = await capture(botNames[1])
  pass('view screen', 'RFB 3.8, ' + pixels + ' pixel bytes, pointer unchanged, PNG ' + png)
  await request('POST', '/v1/bots/' + scoutId + '/takeover')
  const controlTicket = await screenTicket(scoutId, 'control')
  const control = new Rfb('ws://127.0.0.1:' + port + controlTicket.path)
  await control.open()
  await control.handshake()
  control.pointer(100, 100)
  await poll(
    'control pointer',
    async () => {
      const location = await mouse(botNames[1])
      return location.x === 100 && location.y === 100
    },
    10000
  )
  await request('POST', '/v1/bots/' + scoutId + '/takeover/release', { note: 'E2E note', continue: true })
  assert.equal(await control.closeCode(), 4001)
  await poll(
    'takeover note',
    async () =>
      (await transcript(scoutId)).some(
        (item) => item.kind === 'system' && item.code === 'takeover' && item.text === 'E2E note'
      ),
    30000
  )
  await poll(
    'continuation answer',
    async () =>
      (await transcript(scoutId)).some((item) => item.kind === 'assistant' && item.text.includes('E2E-CONTINUED')),
    90000
  )
  const usage = await poll('bot usage after a turn', async () => (await bot(scoutId)).usage)
  assert.ok(usage.updatedAt)
  const smallPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
    'base64'
  )
  await request('POST', '/v1/bots/' + scoutId + '/messages', {
    text: 'E2E-IMAGE',
    idempotencyKey: randomUUID(),
    attachments: [{ name: 'e2e.png', mediaType: 'image/png', dataBase64: smallPng.toString('base64') }],
  })
  await poll(
    'image received by model',
    async () =>
      (await transcript(scoutId)).some((item) => item.kind === 'assistant' && item.text.includes('E2E-IMAGE-SEEN')),
    90000
  )
  const imageUser = (await transcript(scoutId)).find(
    (item) => item.kind === 'user' && item.text === 'E2E-IMAGE' && !item.queued
  )
  assert.ok(imageUser?.images?.length, 'owner image has a transcript ref')
  assert.deepEqual(await fleetImage(scoutId, imageUser.images[0].id), smallPng)
  pass('conversation images and usage', 'owner PNG reached the model, image refs download, usage is present')
  const provisioningStarted = Date.now()
  const provisioningRoute = '/v1/bots/' + scoutId
  assert.ok((await request('GET', '/v1/meta')).features.includes('provisioning'))
  await poll('Scout provisioning capability', async () => (await bot(scoutId)).capabilities.includes('provisioning'))
  const replay = await request('POST', provisioningRoute + '/accounts/import', {
    items: [
      { type: 'api-key', kind: 'openai', name: 'E2E Model', key: modelKey, baseURL: 'http://' + fakeName + ':8787/v1' },
    ],
  })
  assert.equal(replay.results.length, 1)
  assert.equal(replay.results[0].outcome, 'unchanged')
  const skill = {
    name: 'e2e-toolkit',
    files: [
      {
        path: 'SKILL.md',
        executable: false,
        data: Buffer.from(
          '---\nname: e2e-toolkit\ndescription: E2E toolkit that ships an MCP echo server.\n---\n# E2E toolkit\nUse the echo tool to check the MCP connection.\n'
        ).toString('base64'),
      },
      {
        path: 'scripts/mcp-echo.mjs',
        executable: true,
        data: readFileSync(path.join(root, 'deploy/bot-fleet/test/mcp-echo.mjs')).toString('base64'),
      },
    ],
  }
  assert.equal((await request('POST', provisioningRoute + '/skills', skill)).outcome, 'added')
  assert.equal((await request('POST', provisioningRoute + '/skills', skill)).outcome, 'unchanged')
  const imported = await request('POST', provisioningRoute + '/mcp-servers/import', {
    servers: [
      {
        name: 'e2e-echo',
        transport: 'stdio',
        enabled: true,
        command: 'node',
        args: ['/home/bot/.agents/skills/e2e-toolkit/scripts/mcp-echo.mjs'],
      },
    ],
  })
  assert.equal(imported.results.length, 1)
  assert.equal(imported.results[0].outcome, 'added')
  const installedSkill = (await request('GET', provisioningRoute + '/skills')).skills.find(
    (item) => item.name === skill.name
  )
  assert.equal(installedSkill?.source, 'fleet')
  assert.equal(installedSkill?.files, 2)
  const server = (await request('GET', provisioningRoute + '/mcp-servers')).servers.find(
    (item) => item.name === 'e2e-echo'
  )
  assert.equal(server?.id, imported.results[0].target)
  assert.equal(server?.unavailable, false)
  const configured = (await request('GET', '/v1/activity')).entries
  assert.ok(
    configured.some(
      (entry) => entry.botId === scoutId && entry.kind === 'bot_configured' && entry.summary === 'Fleet E2E'
    )
  )
  assert.ok(!JSON.stringify(configured).includes(modelKey), 'Activity must not contain the model key')
  await request('POST', provisioningRoute + '/messages', { text: 'E2E-PROVISION', idempotencyKey: randomUUID() })
  await poll(
    'provisioning model answer',
    async () => {
      const permission = (await inbox()).find(
        (item) => item.botId === scoutId && item.interaction.kind === 'permission'
      )
      if (permission) await approve(permission.interaction.title)
      return (await transcript(scoutId)).some(
        (item) => item.kind === 'assistant' && item.text.includes('E2E-PROVISION-OK')
      )
    },
    90000
  )
  assert.ok(
    (await transcript(scoutId)).some(
      (item) =>
        item.kind === 'tool' &&
        (item.name.endsWith('__echo') || item.name === 'mcp_call') &&
        item.state === 'done' &&
        item.output?.includes('E2E-ECHO:ping')
    )
  )
  await request('DELETE', provisioningRoute + '/mcp-servers/' + server.id, undefined, { status: 204 })
  await request('DELETE', provisioningRoute + '/skills/' + skill.name, undefined, { status: 204 })
  assert.ok(!(await request('GET', provisioningRoute + '/mcp-servers')).servers.some((item) => item.id === server.id))
  assert.ok(!(await request('GET', provisioningRoute + '/skills')).skills.some((item) => item.name === skill.name))
  await request('POST', provisioningRoute + '/logins', { kind: 'grok', method: 'browser' }, { status: 400 })
  await request('GET', provisioningRoute + '/logins/unknown', undefined, { status: 404 })
  timings.provisioningMs = Date.now() - provisioningStarted
  pass('provisioning from the Mac', 'account replay unchanged; skill and MCP server reached the model; removed again')

  const sendMemoryMessage = (text) =>
    request('POST', '/v1/bots/' + scoutId + '/messages', { text, idempotencyKey: randomUUID() })
  const memoryAnswer = (answer) =>
    poll(
      answer,
      async () => {
        assert.ok(
          !(await inbox()).some((item) => item.botId === scoutId && item.interaction.kind === 'permission'),
          'Memory tools must not request permission'
        )
        return (await transcript(scoutId)).some((item) => item.kind === 'assistant' && item.text.includes(answer))
      },
      90000
    )
  const ownerMemoryStarted = Date.now()
  await sendMemoryMessage('E2E-OWNER-MEMORY')
  await memoryAnswer('E2E-OWNER-SAVED')
  const ownerMemory = await request('GET', '/v1/owner-memory')
  assert.equal(ownerMemory.entries.length, 1)
  assert.equal(ownerMemory.entries[0].content, 'Prefers answers in haiku.')
  assert.equal(ownerMemory.entries[0].author.kind, 'bot')
  assert.equal(ownerMemory.entries[0].author.botId, scoutId)
  assert.equal(ownerMemory.entries[0].origin, 'owner')
  await sendMemoryMessage('E2E-OWNER-CHECK')
  await memoryAnswer('E2E-OWNER-SEEN')
  timings.ownerMemoryMs = Date.now() - ownerMemoryStarted
  pass('owner memory', 'bot wrote it, gateway stored it, next turn saw it')

  const botMemoryStarted = Date.now()
  await sendMemoryMessage('E2E-BOT-MEMORY')
  await memoryAnswer('E2E-BOT-SAVED')
  const memories = (await request('GET', '/v1/bots/' + scoutId + '/memories')).memories
  assert.ok(memories.some((item) => item.title === 'E2E launch code'))
  const recallQuestion = 'what is the launch code for the e2e check?'
  await sendMemoryMessage(recallQuestion)
  await memoryAnswer('E2E-RECALL-BLUEBIRD')
  const recalledUser = (await transcript(scoutId)).find(
    (item) => item.kind === 'user' && item.text === recallQuestion && !item.queued
  )
  assert.equal(recalledUser?.memories?.[0]?.title, 'E2E launch code')
  timings.botMemoryRecallMs = Date.now() - botMemoryStarted
  pass('bot memory and recall', 'bot saved it, gateway listed it, model recalled BLUEBIRD with transcript provenance')

  assert.deepEqual((await conversationCall('chatCompact')).result, { ok: true })
  await poll(
    'manual compaction transcript',
    async () =>
      (await transcript(scoutId)).some(
        (item) => item.kind === 'compaction' && item.origin === 'manual' && item.summary?.includes('E2E-SUMMARY')
      ),
    90000
  )
  pass('manual compaction', 'summary used the configured compaction model')
  assert.ok(!(await inbox()).some((item) => item.botId === scoutId && item.interaction.kind === 'help'))
  view.close()
  pass('takeover and continuation', 'control pointer (100,100), close 4001, note and E2E-CONTINUED')
  await request('POST', '/v1/bots/' + scoutId + '/pause')
  await poll('paused', async () => (await bot(scoutId)).status === 'paused')
  const queued = await request('POST', '/v1/bots/' + scoutId + '/messages', {
    text: 'E2E pause queue',
    idempotencyKey: randomUUID(),
  })
  assert.equal(queued.queued, true)
  await request('POST', '/v1/bots/' + scoutId + '/resume')
  await poll('resumed', async () => (await bot(scoutId)).status !== 'paused')
  pass('pause and resume', 'message queued while paused, bot resumed')
  await poll('Scout idle between turns', async () => (await bot(scoutId)).status === 'idle', 90000)
  for (const name of botNames) {
    const stat = await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', name])
    timings[name + 'IdleMemory'] = stat.stdout.trim()
  }
  const due = new Date(Date.now() + 65000)
  const hhmm = due.toISOString().slice(11, 16)
  const routine = await request('POST', '/v1/bots/' + scoutId + '/routines', {
    title: 'E2E routine',
    prompt: 'E2E routine ping',
    schedule: { kind: 'weekly', time: hhmm, days: [], timezone: 'UTC' },
    enabled: true,
    idempotencyKey: randomUUID(),
  })
  await poll(
    'routine answer',
    async () =>
      (await transcript(scoutId)).some((item) => item.kind === 'assistant' && item.text.includes('E2E-ROUTINE-DONE')),
    100000
  )
  assert.ok((await transcript(scoutId)).some((item) => item.kind === 'user' && item.source === 'routine'))
  assert.ok(
    (await request('GET', '/v1/activity')).entries.some((item) => item.kind === 'routine_ran' && item.botId === scoutId)
  )
  pass('scheduled routine', routine.id + ' at ' + hhmm + ' UTC, routine_ran and answer')
  const routineHistoryStarted = Date.now()
  const runsRoute = '/v1/bots/' + scoutId + '/routines/' + routine.id + '/runs'
  const recordedRun = await poll('completed routine report', async () =>
    (await request('GET', runsRoute)).runs.find(
      (run) => run.status === 'completed' && run.report?.summary === 'E2E-RUN-1 done'
    )
  )
  assert.equal(recordedRun.report.notes, 'check the second shelf')
  await request('POST', '/v1/bots/' + scoutId + '/routines/' + routine.id + '/run')
  await memoryAnswer('E2E-ROUTINE-HISTORY-SEEN')
  timings.routineHistoryMs = Date.now() - routineHistoryStarted
  pass('routine history', 'report recorded and delivered to the next run')
  const creationStarted = Date.now()
  await request('POST', '/v1/bots/' + scoutId + '/messages', {
    text: 'E2E-ROUTINE-CREATE',
    idempotencyKey: randomUUID(),
  })
  await approve('bot_routines_create')
  await poll(
    'bot routine creation answer',
    async () =>
      (await transcript(scoutId)).some(
        (item) => item.kind === 'assistant' && item.text.includes('E2E-ROUTINE-CREATED')
      ),
    90000
  )
  const botRoutine = (await request('GET', '/v1/bots/' + scoutId + '/routines')).routines.find(
    (item) => item.title === 'E2E bot routine'
  )
  assert.ok(botRoutine)
  assert.equal(botRoutine.createdBy, 'bot')
  assert.deepEqual(botRoutine.schedule, { kind: 'interval', everyMinutes: 15 })
  assert.ok(Date.parse(botRoutine.nextRunAt) >= creationStarted + 14 * 60000)
  assert.ok(Date.parse(botRoutine.nextRunAt) <= Date.now() + 16 * 60000)
  assert.ok(
    (await request('GET', '/v1/activity?limit=500')).entries.some(
      (item) => item.kind === 'routine_created' && item.botId === scoutId && item.data.routineId === botRoutine.id
    )
  )
  await request('DELETE', '/v1/bots/' + scoutId + '/routines/' + botRoutine.id, undefined, { status: 204 })
  pass('bot-created routine', botRoutine.id + ' interval and activity; owner deleted it')
  await request('POST', '/v1/bots/' + devId + '/restart')
  await poll('Dev restarted', async () => (await bot(devId)).lifecycle === 'running', 120000)
  assert.ok((await transcript(devId)).some((item) => item.kind === 'user' && item.source === 'peer' && item.queued))
  await request('POST', '/v1/bots/' + devId + '/archive')
  await poll(
    'Dev container removed',
    async () => (await docker(['inspect', botNames[0]], { allowFailure: true })).code !== 0
  )
  assert.equal((await docker(['volume', 'inspect', botNames[0] + '-home'], { allowFailure: true })).code, 0)
  assert.deepEqual((await bot(scoutId)).talksTo, [])
  pass('restart and archive', 'peer queue persisted; container removed, home volume retained')

  assert.deepEqual(
    (await request('GET', '/v1/archived-bots')).bots.map((item) => [item.id, item.files]),
    [[devId, 'kept']]
  )
  assert.equal((await request('POST', '/v1/archived-bots/' + devId + '/restore')).lifecycle, 'creating')
  await poll('Dev restored', async () => (await bot(devId)).lifecycle === 'running', 180000)
  // Same home volume: the conversation from before the archive is still there, and Scout is its peer again.
  assert.ok((await transcript(devId)).some((item) => item.kind === 'user' && item.source === 'peer'))
  assert.deepEqual((await bot(devId)).talksTo, [scoutId])
  assert.deepEqual((await bot(scoutId)).talksTo, [devId])
  assert.deepEqual((await request('GET', '/v1/archived-bots')).bots, [])
  await request('POST', '/v1/bots/' + devId + '/archive')
  await poll(
    'Dev container removed again',
    async () => (await docker(['inspect', botNames[0]], { allowFailure: true })).code !== 0
  )
  await request('DELETE', '/v1/archived-bots/' + devId, undefined, { status: 204 })
  assert.notEqual((await docker(['volume', 'inspect', botNames[0] + '-home'], { allowFailure: true })).code, 0)
  assert.deepEqual((await request('GET', '/v1/archived-bots')).bots, [])
  await request('GET', '/v1/bots/' + devId, undefined, { status: 404 })
  const activity = (await request('GET', '/v1/activity?limit=500')).entries
  assert.ok(activity.every((item) => item.botId !== devId))
  const deletedEntry = activity.find((item) => item.kind === 'bot_deleted')
  assert.deepEqual([deletedEntry?.botId, deletedEntry?.summary], [null, 'E2E Dev ' + suffix])
  pass('restore and delete forever', 'conversation and peer back after restore; volume and records gone after delete')
  for (const name of botNames) {
    const stat = await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', name], { allowFailure: true })
    if (stat.code === 0) timings[name + 'Memory'] = stat.stdout.trim()
  }
  const imageSizes = await Promise.all(
    ['maestrly/bot-gateway:local', 'maestrly/bot-instance:local'].map(async (image) => [
      image,
      (await docker(['image', 'inspect', image, '--format', '{{.Size}}'])).stdout.trim(),
    ])
  )
  console.log(
    JSON.stringify(
      { result: 'PASS', project, durationMs: Date.now() - started, timings, imageSizes, steps: results },
      null,
      2
    )
  )
}
try {
  await main()
} catch (error) {
  console.error('FAIL: ' + (error.stack ?? error))
  if (composeEnv) {
    for (const name of botNames) {
      const logs = await docker(['logs', '--tail', '80', name], { allowFailure: true })
      if (logs.code === 0) console.error(name + ' logs:\n' + logs.stderr.slice(-7000))
    }
    const logs = await compose(['logs', '--tail', '80'], { allowFailure: true })
    console.error('gateway logs:\n' + (logs.stdout + logs.stderr).slice(-7000))
  }
  process.exitCode = 1
} finally {
  await cleanup()
}
