#!/usr/bin/env node
// Browser keyboard focus between the screens of a real environment container. npm run test:e2e:bot-fleet runs it.
//
// The owner controls Alpha's browser through the instance's RFB control tunnel, which sends real key and pointer
// events to the environment display (not CDP input), while the other screens change: settings open from another
// device, a new bot's browser starts, and Beta's page opens a popup with native dialogs. Alpha keeps the keyboard until
// its own popup opens, and gets it back when that popup closes. Once the control ends, Beta's popup gets its input
// back, and controlling the environment screen gives the keyboard to Maestrly's settings. The bots' own actions on
// their screens (navigating, clicking, typing) use xdotool inside the container.
//
// It runs the bot image as it is, MAESTRLY_GATEWAY_BOT_IMAGE as for the gateway or maestrly/bot-instance:local, and
// never pulls, builds or tags an image. The credentials are generated for the run and redacted from everything it
// prints or writes. The report and the container's log go to .bot-fleet-local/focus/. It always removes the container
// and the volume it created, found by a label unique to the run, and exits nonzero when a check, a step or the cleanup
// fails.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

if (process.argv.length > 2) throw new Error('Usage: node scripts/test-bot-fleet-focus.mjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const image = process.env.MAESTRLY_GATEWAY_BOT_IMAGE || 'maestrly/bot-instance:local'
const suffix = randomBytes(6).toString('hex')
const name = 'maestrly-focus-test-' + suffix
const volume = name + '-home'
const runLabel = 'org.maestrly.focus-test=' + suffix
const reportFile = path.join(root, '.bot-fleet-local/focus', name + '.json')
const logFile = path.join(root, '.bot-fleet-local/focus', name + '.container.log')
// Credentials of this run only. The container gets them through the docker client's environment, not its arguments.
const credentials = {
  MAESTRLY_BOT_CONTROL_TOKEN: randomBytes(32).toString('base64url'),
  MAESTRLY_BOT_KEYRING_PASSWORD: randomBytes(24).toString('base64url'),
}
const gatewayToken = randomBytes(32).toString('base64url')
const redact = (text) =>
  [...Object.values(credentials), gatewayToken].reduce(
    (value, secret) => value.split(secret).join('[redacted]'),
    String(text)
  )
const headers = {
  'X-Maestrly-Fleet-Protocol': '1',
  Authorization: 'Bearer ' + credentials.MAESTRLY_BOT_CONTROL_TOKEN,
  'Content-Type': 'application/json',
}
// The environment display :0 is a grid of 1280x800 tiles, three per row: tile 0 shows Maestrly's settings, and tile
// <slot> the browser of the bot in that slot.
const TILE = { width: 1280, height: 800, columns: 3 }
/**
 * A bot's browser window in its tile once its desktop presents it (DEFAULT_PRESENTER_GEOMETRY): at the top left, this
 * size, without an identity strip. Its tab strip and address bar take the top 78 pixels.
 */
const PRESENTED = { width: 1120, height: 640, addressBarY: 58 }
const KEYSYM = { alt: 0xffe9, tab: 0xff09, f4: 0xffc1 }
const browserWindow = (botName) => botName + ' — Browser'
const execFileAsync = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (text) => console.log(redact(text))
const sockets = new Set()
const result = { image, container: name, steps: [], checks: [] }
let port
let dockerTouched = false
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    interrupted = true
  })

async function docker(args, options = {}) {
  try {
    const { stdout } = await execFileAsync('docker', args, { maxBuffer: 16 * 1024 ** 2, timeout: 120_000, ...options })
    return stdout.trim()
  } catch (error) {
    // The arguments may hold the fixture's source; the first few name the command well enough.
    const reason = error.stderr?.trim() || (error.killed ? 'timed out' : 'failed with ' + (error.code ?? error.signal))
    throw new Error(redact('docker ' + args.slice(0, 5).join(' ') + ': ' + reason))
  }
}
const xdotool = (...args) => docker(['exec', '-e', 'DISPLAY=:0', name, 'xdotool', ...args])
const tryXdotool = (...args) => xdotool(...args).catch(() => '')
/** What the fixture pages reported: pages loaded, events, typed values, and its clock (`now`). */
const fixture = async () =>
  JSON.parse(
    await docker([
      'exec',
      name,
      'node',
      '-e',
      "fetch('http://127.0.0.1:8111/state').then((response) => response.text()).then(console.log)",
    ])
  )
