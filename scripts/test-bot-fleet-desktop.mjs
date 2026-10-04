#!/usr/bin/env node
// The Linux desktop of each bot in a real environment container, one scenario at a time. It runs every scenario, or the
// ones named by --only <name>[,<name>]: node scripts/bot-fleet-images.mjs --only bot, then
// node scripts/test-bot-fleet-desktop.mjs --only look.
//
//   look      Each bot's apps display (:1, :2) has its own wallpaper, painted from the bot's tint, with the dock over its
//             bottom center, a running window manager and taskbar, and dark Maestrly title bars. Updating a bot's tint
//             paints its wallpaper again.
//   terminal  The dock's Terminal opens a window on the bot's own terminal; closing the window keeps the shell, and the
//             dock opens the same shell again.
//   files     The dock's Files shows the bot's home folder, with a file its shell just wrote, which opens in the editor.
//   url       A link a program on the bot's desktop opens lands in the bot's Maestrly browser, not in Chromium.
//   browser   Each bot's desktop shows its own Maestrly browser as a window, with its own page, at the window's size,
//             and the window comes back where it was after its presenter restarts.
//   typing    Typing on two bots' desktops at once reaches exactly each bot's own page, accents included, and the
//             address bar takes an address typed on the desktop.
//   clipboard Text copied in a desktop program pastes into the bot's page, and text copied there pastes back.
//   popup     A sign-in popup opens inside the presented browser, takes typing and closes from its title bar.
//   resize    Resizing the browser window on one bot's desktop resizes that bot's browser only.
//   forward   A link opened while the owner works in another window raises the browser without taking the keyboard,
//             and a terminal window opened for the bot's own work does not take it either.
//
// More scenarios register in `scenarios` below. It runs the bot image as it is, MAESTRLY_GATEWAY_BOT_IMAGE as for the
// gateway or maestrly/bot-instance:local, and never pulls, builds or tags an image. It installs synthetic bots through the
// instance's control API, generates the credentials for the run and redacts them from everything it prints or writes. The
// report, the screen captures and the container's log go to .bot-fleet-local/desktop/. It always removes the container
// and the volume it created, found by a label unique to the run, and exits nonzero when a check, a step or the cleanup
// fails.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

// ---- The fixture pages and the dock -------------------------------------------------------------------------------

const FIXTURE = 'http://127.0.0.1:8111'
/** What the fixture pages and programs reported: hits with their user agent, shell pids, typed values, sizes. */
const fixture = async () =>
  JSON.parse(
    await docker([
      'exec',
      name,
      'node',
      '-e',
      `fetch('${FIXTURE}/state').then((response) => response.text()).then(console.log)`,
    ])
  )
const xdotool = (bot, ...args) => onDisplay(':' + bot.slot, 'xdotool', ...args)
const windows = async (bot, ...query) =>
  (await xdotool(bot, 'search', '--onlyvisible', ...query).catch(() => '')).split('\n').filter(Boolean)
/** The dock, as tint2 shows it: its window's position and size on the bot's display. */
async function dock(bot) {
  const [panel] = await windows(bot, '--class', 'tint2')
  if (!panel) throw new Error(bot.name + ' has no dock')
  const shell = await xdotool(bot, 'getwindowgeometry', '--shell', panel)
  const value = (key) => Number(new RegExp('^' + key + '=(-?\\d+)', 'm').exec(shell)?.[1])
  return { x: value('X'), y: value('Y'), width: value('WIDTH'), height: value('HEIGHT') }
}
/** Clicks a launcher of the dock: 0 Browser, 1 Terminal, 2 Files (tint2rc: 10 px padding, 44 px icons, 8 px apart). */
async function launch(bot, index) {
  const panel = await dock(bot)
  const x = panel.x + 10 + index * (44 + 8) + 22
  const y = panel.y + Math.floor(panel.height / 2)
  await xdotool(bot, 'mousemove', String(x), String(y), 'click', '1')
}
/** Types a command into the active window of the bot's display, as its owner would, and runs it. */
async function typeCommand(bot, command) {
  await xdotool(bot, 'type', '--delay', '15', '--', command)
  await xdotool(bot, 'key', 'Return')
}
/** Opens the bot's terminal from the dock and waits for its window to take the keyboard. */
async function openTerminal(bot) {
  await launch(bot, 1)
  await poll(
    bot.name + "'s terminal window",
    async () => (await windows(bot, '--class', 'Maestrly-Terminal')).length > 0
  )
  const [window] = await windows(bot, '--class', 'Maestrly-Terminal')
  await xdotool(bot, 'windowactivate', '--sync', window)
  // The window shows the shell's earlier output first; give its prompt a moment.
  await sleep(800)
  return window
}
async function closeTerminals(bot) {
  for (const window of await windows(bot, '--class', 'Maestrly-Terminal'))
    await xdotool(bot, 'windowclose', window).catch(() => undefined)
  await poll(
    bot.name + "'s terminal windows to close",
    async () => (await windows(bot, '--class', 'Maestrly-Terminal')).length === 0
  )
}
const desktopSocket = (bot) => `/home/bot/.cache/maestrly-bots/${bot.botId}/desktop.sock`
/** Opens an address as a program on the bot's desktop would: through its link opener. */
const openLink = (bot, address) =>
  docker([
    'exec',
    '-e',
    'DISPLAY=:' + bot.slot,
    '-e',
    'MAESTRLY_DESKTOP_SOCKET=' + desktopSocket(bot),
    name,
    'xdg-open',
    address,
  ])
