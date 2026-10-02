#!/usr/bin/env node
// The Linux desktop of each bot in a real environment container, one scenario at a time. It runs every scenario, or the
// ones named by --only <name>[,<name>]: node scripts/bot-fleet-images.mjs --only bot, then
// node scripts/test-bot-fleet-desktop.mjs --only look.
//
//   look   Each bot's apps display (:1, :2) has its own wallpaper, painted from the bot's tint, with the dock over its
//          bottom center, a running window manager and taskbar, and dark Maestrly title bars. Updating a bot's tint
//          paints its wallpaper again.
//
// More scenarios register in `scenarios` below. It runs the bot image as it is, MAESTRLY_GATEWAY_BOT_IMAGE as for the
// gateway or maestrly/bot-instance:local, and never pulls, builds or tags an image. It installs synthetic bots through the
// instance's control API, generates the credentials for the run and redacts them from everything it prints or writes. The
// report, the screen captures and the container's log go to .bot-fleet-local/desktop/. It always removes the container
// and the volume it created, found by a label unique to the run, and exits nonzero when a check, a step or the cleanup
// fails.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const image = process.env.MAESTRLY_GATEWAY_BOT_IMAGE || 'maestrly/bot-instance:local'
const suffix = randomBytes(6).toString('hex')
const name = 'maestrly-desktop-test-' + suffix
const volume = name + '-home'
const runLabel = 'org.maestrly.desktop-test=' + suffix
const outputDirectory = path.join(root, '.bot-fleet-local/desktop')
const reportFile = path.join(outputDirectory, name + '.json')
const logFile = path.join(outputDirectory, name + '.container.log')
const captureFile = (label) => path.join(outputDirectory, name + '-' + label + '.png')
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
const SCREEN = { width: 1280, height: 800 }
// How far a pixel may be from a color it should have, per channel. The wallpaper is rendered once and shown as it is, but
// its soft highlight reaches the corner a little.
const TOLERANCE = 16
const execFileAsync = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (text) => console.log(redact(text))
const result = { image, container: name, scenarios: [], steps: [], checks: [], captures: [] }
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
/** Runs a program in the container, as the bot, on one of its displays. */
const onDisplay = (display, program, ...args) => docker(['exec', '-e', 'DISPLAY=' + display, name, program, ...args])
const inContainer = (script) => docker(['exec', name, 'sh', '-c', script])
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
function step(label, extra = {}) {
  if (interrupted) throw new Error('Interrupted')
  const entry = { label, ...extra }
  result.steps.push(entry)
  log(JSON.stringify(entry))
  return entry
}
function check(label, pass, detail) {
  result.checks.push({ label, pass, ...(detail === undefined ? {} : { detail }) })
  log((pass ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' ' + JSON.stringify(detail)))
}

/** The bots of the run: synthetic names, and tints far enough apart to tell their wallpapers apart. */
const BOTS = [
  { botId: 'alpha', name: 'Alpha', slot: 1, tint: '#8b6cf0' },
  { botId: 'beta', name: 'Beta', slot: 2, tint: '#3f9fd8' },
]
const install = (bot) =>
  request(
    '/v1/bots/' + bot.botId,
    {
      profile: {
        botId: bot.botId,
        name: bot.name,
        instructions: 'Synthetic desktop fixture.',
        ceiling: 'full',
        selection: null,
        compaction: null,
        gateway: { peersEnabled: false },
        tint: bot.tint,
      },
      slot: bot.slot,
      gatewayToken,
    },
    'PUT'
  )

// ---- Pictures of a display, read inside the container with ImageMagick --------------------------------------------