async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch('http://127.0.0.1:' + port + route, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(method + ' ' + route + ' HTTP ' + response.status + ': ' + (await response.text()))
  return response.status === 204 ? null : response.json()
}
async function poll(what, test, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs
  let last
  for (;;) {
    if (interrupted) throw new Error('Interrupted')
    try {
      if (await test()) return
    } catch (error) {
      last = error
    }
    if (Date.now() >= until) throw new Error('Timed out waiting for ' + what + (last ? ': ' + last.message : ''))
    await sleep(500)
  }
}
const keyboardFocus = async () => ({
  focus: await tryXdotool('getwindowfocus', 'getwindowname'),
  active: await tryXdotool('getactivewindow', 'getwindowname'),
})
async function geometry(title) {
  const shell = await tryXdotool('search', '--onlyvisible', '--name', '^' + title + '$', 'getwindowgeometry', '--shell')
  const value = (key) => Number(new RegExp('^' + key + '=(-?\\d+)', 'm').exec(shell)?.[1])
  return { x: value('X'), y: value('Y'), width: value('WIDTH'), height: value('HEIGHT') }
}
const tileOrigin = (slot) => ({
  x: (slot % TILE.columns) * TILE.width,
  y: Math.floor(slot / TILE.columns) * TILE.height,
})
function insideTile(area, slot) {
  const { x, y } = tileOrigin(slot)
  return area.x >= x && area.y >= y && area.x + area.width <= x + TILE.width && area.y + area.height <= y + TILE.height
}
async function step(label, extra = {}) {
  if (interrupted) throw new Error('Interrupted')
  const entry = { label, ...(await keyboardFocus()), ...extra }
  result.steps.push(entry)
  log(JSON.stringify(entry))
  return entry
}
function check(label, pass, detail) {
  result.checks.push({ label, pass, ...(detail === undefined ? {} : { detail }) })
  log((pass ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' ' + JSON.stringify(detail)))
}

/** The owner's side: the instance's RFB control tunnel for a screen, as the gateway forwards it. */
async function control(route) {
  const { socket, head } = await new Promise((resolve, reject) => {
    const upgrade = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      headers: { ...headers, Connection: 'Upgrade', Upgrade: 'maestrly-rfb' },
      timeout: 30_000,
    })
    upgrade.on('upgrade', (_response, socket, head) => resolve({ socket, head }))
    upgrade.on('response', (response) => {
      response.resume()
      reject(new Error('Control of ' + route + ' refused: HTTP ' + response.statusCode))
    })
    upgrade.on('timeout', () => upgrade.destroy(new Error('Control of ' + route + ' timed out')))
    upgrade.on('error', reject)
    upgrade.end()
  })
  sockets.add(socket)
  let buffer = Buffer.from(head)
  let failure
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
  })
  socket.on('error', (error) => {
    failure = error
  })
  socket.on('close', () => {
    failure ??= new Error('Control of ' + route + ' closed')
  })
  const take = async (size) => {
    const until = Date.now() + 30_000
    while (buffer.length < size) {
      if (failure) throw failure
      if (Date.now() >= until) throw new Error('Timed out waiting for RFB data from ' + route)
      await sleep(50)
    }
    const bytes = buffer.subarray(0, size)
    buffer = buffer.subarray(size)
    return bytes
  }
  const send = async (bytes, pauseMs) => {
    if (failure) throw failure
    socket.write(bytes)
    await sleep(pauseMs)
  }
  await take(12)
  socket.write('RFB 003.008\n')
  const securityTypes = await take((await take(1))[0])
  if (!securityTypes.includes(1)) throw new Error('Control of ' + route + ' offers no RFB None security')
  socket.write(Buffer.from([1]))
  if ((await take(4)).readUInt32BE(0) !== 0) throw new Error('Control of ' + route + ' failed the RFB handshake')
  // ClientInit, shared; then ServerInit and the desktop name.
  socket.write(Buffer.from([1]))
  const serverInit = await take(24)
  await take(serverInit.readUInt32BE(20))
  const key = (keysym, down) => {
    const event = Buffer.alloc(8)
    event[0] = 4
    event[1] = down ? 1 : 0
    event.writeUInt32BE(keysym, 4)
    return send(event, 25)
  }
  return {
    async click(x, y) {
      for (const buttons of [0, 1, 0]) {
        const event = Buffer.alloc(6)
        event[0] = 5
        event[1] = buttons
        event.writeUInt16BE(x, 2)
        event.writeUInt16BE(y, 4)
        await send(event, 80)
      }
    },
    /** Types ASCII text; each character's keysym is its code point. */
    async text(value) {
      for (const character of value) for (const down of [true, false]) await key(character.codePointAt(0), down)
    },
    async press(...keysyms) {
      for (const keysym of keysyms) await key(keysym, true)
      for (const keysym of [...keysyms].reverse()) await key(keysym, false)
    },
    close() {
      socket.destroy()
      sockets.delete(socket)
    },
  }
}

