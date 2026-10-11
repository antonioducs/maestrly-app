#!/usr/bin/env node
// A workspaces environment on the real images: the gateway creates it beside no bot, mounts the server's workspaces
// folder into it, and bridges a paired computer to the Maestrly that runs there. The computer's side is played here
// the way the desktop app plays it: a bridge ticket, the bridge WebSocket, and the app's own IPC channels over it.
//
// It runs in a Compose project and containers of its own, removed at the end (kept with --keep), and saves no state.
// Images: MAESTRLY_GATEWAY_IMAGE and MAESTRLY_GATEWAY_BOT_IMAGE as Compose reads them, or the `:local` ones.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync, zstdDecompressSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const composeFile = path.join(root, 'deploy/bot-fleet/compose.yml')
const fakeFile = path.join(root, 'deploy/bot-fleet/test/fake-model.mjs')
const appVersion = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')).version
const keep = process.argv.slice(2).includes('--keep')
if (process.argv.slice(2).some((arg) => arg !== '--keep'))
  throw new Error('Usage: node scripts/test-bot-fleet-workspaces.mjs [--keep]')
const suffix = randomUUID().slice(0, 8)
const project = 'fleet-ws-e2e-' + suffix
const network = project + '-bots'
const fakeName = project + '-model'
const modelKey = 'e2e-model-key'
// The environment's id comes from its name, and its container and volume from its id.
const environmentName = 'E2E Workspaces ' + suffix
const environmentId = 'e2e-workspaces-' + suffix
const container = 'maestrly-env-' + environmentId
const started = Date.now()
let stepStarted = started
const results = []
let composeEnv
let base
let token
let workspacesRoot
let dockerReady = false
let bridge

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
/** The promise's result, or a failure once it took too long; its timer never outlives it. */
function within(promise, ms, message) {
  let timer
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

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
    signal: AbortSignal.timeout(30000),
  })
  const value = response.status === 204 ? null : await response.json()
  if (options.status !== undefined) assert.equal(response.status, options.status, JSON.stringify(value))
  else if (!response.ok)
    throw new Error(method + ' ' + route + ' HTTP ' + response.status + ': ' + JSON.stringify(value))
  return value
}

/** A request whose body or answer is raw bytes: the answer itself, whatever its status. */
function raw(method, route, { headers = {}, body, timeout = 120000 } = {}) {
  return fetch(base + route, {
    method,
    headers: { 'X-Maestrly-Fleet-Protocol': '1', Authorization: 'Bearer ' + token, ...headers },
    ...(body === undefined ? {} : { body }),
    ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}),
  })
}
const json = (value) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const MiB = 1024 * 1024

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

const environment = async () =>
  (await request('GET', '/v1/environments')).environments.find((item) => item.id === environmentId)

/**
 * The bridge as a computer's main process holds it: JSON frames over the WebSocket the gateway passes through. Values
 * here are plain JSON; the app's codec also carries binary and `undefined`, which this test does not send.
 */
async function openBridge(version = appVersion) {
  const ticket = await request('POST', `/v1/environments/${environmentId}/bridge-tickets`, {}, { status: 201 })
  assert.match(ticket.path, /^\/v1\/bridge\?ticket=[A-Za-z0-9_-]+$/)
  const socket = new WebSocket(base.replace('http', 'ws') + ticket.path)
  const waiting = new Map()
  const listeners = new Set()
  let nextId = 1
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('error', () => reject(new Error('The bridge WebSocket failed')))
    socket.addEventListener('close', (event) => reject(new Error('The bridge closed: ' + event.code)))
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({
          t: 'hello',
          protocol: 1,
          appVersion: version,
          client: { deviceName: 'Workspaces E2E', os: 'linux', locale: 'en' },
        })
      )
    )
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data)
      if (frame.t === 'welcome' || frame.t === 'refused') return resolve(frame)
      if (frame.t === 'ping') return socket.send(JSON.stringify({ t: 'pong', n: frame.n }))
      if (frame.t === 'result') {
        const entry = waiting.get(frame.id)
        waiting.delete(frame.id)
        if (frame.ok) entry?.resolve(frame.value)
        else entry?.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }))
      }
      if (frame.t === 'event') for (const listener of listeners) listener(frame)
    })
  })
  const first = await opened
  const invokeAs = (origin, channel, ...args) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      socket.send(JSON.stringify({ t: 'invoke', id, origin, channel, args }))
      setTimeout(() => waiting.delete(id) && reject(new Error('No answer to ' + channel)), 60000).unref()
    })
  const sendAs = (origin, channel, ...args) => socket.send(JSON.stringify({ t: 'send', origin, channel, args }))
  return {
    first,
    ticket,
    socket,
    open: (origin, role) => socket.send(JSON.stringify({ t: 'open', origin, ...role })),
    // Origin 1 is the window's main renderer; another origin stands for a second window of the same computer.
    invoke: (channel, ...args) => invokeAs(1, channel, ...args),
    invokeAs,
    send: (channel, ...args) => sendAs(1, channel, ...args),
    sendAs,
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => socket.close(),
  }
}