const rgb = (text) => {
  const match = /srgba?\((\d+),(\d+),(\d+)/.exec(text)
  if (!match) throw new Error('Not a pixel: ' + text)
  return match.slice(1, 4).map(Number)
}
const hexRgb = (color) => [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16))
const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= TOLERANCE)
const pixel = async (file, x, y) => rgb(await inContainer(`convert ${file} -format '%[pixel:p{${x},${y}}]' info:`))
/** The average color of a region, given as [width, height, x, y]. */
async function meanColor(file, [width, height, x, y]) {
  const output = await inContainer(
    `convert ${file} -crop ${width}x${height}+${x}+${y} +repage ` +
      `-format '%[fx:int(255*mean.r)],%[fx:int(255*mean.g)],%[fx:int(255*mean.b)]' info:`
  )
  return output.split(',').map(Number)
}
/** How many pixels of two regions differ by more than a few percent. */
async function differing(first, second, [width, height, x, y]) {
  const crop = `-crop ${width}x${height}+${x}+${y} +repage`
  const output = await inContainer(
    `convert ${first} ${crop} /tmp/a.png && convert ${second} ${crop} /tmp/b.png && ` +
      `(compare -metric AE -fuzz 4% /tmp/a.png /tmp/b.png null: 2>&1; true)`
  )
  return Number.parseInt(output, 10)
}
/** The apps display of a bot, as the container shows it: a picture of the root window. */
async function capture(bot, label) {
  const file = `/tmp/${label}-${bot.slot}.png`
  await onDisplay(':' + bot.slot, 'import', '-window', 'root', file)
  const local = captureFile(`${label}-slot${bot.slot}`)
  await docker(['cp', `${name}:${file}`, local])
  if (!result.captures.includes(path.relative(root, local))) result.captures.push(path.relative(root, local))
  return file
}
const wallpaperFolder = (bot) => `/home/bot/.cache/maestrly-bots/${bot.botId}`
/** The first color of the wallpaper's gradient, which is the color of its top left corner. */
const firstStop = async (bot) =>
  hexRgb(
    /<linearGradient[^>]*>\s*<stop offset="0" stop-color="(#[0-9a-f]{6})"/.exec(
      await inContainer(`cat ${wallpaperFolder(bot)}/wallpaper.svg`)
    )?.[1] ?? '#000000'
  )

// ---- Scenarios ---------------------------------------------------------------------------------------------------

/** A window manager of the display's own, and a taskbar window, found through the display itself. */
async function desktopPrograms(bot) {
  const display = ':' + bot.slot
  const taskbar = (await onDisplay(display, 'xdotool', 'search', '--class', 'tint2').catch(() => '')).split('\n')[0]
  const manager = (await onDisplay(display, 'xprop', '-root', '_NET_SUPPORTING_WM_CHECK').catch(() => '')).split(
    '# '
  )[1]
  const managerName = manager
    ? await onDisplay(display, 'xprop', '-id', manager.trim(), '_NET_WM_NAME').catch(() => '')
    : ''
  return { taskbar: taskbar || null, windowManager: /"([^"]+)"/.exec(managerName)?.[1] ?? null }
}

async function look() {
  for (const bot of BOTS) {
    await poll(bot.name + "'s wallpaper", async () => {
      const root = await onDisplay(':' + bot.slot, 'xprop', '-root', '_XROOTPMAP_ID')
      return /pixmap id/.test(root) && (await desktopPrograms(bot)).taskbar !== null
    })
  }
  // Every bot gets its own wallpaper, window manager and taskbar.
  for (const bot of BOTS) {
    const programs = await desktopPrograms(bot)
    step('desktop programs of ' + bot.name, programs)
    check(`${bot.name}'s display runs Openbox`, programs.windowManager === 'Openbox', programs)
    check(`${bot.name}'s display runs tint2`, programs.taskbar !== null, programs)
    const svg = await inContainer(`cat ${wallpaperFolder(bot)}/wallpaper.svg`)
    check(
      `${bot.name}'s wallpaper shows its name and tint`,
      svg.includes('>' + bot.name + '</text>') && svg.includes(`fill="${bot.tint}"`),
      { folder: wallpaperFolder(bot) }
    )
    const shot = await capture(bot, 'look')
    const [stop, corner] = [await firstStop(bot), await pixel(shot, 20, 20)]
    check(`${bot.name}'s top left corner has the first color of its gradient`, near(corner, stop), { corner, stop })
    const reference = `${wallpaperFolder(bot)}/wallpaper.png`
    // The dock floats over the bottom center: the bottom 90 pixels differ from the wallpaper there, and only there.
    const center = await differing(shot, reference, [320, 90, 480, SCREEN.height - 90])
    const sides = await differing(shot, reference, [400, SCREEN.height, 0, 0])
    const above = await differing(shot, reference, [SCREEN.width, SCREEN.height - 90, 0, 0])
    check(`${bot.name}'s dock covers the bottom center of the wallpaper`, center > 5_000, { differingPixels: center })
    check(`${bot.name}'s wallpaper is untouched beside and above the dock`, sides <= 100 && above <= 100, {
      sides,
      above,
    })
  }
  const [alpha, beta] = BOTS
  const alphaStop = await firstStop(alpha)
  const betaStop = await firstStop(beta)
  check('the two bots have different gradients', alphaStop.join() !== betaStop.join(), { alphaStop, betaStop })

  // Dark title bars: a window on the display gets the Maestrly theme's colors. xterm asks for the top left corner of its
  // frame at 300,200, so its title bar spans the 40 pixels below that, and the label stays at its left end.
  await docker([
    'exec',
    '-d',
    '-e',
    'DISPLAY=:' + alpha.slot,
    name,
    'sh',
    '-c',
    // Not a shell: its prompt would retitle the window.
    'exec xterm -T look-window -geometry 60x12+300+200 -e sleep 600 >/tmp/look-window.log 2>&1',
  ])
  await poll('the look-window window', async () => {
    const found = await onDisplay(':' + alpha.slot, 'xdotool', 'search', '--onlyvisible', '--name', '^look-window$')
    return found.length > 0
  }).catch(async (error) => {
    throw new Error(`${error.message}; xterm said: ${await inContainer('cat /tmp/look-window.log; true')}`)
  })
  await sleep(1500)
  const windowShot = await capture(alpha, 'window')
  const bar = await meanColor(windowShot, [140, 20, 440, 210])
  check(
    'a window gets the dark title bar of the Maestrly theme',
    near(bar, hexRgb('#1c1c1f')) && bar.every((v) => v < 60),
    {
      bar,
    }
  )
  await inContainer('pkill -x xterm || true')

  // A new tint paints the wallpaper again, with the new first color.
  const recolored = { ...alpha, tint: '#d9693f' }
  await install(recolored)
  await poll("Alpha's new wallpaper", async () => {
    const shot = await capture(recolored, 'recolored')
    return near(await pixel(shot, 20, 20), await firstStop(recolored))
  })
  const repainted = await pixel(`/tmp/recolored-${alpha.slot}.png`, 20, 20)
  const expected = await firstStop(recolored)
  check("updating Alpha's tint paints its wallpaper again", near(repainted, expected) && !near(repainted, alphaStop), {
    repainted,
    expected,
    before: alphaStop,
  })
  const untouched = await capture(beta, 'after')
  check("Beta's wallpaper does not change", near(await pixel(untouched, 20, 20), betaStop), {
    corner: await pixel(untouched, 20, 20),
    stop: betaStop,
  })
}