const addBot = (botId, botName, slot) =>
  request(
    '/v1/bots/' + botId,
    {
      profile: {
        botId,
        name: botName,
        instructions: 'Synthetic focus fixture.',
        ceiling: 'full',
        selection: null,
        compaction: null,
        gateway: { peersEnabled: false },
      },
      slot,
      gatewayToken,
    },
    'PUT'
  )
const browserOpen = async (botName) =>
  (await xdotool('search', '--onlyvisible', '--name', browserWindow(botName))).length > 0
/** Opens a fixture page in the browser of the bot in `slot` as that bot would: through the address bar. */
async function navigate(slot, page) {
  const { x, y } = tileOrigin(slot)
  await xdotool('mousemove', String(x + 500), String(y + PRESENTED.addressBarY), 'click', '1', 'key', 'ctrl+a')
  await xdotool('type', '--clearmodifiers', '--delay', '0', '--', 'http://127.0.0.1:8111/' + page)
  await xdotool('key', 'Return')
  await poll('page ' + page, async () => (await fixture()).ready.includes(page))
}

async function main() {
  mkdirSync(path.dirname(reportFile), { recursive: true })
  result.imageId = await docker(['image', 'inspect', image, '--format', '{{.Id}}']).catch((error) => {
    throw new Error('Bot image ' + image + ' is not available locally (' + error.message + ')')
  })
  dockerTouched = true
  await docker(['volume', 'create', '--label', runLabel, volume])
  await docker(
    [
      'create',
      '--pull',
      'never',
      '--name',
      name,
      '--label',
      runLabel,
      '--init',
      '--memory',
      '3g',
      '--shm-size',
      '1g',
      '--security-opt',
      'seccomp=' + path.join(root, 'deploy/bot-fleet/seccomp-bot.json'),
      '-e',
      'MAESTRLY_BOT_MODE=1',
      '-e',
      'MAESTRLY_ENVIRONMENT_ID=focus-test',
      ...Object.keys(credentials).flatMap((variable) => ['-e', variable]),
      '-p',
      '127.0.0.1::7680',
      '-v',
      volume + ':/home/bot',
      result.imageId,
    ],
    { env: { ...process.env, ...credentials } }
  )
  await docker(['start', name])
  port = Number((await docker(['port', name, '7680/tcp'])).split('\n')[0].split(':').at(-1))
  await poll('instance health', async () => (await request('/v1/health')).ready, 120_000)
  const pages = readFileSync(path.join(root, 'deploy/bot-fleet/test/focus-pages.cjs'), 'utf8')
  await docker(['exec', '-d', name, 'node', '-e', pages])
  await poll('fixture pages', () => fixture())
  await addBot('alpha', 'Alpha', 1)
  await addBot('beta', 'Beta', 2)
  for (const botName of ['Alpha', 'Beta']) await poll(botName + "'s browser", () => browserOpen(botName))
  // Each bot's desktop shows its browser once the bot starts, which gives the browser its presented size.
  for (const botName of ['Alpha', 'Beta'])
    await poll(botName + "'s presented browser", async () => {
      const area = await geometry(browserWindow(botName))
      return area.width === PRESENTED.width && area.height === PRESENTED.height
    })
  await sleep(3000)
  await navigate(1, 'alpha')
  await navigate(2, 'beta')
  await step('before control')
  // Beta's page opens its popup some seconds after this click, while the owner controls Alpha's screen.
  const beta = tileOrigin(2)
  await xdotool('mousemove', String(beta.x + TILE.width / 2), String(beta.y + TILE.height / 2), 'click', '1')
  await poll("Beta's click", async () => (await fixture()).ready.includes('beta-clicked'))
  await request('/v1/bots/alpha/hold', { reason: 'takeover' })
  const alpha = await control('/v1/bots/alpha/screen/browser/control')
  const acquiredAt = await fixture()
  await sleep(700)
  const acquired = await step('control of Alpha acquired, no click')
  check(
    'acquiring control gives Alpha the keyboard without a click',
    acquired.focus === browserWindow('Alpha'),
    acquired
  )

  await request('/v1/ui/open', { target: 'main' })
  await sleep(1500)
  const settings = await step('settings opened from another device')
  check('ui/open does not take the keyboard from Alpha', settings.focus === browserWindow('Alpha'), settings)

  await addBot('gamma', 'Gamma', 3)
  await poll("Gamma's browser", () => browserOpen('Gamma'))
  await sleep(1000)
  const gamma = await step('a new bot browser opened')
  check('a new bot browser does not take the keyboard from Alpha', gamma.focus === browserWindow('Alpha'), gamma)

  // Beta's popup reports this event just before its dialogs, so it counts as opened even if a dialog blocks it.
  const popupOpened = (state) => state.events.find(([event]) => event === 'modal-before')?.[1]
  await poll("Beta's popup", async () => popupOpened(await fixture()) !== undefined, 60_000)
  await sleep(800)
  let state = await fixture()
  const timing = { popupAtMs: popupOpened(state), controlAcquiredAtMs: acquiredAt.now }
  const betaPopup = await step("Beta's popup opened", timing)
  check("Beta's popup opened while Alpha was controlled", timing.popupAtMs > timing.controlAcquiredAtMs, timing)
  check("Beta's popup does not take the keyboard from Alpha", betaPopup.focus === browserWindow('Alpha'), betaPopup)
  const betaPopupArea = await geometry('popup')
  check("Beta's popup stays in Beta's tile", insideTile(betaPopupArea, 2), betaPopupArea)

  await alpha.text('owner-alpha')
  await sleep(800)
  state = await fixture()
  const typed = state.values.alpha === 'owner-alpha' && state.values.popup === ''
  check('owner typing lands in Alpha only', typed, state.values)
  const dialogEvents = state.events
    .map(([event]) => event)
    .filter((event) => /^(?:root-)?(?:modal|confirm)-/.test(event))
  check(
    "Beta's popup alert does not block its script",
    dialogEvents.includes('modal-before') && dialogEvents.includes('modal-after'),
    dialogEvents
  )
  check(
    "Beta's popup confirmation is canceled",
    dialogEvents.includes('confirm-false') && !dialogEvents.includes('confirm-true'),
    dialogEvents
  )
  check(
    "Beta's page alert does not block its script",
    dialogEvents.includes('root-modal-before') && dialogEvents.includes('root-modal-after'),
    dialogEvents
  )
  check(
    "Beta's page confirmation follows its default accept policy",
    dialogEvents.includes('root-confirm-true'),
    dialogEvents
  )
  // A native dialog that took the keyboard would still hold it: the remaining steps could only time out.
  if (!typed) throw new Error("The owner's typing did not reach Alpha alone")

  // Alt+Tab would cycle the window manager's focus into other tiles; the environment display has no such binding.
  await alpha.press(KEYSYM.alt, KEYSYM.tab)
  await sleep(600)
  const cycled = await step('Alt+Tab from Alpha')
  check('Alt+Tab keeps the keyboard in Alpha', cycled.focus === browserWindow('Alpha'), cycled)

  // The "Open popup" button fills the bottom of Alpha's page.
  await alpha.click(PRESENTED.width / 2, PRESENTED.height - 40)
  await poll("Alpha's popup", async () => (await fixture()).ready.includes('alpha-popup'))
  await sleep(800)
  const alphaPopup = await step("Alpha's own popup opened")
  check("Alpha's popup takes the keyboard", alphaPopup.focus === 'alpha-popup', alphaPopup)
  const alphaPopupArea = await geometry('alpha-popup')
  check("Alpha's popup stays in Alpha's tile", insideTile(alphaPopupArea, 1), alphaPopupArea)
  await alpha.text('in-popup')
  await sleep(600)
  await alpha.press(KEYSYM.alt, KEYSYM.f4)
  await sleep(1200)
  const closed = await step("Alpha's popup closed")
  check("closing Alpha's popup returns the keyboard to Alpha", closed.focus === browserWindow('Alpha'), closed)
  await alpha.text('X')
  await sleep(800)
  state = await fixture()
  check(
    'typing reaches only Alpha and its popup',
    state.values.alpha === 'owner-alphaX' && state.values.alphaPopup === 'in-popup' && state.values.popup === '',
    state.values
  )
  await alpha.press(KEYSYM.alt, KEYSYM.f4)
  await sleep(800)
  const browserClose = await step('Alt+F4 on the controlled browser')
  check('closing the bot browser keeps it in its tile', browserClose.focus === browserWindow('Alpha'), browserClose)
  await alpha.text('Y')
  await sleep(500)
  state = await fixture()
  check('typing still reaches the browser after Alt+F4', state.values.alpha === 'owner-alphaXY', state.values)

  alpha.close()
  await sleep(2000)
  await xdotool('search', '--onlyvisible', '--name', '^popup$', 'windowactivate', '--sync')
  await sleep(500)
  await xdotool('type', '--delay', '30', 'after')
  await sleep(800)
  state = await fixture()
  const released = await step("control released, Beta's popup activated and typed into")
  check("releasing the control gives Beta's popup its input back", state.values.popup === 'after', {
    ...released,
    values: state.values,
  })

  const environment = await control('/v1/screen/environment/control')
  await sleep(1000)
  const environmentFocus = await step('environment screen control acquired')
  check(
    'controlling the environment screen gives it the keyboard',
    environmentFocus.focus === 'Maestrly',
    environmentFocus
  )
  environment.close()
  await sleep(500)
  result.fixture = await fixture()
}