/**
 * The size of an 8-bit RGB or RGBA PNG and how many different colors it has, up to a few: enough to tell a picture of
 * a page from a blank or black frame, which is what a view nobody paints would give.
 */
function pngColors(png) {
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', 'Not a PNG')
  let width = 0
  let height = 0
  let channels = 0
  const data = []
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('latin1')
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      assert.equal(body[8], 8, 'Unexpected PNG bit depth')
      assert.ok(body[9] === 2 || body[9] === 6, 'Unexpected PNG color type ' + body[9])
      assert.equal(body[12], 0, 'Interlaced PNG')
      channels = body[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') data.push(body)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const colors = new Set()
  let previous = Buffer.alloc(stride)
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]
    const line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)))
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? line[index - channels] : 0
      const up = previous[index]
      const upLeft = index >= channels ? previous[index - channels] : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - upLeft
        const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)]
        predicted = a <= b && a <= c ? left : b <= c ? up : upLeft
      }
      line[index] = (line[index] + predicted) & 0xff
    }
    for (let x = 0; x < width && colors.size < 16; x++) colors.add(line.readUIntBE(x * channels, 3))
    previous = line
  }
  return { width, height, colors: colors.size }
}

/** The pixel size of a baseline or progressive JPEG, from its start-of-frame segment. */
function jpegSize(jpeg) {
  for (let offset = 2; offset + 9 < jpeg.length; ) {
    if (jpeg[offset] !== 0xff) throw new Error('Not a JPEG segment at ' + offset)
    const marker = jpeg[offset + 1]
    const length = jpeg.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { width: jpeg.readUInt16BE(offset + 7), height: jpeg.readUInt16BE(offset + 5) }
    }
    offset += 2 + length
  }
  throw new Error('The JPEG has no frame header')
}

