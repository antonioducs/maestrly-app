// Checks maestrly-screen-encoder on a real X display: its stream, its input, its clipboard and how it stops.
//
// Run it inside a throwaway container of the bot image whose display :0 is 3840x2400, with something drawn in the
// tile at (1280, 0):
//
//   docker run -d --rm --name maestrly-screen-smoke --shm-size 1g --entrypoint sh maestrly/bot-instance:local \
//     -c 'Xvfb :0 -screen 0 3840x2400x24 -nolisten tcp & sleep 1; DISPLAY=:0 xterm -geometry 80x20+1300+20 & sleep 600'
//   docker cp deploy/bot-fleet/test/screen-encoder-smoke.mjs maestrly-screen-smoke:/tmp/smoke.mjs
//   docker exec -e DISPLAY=:0 maestrly-screen-smoke node /tmp/smoke.mjs
//
// It prints one `ok` line per check and exits 1 at the first failure.
import { execFileSync, spawn } from 'node:child_process'

const ENCODER = '/usr/local/bin/maestrly-screen-encoder'
const REGION = { x: 1280, y: 0, width: 1280, height: 800 }
const TYPES = { ready: 0x01, frame: 0x02, cursor: 0x03, pointer: 0x04, clipboard: 0x05, log: 0x06 }
const COMMANDS = { tune: 0x83, pointer: 0x84, clipboard: 0x87, watch: 0x88 }
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const child = spawn(ENCODER, ['--display', ':0', '--region', `${REGION.x},${REGION.y},${REGION.width},${REGION.height}`], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
const messages = []
let buffer = Buffer.alloc(0)
let wake = () => {}
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 5) {
    const length = buffer.readUInt32BE(1)
    if (buffer.length < 5 + length) break
    const message = { type: buffer[0], payload: buffer.subarray(5, 5 + length), at: Date.now() }
    if (message.type === TYPES.log) process.stderr.write(`[encoder] ${message.payload.toString('utf8')}\n`)
    messages.push(message)
    buffer = buffer.subarray(5 + length)
  }
  wake()
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))

function fail(message) {
  process.stderr.write(`FAIL ${message}\n`)
  child.kill('SIGKILL')
  process.exit(1)
}

/** Resolves with the first message from index `from` on that matches, or fails after `ms`. */
function waitFor(label, from, matches, ms) {
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      wake = () => {}
      fail(`${label}: nothing within ${ms} ms`)
    }, ms)
    const check = () => {
      for (let i = from; i < messages.length; i++)
        if (matches(messages[i])) {
          clearTimeout(deadline)
          wake = () => {}
          resolve(messages[i])
          return
        }
    }
    wake = check
    check()
  })
}

function command(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(5)
  header[0] = type
  header.writeUInt32BE(payload.length, 1)
  child.stdin.write(Buffer.concat([header, payload]))
}
function pointerCommand(x, y, buttons) {
  const payload = Buffer.alloc(5)
  payload.writeUInt16BE(x, 0)
  payload.writeUInt16BE(y, 2)
  payload[4] = buttons
  command(COMMANDS.pointer, payload)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shell = (script) => execFileSync('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'inherit'] }).toString('utf8')
function mouse() {
  const out = execFileSync('xdotool', ['getmouselocation', '--shell']).toString('utf8')
  return { x: Number(/^X=(\d+)/m.exec(out)?.[1]), y: Number(/^Y=(\d+)/m.exec(out)?.[1]) }
}
async function pointerAt(label, x, y) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const where = mouse()
    if (where.x === x && where.y === y) return
    await sleep(100)
  }
  const where = mouse()
  fail(`${label}: the pointer is at ${where.x},${where.y}, not ${x},${y}`)
}
const clipboardText = (message) => (message.payload[0] & 1 ? null : message.payload.subarray(1).toString('utf8'))
const ok = (text) => process.stdout.write(`ok ${text}\n`)

const ready = await waitFor('ready', 0, (message) => message.type === TYPES.ready, 5000)
const info = JSON.parse(ready.payload.toString('utf8'))
if (info.width !== REGION.width || info.height !== REGION.height) fail(`ready: size ${info.width}x${info.height}`)
ok(`ready ${info.width}x${info.height} (${info.capture}, ${info.encoder})`)

