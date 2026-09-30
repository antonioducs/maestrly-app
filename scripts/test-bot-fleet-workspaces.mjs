#!/usr/bin/env node
// A workspaces environment on the real images: the gateway creates it beside no bot, mounts the server's workspaces
// folder into it, and bridges a paired computer to the Maestrly that runs there. The computer's side is played here
// the way the desktop app plays it: a bridge ticket, the bridge WebSocket, and the app's own IPC channels over it.
//
// It runs in a Compose project and containers of its own, removed at the end (kept with --keep), and saves no state.
// Images: MAESTRLY_GATEWAY_IMAGE and MAESTRLY_GATEWAY_BOT_IMAGE as Compose reads them, or the `:local` ones.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

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
  return {
    first,
    ticket,
    socket,
    open: (origin, role) => socket.send(JSON.stringify({ t: 'open', origin, ...role })),
    invoke: (channel, ...args) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        waiting.set(id, { resolve, reject })
        socket.send(JSON.stringify({ t: 'invoke', id, origin: 1, channel, args }))
        setTimeout(() => waiting.delete(id) && reject(new Error('No answer to ' + channel)), 60000).unref()
      }),
    send: (channel, ...args) => socket.send(JSON.stringify({ t: 'send', origin: 1, channel, args })),
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
      editor: false,
      browser: false,
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

  // Revoking the device closes its bridge.
  const closed = new Promise((resolve) => bridge.socket.addEventListener('close', resolve))
  await request('DELETE', '/v1/devices/self')
  await within(closed, 15000, 'The bridge outlived its device')
  pass('revocation', 'the bridge closed with its device')

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