/** Removes the container and the volume of this run, found by its label, after saving the container's log. */
async function cleanup() {
  const errors = []
  const attempt = async (what, action) => {
    try {
      return await action()
    } catch (error) {
      errors.push(what + ': ' + redact(error.message))
    }
  }
  const list = async (args) => (await docker([...args, '--filter', 'label=' + runLabel])).split(/\s+/).filter(Boolean)
  const containers = (await attempt('list containers', () => list(['ps', '-aq']))) ?? []
  if (containers.length) {
    await attempt('save the container log', async () => {
      const logs = await execFileAsync('docker', ['logs', '--tail', '300', name], {
        maxBuffer: 16 * 1024 ** 2,
        timeout: 60_000,
      })
      writeFileSync(logFile, redact(logs.stdout + logs.stderr))
    })
    await attempt('remove the container', () => docker(['rm', '-f', ...containers]))
  }
  const volumes = (await attempt('list volumes', () => list(['volume', 'ls', '-q']))) ?? []
  if (volumes.length) await attempt('remove the volume', () => docker(['volume', 'rm', ...volumes]))
  const left = await attempt('list what remains', async () => [
    ...(await list(['ps', '-aq'])),
    ...(await list(['volume', 'ls', '-q'])),
  ])
  if (left?.length) errors.push('left behind: ' + left.join(', '))
  return errors
}

