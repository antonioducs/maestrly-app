// Linux-only probe of window controls as a person uses them: Openbox runs with the deployed
// rc.xml and every click, drag and double click goes through HumanInput (XTEST), in the
// separate batches the app sends. Bundled by scripts/verify-bot-desktop.mjs and executed
// inside the disposable, network-less probe container.
import { execFileSync, spawn } from 'node:child_process'
import { X11Connection } from '../../apps/bot-runtime/src/desktop/x11.js'
import { HumanInput } from '../../apps/bot-runtime/src/desktop/human-input.js'
import { VncTransmitter } from '../../apps/bot-runtime/src/desktop/vnc-server.js'
// @ts-expect-error plain ESM test client
import { RfbClient, RFB_ENCODING_CURSOR, RFB_ENCODING_DESKTOP_SIZE, RFB_ENCODING_RAW } from './rfb-client.mjs'

const sh = (command: string) => execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }).trim()
const quiet = (command: string) => {
  try {
    return sh(command)
  } catch {
    return ''
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type Box = { x: number; y: number; width: number; height: number }
const windowOf = (title: string) => Number(quiet(`xdotool search --name '^${title}$' | head -1`)) || undefined
function geometry(id: number): Box {
  const info = sh(`xwininfo -id ${id}`)
  const value = (label: string) => Number(new RegExp(`${label}:\\s+(-?\\d+)`).exec(info)?.[1])
  return { x: value('Absolute upper-left X'), y: value('Absolute upper-left Y'), width: value('Width'), height: value('Height') }
}
function extents(id: number) {
  const [left, right, top, bottom] = (/=\s*(.+)$/.exec(quiet(`xprop -id ${id} _NET_FRAME_EXTENTS`))?.[1] ?? '0,0,0,0').split(',').map(Number)
  return { left, right, top, bottom }
}
/** Title bar buttons of one window, left to right (Openbox gives each button its own X window). */
function buttons(id: number): Box[] {
  const client = geometry(id)
  const frame = extents(id)
  const found: (Box & { id: string })[] = []
  for (const line of sh('xwininfo -root -tree').split('\n')) {
    const match = /^\s+(0x[0-9a-f]+) .*\s(\d+)x(\d+)\+-?\d+\+-?\d+\s+\+(-?\d+)\+(-?\d+)\s*$/.exec(line)
    if (!match) continue
    const [, wid, w, h, ax, ay] = match
    const box = { id: wid, x: Number(ax), y: Number(ay), width: Number(w), height: Number(h) }
    const inTitle = box.y >= client.y - frame.top && box.y + box.height <= client.y && box.x >= client.x - frame.left && box.x + box.width <= client.x + client.width + frame.right
    if (inTitle && box.width >= 8 && box.width <= 32 && box.height >= 8 && box.height <= 32 && Math.abs(box.width - box.height) <= 4) found.push(box)
  }
  return found.filter((box) => /IsViewable/.test(quiet(`xwininfo -id ${box.id}`))).sort((a, b) => a.x - b.x)
}
const center = (box: Box) => ({ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) })
const active = () => Number(quiet('xdotool getactivewindow')) || undefined

async function main() {
  const report: Record<string, unknown> = {}
  const x = await X11Connection.open({ display: process.env.DISPLAY ?? ':10', xauthority: process.env.XAUTHORITY })
  const input = new HumanInput(x)
  // What the app sends for one click: the motion, then press and release as separate calls.
  const click = async (point: { x: number; y: number }) => {
    await input.apply([{ kind: 'pointer', ...point }])
    await input.apply([{ kind: 'button', button: 'left', down: true, ...point }])
    await sleep(60)
    await input.apply([{ kind: 'button', button: 'left', down: false, ...point }])
  }
  const drag = async (from: { x: number; y: number }, dx: number, dy: number) => {
    await input.apply([{ kind: 'pointer', ...from }])
    await input.apply([{ kind: 'button', button: 'left', down: true, ...from }])
    for (let step = 1; step <= 12; step++) {
      await sleep(16) // the app coalesces motion to 60 Hz
      await input.apply([{ kind: 'pointer', x: from.x + Math.round((dx * step) / 12), y: from.y + Math.round((dy * step) / 12) }])
    }
    await input.apply([{ kind: 'button', button: 'left', down: false, x: from.x + dx, y: from.y + dy }])
  }
  for (const [title, place] of [['Alpha', '+100+120'], ['Beta', '+320+220']]) {
    spawn('xterm', ['-title', title, '-geometry', `70x18${place}`, '-e', 'sleep', '600'], { stdio: 'ignore', env: process.env }).unref()
    for (let i = 0; i < 50 && !windowOf(title); i++) await sleep(100)
  }
  await sleep(600)
  const alpha = windowOf('Alpha')!
  const beta = windowOf('Beta')!
  report.titleButtons = buttons(alpha).length
  // Clicking an uncovered part of a background window gives it the focus.
  const start = geometry(alpha)
  report.focusBefore = active() === beta ? 'Beta' : active() === alpha ? 'Alpha' : 'other'
  await click({ x: start.x + 20, y: start.y + 20 })
  await sleep(300)
  report.focusClick = active() === alpha
  // Dragging the title bar moves the window.
  const top = extents(alpha).top
  await drag({ x: start.x + 60, y: start.y - Math.max(1, Math.round(top / 2)) }, 150, 80)
  await sleep(300)
  const moved = geometry(alpha)
  report.move = { dx: moved.x - start.x, dy: moved.y - start.y }
  // Maximize button, then double click on the title bar restores it.
  const betaButtons = buttons(beta)
  if (betaButtons.length >= 2) {
    await click(center(betaButtons.at(-2)!))
    await sleep(400)
  }
  report.maximizeWidth = geometry(beta).width
  const maximized = geometry(beta)
  const title = { x: maximized.x + 200, y: maximized.y - Math.max(1, Math.round(extents(beta).top / 2)) }
  await input.apply([{ kind: 'pointer', ...title }])
  for (const down of [true, false, true, false]) {
    await input.apply([{ kind: 'button', button: 'left', down, ...title }])
    await sleep(50)
  }
  await sleep(400)
  report.restoredWidth = geometry(beta).width
  // Close button.
  const alphaButtons = buttons(alpha)
  if (alphaButtons.length) await click(center(alphaButtons.at(-1)!))
  await sleep(800)
  report.closed = !windowOf('Alpha')
  // The screen server sends the cursor shape, so the app can draw a zero-latency pointer.
  const transmitter = new VncTransmitter({ display: process.env.DISPLAY ?? ':10', socketPath: '/run/maestrly-desktop/wm/rfb.sock', environment: process.env, idleMs: 100 })
  await transmitter.acquire()
  const rfb = await RfbClient.connect(transmitter.socketPath, { encodings: [RFB_ENCODING_RAW, RFB_ENCODING_CURSOR, RFB_ENCODING_DESKTOP_SIZE] })
  await rfb.update(false)
  await input.apply([{ kind: 'pointer', x: 5, y: 5 }])
  await sleep(100)
  const b = geometry(beta)
  await input.apply([{ kind: 'pointer', x: b.x + 40, y: b.y + 40 }])
  for (let i = 0; i < 10 && rfb.cursors.length < 2; i++) await rfb.update(true, 500).catch(() => {})
  report.cursorShapes = rfb.cursors.map((cursor: { width: number; height: number; visible: boolean }) => `${cursor.width}x${cursor.height}${cursor.visible ? '' : ' invisible'}`)
  rfb.close()
  await transmitter.close()
  x.close()
  const move = report.move as { dx: number; dy: number }
  report.verified =
    report.focusClick === true &&
    Math.abs(move.dx - 150) <= 4 && Math.abs(move.dy - 80) <= 4 &&
    (report.maximizeWidth as number) >= 1200 && (report.restoredWidth as number) < 1000 &&
    report.closed === true && (report.cursorShapes as string[]).length > 0
  process.stdout.write(`${JSON.stringify(report)}\n`)
}
main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ verified: false, error: String(error?.stack ?? error).slice(0, 600) })}\n`)
  process.exitCode = 1
})