async function cleanup() {
  bridge?.close()
  if (!dockerReady) return
  if (keep) {
    console.log('Kept Docker resources for project ' + project + ' and ' + workspacesRoot)
    return
  }
  // The gateway stops first so that it creates nothing more; every resource of this run carries its suffix.
  if (composeEnv) await compose(['stop'], { allowFailure: true })
  for (const name of [container, fakeName]) await docker(['rm', '-f', name], { allowFailure: true })
  await docker(['volume', 'rm', container + '-home'], { allowFailure: true })
  if (composeEnv) await compose(['down', '-v', '--remove-orphans'], { allowFailure: true })
  await docker(['network', 'rm', network], { allowFailure: true })
  if (workspacesRoot) rmSync(workspacesRoot, { recursive: true, force: true })
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
  // A folder of the Docker host, mounted into the environment at the same path. The environment writes to it as its
  // own user (uid 1000), which does not own a folder this test just made: only here is it opened to everyone.
  workspacesRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maestrly-ws-e2e-')))
  chmodSync(workspacesRoot, 0o777)
  const port = await freePort()
  base = 'http://127.0.0.1:' + port
  composeEnv = {
    ...process.env,
    MAESTRLY_GATEWAY_NETWORK: network,
    MAESTRLY_GATEWAY_PORT: String(port),
    MAESTRLY_GATEWAY_BIND: '127.0.0.1',
    MAESTRLY_GATEWAY_BOT_EGRESS: 'public',
    MAESTRLY_GATEWAY_WORKSPACES_ROOT: workspacesRoot,
  }
  await compose(['up', '-d', '--no-build'])
  const meta = await poll('gateway /v1/meta', () => request('GET', '/v1/meta'), 30000)
  assert.ok(meta.features.includes('workspaces-host'), 'The gateway does not host workspaces: ' + meta.features)
  const pairOutput = (
    await compose(['exec', '-T', 'maestrly-bot-gateway', 'node', 'apps/bot-gateway/dist/main.js', 'pair'])
  ).stdout
  const code = /[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/.exec(pairOutput)?.[0]
  assert.ok(code, 'Pairing code absent from gateway CLI output')
  token = (await request('POST', '/v1/pair', { code: code.replace('-', ''), deviceName: 'Workspaces E2E' })).token
  pass('gateway and pairing', 'features include workspaces-host; paired device')

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

  // The environment: Maestrly in server mode, no bot, the server's folder mounted at its own path.
  const created = await request(
    'POST',
    '/v1/environments',
    { name: environmentName, kind: 'workspaces', idempotencyKey: randomUUID() },
    { status: 201 }
  )
  assert.equal(created.id, environmentId)
  assert.equal(created.kind, 'workspaces')
  const running = await poll('workspaces environment running', async () => {
    const value = await environment()
    if (value?.lifecycle === 'failed') throw new Error('It failed to start: ' + JSON.stringify(value.setup))
    return value?.lifecycle === 'running' && value
  })
  assert.deepEqual(running.botIds, [])
  // Only the app in server mode reports this: as a bot (had the entrypoint set bot mode) it would not.
  assert.ok(running.capabilities.includes('workspaces-host'), 'capabilities: ' + running.capabilities)
  assert.equal(running.appVersion, appVersion)
  const inspected = JSON.parse((await docker(['inspect', container])).stdout)[0]
  assert.ok(inspected.Config.Env.includes('MAESTRLY_SERVER_MODE=1'))
  assert.ok(inspected.Config.Env.includes('MAESTRLY_WORKSPACES_ROOT=' + workspacesRoot))
  assert.ok(!inspected.Config.Env.some((entry) => entry.startsWith('MAESTRLY_BOT_MODE=')))
  assert.deepEqual(
    inspected.Mounts.filter((mount) => mount.Type === 'bind').map((mount) => [mount.Source, mount.Destination]),
    [[workspacesRoot, workspacesRoot]]
  )
  // The app itself runs in server mode and not as a bot: the entrypoint left bot mode unset.
  pass('workspaces environment', `${container} runs ${appVersion} in server mode with ${workspacesRoot} mounted`)

  await request(
    'POST',
    '/v1/environments',
    { name: 'E2E Second ' + suffix, kind: 'workspaces', idempotencyKey: randomUUID() },
    { status: 409 }
  )
  const refusedBot = await request(
    'POST',
    '/v1/bots',
    {
      name: 'E2E Intruder ' + suffix,
      instructions: '',
      ceiling: 'ask',
      talksTo: [],
      environmentId,
      idempotencyKey: randomUUID(),
    },
    { status: 409 }
  )
  assert.equal(refusedBot.message, 'Workspaces environments hold no bots.')
  assert.deepEqual((await request('GET', '/v1/bots')).bots, [])
  pass('one workspaces environment, no bots', 'a second one and a bot in it are both refused with 409')

  // Accounts reach the host the way they reach a bots environment: through the gateway.
  await request('POST', `/v1/environments/${environmentId}/accounts/api-key`, {
    kind: 'openai',
    name: 'E2E Model',
    key: modelKey,
    baseURL: 'http://' + fakeName + ':8787/v1',
  })
  const accounts = await request('GET', `/v1/environments/${environmentId}/accounts`)
  assert.deepEqual(
    accounts.apiKeys.map((item) => item.name),
    ['E2E Model']
  )
  assert.ok(!JSON.stringify(accounts).includes(modelKey), 'The account list carries the key')
  pass('host account through the gateway', 'API key account listed without its key')

  // The bridge: a ticket of the gateway, then the app's own frames with the host.
  const refused = await openBridge('0.0.0-other')
  assert.deepEqual(refused.first, { t: 'refused', reason: 'version', hostVersion: appVersion })
  refused.close()
  // A ticket is spent by its first upgrade, whatever came of it.
  const again = new WebSocket(base.replace('http', 'ws') + refused.ticket.path)
  const reused = await new Promise((resolve) => {
    again.addEventListener('open', () => resolve('open'))
    again.addEventListener('error', () => resolve('refused'))
    again.addEventListener('close', () => resolve('refused'))
  })
  again.close()
  assert.equal(reused, 'refused', 'A ticket opened a second bridge')
  bridge = await openBridge()
  assert.equal(bridge.first.t, 'welcome')
  assert.equal(bridge.first.appVersion, appVersion)
  assert.deepEqual(
    { ...bridge.first.host, hostName: '' },
    {
      os: 'linux',
      hostName: '',
      homeDir: '/home/bot',
      roots: ['/home/bot', workspacesRoot],
      desktopEffects: false,
      editor: true,
      browser: true,
    }
  )
  bridge.open(1, { role: 'main' })
  assert.deepEqual(await bridge.invoke('conversation:list-standalone', true), [])
  await assert.rejects(bridge.invoke('workspace:pick'), { code: 'remote-unsupported' })
  await assert.rejects(bridge.invoke('fleet:getSnapshot'), { code: 'remote-unsupported' })
  pass(
    'bridge through the gateway',
    'another version refused; a ticket opens one bridge; desktop and local channels refused'
  )

  // A folder of the server becomes a workspace: created through the host, visible on the Docker host.
  const roots = await bridge.invoke('host-fs:roots')
  assert.deepEqual(roots, [
    { path: '/home/bot', label: 'home' },
    { path: workspacesRoot, label: 'workspaces' },
  ])
  const setup = await bridge.invoke('project-setup:start', {
    operationId: randomUUID(),
    kind: 'create',
    parentPath: workspacesRoot,
    name: 'e2e-project',
  })
  assert.equal(setup.status, 'success', JSON.stringify(setup))
  const projectPath = path.join(workspacesRoot, 'e2e-project')
  assert.equal(setup.workspace.path, projectPath)
  assert.ok(existsSync(path.join(projectPath, '.git')), 'The project is not on the Docker host')
  const listing = await bridge.invoke('host-fs:list', workspacesRoot, {})
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.kind]),
    [['e2e-project', 'directory']]
  )
  await assert.rejects(bridge.invoke('host-fs:list', '/etc', {}), /outside the folders/)
  const workspaces = await bridge.invoke('workspace:list', true)
  assert.deepEqual(
    workspaces.map((item) => item.path),
    [projectPath]
  )
  pass(
    'workspace under the mounted folder',
    projectPath + ' created by the host, owner uid ' + statSync(projectPath).uid
  )

  // A chat turn on the host, whose model drives the host's own browser.
  const chat = await bridge.invoke('conversation:create-standalone', {})
  const provider = (await bridge.invoke('chat:config')).providers.find((item) => item.name === 'E2E Model')
  assert.ok(provider, 'The account added through the gateway is not a provider of the host')
  assert.deepEqual(
    await bridge.invoke('chat:set-selection', chat.id, { providerId: provider.id, modelId: 'e2e-model' }),
    {
      ok: true,
    }
  )
  // The app's own tools (its browser among them) are a setting of the profile, off until the person turns it on.
  assert.deepEqual(await bridge.invoke('chat:set-app-tools', true), { ok: true })
  assert.deepEqual(await bridge.invoke('chat:set-mode', chat.id, 'agent'), { ok: true })
  assert.deepEqual(await bridge.invoke('chat:set-perm-mode', chat.id, 'full'), { ok: true })
  const kinds = []
  const finished = new Promise((resolve) => {
    bridge.onEvent((frame) => {
      if (frame.channel !== 'chat:delta:' + chat.id) return
      const kind = frame.args[0]?.kind
      kinds.push(kind)
      if (kind === 'done' || kind === 'finish' || kind === 'error') resolve(kind)
    })
  })
  bridge.send('chat:subscribe', chat.id)
  const sent = await bridge.invoke('chat:send', {
    conversationId: chat.id,
    text: `E2E-HOST-BROWSER url=http://${fakeName}:8787/e2e/cookie/show`,
  })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  // The gateway sees the host as busy while the turn runs, which holds a scheduled update back.
  await within(finished, 180000, 'The turn did not finish')
  const history = JSON.stringify(await bridge.invoke('chat:history:page', chat.id))
  if (!history.includes('E2E-HOST-BROWSER-OK')) {
    const state = await bridge.invoke('drawer:browser-state-get', chat.id).catch((error) => String(error))
    assert.fail('The host browser turn failed: ' + history.slice(-1500) + '\nbrowser: ' + JSON.stringify(state))
  }
  for (const tool of ['browser_navigate', 'browser_read_text', 'browser_screenshot'])
    assert.ok(history.includes(tool), 'The turn did not call ' + tool)
  assert.ok(kinds.length > 0, 'No chat event reached the bridge')
  // The picture is of the page: the host's browser paints although nobody looks at the host's window.
  const answer = (await bridge.invoke('chat:history:page', chat.id)).messages.at(-1)
  const shot = answer.parts.find((part) => part.type === 'tool' && part.toolName === 'browser_screenshot')
  const [image] = shot.state.output.images
  const picture = await bridge.invoke('chat:tool-image', {
    conversationId: chat.id,
    messageId: answer.id,
    toolPartId: shot.id,
    imageId: image.id,
  })
  assert.equal(picture.ok, true, JSON.stringify(picture).slice(0, 200))
  // Binary values cross the bridge as tagged base64.
  assert.equal(picture.bytes.$bin, 'u8')
  const seen = pngColors(Buffer.from(picture.bytes.b64, 'base64'))
  assert.ok(seen.width >= 400 && seen.height >= 300, 'The screenshot is ' + seen.width + 'x' + seen.height)
  assert.ok(seen.colors >= 2, 'The screenshot is one flat color: the page was not painted')
  pass(
    'chat turn with the host browser',
    `navigate, read and screenshot ran on the host; ${seen.width}x${seen.height} picture of the page; ${kinds.length} events`
  )

  // The conversation's browser, streamed to this computer the way its window shows it: JPEG frames acknowledged one by
  // one, input, a resize, a list, a file field, the agent's own screenshot meanwhile, another window taking it over,
  // and its end.
  const STREAM_CHANNELS = new Set([
    'drawer:browser-frame',
    'drawer:browser-stream-source',
    'drawer:browser-stream-ended',
    'drawer:browser-cursor',
    'drawer:browser-select',
    'drawer:browser-stream-notice',
  ])
  const streamed = []
  bridge.onEvent((frame) => {
    if (!STREAM_CHANNELS.has(frame.channel)) return
    const payload = frame.args[0]
    streamed.push({ origin: frame.origin, channel: frame.channel, payload, at: Date.now() })
    // The window acknowledges every frame once it drew it; the host sends the next ones only then.
    if (frame.channel === 'drawer:browser-frame')
      bridge.sendAs(frame.origin, 'drawer:browser-stream-ack', payload.convId, payload.streamId, payload.seq)
  })
  const soon = async (label, fn, timeout = 30000) => {
    const until = Date.now() + timeout
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() > until) throw new Error('Timed out waiting for ' + label)
      await sleep(100)
    }
  }
  const streamedFind = (predicate) => streamed.find(predicate)
  const framesOf = (streamId) =>
    streamed.filter((item) => item.channel === 'drawer:browser-frame' && item.payload.streamId === streamId)
  const activeTitle = async () => {
    const state = await bridge.invoke('drawer:browser-state-get', chat.id)
    return state.tabs.find((tab) => tab.id === state.activeId)?.title
  }
  const input = (origin, streamId, value) => bridge.sendAs(origin, 'drawer:browser-input', chat.id, streamId, value)
  const click = (origin, streamId, x, y) => {
    for (const action of ['down', 'up'])
      input(origin, streamId, {
        type: 'mouse',
        action,
        x,
        y,
        button: 'left',
        buttons: action === 'down' ? 1 : 0,
        clickCount: 1,
        modifiers: 0,
      })
  }

  const { streamId } = await bridge.invoke('drawer:browser-stream-start', chat.id, 900, 640)
  assert.match(streamId, /^[A-Za-z0-9_-]{16,64}$/)
  const source = await soon('the stream source', () =>
    streamedFind((item) => item.channel === 'drawer:browser-stream-source' && item.payload.streamId === streamId)
  )
  assert.deepEqual(source.payload, { convId: chat.id, streamId, source: 1, kind: 'tab', popup: null })
  const firstFrame = await soon('a frame at the size of the surface', () =>
    framesOf(streamId).find((item) => item.payload.width === 900 && item.payload.height === 640)
  )
  const firstJpeg = Buffer.from(firstFrame.payload.data, 'base64')
  assert.equal(firstJpeg.readUInt16BE(0), 0xffd8, 'The frame is not a JPEG')
  assert.deepEqual(jpegSize(firstJpeg), { width: 900, height: 640 })

  bridge.send('drawer:navigate', chat.id, `http://${fakeName}:8787/e2e/stream`)
  await soon('the stream page', async () => (await activeTitle()) === 'E2E stream')
  input(1, streamId, { type: 'focus', focused: true })
  click(1, streamId, 100, 20)
  input(1, streamId, { type: 'text', text: 'ação' })
  await soon('the typed title', async () => (await activeTitle()) === 'typed:ação')

  bridge.send('drawer:browser-stream-resize', chat.id, streamId, 700, 500)
  const resized = await soon('a resized frame', () =>
    framesOf(streamId).find((item) => item.payload.width === 700 && item.payload.height === 500)
  )
  assert.deepEqual(jpegSize(Buffer.from(resized.payload.data, 'base64')), { width: 700, height: 500 })

  click(1, streamId, 100, 75)
  const list = await soon('the list request', () => streamedFind((item) => item.channel === 'drawer:browser-select'))
  assert.deepEqual(list.payload.options, [
    { label: 'Alpha', disabled: false, group: null },
    { label: 'Beta', disabled: false, group: 'More' },
    { label: 'Gamma', disabled: true, group: 'More' },
  ])
  assert.equal(list.payload.selectedIndex, 0)
  assert.deepEqual(
    Object.values(list.payload.rect).map((value) => Math.round(value)),
    [0, 60, 200, 30]
  )
  bridge.send('drawer:browser-select-choose', chat.id, streamId, list.payload.requestId, 1)
  await soon('the chosen option', async () => (await activeTitle()) === 'chose:b')

  click(1, streamId, 100, 135)
  await soon('the file chooser notice', () =>
    streamedFind((item) => item.channel === 'drawer:browser-stream-notice' && item.payload.notice === 'file-chooser')
  )

  // The agent drives and photographs the same browser while it is streamed; the stream goes on meanwhile.
  const framesBeforeTurn = framesOf(streamId).length
  const turned = new Promise((resolve) => {
    const off = bridge.onEvent((frame) => {
      if (frame.channel !== 'chat:delta:' + chat.id) return
      const kind = frame.args[0]?.kind
      if (kind === 'done' || kind === 'finish' || kind === 'error') {
        off()
        resolve(kind)
      }
    })
  })
  const resent = await bridge.invoke('chat:send', {
    conversationId: chat.id,
    text: `E2E-HOST-BROWSER url=http://${fakeName}:8787/e2e/cookie/show`,
  })
  assert.equal(resent.ok, true, JSON.stringify(resent))
  await within(turned, 180000, 'The second browser turn did not finish')
  const streamedAnswer = (await bridge.invoke('chat:history:page', chat.id)).messages.at(-1)
  assert.ok(JSON.stringify(streamedAnswer).includes('E2E-HOST-BROWSER-OK'), JSON.stringify(streamedAnswer).slice(-800))
  const streamedShot = streamedAnswer.parts.find(
    (part) => part.type === 'tool' && part.toolName === 'browser_screenshot'
  )
  const streamedPicture = await bridge.invoke('chat:tool-image', {
    conversationId: chat.id,
    messageId: streamedAnswer.id,
    toolPartId: streamedShot.id,
    imageId: streamedShot.state.output.images[0].id,
  })
  assert.ok(pngColors(Buffer.from(streamedPicture.bytes.b64, 'base64')).colors >= 2, 'The screenshot is one flat color')
  assert.ok(framesOf(streamId).length > framesBeforeTurn, 'No frame showed the agent navigating')

  // Another window of the computer takes the browser over: the first is told and gets nothing more.
  bridge.open(2, { role: 'main' })
  const second = await bridge.invokeAs(2, 'drawer:browser-stream-start', chat.id, 640, 480)
  await soon('the takeover notice', () =>
    streamedFind(
      (item) =>
        item.origin === 1 &&
        item.channel === 'drawer:browser-stream-ended' &&
        item.payload.streamId === streamId &&
        item.payload.reason === 'taken-over'
    )
  )
  await soon('a frame for the second window', () =>
    framesOf(second.streamId).find((item) => item.origin === 2 && item.payload.width === 640)
  )

  // Two conversations watched at once: each browser paints in a stream window of its own on the host's display, and
  // input reaches only its own page.
  const other = await bridge.invoke('conversation:create-standalone', {})
  const otherTitle = async () => {
    const state = await bridge.invoke('drawer:browser-state-get', other.id)
    return state.tabs.find((tab) => tab.id === state.activeId)?.title
  }
  const otherStream = await bridge.invoke('drawer:browser-stream-start', other.id, 520, 400)
  await soon('a frame of the other conversation', () =>
    framesOf(otherStream.streamId).find((item) => item.payload.width === 520 && item.payload.height === 400)
  )
  bridge.send('drawer:navigate', other.id, `http://${fakeName}:8787/e2e/stream`)
  await soon('the other conversation page', async () => (await otherTitle()) === 'E2E stream')
  const otherInput = (value) => bridge.send('drawer:browser-input', other.id, otherStream.streamId, value)
  otherInput({ type: 'focus', focused: true })
  for (const action of ['down', 'up'])
    otherInput({
      type: 'mouse',
      action,
      x: 100,
      y: 20,
      button: 'left',
      buttons: action === 'down' ? 1 : 0,
      clickCount: 1,
      modifiers: 0,
    })
  otherInput({ type: 'text', text: 'outra' })
  await soon('the title typed in the other conversation', async () => (await otherTitle()) === 'typed:outra')
  const framesBeforeOther = framesOf(second.streamId).length
  bridge.send('drawer:navigate', chat.id, `http://${fakeName}:8787/e2e/cookie/show`)
  await soon('a frame of the first conversation meanwhile', () => framesOf(second.streamId).length > framesBeforeOther)
  assert.equal(await activeTitle(), 'E2E cookie')
  bridge.send('drawer:browser-stream-stop', other.id, otherStream.streamId)
  const firstWindowFrames = framesOf(streamId).length

  // Stopped, the stream sends nothing even as the page changes; after its grace period the page leaves its stream
  // window, and a new stream presents it again.
  bridge.sendAs(2, 'drawer:browser-stream-stop', chat.id, second.streamId)
  await sleep(500)
  const stoppedFrames = framesOf(second.streamId).length
  bridge.send('drawer:navigate', chat.id, `http://${fakeName}:8787/e2e/stream`)
  await soon('the page after the stop', async () => (await activeTitle()) === 'E2E stream')
  await sleep(1500)
  assert.equal(framesOf(second.streamId).length, stoppedFrames, 'A stopped stream kept sending frames')
  assert.equal(framesOf(streamId).length, firstWindowFrames, 'A window that was taken over kept getting frames')
  await sleep(16000)
  const restarted = await bridge.invoke('drawer:browser-stream-start', chat.id, 800, 600)
  const restartedFrame = await soon('a frame after the release', () =>
    framesOf(restarted.streamId).find((item) => item.payload.width === 800 && item.payload.height === 600)
  )
  assert.deepEqual(jpegSize(Buffer.from(restartedFrame.payload.data, 'base64')), { width: 800, height: 600 })
  bridge.send('drawer:browser-stream-stop', chat.id, restarted.streamId)
  pass(
    'host browser stream',
    `${framesOf(streamId).length + framesOf(second.streamId).length + framesOf(restarted.streamId).length} JPEG frames ` +
      'paced by acknowledgements; typed text, resize, list choice, file chooser refused, agent screenshot while ' +
      'streaming, takeover, two conversations at once, stop and release'
  )

  // A terminal of the host, in the conversation's folder.
  const output = []
  bridge.onEvent((frame) => {
    if (frame.channel.startsWith('pty:data')) output.push(JSON.stringify(frame.args))
  })
  bridge.send('drawer:create-terminal', chat.id)
  const terminal = await poll(
    'host terminal',
    async () => (await bridge.invoke('drawer:terminal-state-get', chat.id)).terminals[0],
    30000
  )
  await poll(
    'terminal ready',
    async () => (await bridge.invoke('drawer:read-terminal', terminal.id)).data.length > 0,
    30000
  )
  bridge.send('pty:write', {
    id: terminal.id,
    data: `echo host-$((40+2))-$(id -u) > ${projectPath}/from-terminal.txt\n`,
  })
  await poll('terminal wrote a file', async () => existsSync(path.join(projectPath, 'from-terminal.txt')), 30000)
  assert.equal(readFileSync(path.join(projectPath, 'from-terminal.txt'), 'utf8').trim(), 'host-42-1000')
  pass('host terminal', 'a shell of the host wrote under the mounted folder as uid 1000')

  // The host's editor: VS Code's serve-web, downloaded and started on the host when a computer opens it, reached through
  // the gateway with this device's token. The host adds the editor's token; its workbench page receives it, as the page
  // authenticates its connection to the editor's server with it.
  const opened = await bridge.invoke('editor:open', chat.id)
  assert.equal(opened.folder, chat.cwd)
  assert.ok(['downloading', 'starting', 'ready'].includes(opened.phase), JSON.stringify(opened))
  const phases = new Set([opened.phase])
  await poll(
    'the host editor',
    async () => {
      const phase = await bridge.invoke('editor:status')
      phases.add(phase)
      if (phase === 'error') throw new Error('The host editor failed to start')
      return phase === 'ready'
    },
    300000
  )
  const editorRoute = '/v1/environments/' + environmentId + '/editor'
  const forwarded = '127.0.0.1:45678'
  const workbench = await raw('GET', editorRoute + '/?folder=' + encodeURIComponent(chat.cwd), {
    headers: { 'x-forwarded-host': forwarded },
  })
  assert.equal(workbench.status, 200)
  const html = await workbench.text()
  const settings = /id="vscode-workbench-web-configuration"[^>]*data-settings="([^"]*)"/.exec(html)?.[1]
  assert.ok(settings, 'The workbench page has no web configuration: ' + html.slice(0, 300))
  const configuration = JSON.parse(settings.replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
  assert.equal(configuration.remoteAuthority, forwarded)
  const cookies = workbench.headers.getSetCookie()
  assert.ok(
    cookies.some((cookie) => cookie.startsWith('vscode-tkn=')),
    'The workbench page did not get the token: ' + cookies
  )
  const stable = /\/(stable-[0-9a-f]{40})\//.exec(html)?.[1]
  assert.ok(stable, 'The workbench page names no build')
  // The workbench's own code (the page also lists built-in extensions, some of which the web server does not ship).
  const asset = new RegExp('/' + stable + '/static/out/[^"\'\\s]+\\.(?:js|css)').exec(html)?.[0]
  assert.ok(asset, 'The workbench page has no static asset')
  const assetResponse = await raw('GET', editorRoute + asset)
  assert.equal(assetResponse.status, 200, asset)
  assert.ok((await assetResponse.arrayBuffer()).byteLength > 0, 'The static asset is empty: ' + asset)
  const anonymous = await fetch(base + editorRoute + '/', { headers: { 'X-Maestrly-Fleet-Protocol': '1' } })
  assert.equal(anonymous.status, 401)
  // The editor's connection to its server: a WebSocket the gateway and the host pass through.
  const editorSocket = await new Promise((resolve, reject) => {
    const upgrade = http.request(
      base +
        editorRoute +
        '/' +
        stable +
        '?reconnectionToken=' +
        randomUUID() +
        '&reconnection=false&skipWebSocketFrames=false',
      {
        headers: {
          'X-Maestrly-Fleet-Protocol': '1',
          Authorization: 'Bearer ' + token,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          'x-forwarded-host': forwarded,
          Cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; '),
        },
      }
    )
    upgrade.on('upgrade', (response, socket) => {
      assert.equal(response.statusCode, 101)
      socket.on('error', () => undefined)
      resolve(socket)
    })
    upgrade.on('response', (response) =>
      reject(new Error('The editor WebSocket was refused: HTTP ' + response.statusCode))
    )
    upgrade.on('error', reject)
    upgrade.end()
  })
  pass(
    'host editor',
    `serve-web ${stable} (${[...phases].join(' → ')}) through the gateway: workbench for ${forwarded}, ` +
      'token cookie for the page, static asset, WebSocket 101; 401 without a device token'
  )

  // Files move between this computer and the host through the gateway, checked by SHA-256 on the way.
  const files = '/v1/environments/' + environmentId + '/host-files'
  const upload = randomBytes(20 * MiB)
  const begun = await raw(
    'POST',
    files + '/uploads',
    json({ directory: workspacesRoot, name: 'e2e-upload.bin', size: upload.length, overwrite: false })
  )
  const session = await begun.json()
  assert.equal(begun.status, 200, JSON.stringify(session))
  for (const [offset, length] of [
    [0, 16 * MiB],
    [16 * MiB, 4 * MiB],
  ]) {
    const chunk = upload.subarray(offset, offset + length)
    const put = await raw('PUT', files + '/uploads/' + session.uploadId + '?offset=' + offset, {
      headers: { 'x-maestrly-sha256': sha256(chunk), 'x-maestrly-length': String(length) },
      body: chunk,
    })
    assert.equal(put.status, 204, await put.text())
  }
  const committed = await (
    await raw('POST', files + '/uploads/' + session.uploadId + '/commit', json({ sha256: sha256(upload) }))
  ).json()
  assert.equal(committed.sha256, sha256(upload), JSON.stringify(committed))
  const uploaded = path.join(workspacesRoot, 'e2e-upload.bin')
  // The folder is mounted at the same path in the environment: the file is on the Docker host, where its owner is
  // reported as the host maps it (Docker Desktop maps it to the person; the terminal above shows who wrote it).
  assert.equal(sha256(readFileSync(uploaded)), sha256(upload))

  const report = path.join(workspacesRoot, 'e2e-report.csv')
  const csv = Buffer.from('id,name,amount\n1,alpha,10\n'.repeat(Math.ceil((70 * MiB) / 25))).subarray(0, 70 * MiB)
  writeFileSync(report, csv)
  const stat = await (await raw('POST', files + '/stat', json({ path: report }))).json()
  assert.equal(stat.size, csv.length, JSON.stringify(stat))
  const content = (headers, timeout) =>
    raw('GET', files + '/content?path=' + encodeURIComponent(report), { headers, timeout })
  const first = await content({
    range: 'bytes=0-' + (64 * MiB - 1),
    'x-maestrly-file-identity': stat.identity,
    'x-maestrly-accept-encoding': 'zstd',
  })
  assert.equal(first.status, 206)
  assert.equal(first.headers.get('x-maestrly-encoding'), 'zstd')
  const range = zstdDecompressSync(Buffer.from(await first.arrayBuffer()))
  assert.equal(sha256(range), first.headers.get('x-maestrly-sha256'))
  assert.equal(sha256(range), sha256(csv.subarray(0, 64 * MiB)))
  const changed = await content({ range: 'bytes=0-9', 'x-maestrly-file-identity': '1:1:1' })
  assert.equal(changed.status, 409)
  const beyond = await content({
    range: 'bytes=' + 70 * MiB + '-' + (70 * MiB + 9),
    'x-maestrly-file-identity': stat.identity,
  })
  assert.equal(beyond.status, 416)
  const outside = await raw('POST', files + '/stat', json({ path: '/etc/passwd' }))
  assert.equal(outside.status, 403)
  pass(
    'host files',
    `20 MiB upload committed on the Docker host (owner uid ${statSync(uploaded).uid}); 64 MiB zstd range verified; ` +
      'refusals 409/416/403'
  )

  // Revoking the device closes its bridge and cuts its transfers.
  const reading = await content({ range: 'bytes=0-' + (64 * MiB - 1), 'x-maestrly-file-identity': stat.identity }, 0)
  const reader = reading.body.getReader()
  await reader.read()
  const closed = new Promise((resolve) => bridge.socket.addEventListener('close', resolve))
  const editorClosed = new Promise((resolve) => editorSocket.once('close', resolve))
  await request('DELETE', '/v1/devices/self')
  await within(closed, 15000, 'The bridge outlived its device')
  await within(editorClosed, 15000, 'The editor connection outlived its device')
  const ended = (async () => {
    for (;;) if ((await reader.read()).done) return 'complete'
  })().catch(() => 'cut')
  assert.equal(await within(ended, 10000, 'The transfer outlived its device'), 'cut')
  pass('revocation', 'the bridge and the editor connection closed with its device, and its file transfer was cut')

  console.log(JSON.stringify({ result: 'PASS', project, durationMs: Date.now() - started, steps: results }, null, 2))
  // The last line is a summary for a caller that runs this test as one of its steps.
  console.log(JSON.stringify({ result: 'PASS', checks: results.length, durationMs: Date.now() - started }))
}

main()
  .catch(async (error) => {
    console.error('FAIL ' + (error?.stack ?? error))
    if (dockerReady) {
      const logs = await docker(['logs', '--tail', '80', container], { allowFailure: true })
      console.error('--- ' + container + ' ---\n' + logs.stdout + logs.stderr)
      const model = await docker(['logs', '--tail', '20', fakeName], { allowFailure: true })
      console.error('--- ' + fakeName + ' ---\n' + model.stdout + model.stderr)
      const gateway = await compose(['logs', '--tail', '40'], { allowFailure: true }).catch(() => null)
      if (gateway) console.error('--- gateway ---\n' + gateway.stdout + gateway.stderr)
    }
    process.exitCode = 1
  })
  .finally(cleanup)