/** The window that presents the bot's Maestrly browser on its desktop, once it is shown. */
async function browserWindow(bot) {
  let found = null
  await poll(bot.name + "'s browser window", async () => {
    ;[found] = await windows(bot, '--class', 'Maestrly-Browser')
    return Boolean(found)
  })
  return found
}
/**
 * A window's client area on a display. xwininfo, as `xdotool getwindowgeometry` adds the window's offset inside its
 * window manager frame to its position.
 */
async function clientArea(display, window) {
  const info = await onDisplay(display, 'xwininfo', '-id', window)
  const value = (label) => Number(new RegExp(label + ':\\s+(-?\\d+)').exec(info)?.[1])
  return {
    x: value('Absolute upper-left X'),
    y: value('Absolute upper-left Y'),
    width: value('Width'),
    height: value('Height'),
  }
}
const geometry = (bot, window) => clientArea(':' + bot.slot, window)
/** Where a bot's browser window opens the first time (DEFAULT_PRESENTER_GEOMETRY): its client area. */
const DEFAULT_BROWSER_AREA = { x: 80, y: 56, width: 1120, height: 640 }
const sameArea = (a, b) => ['x', 'y', 'width', 'height'].every((key) => a[key] === b[key])
/** The page color of each bot's fixture page (desktop-pages.cjs). */
const PAGE_COLOR = { alpha: [0xff, 0xd6, 0xe0], beta: [0xd6, 0xe8, 0xff] }
/** The bot's tile of the environment display, where its browser lives (fleetEnvironmentTile). */
const tile = (bot) => ({ x: (bot.slot % 3) * 1280, y: Math.floor(bot.slot / 3) * 800 })
/** Clicks a point of the bot's browser window, given in the window's client area. */
async function clickBrowser(bot, x, y) {
  const area = await geometry(bot, await browserWindow(bot))
  await xdotool(bot, 'mousemove', String(area.x + x), String(area.y + y), 'click', '1')
  await sleep(250)
}
/** Opens the bot's own fixture page in its browser, and waits for the page to report its size. */
async function openOwnPage(bot) {
  const since = (await fixture()).now
  await openLink(bot, FIXTURE + '/' + bot.botId)
  // A page reports its size once it has loaded; an earlier tab of the same page reported before.
  await poll(bot.name + "'s page", async () =>
    (await fixture()).hits.some((hit) => hit.path === '/size' && hit.owner === bot.botId && hit.at > since)
  )
  return browserWindow(bot)
}

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
  // A bot's browser window shows on its desktop once the bot starts; minimized, it leaves the wallpaper to measure.
  for (const bot of BOTS) {
    await xdotool(bot, 'windowminimize', '--sync', await browserWindow(bot))
    await poll(
      bot.name + "'s browser window to minimize",
      async () => (await windows(bot, '--class', 'Maestrly-Browser')).length === 0
    )
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

async function terminal() {
  const [alpha] = BOTS
  await closeTerminals(alpha)
  const before = (await fixture()).pids.length
  await openTerminal(alpha)
  await typeCommand(alpha, `curl -s ${FIXTURE}/pid/$$`)
  await poll('the shell to report its pid', async () => (await fixture()).pids.length > before)
  await capture(alpha, 'terminal')
  // Closing the window ends only the window: the shell, with its pid, is still there to open again.
  await closeTerminals(alpha)
  await openTerminal(alpha)
  await typeCommand(alpha, `curl -s ${FIXTURE}/pid/$$`)
  await poll('the shell to report its pid again', async () => (await fixture()).pids.length > before + 1)
  const pids = (await fixture()).pids.slice(before)
  step('shell pids', { pids })
  check(
    'the dock opens a window on the bot terminal, and again on the same shell after it closed',
    /^\d+$/.test(pids[0]) && pids[0] === pids[1],
    { pids }
  )
  await closeTerminals(alpha)
}

async function files() {
  const [alpha] = BOTS
  const file = 'desktop-files-probe.txt'
  await openTerminal(alpha)
  await typeCommand(alpha, `printf 'Synthetic note\\n' > ~/${file}`)
  await poll('the file the shell wrote', async () => (await inContainer(`cat /home/bot/${file}`)) === 'Synthetic note')
  await closeTerminals(alpha)
  await launch(alpha, 2)
  await poll("the bot's file window", async () => (await windows(alpha, '--class', 'Pcmanfm')).length > 0)
  const [folder] = await windows(alpha, '--class', 'Pcmanfm')
  await xdotool(alpha, 'windowactivate', '--sync', folder)
  await sleep(1200)
  await capture(alpha, 'files')
  const title = await xdotool(alpha, 'getwindowname', folder)
  check("the dock's Files shows the bot's home folder", /\bbot\b/.test(title), { title })
  // Typing a name selects that file in the folder; Enter opens it in the text editor.
  await xdotool(alpha, 'type', '--delay', '40', '--', 'desktop-files-probe')
  await sleep(400)
  await xdotool(alpha, 'key', 'Return')
  let editor = []
  await poll(
    'the file in the text editor',
    async () => {
      editor = await windows(alpha, '--name', 'desktop-files-probe')
      return editor.length > 0
    },
    30_000
  ).catch(() => undefined)
  await capture(alpha, 'files-editor')
  check('the file the shell wrote is in the folder and opens in the editor', editor.length > 0, {
    editorTitle: editor.length ? await xdotool(alpha, 'getwindowname', editor[0]) : null,
  })
  await inContainer('pkill -x mousepad || true; pkill -x pcmanfm || true')
}

async function url() {
  const [alpha] = BOTS
  const before = (await fixture()).hits.filter((hit) => hit.path === '/forward').length
  const opened = await docker([
    'exec',
    '-e',
    'DISPLAY=:' + alpha.slot,
    '-e',
    'MAESTRLY_DESKTOP_SOCKET=' + desktopSocket(alpha),
    name,
    'xdg-open',
    FIXTURE + '/forward',
  ]).then(
    () => 'ok',
    (error) => error.message
  )
  step('xdg-open', { opened })
  await poll(
    'the link in the bot browser',
    async () => (await fixture()).hits.filter((hit) => hit.path === '/forward').length > before
  )
  const hit = (await fixture()).hits.filter((entry) => entry.path === '/forward').at(-1)
  const chromium = await inContainer('pgrep -c -x chromium || true')
  check(
    "a link opened on the bot's desktop lands in its Maestrly browser",
    /Electron\//.test(hit.ua) && chromium === '0',
    {
      userAgent: hit.ua,
      chromiumProcesses: chromium,
    }
  )
}

async function browser() {
  for (const bot of BOTS) await openOwnPage(bot)
  for (const bot of BOTS) {
    const window = await browserWindow(bot)
    const area = await geometry(bot, window)
    check(`${bot.name}'s browser window opens centered above the dock`, sameArea(area, DEFAULT_BROWSER_AREA), { area })
    await sleep(800)
    const shot = await capture(bot, 'browser')
    // Below the tab strip and address bar, the window shows the bot's own page.
    const color = await meanColor(shot, [300, 200, area.x + 200, area.y + 250])
    step(bot.name + "'s browser window", { area, color })
    check(`${bot.name}'s desktop shows its own browser with its own page`, near(color, PAGE_COLOR[bot.botId]), {
      area,
      color,
      expected: PAGE_COLOR[bot.botId],
    })
    const size = (await fixture()).sizes[bot.botId]
    check(`${bot.name}'s page is as wide as its browser window`, size.width === area.width, { size, area })
  }
  // The presenter restarts after it ends; the window comes back shown, where it was.
  const [alpha] = BOTS
  const before = await geometry(alpha, await browserWindow(alpha))
  // Anchored, so that it does not match the shell running it.
  await inContainer(`pkill -f '^maestrly-browser-presenter --source :0 --socket ${desktopSocket(alpha)}'`)
  await poll(
    "Alpha's browser window to close",
    async () => (await windows(alpha, '--class', 'Maestrly-Browser')).length === 0
  )
  const after = await geometry(alpha, await browserWindow(alpha))
  check("Alpha's browser window comes back where it was after its presenter restarts", sameArea(before, after), {
    before,
    after,
  })
}

async function typing() {
  for (const bot of BOTS) await openOwnPage(bot)
  const texts = { alpha: 'Alpha escreve: ação, já! 123', beta: 'beta types other words; (ok)' }
  for (const bot of BOTS) await clickBrowser(bot, 300, 300)
  // Both owners type at once, each on their own bot's desktop.
  await Promise.all(BOTS.map((bot) => xdotool(bot, 'type', '--delay', '30', '--', texts[bot.botId])))
  await poll(
    'both pages to get their text',
    async () => {
      const { values } = await fixture()
      return values.alpha === texts.alpha && values.beta === texts.beta
    },
    20_000
  ).catch(() => undefined)
  const { values } = await fixture()
  check(
    "each bot's page gets exactly what was typed on its own desktop",
    values.alpha === texts.alpha && values.beta === texts.beta,
    {
      values: { alpha: values.alpha, beta: values.beta },
      texts,
    }
  )
  // The address bar is in the second row of the browser's chrome, after its three navigation buttons.
  const [alpha] = BOTS
  await clickBrowser(alpha, 500, 58)
  await xdotool(alpha, 'key', 'ctrl+a')
  await xdotool(alpha, 'type', '--delay', '20', '--', FIXTURE + '/arrived')
  await xdotool(alpha, 'key', 'Return')
  const arrived = async () => (await fixture()).hits.find((hit) => hit.path === '/arrived')
  await poll('the address typed in the address bar', arrived, 20_000).catch(() => undefined)
  await capture(alpha, 'address')
  const hit = await arrived()
  check("Alpha's address bar takes an address typed on its desktop", Boolean(hit && /Electron\//.test(hit.ua)), { hit })
}

async function clipboard() {
  const [alpha] = BOTS
  await openOwnPage(alpha)
  const file = '/home/bot/desktop-clipboard.txt'
  await inContainer(`printf 'from the desktop' > ${file}`)
  await docker(['exec', '-d', '-e', 'DISPLAY=:' + alpha.slot, name, 'mousepad', file])
  let editor = []
  await poll('the editor', async () => {
    editor = await windows(alpha, '--name', 'desktop-clipboard')
    return editor.length > 0
  })
  await xdotool(alpha, 'windowactivate', '--sync', editor[0])
  await sleep(500)
  await xdotool(alpha, 'key', 'ctrl+a', 'ctrl+c')
  await sleep(300)
  // Pasted into the bot's page through its browser window, clicked to the right of the editor, which lies over it.
  await clickBrowser(alpha, 900, 300)
  await xdotool(alpha, 'key', 'ctrl+a', 'ctrl+v')
  await poll('the pasted text', async () => (await fixture()).values.alpha === 'from the desktop', 20_000).catch(
    () => undefined
  )
  await capture(alpha, 'clipboard-paste')
  const pasted = (await fixture()).values.alpha
  check('text copied on the desktop pastes into the bot page', pasted === 'from the desktop', { pasted })
  // Copied in the page, pasted into the editor and saved.
  await xdotool(alpha, 'key', 'End')
  await xdotool(alpha, 'type', '--delay', '20', '--', ' and back')
  await poll('the page text', async () => (await fixture()).values.alpha === 'from the desktop and back', 20_000).catch(
    () => undefined
  )
  const typed = (await fixture()).values.alpha
  check('the page holds the pasted text and what was typed after it', typed === 'from the desktop and back', { typed })
  await xdotool(alpha, 'key', 'ctrl+a', 'ctrl+c')
  await sleep(600)
  await xdotool(alpha, 'windowactivate', '--sync', editor[0])
  await sleep(300)
  await xdotool(alpha, 'key', 'ctrl+a', 'ctrl+v', 'ctrl+s')
  await poll(
    'the saved file',
    async () => (await inContainer(`cat ${file}`)).trim() === 'from the desktop and back',
    20_000
  ).catch(() => undefined)
  const saved = (await inContainer(`cat ${file}`)).trim()
  check('text copied in the bot page pastes on the desktop', saved === 'from the desktop and back', { saved })
  await inContainer('pkill -x mousepad || true')
}

async function popup() {
  const [alpha] = BOTS
  const since = (await fixture()).now
  await openLink(alpha, FIXTURE + '/opener')
  await poll('the opener page', async () =>
    (await fixture()).hits.some((hit) => hit.path === '/opener' && hit.at > since)
  )
  await sleep(800)
  await clickBrowser(alpha, 560, 360)
  await poll('the popup', async () => (await fixture()).openers.popup === '/opener', 20_000).catch(() => undefined)
  check('the page opens its sign-in popup', (await fixture()).openers.popup === '/opener', {
    openers: (await fixture()).openers,
  })
  // The popup lies on the environment display; the bot's desktop shows it inside the browser window.
  const [popupWindow] = (
    await onDisplay(':0', 'xdotool', 'search', '--onlyvisible', '--name', '^popup$').catch(() => '')
  )
    .split('\n')
    .filter(Boolean)
  if (!popupWindow) throw new Error('The popup is not on the environment display')
  const onEnvironment = await clientArea(':0', popupWindow)
  const origin = tile(alpha)
  const inBrowser = { ...onEnvironment, x: onEnvironment.x - origin.x, y: onEnvironment.y - origin.y }
  const area = await geometry(alpha, await browserWindow(alpha))
  await sleep(500)
  const shot = await capture(alpha, 'popup')
  const color = await meanColor(shot, [
    100,
    60,
    area.x + inBrowser.x + inBrowser.width / 2 - 50,
    area.y + inBrowser.y + inBrowser.height / 2 - 30,
  ])
  check('the popup shows inside the browser window on the bot desktop', near(color, [0xd9, 0xf7, 0xd6]), {
    inBrowser,
    color,
  })
  await clickBrowser(alpha, inBrowser.x + inBrowser.width / 2, inBrowser.y + inBrowser.height / 2)
  await xdotool(alpha, 'type', '--delay', '20', '--', 'signed in')
  await poll('the popup text', async () => (await fixture()).values.popup === 'signed in', 20_000).catch(
    () => undefined
  )
  check('typing on the desktop reaches the popup', (await fixture()).values.popup === 'signed in', {
    value: (await fixture()).values.popup,
  })
  // Its close button is at the right end of the title bar Openbox draws above it on the environment display.
  await clickBrowser(alpha, inBrowser.x + inBrowser.width - 10, inBrowser.y - 10)
  const open = async () =>
    (await onDisplay(':0', 'xdotool', 'search', '--onlyvisible', '--name', '^popup$').catch(() => '')).trim() !== ''
  await poll('the popup to close', async () => !(await open()), 20_000).catch(() => undefined)
  check("the popup closes from its title bar's close button", !(await open()))
}

async function resize() {
  for (const bot of BOTS) await openOwnPage(bot)
  const [alpha] = BOTS
  const betaBefore = (await fixture()).sizes.beta
  await xdotool(alpha, 'windowsize', '--sync', await browserWindow(alpha), '900', '560')
  await poll("Alpha's page at its new size", async () => (await fixture()).sizes.alpha?.width === 900, 20_000).catch(
    () => undefined
  )
  await sleep(800)
  const sizes = (await fixture()).sizes
  const area = await geometry(alpha, await browserWindow(alpha))
  await capture(alpha, 'resize')
  check("resizing Alpha's browser window resizes its browser", sizes.alpha.width === 900 && area.width === 900, {
    sizes,
    area,
  })
  check(
    "Beta's browser keeps its size",
    sizes.beta.width === betaBefore.width && sizes.beta.height === betaBefore.height,
    {
      before: betaBefore,
      after: sizes.beta,
    }
  )
  const saved = JSON.parse(await inContainer(`cat ${wallpaperFolder(alpha)}/presenter.json`))
  check("Alpha's browser window keeps its new size for next time", saved.width === 900 && saved.height === 560, {
    saved,
  })
}

/** The windows Openbox manages on a display, bottom to top, and the one with the keyboard. */
async function stacking(bot) {
  const ids = (text) => (text.match(/0x[0-9a-f]+/gi) ?? []).map((id) => Number.parseInt(id, 16))
  const stack = ids(await onDisplay(':' + bot.slot, 'xprop', '-root', '_NET_CLIENT_LIST_STACKING'))
  const [active] = ids(await onDisplay(':' + bot.slot, 'xprop', '-root', '_NET_ACTIVE_WINDOW'))
  return { stack, active }
}
/** The managed window among those a search found. */
async function managed(bot, ...query) {
  const { stack } = await stacking(bot)
  const found = (await windows(bot, ...query)).map(Number)
  return found.find((id) => stack.includes(id)) ?? null
}

async function forward() {
  const [alpha] = BOTS
  await openOwnPage(alpha)
  const file = '/home/bot/desktop-forward.txt'
  await inContainer(`printf 'owner at work' > ${file}`)
  await docker(['exec', '-d', '-e', 'DISPLAY=:' + alpha.slot, name, 'mousepad', file])
  let editor = null
  await poll('the editor', async () => {
    editor = await managed(alpha, '--name', 'desktop-forward')
    return editor !== null
  })
  await xdotool(alpha, 'windowactivate', '--sync', String(editor))
  await sleep(500)
  const browserId = Number(await browserWindow(alpha))
  const before = await stacking(alpha)
  step('stacking before the link', { before, editor, browserId })
  await openLink(alpha, FIXTURE + '/forward')
  await poll(
    'the browser above the editor',
    async () => {
      const { stack } = await stacking(alpha)
      return stack.indexOf(browserId) > stack.indexOf(editor)
    },
    20_000
  ).catch(() => undefined)
  const after = await stacking(alpha)
  check(
    'a link brings the browser above the window the owner works in, which keeps the keyboard',
    after.stack.indexOf(browserId) > after.stack.indexOf(editor) && after.active === editor,
    { after, editor, browserId }
  )
  // A terminal window opened for the bot's work, as its terminal tools open them.
  await docker([
    'exec',
    '-d',
    '-e',
    'DISPLAY=:' + alpha.slot,
    name,
    'xterm',
    '-class',
    'Maestrly-Terminal',
    '-name',
    'maestrly-quiet',
    '-T',
    'Quiet terminal',
    '-e',
    'sleep',
    '60',
  ])
  const activeBefore = (await stacking(alpha)).active
  let quiet = null
  await poll('the quiet terminal', async () => {
    quiet = await managed(alpha, '--name', 'Quiet terminal')
    return quiet !== null
  })
  await sleep(800)
  const withTerminal = await stacking(alpha)
  check(
    "a terminal window opened for the bot's work leaves the keyboard where it was",
    withTerminal.active === activeBefore && withTerminal.stack.includes(quiet),
    {
      withTerminal,
      activeBefore,
      quiet,
    }
  )
  await inContainer(
    'pkill -x mousepad || true; pkill -f "^xterm -class Maestrly-Terminal -name maestrly-quiet" || true'
  )
}

const scenarios = new Map([
  ['look', { title: "The look of each bot's desktop", run: look }],
  ['terminal', { title: "The dock's Terminal and the bot's shell", run: terminal }],
  ['files', { title: "The dock's Files and the editor", run: files }],
  ['url', { title: 'Links from the desktop open in the Maestrly browser', run: url }],
  ['browser', { title: "Each bot's browser as a window of its desktop", run: browser }],
  ['typing', { title: 'Typing reaches only the bot whose desktop it is on', run: typing }],
  ['clipboard', { title: 'The desktop clipboard and the browser', run: clipboard }],
  ['popup', { title: 'Sign-in popups inside the presented browser', run: popup }],
  ['resize', { title: 'Resizing the browser window', run: resize }],
  ['forward', { title: 'Apps come forward without taking the keyboard', run: forward }],
])

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
  await docker([
    'exec',
    '-d',
    name,
    'node',
    '-e',
    readFileSync(path.join(root, 'deploy/bot-fleet/test/desktop-pages.cjs'), 'utf8'),
  ])
  await poll('fixture pages', () => fixture())
  for (const bot of BOTS) await install(bot)
  // Every scenario starts from a desktop that is up: its wallpaper painted and its dock shown.
  for (const bot of BOTS)
    await poll(bot.name + "'s desktop", async () => {
      const root = await onDisplay(':' + bot.slot, 'xprop', '-root', '_XROOTPMAP_ID')
      return /pixmap id/.test(root) && (await desktopPrograms(bot)).taskbar !== null
    })
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