try {
  await main()
} catch (error) {
  result.error = redact(error?.stack ?? error)
} finally {
  for (const socket of sockets) socket.destroy()
  // After a failure, what the pages reported (loads, dialog and focus events, values) helps explain it.
  if (dockerTouched && !result.fixture) result.fixture = await fixture().catch(() => null)
  result.cleanupErrors = dockerTouched ? await cleanup() : []
  result.pass = !result.error && result.cleanupErrors.length === 0 && result.checks.every((entry) => entry.pass)
  try {
    mkdirSync(path.dirname(reportFile), { recursive: true })
    writeFileSync(reportFile, redact(JSON.stringify(result, null, 2)) + '\n')
  } catch (error) {
    result.pass = false
    result.cleanupErrors.push('write the report: ' + error.message)
  }
  const report = path.relative(root, reportFile)
  if (result.pass) log(JSON.stringify({ result: 'PASS', checks: result.checks.length, report }))
  else {
    process.exitCode = 1
    console.error(
      redact(
        [
          ...(result.error ? [result.error] : []),
          ...result.checks.filter((entry) => !entry.pass).map((entry) => 'Failed check: ' + entry.label),
          ...result.cleanupErrors.map((entry) => 'Cleanup failed: ' + entry),
          'Browser keyboard focus FAIL (' + result.checks.length + ' checks); report ' + report,
        ].join('\n')
      )
    )
  }
}