const scenarios = new Map([['look', { title: "The look of each bot's desktop", run: look }]])

function parseScenarios(argv) {
  const names = [...scenarios.keys()]
  let only = null
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--only') only = argv[++index] ?? ''
    else if (arg.startsWith('--only=')) only = arg.slice(7)
    else throw new Error('Usage: node scripts/test-bot-fleet-desktop.mjs [--only <' + names.join('|') + '>[,<name>]]')
  }
  if (only === null) return names
  const chosen = only.split(',').filter(Boolean)
  const unknown = chosen.filter((chosenName) => !scenarios.has(chosenName))
  if (!chosen.length || unknown.length)
    throw new Error(
      (unknown.length ? 'Unknown scenario ' + unknown.join(', ') : '--only needs a scenario') +
        '. Scenarios: ' +
        names.join(', ')
    )
  return [...new Set(chosen)]
}

async function main(chosen) {
  mkdirSync(outputDirectory, { recursive: true })
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
      'MAESTRLY_ENVIRONMENT_ID=desktop-test',
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
  for (const bot of BOTS) await install(bot)
  for (const scenario of chosen) {
    const entry = { name: scenario, title: scenarios.get(scenario).title, checks: result.checks.length }
    result.scenarios.push(entry)
    log('SCENARIO ' + scenario + ': ' + entry.title)
    await scenarios.get(scenario).run()
    entry.checksRun = result.checks.length - entry.checks
  }
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

let chosen
try {
  chosen = parseScenarios(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
try {
  await main(chosen)
} catch (error) {
  result.error = redact(error?.stack ?? error)
} finally {
  result.cleanupErrors = dockerTouched ? await cleanup() : []
  result.pass =
    !result.error &&
    result.cleanupErrors.length === 0 &&
    result.scenarios.length > 0 &&
    result.checks.length > 0 &&
    result.checks.every((entry) => entry.pass)
  try {
    mkdirSync(outputDirectory, { recursive: true })
    writeFileSync(reportFile, redact(JSON.stringify(result, null, 2)) + '\n')
  } catch (error) {
    result.pass = false
    result.cleanupErrors.push('write the report: ' + error.message)
  }
  const report = path.relative(root, reportFile)
  if (result.pass)
    log(JSON.stringify({ result: 'PASS', checks: result.checks.length, report, captures: result.captures }))
  else {
    process.exitCode = 1
    console.error(
      redact(
        [
          ...(result.error ? [result.error] : []),
          ...result.checks.filter((entry) => !entry.pass).map((entry) => 'Failed check: ' + entry.label),
          ...result.cleanupErrors.map((entry) => 'Cleanup failed: ' + entry),
          'Bot desktop FAIL (' + result.checks.length + ' checks); report ' + report,
        ].join('\n')
      )
    )
  }
}
