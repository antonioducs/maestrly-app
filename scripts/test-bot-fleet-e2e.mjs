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
// The second bot of Scout's environment: it shares Scout's container.
const partnerId = 'e2e-partner-' + suffix
const fakeName = project + '-model'
const modelKey = 'e2e-model-key'
const GiB = 1024 ** 3
// A bot created without an environment gets a new one named after it, so its environment has the bot's id. New
// environments run in `maestrly-env-<id>` containers with `maestrly-env-<id>-home` volumes.
const environmentContainer = (environmentId) => 'maestrly-env-' + environmentId
// The containers of Dev's and Scout's environments.
const containers = [devId, scoutId].map(environmentContainer)
const started = Date.now()
let stepStarted = started
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    interrupted = true
  })
const events = []
const timings = {}
const results = []
// Container memory by number of bots, and facts worth reporting that the test does not require.
const memory = {}
const observations = {}
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
const docker = (args, options) => {
  const environmentExec =
    args[0] === 'exec' &&
    args.some((arg) => /^maestrly-env-/.test(arg) || /^maestrly-bot-(?!gateway(?:$|-))/.test(arg))
  const explicitUser = args.includes('-u') || args.includes('--user')
  return run('docker', environmentExec && !explicitUser ? ['exec', '-u', '1000', ...args.slice(1)] : args, options)
}
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
const historyIds = async (id) => (await transcript(id)).map((item) => item.id)
async function fleetImage(botId, imageId) {
  const response = await fetch(base + '/v1/bots/' + botId + '/images/' + imageId, {
    headers: { Authorization: 'Bearer ' + token, 'X-Maestrly-Fleet-Protocol': '1' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  return Buffer.from(await response.arrayBuffer())
}
const inbox = async () => (await request('GET', '/v1/inbox')).items
/**
 * Every activity entry, oldest first, page by page. Without `environments` this is what older Macs read: entries
 * about environments themselves (`environment_*`) are left out.
 */
async function activityEntries(environments = false) {
  const entries = []
  for (let after = 0; ; ) {
    const page = (
      await request(
        'GET',
        '/v1/activity?after=' + after + '&limit=500' + (environments ? '&includeEnvironmentActivity=1' : '')
      )
    ).entries
    entries.push(...page)
    if (page.length < 500) return entries
    after = page.at(-1).seq
  }
}
const permissions = async (botId) =>
  (await inbox()).filter((entry) => entry.botId === botId && entry.interaction.kind === 'permission')
const allow = (entry) =>
  request('POST', '/v1/bots/' + entry.botId + '/interactions/' + entry.interaction.id, {
    kind: 'permission',
    reply: 'once',
  })
async function approve(name, botId = scoutId) {
  const item = await poll(
    name + ' permission',
    async () => (await permissions(botId)).find((entry) => entry.interaction.title.includes(name)),
    90000
  )
  assert.ok((await activityEntries()).some((entry) => entry.botId === botId && entry.kind === 'needs_you'))
  await allow(item)
  return item
}
const assistantIds = async (botId) =>
  new Set((await transcript(botId)).filter((item) => item.kind === 'assistant').map((item) => item.id))
/** Sends the owner's message; its answer is an assistant item the bot did not have before. */
async function send(botId, text) {
  const before = await assistantIds(botId)
  const receipt = await request('POST', '/v1/bots/' + botId + '/messages', { text, idempotencyKey: randomUUID() })
  return { botId, before, receipt }
}
/** Waits for the answer to `sent` that contains `needle`, granting or forbidding permissions meanwhile. */
async function answer(sent, needle, options = {}) {
  const { botId, before } = sent
  try {
    return await poll(
      botId + ' answer ' + needle,
      async () => {
        const pending = await permissions(botId)
        if (options.noPermission) assert.equal(pending.length, 0, botId + ' must not request permission')
        if (options.approve) for (const entry of pending) await allow(entry)
        return (await transcript(botId)).find(
          (item) => item.kind === 'assistant' && !before.has(item.id) && item.text.includes(needle)
        )
      },
      options.timeout ?? 90000
    )
  } catch (error) {
    const tail = (await transcript(botId).catch(() => [])).slice(-10).map((item) => ({
      kind: item.kind,
      name: item.name,
      state: item.state,
      text: item.text?.slice(0, 300),
      output: item.output?.slice(0, 300),
    }))
    throw new Error(error.message + '\n' + botId + ' transcript tail: ' + JSON.stringify(tail))
  }
}
async function mouse(name, display = ':0') {
  const value = (await docker(['exec', '-e', 'DISPLAY=' + display, name, 'xdotool', 'getmouselocation', '--shell']))
    .stdout
  return { x: Number(/^X=(\d+)/m.exec(value)?.[1]), y: Number(/^Y=(\d+)/m.exec(value)?.[1]) }
}
/** Puts a display's pointer somewhere, as a person would; returns once it is there. */
async function movePointer(name, display, x, y) {
  await docker(['exec', '-e', 'DISPLAY=' + display, name, 'xdotool', 'mousemove', String(x), String(y)])
  await poll(
    display + ' pointer at ' + x + ',' + y,
    async () => {
      const location = await mouse(name, display)
      return location.x === x && location.y === y
    },
    10000
  )
}
/**
 * Waits for the bot's last call of a computer tool to finish, then checks it did what it says ("Desktop click
 * completed.").
 */
async function assertComputerToolDone(botId, action) {
  const call = await poll(
    botId + ' computer_' + action + ' finished',
    async () => {
      const found = (await transcript(botId)).findLast(
        (item) => item.kind === 'tool' && item.name.endsWith('computer_' + action)
      )
      return found && found.state !== 'running' && found
    },
    30000
  )
  assert.ok(
    call.state === 'done' && call.output?.includes('Desktop ' + action + ' completed'),
    botId + ' computer_' + action + ' did not complete: ' + JSON.stringify([call.state, call.output])
  )
}
/** Tile `index` of the environment display :0 (3x3 tiles of 1280x800): 0 is its screen, k the slot k browser. */
const tile = (index) => ({ x: (index % 3) * 1280, y: Math.floor(index / 3) * 800 })
async function containerState(name) {
  const result = await docker(['inspect', '--format', '{{json .}}', name], { allowFailure: true })
  if (result.code !== 0) return null
  const value = JSON.parse(result.stdout)
  return {
    id: value.Id,
    running: value.State.Running,
    startedAt: value.State.StartedAt,
    labels: value.Config.Labels ?? {},
    memory: value.HostConfig.Memory,
    memorySwap: value.HostConfig.MemorySwap,
  }
}
/** This run's containers (their names carry its unique suffix). */
async function ownContainers() {
  const listed = await docker(['ps', '-a', '--filter', 'name=' + suffix, '--format', '{{.Names}}'])
  return listed.stdout.split('\n').filter(Boolean).sort()
}
/** What the environment's Maestrly itself reports: its installed bots and their display slots. */
async function instanceStatus(name) {
  const output = await docker([
    'exec',
    name,
    'sh',
    '-c',
    'curl -fsS -H "Authorization: Bearer $MAESTRLY_BOT_CONTROL_TOKEN" -H "X-Maestrly-Fleet-Protocol: 1" http://127.0.0.1:7680/v1/environment/status',
  ])
  return JSON.parse(output.stdout)
}
async function instanceProcess(name) {
  // Electron rewrites cmdline into one display string. The entrypoint starts its main process as a session leader;
  // renderer and utility processes share that session but are not its leader.
  const result = await docker([
    'exec',
    name,
    'node',
    '-e',
    "const fs = require('node:fs'); const pids = fs.readdirSync('/proc').filter(id => /^\\d+$/.test(id)).filter(id => { try { const exe = fs.readlinkSync('/proc/' + id + '/exe'); const stat = fs.readFileSync('/proc/' + id + '/stat', 'utf8'); const session = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]); return exe.endsWith('/electron') && session === Number(id) } catch { return false } }); if (pids.length !== 1) throw new Error('Expected one Maestrly main process'); console.log(pids[0])",
  ])
  return Number(result.stdout.trim())
}
const slots = (status) => status.bots.map((item) => [item.botId, item.slot]).sort((a, b) => a[1] - b[1])
const processRuns = async (name, pattern) =>
  (await docker(['exec', name, 'pgrep', '-f', pattern], { allowFailure: true })).code === 0
/** Listening TCP sockets of a container, from its network namespace's /proc tables. */
async function tcpListeners(name) {
  const output = await docker(['exec', name, 'sh', '-c', 'cat /proc/net/tcp; cat /proc/net/tcp6 2>/dev/null || true'])
  const listeners = []
  for (const line of output.stdout.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4 || fields[3] !== '0A' || !fields[1].includes(':')) continue
    const [hex, hexPort] = fields[1].split(':')
    // Each 32-bit word of the address is in host (little-endian) order.
    const bytes = (hex.match(/.{8}/g) ?? []).flatMap((word) =>
      [6, 4, 2, 0].map((offset) => Number.parseInt(word.slice(offset, offset + 2), 16))
    )
    const v4 = bytes.length === 4
    const mapped = !v4 && bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255
    const loopback = v4
      ? bytes[0] === 127
      : mapped
        ? bytes[12] === 127
        : bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1
    const address = v4 || mapped ? bytes.slice(v4 ? 0 : 12).join('.') : loopback ? '[::1]' : '[' + hex + ']'
    listeners.push({ port: Number.parseInt(hexPort, 16), address, loopback })
  }
  return listeners
}
const vncListeners = async (name) => (await tcpListeners(name)).filter((item) => item.port >= 5900 && item.port < 6000)
async function canConnect(from, host, targetPort) {
  const attempt = await docker(
    ['exec', from, 'bash', '-c', `timeout 3 bash -c 'echo >/dev/tcp/${host}/${targetPort}'`],
    { allowFailure: true }
  )
  return attempt.code === 0
}
const mib = (bytes) => Math.round((bytes / 1024 ** 2) * 10) / 10
/** Memory of an environment's container: Docker's figure, its cgroup's, and the summed PSS of its processes. */
async function memorySample(name) {
  const stats = (await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', name])).stdout.trim()
  const script = [
    'cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0',
    'for f in /proc/[0-9]*/smaps_rollup; do cat "$f" 2>/dev/null; done | awk \'/^Pss:/ {s += $2} END {print s + 0}\'',
    'pgrep -c x11vnc || true',
    'pgrep -c Xvfb || true',
    'pgrep -c -f electron/dist/electron || true',
  ].join('; ')
  const [cgroup, pss, vnc, xvfb, electron] = (await docker(['exec', name, 'sh', '-c', script])).stdout
    .trim()
    .split('\n')
    .map(Number)
  return {
    dockerStats: stats,
    cgroupMiB: mib(cgroup),
    pssMiB: mib(pss * 1024),
    processes: { x11vnc: vnc, Xvfb: xvfb, electron },
  }
}
/**
 * Memory of an environment's container at rest: once its VNC servers stopped (a minute after their last client left)
 * and its cgroup memory stopped moving, three readings 5 s apart within 2% (two minutes at most).
 */
async function idleMemorySample(name, conditions) {
  await waitForNoVnc(name)
  const readings = []
  const settleStarted = Date.now()
  while (Date.now() - settleStarted < 120000) {
    readings.push(Number((await docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.current'])).stdout.trim()))
    const last = readings.slice(-3)
    if (last.length === 3 && Math.max(...last) - Math.min(...last) <= 0.02 * Math.max(...last)) break
    await sleep(5000)
  }
  return {
    ...(await memorySample(name)),
    conditions,
    settleMs: Date.now() - settleStarted,
    settleReadingsMiB: readings.map(mib),
  }
}
/** VNC servers stop a minute after their last client leaves; measuring memory waits for that. */
async function waitForNoVnc(name) {
  await poll(
    name + ' VNC servers stopped',
    async () => (await docker(['exec', name, 'pgrep', 'x11vnc'], { allowFailure: true })).code === 1,
    90000
  )
}
/** A real window on an apps display that logs the pointer buttons and keys it receives. */
async function openEventWindow(name, display, window) {
  await docker([
    'exec',
    '-d',
    '-e',
    'DISPLAY=' + display,
    name,
    'sh',
    '-c',
    `exec stdbuf -oL xev -name ${window} -geometry 1200x700+40+40 -event keyboard -event button >/tmp/${window}.log 2>&1`,
  ])
  await poll(
    window + ' window on ' + display,
    async () =>
      (
        await docker(['exec', '-e', 'DISPLAY=' + display, name, 'xdotool', 'search', '--name', '^' + window + '$'], {
          allowFailure: true,
        })
      ).code === 0,
    15000
  )
}
async function eventWindowLog(name, window) {
  const output = (await docker(['exec', name, 'cat', '/tmp/' + window + '.log'])).stdout
  const keys = [],
    clicks = []
  for (const block of output.split(/\n\s*\n/).map((value) => value.trim())) {
    const time = Number(/\btime (\d+)/.exec(block)?.[1])
    if (block.startsWith('KeyPress event')) {
      const char = /XLookupString gives 1 bytes: \([0-9a-f]+\) "(.)"/.exec(block)?.[1]
      if (char !== undefined) keys.push({ char, time })
    } else if (block.startsWith('ButtonPress event')) {
      const at = /root:\((-?\d+),(-?\d+)\)/.exec(block)
      clicks.push({ x: Number(at?.[1]), y: Number(at?.[2]), time })
    }
  }
  return { text: keys.map((key) => key.char).join(''), keys, clicks }
}
/** The folders a bot's data lives in inside its environment's home. */
async function botFolders(name, botId) {
  const output = await docker([
    'exec',
    name,
    'sh',
    '-c',
    `find /home/bot/.config /home/bot/.cache -maxdepth 5 -type d -name ${botId} 2>/dev/null || true`,
  ])
  return output.stdout.split('\n').filter(Boolean).sort()
}
/** The requests the local site's cookie pages received, with the cookie each browser sent. */
async function cookieRequests() {
  const output = await docker([
    'exec',
    fakeName,
    'node',
    '-e',
    `fetch('http://127.0.0.1:8787/e2e/cookie/log', { headers: { authorization: 'Bearer ${modelKey}' } }).then((response) => response.text()).then((text) => process.stdout.write(text))`,
  ])
  return JSON.parse(output.stdout).requests
}

/**
 * The visible windows named Maestrly (its settings window) on the environment display, with the frame openbox drew
 * around each: the outer rectangle is the client area plus the frame extents (left, right, top, bottom).
 */
async function settingsWindows(name) {
  const x = (args) => docker(['exec', '-e', 'DISPLAY=:0', name, ...args], { allowFailure: true })
  const found = await x(['xdotool', 'search', '--onlyvisible', '--name', '^Maestrly$'])
  if (found.code !== 0) return []
  const windows = []
  for (const id of found.stdout.split('\n').filter(Boolean)) {
    const info = (await x(['xwininfo', '-id', id])).stdout
    const extents = (await x(['xprop', '-id', id, '_NET_FRAME_EXTENTS'])).stdout
    const number = (label) => Number(new RegExp(label + ':\\s+(-?\\d+)').exec(info)?.[1])
    const client = {
      x: number('Absolute upper-left X'),
      y: number('Absolute upper-left Y'),
      width: number('Width'),
      height: number('Height'),
    }
    const [left, right, top, bottom] = /=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/.exec(extents)?.slice(1).map(Number) ?? [
      0, 0, 0, 0,
    ]
    windows.push({
      client,
      extents: { left, right, top, bottom },
      outer: {
        x: client.x - left,
        y: client.y - top,
        width: client.width + left + right,
        height: client.height + top + bottom,
      },
    })
  }
  return windows
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
/** A ticket for a bot's screen. Without `surface` the body is an older Mac's, which only knows the browser area. */
async function screenTicket(id, mode, surface, options) {
  return request('POST', '/v1/bots/' + id + '/screen-tickets', { mode, ...(surface ? { surface } : {}) }, options)
}
/** A ticket for an environment screen: Maestrly's settings on tile 0 of its display. */
async function environmentTicket(environmentId, mode, options) {
  return request('POST', '/v1/environments/' + environmentId + '/screen-tickets', { mode }, options)
}
async function openScreen(ticket) {
  const rfb = new Rfb('ws://127.0.0.1:' + port + ticket.path)
  await rfb.open()
  await rfb.handshake()
  return rfb
}
async function capture(name, display = ':0', fileName = 'e2e-scout.png') {
  const target = path.join(root, '.bot-fleet-local/screens', fileName)
  mkdirSync(path.dirname(target), { recursive: true })
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-u', '1000', name, 'import', '-display', display, '-window', 'root', 'png:-'], {
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
  // The gateway stops first so that it creates nothing more. Every container and volume of this run carries its
  // unique suffix in its name; nothing else is touched.
  if (composeEnv) await compose(['stop'], { allowFailure: true })
  for (const name of [...containers, fakeName]) await docker(['rm', '-f', name], { allowFailure: true })
  const leftovers = (await docker(['ps', '-aq', '--filter', 'name=' + suffix], { allowFailure: true })).stdout
    .split(/\s+/)
    .filter(Boolean)
  if (leftovers.length) await docker(['rm', '-f', ...leftovers], { allowFailure: true })
  for (const name of containers) await docker(['volume', 'rm', name + '-home'], { allowFailure: true })
  if (composeEnv) await compose(['down', '-v', '--remove-orphans'], { allowFailure: true })
  const volumes = (await docker(['volume', 'ls', '-q', '--filter', 'name=' + suffix], { allowFailure: true })).stdout
    .split(/\s+/)
    .filter(Boolean)
  for (const volume of volumes) await docker(['volume', 'rm', volume], { allowFailure: true })
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
  if (available.code !== 0) throw new Error('Docker is unavailable. Start Docker and rerun npm run test:e2e:bot-fleet.')
  dockerReady = true
  port = await freePort()
  base = 'http://127.0.0.1:' + port
  composeEnv = {
    ...process.env,
    MAESTRLY_GATEWAY_NETWORK: network,
    MAESTRLY_GATEWAY_PORT: String(port),
    MAESTRLY_GATEWAY_BIND: '127.0.0.1',
    MAESTRLY_GATEWAY_BOT_EGRESS: 'public',
  }
  await compose(['up', '-d', '--no-build'])
  const meta = await poll('gateway /v1/meta', () => request('GET', '/v1/meta'), 30000)
  assert.equal(meta.protocol, 1)
  assert.ok(meta.features.includes('environments'))
  const missing = await fetch(base + '/v1/bots')
  assert.equal(missing.status, 426)
  await request('GET', '/v1/meta', undefined, { headers: { Origin: 'https://example.test' }, status: 403 })
  const pairOutput = (
    await compose(['exec', '-T', 'maestrly-bot-gateway', 'node', 'apps/bot-gateway/dist/main.js', 'pair'])
  ).stdout
  const code = /[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/.exec(pairOutput)?.[0]
  assert.ok(code, 'Pairing code absent from gateway CLI output')
  token = (await request('POST', '/v1/pair', { code: code.replace('-', ''), deviceName: 'Fleet E2E' })).token
  pass('gateway and pairing', 'protocol 1 with environments; missing header 426; Origin 403; paired device')
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
  // An older Mac creates a bot without naming an environment: the bot gets a new environment of its own.
  const devCreated = Date.now()
  const devRequest = await request('POST', '/v1/bots', {
    name: 'E2E Dev ' + suffix,
    instructions: 'E2E development bot',
    ceiling: 'full',
    talksTo: [],
    idempotencyKey: randomUUID(),
  })
  assert.equal(devRequest.setup.step, 'container')
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
  const devEnvId = dev.environmentId
  const scoutEnvId = scout.environmentId
  assert.equal(devEnvId, devId)
  assert.equal(scoutEnvId, scoutId)
  const environments = (await request('GET', '/v1/environments')).environments
  for (const [environmentId, botId, name] of [
    [devEnvId, devId, containers[0]],
    [scoutEnvId, scoutId, containers[1]],
  ]) {
    const environment = environments.find((item) => item.id === environmentId)
    assert.equal(environment?.lifecycle, 'running')
    assert.deepEqual(environment.botIds, [botId])
    assert.equal(environment.appVersion, version)
    assert.ok(environment.capabilities.includes('environments'))
    const state = await containerState(name)
    assert.equal(state?.running, true)
    assert.equal(state.labels['org.maestrly.fleet.environment-id'], environmentId)
    assert.equal((await docker(['volume', 'inspect', name + '-home'], { allowFailure: true })).code, 0)
    const installed = await instanceStatus(name)
    assert.deepEqual(slots(installed), [[botId, 1]])
    observations.instanceEnvironmentId ??= installed.environmentId
  }
  // Each bot runs in its environment's container, never in one of its own.
  assert.deepEqual(
    (await ownContainers()).filter((name) => name.startsWith('maestrly-')),
    [...containers].sort()
  )
  pass('two bot containers', 'running, setup, appVersion ' + version + '; one maestrly-env-* container each, slot 1')
  const egressContainer = containers[1]
  assert.equal(
    (await docker(['inspect', '-f', '{{.Config.User}} {{json .HostConfig.CapAdd}}', egressContainer])).stdout.trim(),
    '0 ["NET_ADMIN"]'
  )
  const mainPid = await instanceProcess(egressContainer)
  const status = (await docker(['exec', egressContainer, 'cat', '/proc/' + mainPid + '/status'])).stdout
  const capBnd = /^CapBnd:\s*([0-9a-f]+)$/m.exec(status)?.[1]
  assert.ok(capBnd, 'Maestrly process CapBnd missing')
  assert.equal(BigInt('0x' + capBnd) & (1n << 12n), 0n, 'Maestrly still has NET_ADMIN')
  assert.notEqual((await docker(['exec', egressContainer, 'iptables', '-S'], { allowFailure: true })).code, 0)
  const outputRules = (await docker(['exec', '-u', '0', egressContainer, 'iptables', '-S', 'OUTPUT'])).stdout
  assert.match(outputRules, /-P OUTPUT ACCEPT/)
  assert.match(outputRules, /-A OUTPUT -d 169\.254\.0\.0\/16 -j REJECT/)
  assert.equal(await canConnect(egressContainer, 'maestrly-bot-gateway', 7444), true)
  const listener = net.createServer((socket) => socket.end())
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '0.0.0.0', resolve))
  try {
    const listenerPort = listener.address().port
    const hostLookup = await docker(['exec', fakeName, 'getent', 'ahostsv4', 'host.docker.internal'], {
      allowFailure: true,
    })
    const targetHost = hostLookup.code === 0
      ? hostLookup.stdout.trim().split(/\s+/)[0]
      : (await docker(['network', 'inspect', '-f', '{{(index .IPAM.Config 0).Gateway}}', network])).stdout.trim()
    const sidecarControl = await docker(
      ['exec', fakeName, 'node', '-e',
        "const net=require('node:net');const s=net.connect(Number(process.argv[2]),process.argv[1]);s.setTimeout(3000);s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))",
        targetHost, String(listenerPort)],
      { allowFailure: true }
    )
    assert.equal(sidecarControl.code, 0, 'Cannot verify host egress here: the model sidecar cannot reach the host listener')
    assert.equal(await canConnect(egressContainer, targetHost, listenerPort), false, 'Bot reached the host listener')
    assert.equal(await canConnect(egressContainer, '169.254.169.254', 80), false, 'Bot reached metadata address')
    pass('egress guard', 'root container, NET_ADMIN removed from Maestrly; firewall blocks host and metadata while gateway remains reachable')
  } finally {
    await new Promise((resolve) => listener.close(resolve))
  }
  const toolchainStarted = Date.now()
  const binaries =
    'node npm npx corepack pnpm python python3 pip uv uvx mise git ssh gcc make rg fd jq sqlite3 zip unzip'.split(' ')
  const plainShell = (
    await docker([
      'exec',
      containers[1],
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
    await docker(['exec', containers[1], 'bash', '-lc', 'command -v node uv mise; echo $NPM_CONFIG_PREFIX'])
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

  // VNC servers start when a screen opens. Nothing listens before; with Scout's browser and apps views open, the
  // real servers must accept loopback connections only (slot 1: browser view 5903, apps view 5953).
  assert.deepEqual(await vncListeners(containers[1]), [])
  const isolationViews = []
  for (const surface of ['browser', 'apps'])
    isolationViews.push(await openScreen(await screenTicket(scoutId, 'view', surface)))
  const livePorts = [5903, 5953]
  const listening = await vncListeners(containers[1])
  for (const vncPort of livePorts)
    assert.ok(
      listening.some((item) => item.port === vncPort),
      'No VNC server on ' + vncPort + ' while its view is open'
    )
  assert.ok(
    listening.every((item) => item.loopback),
    'A VNC server listens beyond loopback: ' + JSON.stringify(listening)
  )
  // Each server listens on its own surface's port only: no other surface's port is taken.
  assert.deepEqual(
    [...new Set(listening.map((item) => item.port))].sort((a, b) => a - b),
    livePorts,
    'VNC ports other than the open views listen: ' + JSON.stringify(listening)
  )
  const ownAddresses = (await docker(['exec', containers[1], 'hostname', '-I'])).stdout.trim().split(/\s+/)
  assert.ok(ownAddresses.length && ownAddresses.every(Boolean))
  for (const vncPort of livePorts) {
    assert.equal(await canConnect(containers[1], '127.0.0.1', vncPort), true)
    for (const address of ownAddresses)
      assert.equal(await canConnect(containers[1], address, vncPort), false, `VNC port ${vncPort} open on ${address}`)
  }
  for (const vncPort of [5900, 5901, ...livePorts]) {
    const attempt = await docker(
      ['exec', containers[0], 'bash', '-c', `timeout 3 bash -c 'echo >/dev/tcp/${containers[1]}/${vncPort}'`],
      { allowFailure: true }
    )
    assert.notEqual(attempt.code, 0, `Bot reached another bot's VNC port ${vncPort}`)
  }
  for (const view of isolationViews) view.close()
  const gatewayFromBot = await docker([
    'exec',
    containers[0],
    'curl',
    '-sS',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    'http://maestrly-bot-gateway:7443/v1/meta',
  ])
  assert.equal(gatewayFromBot.stdout.trim(), '403')
  pass(
    'bot network isolation',
    'VNC starts on demand and listens on ' +
      [...new Set(listening.map((item) => item.address + ':' + item.port))].join(', ') +
      ' only; cross-bot VNC ports refuse connections; gateway public API returns 403'
  )
  for (const name of containers) {
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
  const scoutDefault = {
    providerId: selection.providerId,
    modelId: selection.modelId,
    reasoning: null,
    fastMode: false,
    intervalTokens: 100000,
  }
  await request('PATCH', '/v1/bots/' + scoutId, { compaction: scoutDefault })
  await poll('Scout compaction ready', async () => {
    const state = await bot(scoutId)
    return state.compactionState?.configured === true && state.status !== 'setup'
  })
  // Scout's environment had no default: Scout's first model became it, and Scout uses it from there.
  assert.deepEqual((await request('GET', '/v1/environments/' + scoutEnvId)).compaction, scoutDefault)
  assert.equal((await bot(scoutId)).compactionSource, 'environment')
  assert.equal(
    (
      await poll('Scout default compaction event', () =>
        events.findLast((event) => event.type === 'environment.updated' && event.environment.id === scoutEnvId)
      )
    ).environment.compaction?.modelId,
    selection.modelId
  )
  pass('environment default compaction', `Scout's first model became the default of ${scoutEnvId}`)
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

  // Computer tools act on the bot's apps display (:1 for slot 1); the environment display :0 keeps its pointer.
  // Xvfb starts a pointer at the centre of its screen, which is where the model clicks: the click has to move it.
  await movePointer(containers[1], ':1', 10, 10)
  const environmentPointer = await mouse(containers[1])
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
      const location = await mouse(containers[1], ':1')
      return location.x === 640 && location.y === 400
    },
    90000
  )
  await assertComputerToolDone(scoutId, 'click')
  assert.deepEqual(await mouse(containers[1]), environmentPointer)
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
  pass(
    'model tool chain',
    'screenshot 1280x800 of :1, approved click (640,400) on :1 only, peer delivered and queued, help pending'
  )
  // No surface: the older Macs' ticket shows the browser area, tile 1 of :0. The apps view shows :1.
  const viewTicket = await screenTicket(scoutId, 'view')
  const view = await openScreen(viewTicket)
  const pixels = await view.pixels()
  assert.ok(pixels > 0)
  const appsView = await openScreen(await screenTicket(scoutId, 'view', 'apps'))
  const appsPixels = await appsView.pixels()
  assert.ok(appsPixels > 0)
  const before = await mouse(containers[1])
  const appsBefore = await mouse(containers[1], ':1')
  view.pointer(220, 180)
  appsView.pointer(220, 180)
  await sleep(500)
  assert.deepEqual(await mouse(containers[1]), before)
  assert.deepEqual(await mouse(containers[1], ':1'), appsBefore)
  const png = await capture(containers[1])
  const appsPng = await capture(containers[1], ':1', 'e2e-scout-apps.png')
  pass(
    'view screen',
    'RFB 3.8, ' +
      pixels +
      ' browser and ' +
      appsPixels +
      ' apps pixel bytes, pointers unchanged, PNG ' +
      png +
      ', ' +
      appsPng
  )
  await request('POST', '/v1/bots/' + scoutId + '/takeover')
  const scoutTile = tile(1)
  const controlTicket = await screenTicket(scoutId, 'control')
  const control = await openScreen(controlTicket)
  control.pointer(100, 100)
  await poll(
    'control pointer',
    async () => {
      const location = await mouse(containers[1])
      return location.x === scoutTile.x + 100 && location.y === scoutTile.y + 100
    },
    10000
  )
  const appsControl = await openScreen(await screenTicket(scoutId, 'control', 'apps'))
  appsControl.pointer(100, 100)
  await poll(
    'apps control pointer',
    async () => {
      const location = await mouse(containers[1], ':1')
      return location.x === 100 && location.y === 100
    },
    10000
  )
  await request('POST', '/v1/bots/' + scoutId + '/takeover/release', { note: 'E2E note', continue: true })
  assert.equal(await control.closeCode(), 4001)
  assert.equal(await appsControl.closeCode(), 4001)
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
  // An older Mac's bot routes configure the bot's environment.
  const provisioningRoute = '/v1/bots/' + scoutId
  const environmentRoute = '/v1/environments/' + scoutEnvId
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
  assert.deepEqual(
    await request('GET', environmentRoute + '/skills'),
    await request('GET', provisioningRoute + '/skills')
  )
  assert.deepEqual(
    await request('GET', environmentRoute + '/mcp-servers'),
    await request('GET', provisioningRoute + '/mcp-servers')
  )
  // Configuration is recorded on the environment, with no bot.
  const configured = await activityEntries()
  assert.ok(
    configured.some(
      (entry) =>
        entry.botId === null &&
        entry.environmentId === scoutEnvId &&
        entry.kind === 'bot_configured' &&
        entry.summary === 'Fleet E2E'
    )
  )
  assert.ok(!JSON.stringify(configured).includes(modelKey), 'Activity must not contain the model key')
  assert.ok(!JSON.stringify(await activityEntries(true)).includes(modelKey), 'Activity must not contain the model key')
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
  pass(
    'provisioning from the Mac',
    "account replay unchanged; skill and MCP server reached the model and are the environment's; removed again"
  )

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
  // What a bot saves belongs to its environment.
  assert.equal(ownerMemory.entries[0].environmentId, scoutEnvId)
  await sendMemoryMessage('E2E-OWNER-CHECK')
  await memoryAnswer('E2E-OWNER-SEEN')
  timings.ownerMemoryMs = Date.now() - ownerMemoryStarted
  pass('owner memory', "bot wrote it, gateway stored it in Scout's environment, next turn saw it")

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
  appsView.close()
  pass(
    'takeover and continuation',
    'control pointer (100,100) at :0 (' +
      (scoutTile.x + 100) +
      ',' +
      (scoutTile.y + 100) +
      ') and :1 (100,100), close 4001, note and E2E-CONTINUED'
  )
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
  for (const name of containers) {
    const stat = await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', name])
    timings[name + 'IdleMemory'] = stat.stdout.trim()
  }
  // One bot in the environment, idle, with no screen open: its container, once the VNC servers stopped.
  memory.oneBotIdle = await idleMemorySample(
    containers[1],
    "Scout's environment with Scout only, idle after its turns, no screen open, memory settled"
  )
  // A bot alone in its environment reports the container's figures, as bots did before environments.
  const alone = await poll('Scout reports its environment resources', async () => {
    const value = await bot(scoutId)
    return value.resources.memoryBytes !== null && value.resources
  })
  memory.oneBotIdle.gatewayMiB = mib(alone.memoryBytes)
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
  assert.ok((await activityEntries()).some((item) => item.kind === 'routine_ran' && item.botId === scoutId))
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
    (await activityEntries()).some(
      (item) => item.kind === 'routine_created' && item.botId === scoutId && item.data.routineId === botRoutine.id
    )
  )
  await request('DELETE', '/v1/bots/' + scoutId + '/routines/' + botRoutine.id, undefined, { status: 204 })
  pass('bot-created routine', botRoutine.id + ' interval and activity; owner deleted it')

  // A second bot joins Scout's environment: no new container, the environment's accounts, skills and MCP servers and
  // its default compaction model at once, and a model selection of its own to choose.
  const containersBeforeJoin = await ownContainers()
  const scoutContainer = await containerState(containers[1])
  const joinStarted = Date.now()
  const partnerRequest = await request('POST', '/v1/bots', {
    name: 'E2E Partner ' + suffix,
    instructions: 'E2E partner bot sharing the Scout environment',
    ceiling: 'ask',
    talksTo: [],
    idempotencyKey: randomUUID(),
    environmentId: scoutEnvId,
  })
  assert.equal(partnerRequest.id, partnerId)
  assert.equal(partnerRequest.environmentId, scoutEnvId)
  assert.equal(partnerRequest.setup.step, 'profile')
  const partner = await poll('Partner running', async () => {
    const value = await bot(partnerId)
    return value.lifecycle === 'running' && value
  })
  timings.partnerJoinToRunningMs = Date.now() - joinStarted
  assert.deepEqual(await ownContainers(), containersBeforeJoin)
  assert.equal(await containerState(environmentContainer(partnerId)), null)
  const scoutContainerJoined = await containerState(containers[1])
  assert.equal(scoutContainerJoined.id, scoutContainer.id)
  assert.equal(scoutContainerJoined.startedAt, scoutContainer.startedAt)
  assert.deepEqual((await request('GET', environmentRoute)).botIds, [scoutId, partnerId])
  assert.deepEqual(slots(await instanceStatus(containers[1])), [
    [scoutId, 1],
    [partnerId, 2],
  ])
  await poll('Partner apps display :2', () => processRuns(containers[1], '^Xvfb :2 '), 30000)
  await poll(
    'environment event with Partner',
    () =>
      events.some(
        (event) =>
          event.type === 'environment.updated' &&
          event.environment.id === scoutEnvId &&
          event.environment.botIds.includes(partnerId)
      ),
    10000
  )
  assert.equal(partner.appVersion, version)
  await poll('Partner uses the shared account', async () => (await bot(partnerId)).accounts.connected)
  for (const kind of ['accounts', 'skills', 'mcp-servers']) {
    const shared = await request('GET', environmentRoute + '/' + kind)
    assert.deepEqual(await request('GET', '/v1/bots/' + partnerId + '/' + kind), shared)
    assert.deepEqual(await request('GET', '/v1/bots/' + scoutId + '/' + kind), shared)
  }
  assert.ok((await request('GET', environmentRoute + '/accounts')).apiKeys.some((item) => item.name === 'E2E Model'))
  assert.equal(partner.selection, null)
  // Partner compacts with its environment's default from the start: it never waits for a compaction model.
  assert.equal(partner.compactionSource, 'environment')
  assert.deepEqual(partner.compaction, scoutDefault)
  await poll('Partner inherits the default compaction model', async () => {
    const state = await bot(partnerId)
    return (
      state.compactionSource === 'environment' && state.compactionState?.configured === true && state.status !== 'setup'
    )
  })
  // The environment's Maestrly keeps each bot's own choice: none for Partner yet, Scout's own for Scout.
  const chosen = Object.fromEntries(
    (await instanceStatus(containers[1])).bots.map((item) => [item.botId, item.status.selection])
  )
  assert.equal(chosen[partnerId], null)
  assert.equal(chosen[scoutId]?.modelId, selection.modelId)
  // Partner picks another model of the shared account than Scout's.
  const partnerSelection = (await request('GET', '/v1/bots/' + partnerId + '/selections')).options.find(
    (option) => option.modelId === 'e2e-model-b'
  )
  assert.equal(partnerSelection?.providerId, selection.providerId)
  const partnerChoice = {
    providerId: partnerSelection.providerId,
    modelId: partnerSelection.modelId,
    reasoning: null,
    fastMode: false,
  }
  await request('PATCH', '/v1/bots/' + partnerId, { selection: partnerChoice })
  // With a default in place, Partner's model is its own.
  await request('PATCH', '/v1/bots/' + partnerId, { compaction: { ...partnerChoice, intervalTokens: 100000 } })
  await poll('Partner compaction ready', async () => {
    const state = await bot(partnerId)
    return state.compactionSource === 'bot' && state.compactionState?.configured === true && state.status !== 'setup'
  })
  assert.deepEqual((await request('GET', environmentRoute)).compaction, scoutDefault)
  assert.equal((await request('GET', '/v1/bots/' + partnerId + '/selections')).current?.modelId, 'e2e-model-b')
  assert.equal((await request('GET', '/v1/bots/' + scoutId + '/selections')).current?.modelId, selection.modelId)
  const scoutAfterJoin = await bot(scoutId)
  assert.equal(scoutAfterJoin.selection?.modelId, selection.modelId)
  assert.equal(scoutAfterJoin.compaction?.intervalTokens, 100000)
  // A new default reaches the bot that inherits it, never the one with its own model.
  const retuned = await request('PATCH', environmentRoute, { compaction: { ...scoutDefault, intervalTokens: 120000 } })
  assert.equal(retuned.compaction?.intervalTokens, 120000)
  const scoutRetuned = await poll('Scout takes the new default', async () => {
    const state = await bot(scoutId)
    return state.compaction?.intervalTokens === 120000 && state.compactionState?.configured === true && state
  })
  assert.equal(scoutRetuned.compactionSource, 'environment')
  const partnerKept = await bot(partnerId)
  assert.deepEqual(
    [partnerKept.compactionSource, partnerKept.compaction?.modelId, partnerKept.compaction?.intervalTokens],
    ['bot', 'e2e-model-b', 100000]
  )
  assert.equal(partnerKept.compactionState?.configured, true)
  await request('PATCH', environmentRoute, { compaction: scoutDefault })
  await poll(
    'Scout back on the previous default',
    async () => (await bot(scoutId)).compaction?.intervalTokens === 100000
  )
  pass('environment default compaction change', 'Scout (inherits) took 120000 tokens and back; Partner kept its own')
  // Older Macs start, stop and restart bots; a shared bot's environment is restarted instead.
  for (const [id, action] of [
    [scoutId, 'restart'],
    [partnerId, 'stop'],
    [partnerId, 'start'],
  ]) {
    const refused = await request('POST', '/v1/bots/' + id + '/' + action, undefined, { status: 409 })
    assert.deepEqual(
      [refused.code, refused.message],
      ['CONFLICT', 'This bot shares its environment. Restart the environment instead.']
    )
  }
  pass(
    'shared environment join',
    `Partner joined ${scoutEnvId} in slot 2 in ${timings.partnerJoinToRunningMs} ms with no new container; ` +
      'accounts, skills and MCP servers shared; its own model (e2e-model-b) and compaction; bot lifecycle refused'
  )
  // The owner changes the environment's memory limit live, then goes back to the gateway's default.
  const limited = await request('PATCH', environmentRoute, { memoryLimitBytes: 3 * GiB })
  assert.equal(limited.memoryLimitBytes, 3 * GiB)
  const limitedContainer = await containerState(containers[1])
  assert.deepEqual([limitedContainer.memory, limitedContainer.memorySwap], [3 * GiB, 6 * GiB])
  assert.equal(limitedContainer.startedAt, scoutContainer.startedAt)
  const defaultLimit = await request('PATCH', environmentRoute, { memoryLimitBytes: null })
  assert.equal(defaultLimit.memoryLimitBytes, null)
  const defaultContainer = await containerState(containers[1])
  assert.deepEqual(
    [defaultContainer.memory, defaultContainer.memorySwap],
    [scoutContainer.memory, 2 * scoutContainer.memory]
  )
  assert.equal(defaultContainer.startedAt, scoutContainer.startedAt)
  observations.createdMemoryLimit = { memory: scoutContainer.memory, memorySwap: scoutContainer.memorySwap }
  pass(
    'environment memory limit',
    '3 GiB (swap 6 GiB) applied live, then back to the default ' + mib(scoutContainer.memory) + ' MiB'
  )

  await poll(
    'both bots idle',
    async () => (await bot(scoutId)).status === 'idle' && (await bot(partnerId)).status === 'idle',
    60000
  )
  memory.twoBotsIdle = await idleMemorySample(
    containers[1],
    "Scout's environment with Scout and Partner, both idle, Partner before its first turn, no screen open, memory settled"
  )
  // Bots that share a container report no container figures of their own; the environment and the host count it once.
  await poll('shared bots without container figures', async () =>
    (await Promise.all([bot(scoutId), bot(partnerId)])).every((value) => value.resources.memoryBytes === null)
  )
  const measured = await poll('environment memory', async () => {
    const value = await request('GET', environmentRoute)
    return value.resources.memoryBytes !== null && value
  })
  memory.twoBotsIdle.gatewayMiB = mib(measured.resources.memoryBytes)
  const countedOnce = await hostCountsEachEnvironmentOnce()
  memory.secondBotMiB = {
    cgroup: Math.round((memory.twoBotsIdle.cgroupMiB - memory.oneBotIdle.cgroupMiB) * 10) / 10,
    pss: Math.round((memory.twoBotsIdle.pssMiB - memory.oneBotIdle.pssMiB) * 10) / 10,
  }
  pass(
    'memory with one and two bots',
    `idle cgroup ${memory.oneBotIdle.cgroupMiB} -> ${memory.twoBotsIdle.cgroupMiB} MiB, PSS ${memory.oneBotIdle.pssMiB} -> ` +
      `${memory.twoBotsIdle.pssMiB} MiB; host counts ${countedOnce.environments} environments once`
  )

  // Both bots' turns run at the same time: each model request waits at the fake model until the other one arrives.
  const pairKey = randomUUID().slice(0, 8)
  const pairStarted = Date.now()
  const pairSent = await Promise.all([
    send(scoutId, `E2E-PAIR key=${pairKey} role=scout peer=${partnerId} hold=3000`),
    send(partnerId, `E2E-PAIR key=${pairKey} role=partner peer=${scoutId} hold=3000`),
  ])
  await poll(
    'both bots working at once',
    async () => (await Promise.all([bot(scoutId), bot(partnerId)])).every((value) => value.status === 'working'),
    60000
  )
  const pairAnswers = await Promise.all([
    answer(pairSent[0], `E2E-PAIR-DONE role=scout key=${pairKey} peers=yes model=${selection.modelId} waited=`, {
      noPermission: true,
    }),
    answer(pairSent[1], `E2E-PAIR-DONE role=partner key=${pairKey} peers=yes model=e2e-model-b waited=`, {
      noPermission: true,
    }),
  ])
  timings.concurrentTurnsMs = Date.now() - pairStarted
  assert.ok(
    !(await transcript(scoutId)).some((item) => item.kind === 'assistant' && item.text.includes('role=partner'))
  )
  assert.ok(
    !(await transcript(partnerId)).some((item) => item.kind === 'assistant' && item.text.includes('role=scout'))
  )
  observations.pairWaitsMs = pairAnswers.map((item) => Number(/waited=(\d+)/.exec(item.text)?.[1]))
  pass(
    'concurrent turns',
    'both turns met at the model (waits ' +
      observations.pairWaitsMs.join(' and ') +
      ' ms), each with its own model and conversation, each knowing the other bot shares its environment'
  )

  // Each bot clicks into a real window on its own apps display and types its own text, both at the same time: the
  // owner grants their typing permissions together.
  const typists = [
    { botId: scoutId, name: 'scout', display: ':1' },
    { botId: partnerId, name: 'partner', display: ':2' },
  ].map((typist) => ({
    ...typist,
    window: 'e2e-apps-' + typist.name,
    text: (typist.name + randomUUID().replaceAll('-', '').slice(0, 8)).repeat(20).slice(0, 180),
  }))
  for (const typist of typists) await openEventWindow(containers[1], typist.display, typist.window)
  // Scout's click moves its pointer; Partner's pointer is already where it clicks (Xvfb starts it at the centre), and
  // its click must land all the same.
  assert.notDeepEqual(await mouse(containers[1], ':1'), { x: 640, y: 400 })
  assert.deepEqual(await mouse(containers[1], ':2'), { x: 640, y: 400 })
  for (const [typist, other] of [typists, [...typists].reverse()]) {
    const elsewhere = await docker(
      [
        'exec',
        '-e',
        'DISPLAY=' + other.display,
        containers[1],
        'xdotool',
        'search',
        '--name',
        '^' + typist.window + '$',
      ],
      { allowFailure: true }
    )
    assert.notEqual(elsewhere.code, 0, typist.window + ' is also on ' + other.display)
  }
  const typingSent = await Promise.all(typists.map((typist) => send(typist.botId, 'E2E-APPS-TYPE text=' + typist.text)))
  const typeRequests = new Map()
  await poll(
    'both bots about to type',
    async () => {
      for (const typist of typists)
        for (const entry of await permissions(typist.botId)) {
          const tool = entry.interaction.tool?.name ?? entry.interaction.title
          if (tool.endsWith('computer_type') || entry.interaction.title.includes('computer_type'))
            typeRequests.set(entry.botId, entry)
          else await allow(entry)
        }
      return typeRequests.size === 2
    },
    90000
  )
  await Promise.all([...typeRequests.values()].map(allow))
  await Promise.all(typingSent.map((sent, index) => answer(sent, 'E2E-APPS-TYPED text=' + typists[index].text)))
  const typed = await poll(
    'typed keys in both windows',
    async () => {
      const logs = await Promise.all(typists.map((typist) => eventWindowLog(containers[1], typist.window)))
      return logs.every((log, index) => log.keys.length >= typists[index].text.length) && logs
    },
    15000
  )
  for (const typist of typists) {
    await assertComputerToolDone(typist.botId, 'click')
    await assertComputerToolDone(typist.botId, 'type')
  }
  for (const [index, typist] of typists.entries()) {
    assert.equal(typed[index].text, typist.text, typist.window + ' did not receive exactly its own bot keys')
    assert.ok(
      typed[index].clicks.some((click) => click.x === 640 && click.y === 400),
      typist.window + ' missed its bot click: ' + JSON.stringify(typed[index].clicks)
    )
  }
  // X server times of both displays come from the same monotonic clock.
  const spans = typed.map((log) => [log.keys[0].time, log.keys.at(-1).time])
  const overlapMs = Math.min(spans[0][1], spans[1][1]) - Math.max(spans[0][0], spans[1][0])
  assert.ok(overlapMs > 0, 'The bots did not type at the same time: ' + JSON.stringify(spans))
  observations.appsTyping = { characters: typists[0].text.length, typingMs: spans.map(([a, b]) => b - a), overlapMs }
  const partnerAppsPng = await capture(containers[1], ':2', 'e2e-partner-apps.png')
  await docker(['exec', containers[1], 'pkill', '-f', 'xev -name e2e-apps-'], { allowFailure: true })
  pass(
    'apps displays',
    `:1 and :2 windows each got only their own bot's click (640,400) and ${typists[0].text.length} keys, ` +
      `typed at the same time (overlap ${overlapMs} ms); PNG ${partnerAppsPng}`
  )

  // Site logins are the environment's: a cookie Scout's browser stores on a local site is sent by Partner's browser.
  const site = 'http://' + fakeName + ':8787'
  const cookieValue = 'e2e-' + randomUUID().slice(0, 8)
  await answer(
    await send(scoutId, `E2E-COOKIE-SET url=${site}/e2e/cookie/set?value=${cookieValue} value=${cookieValue}`),
    'E2E-COOKIE-STORED value=' + cookieValue,
    { approve: true }
  )
  await answer(
    await send(partnerId, `E2E-COOKIE-GET url=${site}/e2e/cookie/show`),
    'E2E-COOKIE-SEEN value=' + cookieValue,
    { approve: true }
  )
  assert.ok(
    (await cookieRequests()).some((entry) => entry.path === '/e2e/cookie/show' && entry.cookie === cookieValue),
    'The site did not receive the shared cookie'
  )
  for (const id of [scoutId, partnerId])
    assert.ok(
      (await transcript(id)).some(
        (item) => item.kind === 'tool' && item.name.endsWith('browser_navigate') && item.state === 'done'
      )
    )
  pass('shared site logins', "cookie stored by Scout's browser_navigate was sent by Partner's browser")

  // The environment screen is tile 0 of :0: Maestrly's settings window fills it, frame included, and never reaches a
  // bot's browser tile. Opening it again leaves it in place.
  await request('POST', environmentRoute + '/ui/open', { target: 'main' }, { status: 204 })
  const settings = await poll(
    'visible settings window',
    async () => {
      const found = await settingsWindows(containers[1])
      return found.length > 0 && found
    },
    30000
  )
  for (const window of settings)
    assert.deepEqual(
      window.outer,
      { x: 0, y: 0, width: 1280, height: 800 },
      'Settings window ' + JSON.stringify(window)
    )
  await request('POST', environmentRoute + '/ui/open', { target: 'main' }, { status: 204 })
  await sleep(1500)
  assert.deepEqual(await settingsWindows(containers[1]), settings)
  observations.settingsWindows = settings
  pass(
    'environment settings window',
    'settings window frame at 0,0 1280x800 (client ' +
      settings.map((window) => Object.values(window.client).join(',')).join('; ') +
      ', frame ' +
      settings.map((window) => Object.values(window.extents).join(',')).join('; ') +
      '), stable when opened again'
  )

  // Every surface has a working ticket: both bots' browser tiles and apps displays, and the environment screen.
  const surfaces = [
    ['Scout browser', () => screenTicket(scoutId, 'view', 'browser')],
    ['Scout apps', () => screenTicket(scoutId, 'view', 'apps')],
    ['Partner browser', () => screenTicket(partnerId, 'view', 'browser')],
    ['Partner apps', () => screenTicket(partnerId, 'view', 'apps')],
    ['environment', () => environmentTicket(scoutEnvId, 'view')],
  ]
  const views = []
  for (const [label, issue] of surfaces) {
    const screen = await openScreen(await issue())
    assert.ok((await screen.pixels()) > 0, label + ' view has no pixels')
    views.push(screen)
  }
  const partnerAppsPointer = await mouse(containers[1], ':2')
  views[3].pointer(10, 10)
  await sleep(500)
  assert.deepEqual(await mouse(containers[1], ':2'), partnerAppsPointer)
  // The environment screen shows only Maestrly's settings: controlling it needs no takeover.
  const environmentControl = await openScreen(await environmentTicket(scoutEnvId, 'control'))
  environmentControl.pointer(50, 60)
  await poll(
    'environment screen control pointer',
    async () => {
      const location = await mouse(containers[1])
      return location.x === 50 && location.y === 60
    },
    10000
  )
  await request('POST', '/v1/bots/' + scoutId + '/takeover')
  // A takeover holds one bot: Partner keeps working meanwhile.
  const heldTag = randomUUID().slice(0, 8)
  await answer(await send(partnerId, 'E2E-ALIVE tag=' + heldTag), 'E2E-ALIVE-OK tag=' + heldTag, {
    noPermission: true,
  })
  assert.equal((await bot(scoutId)).status, 'human')
  // :0 takes one control at a time; the apps displays are separate, with a pointer each.
  const refusedWhileEnvironment = await screenTicket(scoutId, 'control', 'browser', { status: 409 })
  assert.deepEqual(
    [refusedWhileEnvironment.code, refusedWhileEnvironment.message],
    ['CONFLICT', 'Another screen in this environment is being controlled.']
  )
  const scoutAppsControl = await openScreen(await screenTicket(scoutId, 'control', 'apps'))
  scoutAppsControl.pointer(300, 300)
  await poll(
    'Scout apps control pointer',
    async () => {
      const location = await mouse(containers[1], ':1')
      return location.x === 300 && location.y === 300
    },
    10000
  )
  await request('POST', '/v1/bots/' + partnerId + '/takeover')
  const partnerAppsControl = await openScreen(await screenTicket(partnerId, 'control', 'apps'))
  partnerAppsControl.pointer(200, 250)
  await poll(
    'Partner apps control pointer',
    async () => {
      const location = await mouse(containers[1], ':2')
      return location.x === 200 && location.y === 250
    },
    10000
  )
  assert.deepEqual(await mouse(containers[1], ':1'), { x: 300, y: 300 })
  environmentControl.close()
  const scoutBrowserControl = await openScreen(
    await poll(':0 free for Scout', () => screenTicket(scoutId, 'control', 'browser'), 15000)
  )
  scoutBrowserControl.pointer(100, 100)
  await poll(
    'Scout browser control pointer',
    async () => {
      const location = await mouse(containers[1])
      return location.x === scoutTile.x + 100 && location.y === scoutTile.y + 100
    },
    10000
  )
  for (const refused of [
    await screenTicket(partnerId, 'control', 'browser', { status: 409 }),
    await environmentTicket(scoutEnvId, 'control', { status: 409 }),
  ])
    assert.equal(refused.code, 'CONFLICT')
  // Tickets issued while :0 is free are checked again when used: the second control to connect is refused.
  scoutBrowserControl.close()
  const partnerBrowserTicket = await poll(
    ':0 free for Partner',
    () => screenTicket(partnerId, 'control', 'browser'),
    15000
  )
  const lateTicket = await environmentTicket(scoutEnvId, 'control')
  const partnerBrowserControl = await openScreen(partnerBrowserTicket)
  const partnerTile = tile(2)
  partnerBrowserControl.pointer(100, 100)
  await poll(
    'Partner browser control pointer',
    async () => {
      const location = await mouse(containers[1])
      return location.x === partnerTile.x + 100 && location.y === partnerTile.y + 100
    },
    10000
  )
  const late = new Rfb('ws://127.0.0.1:' + port + lateTicket.path)
  await late.open()
  assert.equal(await late.closeCode(), 4003)
  // Giving back Scout's takeover ends Scout's controls only.
  await request('POST', '/v1/bots/' + scoutId + '/takeover/release', { note: null, continue: false })
  assert.equal(await scoutAppsControl.closeCode(), 4001)
  await sleep(1000)
  assert.equal(partnerAppsControl.closed, null)
  assert.equal(partnerBrowserControl.closed, null)
  await request('POST', '/v1/bots/' + partnerId + '/takeover/release', { note: null, continue: false })
  assert.equal(await partnerAppsControl.closeCode(), 4001)
  assert.equal(await partnerBrowserControl.closeCode(), 4001)
  for (const screen of views) {
    assert.equal(screen.closed, null)
    screen.close()
  }
  const environmentPng = await capture(containers[1], ':0', 'e2e-environment.png')
  pass(
    'screens of a shared environment',
    '5 surfaces viewed; environment control without takeover at :0 (50,60); second :0 control 409 and 4003 at use; ' +
      `apps controls at :1 (300,300) and :2 (200,250) at once; browser controls at :0 (${scoutTile.x + 100},100) and ` +
      `(${partnerTile.x + 100},100); release closed only that bot's controls; PNG ${environmentPng}`
  )

  // The environment's owner memory is Partner's too; Scout's bot memory stays Scout's.
  await answer(await send(partnerId, 'E2E-OWNER-CHECK'), 'E2E-OWNER-SEEN', { noPermission: true })
  assert.ok(
    !(await request('GET', '/v1/bots/' + partnerId + '/memories')).memories.some(
      (item) => item.title === 'E2E launch code'
    )
  )
  assert.ok(
    (await request('GET', '/v1/bots/' + scoutId + '/memories')).memories.some(
      (item) => item.title === 'E2E launch code'
    )
  )
  await answer(await send(partnerId, recallQuestion), 'E2E-RECALL-NONE', { noPermission: true })
  const partnerRecall = (await transcript(partnerId)).find(
    (item) => item.kind === 'user' && item.text === recallQuestion && !item.queued
  )
  assert.ok(!(partnerRecall?.memories ?? []).some((item) => item.title === 'E2E launch code'))
  pass(
    'memory in a shared environment',
    "Partner sees the environment's owner memory; Scout's bot memory stays Scout's"
  )
  memory.twoBotsAfterWork = await idleMemorySample(
    containers[1],
    'Both bots idle after turns, browser pages and apps windows used, no screen open, memory settled'
  )
  // Against Scout alone at rest; both bots have done more work by now (browser pages, windows, turns).
  memory.secondBotAfterWorkMiB = {
    cgroup: Math.round((memory.twoBotsAfterWork.cgroupMiB - memory.oneBotIdle.cgroupMiB) * 10) / 10,
    pss: Math.round((memory.twoBotsAfterWork.pssMiB - memory.oneBotIdle.pssMiB) * 10) / 10,
  }

  // Archiving Partner leaves Scout running in the same container, even in the middle of a turn.
  const partnerHistory = await historyIds(partnerId)
  const slowTag = randomUUID().slice(0, 8)
  const slow = await send(scoutId, 'E2E-SLOW ms=8000 tag=' + slowTag)
  await poll('Scout working', async () => (await bot(scoutId)).status === 'working', 30000)
  assert.equal((await request('POST', '/v1/bots/' + partnerId + '/archive')).lifecycle, 'archived')
  await answer(slow, 'E2E-SLOW-DONE tag=' + slowTag, { noPermission: true })
  await poll('Partner uninstalled', async () => {
    const installed = slots(await instanceStatus(containers[1]))
    return installed.length === 1 && installed[0][0] === scoutId && installed[0][1] === 1
  })
  await poll('Partner apps display stopped', async () => !(await processRuns(containers[1], '^Xvfb :2 ')), 30000)
  const scoutContainerArchived = await containerState(containers[1])
  assert.deepEqual(
    [scoutContainerArchived.id, scoutContainerArchived.startedAt],
    [scoutContainer.id, scoutContainer.startedAt]
  )
  const environmentWithoutPartner = await request('GET', environmentRoute)
  assert.equal(environmentWithoutPartner.lifecycle, 'running')
  assert.deepEqual(environmentWithoutPartner.botIds, [scoutId])
  const archivedPartner = (await request('GET', '/v1/archived-bots')).bots
  assert.deepEqual(
    archivedPartner.map((item) => [item.id, item.files, item.environmentId]),
    [[partnerId, 'kept', scoutEnvId]]
  )
  await request('GET', '/v1/bots/' + partnerId, undefined, { status: 404 })
  pass(
    'archive one bot of an environment',
    "Scout's turn went on; Partner uninstalled and its display :2 stopped; same container"
  )

  const restoredPartner = await request('POST', '/v1/archived-bots/' + partnerId + '/restore')
  assert.equal(restoredPartner.lifecycle, 'creating')
  await poll('Partner restored', async () => (await bot(partnerId)).lifecycle === 'running', 120000)
  assert.deepEqual(slots(await instanceStatus(containers[1])), [
    [scoutId, 1],
    [partnerId, 2],
  ])
  await poll('Partner apps display back', () => processRuns(containers[1], '^Xvfb :2 '), 30000)
  const restoredHistory = new Set(await historyIds(partnerId))
  assert.ok(
    partnerHistory.every((id) => restoredHistory.has(id)),
    'Partner lost its conversation'
  )
  assert.equal((await bot(partnerId)).selection?.modelId, 'e2e-model-b')
  assert.deepEqual((await request('GET', '/v1/archived-bots')).bots, [])
  const scoutContainerRestored = await containerState(containers[1])
  assert.deepEqual(
    [scoutContainerRestored.id, scoutContainerRestored.startedAt],
    [scoutContainer.id, scoutContainer.startedAt]
  )
  const restoredTag = randomUUID().slice(0, 8)
  await answer(await send(partnerId, 'E2E-ALIVE tag=' + restoredTag), 'E2E-ALIVE-OK tag=' + restoredTag, {
    noPermission: true,
  })
  pass('restore a bot into its environment', 'slot 2 and its conversation back, same container, answering again')

  // Restarting the environment restarts both bots, which come back with their conversations and slots.
  const histories = [
    [scoutId, await historyIds(scoutId)],
    [partnerId, await historyIds(partnerId)],
  ]
  const restartStarted = Date.now()
  const eventsBeforeRestart = events.length
  const restarted = await request('POST', environmentRoute + '/restart', undefined, { timeout: 300000 })
  timings.environmentRestartMs = Date.now() - restartStarted
  assert.equal(restarted.lifecycle, 'running')
  for (const id of [scoutId, partnerId])
    await poll(
      id + ' back after the environment restart',
      async () => {
        const value = await bot(id)
        return value.lifecycle === 'running' && value.status === 'idle'
      },
      120000
    )
  const scoutContainerRestarted = await containerState(containers[1])
  assert.equal(scoutContainerRestarted.id, scoutContainer.id)
  assert.notEqual(scoutContainerRestarted.startedAt, scoutContainer.startedAt)
  assert.deepEqual(slots(await instanceStatus(containers[1])), [
    [scoutId, 1],
    [partnerId, 2],
  ])
  for (const [id, ids] of histories) {
    const kept = new Set(await historyIds(id))
    assert.ok(
      ids.every((item) => kept.has(item)),
      id + ' lost its conversation in the restart'
    )
  }
  // The gateway coalesces an environment's updates within 250 ms, so "restarting" may reach devices already replaced by
  // the next state; the restart takes seconds, so some state other than running reaches them.
  assert.ok(
    events
      .slice(eventsBeforeRestart)
      .some(
        (event) =>
          event.type === 'environment.updated' &&
          event.environment.id === scoutEnvId &&
          event.environment.lifecycle !== 'running'
      ),
    'no device heard the environment restart'
  )
  const aliveTag = randomUUID().slice(0, 8)
  const alive = await Promise.all([scoutId, partnerId].map((id) => send(id, 'E2E-ALIVE tag=' + aliveTag)))
  await Promise.all(alive.map((sent) => answer(sent, 'E2E-ALIVE-OK tag=' + aliveTag, { noPermission: true })))
  // Whether the shared cookie outlived the restart is reported, not required.
  observations.cookieAfterEnvironmentRestart = (
    await answer(await send(partnerId, `E2E-COOKIE-GET url=${site}/e2e/cookie/show`), 'E2E-COOKIE-SEEN value=', {
      approve: true,
    })
  ).text
  // Environment activity reaches only devices that ask for it.
  const restartEntries = (await activityEntries(true)).filter(
    (entry) => entry.kind === 'environment_restarted' && entry.environmentId === scoutEnvId
  )
  assert.deepEqual(
    restartEntries.map((entry) => [entry.botId, entry.summary]),
    [[null, 'E2E Scout ' + suffix]]
  )
  assert.ok((await activityEntries()).every((entry) => !entry.kind.startsWith('environment_')))
  pass(
    'environment restart',
    `both bots back in ${timings.environmentRestartMs} ms with their conversations and slots 1 and 2; ` +
      'environment_restarted only for devices that ask'
  )

  // The entrypoint must recover a process crash without a gateway restart or a container replacement, reinstalling
  // membership and current holds before any queued work can run.
  await request('POST', '/v1/bots/' + scoutId + '/pause')
  await request('POST', '/v1/bots/' + partnerId + '/takeover')
  const beforeProcessCrash = await instanceStatus(containers[1])
  const beforeProcessContainer = await containerState(containers[1])
  const beforePid = await instanceProcess(containers[1])
  await docker([
    'exec',
    containers[1],
    'node',
    '-e',
    "process.kill(Number(process.argv[1]), 'SIGKILL')",
    String(beforePid),
  ])
  const recovered = await poll(
    'Maestrly process recovery with its pause and takeover',
    async () => {
      const state = await instanceStatus(containers[1])
      const scout = state.bots.find((entry) => entry.botId === scoutId)
      const partner = state.bots.find((entry) => entry.botId === partnerId)
      return scout?.status.ready &&
        partner?.status.ready &&
        scout.status.hold.reason === 'paused' &&
        partner.status.hold.reason === 'takeover' &&
        (await instanceProcess(containers[1])) !== beforePid
        ? state
        : null
    },
    25000
  )
  assert.deepEqual(
    recovered.bots.map((entry) => [entry.botId, entry.status.conversationId]).sort(),
    beforeProcessCrash.bots.map((entry) => [entry.botId, entry.status.conversationId]).sort()
  )
  const afterProcessContainer = await containerState(containers[1])
  assert.deepEqual(
    [afterProcessContainer.id, afterProcessContainer.startedAt],
    [beforeProcessContainer.id, beforeProcessContainer.startedAt]
  )
  await request('POST', '/v1/bots/' + partnerId + '/takeover/release', { note: null, continue: false })
  await request('POST', '/v1/bots/' + scoutId + '/resume')
  await answer(await send(partnerId, 'E2E-ALIVE tag=process-restart'), 'E2E-ALIVE-OK tag=process-restart')
  pass(
    'Maestrly process recovery',
    'same container and conversations; pause and takeover reinstalled, then a new turn answered'
  )

  const devRoute = '/v1/environments/' + devEnvId
  await request('POST', '/v1/bots/' + devId + '/restart', undefined, { timeout: 300000 })
  await poll('Dev restarted', async () => (await bot(devId)).lifecycle === 'running', 120000)
  assert.ok((await transcript(devId)).some((item) => item.kind === 'user' && item.source === 'peer' && item.queued))
  // Archiving a bot uninstalls it from its environment, which keeps running with its container and home volume.
  const devContainer = await containerState(containers[0])
  await request('POST', '/v1/bots/' + devId + '/archive')
  await poll('Dev uninstalled', async () => (await instanceStatus(containers[0])).bots.length === 0)
  const devContainerArchived = await containerState(containers[0])
  assert.equal(devContainerArchived?.running, true)
  assert.deepEqual([devContainerArchived.id, devContainerArchived.startedAt], [devContainer.id, devContainer.startedAt])
  const devEnvironment = await request('GET', devRoute)
  assert.equal(devEnvironment.lifecycle, 'running')
  assert.deepEqual(devEnvironment.botIds, [])
  assert.equal((await docker(['volume', 'inspect', containers[0] + '-home'], { allowFailure: true })).code, 0)
  assert.deepEqual((await bot(scoutId)).talksTo, [])
  pass(
    'restart and archive',
    'peer queue persisted; bot uninstalled while its environment, container and home volume stay'
  )

  const archivedDev = (await request('GET', '/v1/archived-bots')).bots
  assert.deepEqual(
    archivedDev.map((item) => [item.id, item.files]),
    [[devId, 'kept']]
  )
  assert.equal(archivedDev[0].environmentId, devEnvId)
  assert.equal((await request('POST', '/v1/archived-bots/' + devId + '/restore')).lifecycle, 'creating')
  await poll('Dev restored', async () => (await bot(devId)).lifecycle === 'running', 180000)
  // Same environment and home: the conversation from before the archive is still there, and Scout is its peer again.
  assert.ok((await transcript(devId)).some((item) => item.kind === 'user' && item.source === 'peer'))
  assert.deepEqual((await bot(devId)).talksTo, [scoutId])
  assert.deepEqual((await bot(scoutId)).talksTo, [devId])
  assert.deepEqual((await request('GET', '/v1/archived-bots')).bots, [])
  assert.deepEqual(slots(await instanceStatus(containers[0])), [[devId, 1]])

  // Another environment has accounts, owner memory and site logins of its own.
  const devImport = await request('POST', devRoute + '/accounts/import', {
    items: [
      { type: 'api-key', kind: 'openai', name: 'E2E Model', key: modelKey, baseURL: 'http://' + fakeName + ':8787/v1' },
    ],
  })
  assert.equal(devImport.results[0].outcome, 'added')
  await poll('Dev account connected', async () => (await bot(devId)).accounts.connected)
  const devSelection = await poll('Dev model selection', async () =>
    (await request('GET', '/v1/bots/' + devId + '/selections')).options.find((option) => option.modelId === 'e2e-model')
  )
  const devChoice = {
    providerId: devSelection.providerId,
    modelId: devSelection.modelId,
    reasoning: null,
    fastMode: false,
  }
  await request('PATCH', '/v1/bots/' + devId, { selection: devChoice })
  await request('PATCH', '/v1/bots/' + devId, { compaction: { ...devChoice, intervalTokens: 100000 } })
  // Dev's own environment had no default either: Dev's model became it.
  assert.deepEqual((await request('GET', devRoute)).compaction, { ...devChoice, intervalTokens: 100000 })
  assert.equal((await bot(devId)).compactionSource, 'environment')
  await poll(
    'Dev ready and done with its queue',
    async () => {
      const state = await bot(devId)
      return state.compactionState?.configured === true && state.status === 'idle'
    },
    120000
  )
  await answer(await send(devId, 'E2E-OWNER-CHECK'), 'E2E-OWNER-MISSING', { noPermission: true })
  const scoutEntry = (await request('GET', '/v1/owner-memory')).entries.find(
    (item) => item.content === 'Prefers answers in haiku.'
  )
  assert.equal(
    (await request('PATCH', '/v1/owner-memory/' + scoutEntry.id, { environmentId: null })).environmentId,
    null
  )
  await answer(await send(devId, 'E2E-OWNER-CHECK'), 'E2E-OWNER-SEEN', { noPermission: true })
  await answer(await send(devId, `E2E-COOKIE-GET url=${site}/e2e/cookie/show`), 'E2E-COOKIE-SEEN value=none', {
    approve: true,
  })
  pass(
    'environments stay apart',
    "Dev's environment got its own account; Scout's environment memory reached Dev only once made global; no shared cookie"
  )

  await request('POST', '/v1/bots/' + devId + '/archive')
  await poll('Dev uninstalled again', async () => (await instanceStatus(containers[0])).bots.length === 0)
  assert.equal((await containerState(containers[0]))?.running, true)
  const devFolders = await botFolders(containers[0], devId)
  assert.ok(devFolders.length > 0, 'Dev has no data folders to delete')
  await request('DELETE', '/v1/archived-bots/' + devId, undefined, { status: 204 })
  // The environment's Maestrly deleted the bot's data; the environment and its home volume stay.
  assert.deepEqual(await botFolders(containers[0], devId), [])
  assert.equal((await docker(['volume', 'inspect', containers[0] + '-home'], { allowFailure: true })).code, 0)
  assert.deepEqual((await request('GET', devRoute)).botIds, [])
  assert.deepEqual((await request('GET', '/v1/archived-bots')).bots, [])
  await request('GET', '/v1/bots/' + devId, undefined, { status: 404 })
  const activity = await activityEntries()
  assert.ok(activity.every((item) => item.botId !== devId))
  const deletedEntry = activity.find((item) => item.kind === 'bot_deleted')
  assert.deepEqual([deletedEntry?.botId, deletedEntry?.summary], [null, 'E2E Dev ' + suffix])
  assert.equal(deletedEntry.environmentId, devEnvId)
  memory.noBotsIdle = await idleMemorySample(
    containers[0],
    "Dev's environment after its only bot was deleted, idle, no screen open, memory settled"
  )
  // Archiving the environment removes its container and keeps its home volume; deleting it forever removes both.
  await request('POST', devRoute + '/archive', undefined, { timeout: 120000 })
  await poll(
    'Dev container removed',
    async () => (await docker(['inspect', containers[0]], { allowFailure: true })).code !== 0
  )
  assert.equal((await docker(['volume', 'inspect', containers[0] + '-home'], { allowFailure: true })).code, 0)
  await request('GET', devRoute, undefined, { status: 404 })
  assert.deepEqual(
    (await request('GET', '/v1/archived-environments')).environments.map((item) => [item.id, item.files, item.bots]),
    [[devEnvId, 'kept', []]]
  )
  await request('DELETE', '/v1/archived-environments/' + devEnvId, undefined, { status: 204 })
  assert.notEqual((await docker(['volume', 'inspect', containers[0] + '-home'], { allowFailure: true })).code, 0)
  assert.deepEqual((await request('GET', '/v1/archived-environments')).environments, [])
  await poll(
    'environment removed event',
    () => events.some((event) => event.type === 'environment.removed' && event.environmentId === devEnvId),
    10000
  )
  const legacyActivity = await activityEntries()
  const fullActivity = await activityEntries(true)
  assert.ok(legacyActivity.every((entry) => !entry.kind.startsWith('environment_')))
  const fullSeqs = new Set(fullActivity.map((entry) => entry.seq))
  assert.ok(legacyActivity.every((entry) => fullSeqs.has(entry.seq)))
  const deletedEnvironment = fullActivity.find(
    (entry) => entry.kind === 'environment_deleted' && entry.environmentId === devEnvId
  )
  assert.deepEqual([deletedEnvironment?.botId, deletedEnvironment?.summary], [null, 'E2E Dev ' + suffix])
  pass(
    'restore and delete forever',
    'conversation and peer back after restore; bot data gone after delete; environment archive kept the volume, ' +
      'delete forever removed it and its records'
  )
  for (const name of containers) {
    const stat = await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', name], { allowFailure: true })
    if (stat.code === 0) timings[name + 'Memory'] = stat.stdout.trim()
  }
  const imageSizes = await Promise.all(
    ['maestrly/bot-gateway:local', 'maestrly/bot-instance:local'].map(async (image) => [
      image,
      (await docker(['image', 'inspect', image, '--format', '{{.Size}}'])).stdout.trim(),
    ])
  )
  // Browser keyboard focus between the screens of one environment, in a container of its own. That test always removes
  // its own container and volume, even with --keep, and saves its report under .bot-fleet-local/focus/.
  const focus = await run(process.execPath, [path.join(root, 'scripts/test-bot-fleet-focus.mjs')])
  const focusSummary = JSON.parse(focus.stdout.trim().split('\n').at(-1))
  pass(
    'browser keyboard focus',
    focusSummary.checks +
      " checks over RFB: Alpha kept the keyboard through settings, a new browser, Beta's popup and its dialogs, and " +
      'Alt+Tab; its own popup, the release and the environment screen took it in turn; report ' +
      focusSummary.report
  )
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        project,
        durationMs: Date.now() - started,
        timings,
        memory,
        observations,
        imageSizes,
        steps: results,
      },
      null,
      2
    )
  )
}
/**
 * The host's bot memory is the sum of the environments' container figures, each counted once, as the gateway measured
 * them in the refresh that preceded the host update.
 */
async function hostCountsEachEnvironmentOnce() {
  const from = events.length
  const update = await poll(
    'host update',
    () => events.slice(from).find((event) => event.type === 'host.updated'),
    30000
  )
  const latest = new Map()
  for (const event of events.slice(0, events.indexOf(update))) {
    if (event.type === 'environment.updated') latest.set(event.environment.id, event.environment)
    if (event.type === 'environment.removed') latest.delete(event.environmentId)
  }
  const environments = [...latest.values()].filter((environment) => environment.resources.memoryBytes !== null)
  const sum = environments.reduce((total, environment) => total + environment.resources.memoryBytes, 0)
  assert.equal(update.host.memory.botsBytes, sum)
  return { botsBytes: sum, environments: environments.length }
}
try {
  await main()
} catch (error) {
  console.error('FAIL: ' + (error.stack ?? error))
  console.error(
    JSON.stringify(
      {
        result: 'FAIL',
        project,
        durationMs: Date.now() - started,
        failedAfter: results.at(-1)?.name ?? null,
        timings,
        memory,
        observations,
        steps: results,
      },
      null,
      2
    )
  )
  if (composeEnv) {
    for (const name of [...containers, fakeName]) {
      const logs = await docker(['logs', '--tail', '80', name], { allowFailure: true })
      if (logs.code === 0) console.error(name + ' logs:\n' + (logs.stdout + logs.stderr).slice(-7000))
    }
    const logs = await compose(['logs', '--tail', '80'], { allowFailure: true })
    console.error('gateway logs:\n' + (logs.stdout + logs.stderr).slice(-7000))
  }
  process.exitCode = 1
} finally {
  await cleanup()
}