const key = await waitFor('key frame', 0, (message) => message.type === TYPES.frame && (message.payload[8] & 1) === 1, 3000)
ok(`key frame ${key.payload.readUInt32BE(0)} of ${key.payload.length - 9} bytes`)

const cursor = await waitFor('cursor', 0, (message) => message.type === TYPES.cursor, 3000)
if (!cursor.payload.subarray(4, 12).equals(PNG_SIGNATURE)) fail('cursor: the sprite is not a PNG')
ok(`cursor ${cursor.payload.length - 4} bytes, hot spot ${cursor.payload.readUInt16BE(0)},${cursor.payload.readUInt16BE(2)}`)

pointerCommand(100, 120, 0)
await pointerAt('pointer', REGION.x + 100, REGION.y + 120)
ok('pointer moves within the region')

pointerCommand(5000, 5000, 0)
await pointerAt('clamped pointer', REGION.x + REGION.width - 1, REGION.y + REGION.height - 1)
ok('pointer stays in the region')

command(COMMANDS.clipboard, Buffer.from('ação ✓', 'utf8'))
let pasted = ''
for (let attempt = 0; attempt < 20 && pasted !== 'ação ✓'; attempt++) {
  await sleep(100)
  pasted = shell('xclip -o -selection clipboard 2>/dev/null || true')
}
if (pasted !== 'ação ✓') fail(`clipboard: the display holds ${JSON.stringify(pasted)}`)
ok('clipboard set in UTF-8')

let mark = messages.length
command(COMMANDS.watch, Buffer.from([3]))
await sleep(300)
mark = messages.length
shell('printf externo | xclip -selection clipboard -i >/dev/null 2>&1')
await waitFor('clipboard change', mark, (message) => message.type === TYPES.clipboard && clipboardText(message) === 'externo', 3000)
execFileSync('xdotool', ['mousemove', String(REGION.x + 20), String(REGION.y + 50)])
await waitFor(
  'pointer report',
  mark,
  (message) =>
    message.type === TYPES.pointer && message.payload.readInt32BE(0) === 20 && message.payload.readInt32BE(4) === 50,
  3000
)
ok('watching reports CLIPBOARD changes and the pointer')

mark = messages.length
shell('printf primario | xclip -selection primary -i >/dev/null 2>&1')
await sleep(1000)
const primary = messages.slice(mark).find((message) => message.type === TYPES.clipboard)
if (primary) fail(`primary: reported ${JSON.stringify(clipboardText(primary))}`)
ok('PRIMARY selections are not reported')

// Paint-over stays off until the session turns it on; then a still screen gets a key frame of the whole region.
const isFrame = (message) => message.type === TYPES.frame
const isKey = (message) => isFrame(message) && (message.payload[8] & 1) === 1
const flash = () => shell("xterm -geometry 20x4+1600+400 -bg '#2266cc' -e sleep 1 >/dev/null 2>&1 &")
mark = messages.length
flash()
await sleep(2500)
if (!messages.slice(mark).some(isFrame)) fail('paint-over: a window that came and went sent no frame')
if (messages.slice(mark).some(isKey)) fail('paint-over: a key frame came while it was off')
const tuning = { crf: 25, fps: 30, paintoverCrf: 18, paintoverBurst: 3, paintover: true, paintoverAfterFrames: 10 }
command(COMMANDS.tune, Buffer.from(JSON.stringify(tuning)))
await sleep(200)
mark = messages.length
flash()
const paintover = await waitFor('paint-over key frame', mark, isKey, 4000)
ok(`paint-over off by default, then a key frame of ${paintover.payload.length - 9} bytes once tuned on`)

child.stdin.end()
const result = await Promise.race([exited, sleep(3000).then(() => null)])
if (!result) fail('stop: still running 3 s after stdin closed')
if (result.code !== 0) fail(`stop: exited with ${result.code ?? result.signal}`)
ok('closing stdin stops it')
