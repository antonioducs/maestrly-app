// Linux-only vertical proof for the live desktop. Bundled by scripts/verify-bot-desktop.mjs
// and run inside a disposable Ubuntu 24.04 container without a network interface.
import { execFileSync, spawn } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { VncTransmitter, probeVnc } from '../../apps/bot-runtime/src/desktop/vnc-server.js'
import { X11Connection } from '../../apps/bot-runtime/src/desktop/x11.js'
import { HumanInput } from '../../apps/bot-runtime/src/desktop/human-input.js'
// @ts-expect-error plain ESM test client
import { RfbClient } from './rfb-client.mjs'

const sh = (command: string) => execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }).trim()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))]
const rss = (name: string) => Number(sh(`ps -o rss= -C ${name} | head -1`) || 0)
const typedFile = '/tmp/typed.txt'

async function main() {
  const report: Record<string, unknown> = { stage: 'linux-container', network: sh('ls /sys/class/net').split(/\s+/).filter((n) => n !== 'lo') }
  const probe = await probeVnc()
  report.vnc = { version: probe.version, clipboard: probe.clipboard }
  const socketPath = '/run/maestrly-desktop/probe/rfb.sock'
  const transmitter = new VncTransmitter({ display: ':10', socketPath, environment: process.env, idleMs: 500 })
  const connectStarted = performance.now()
  await transmitter.acquire()
  const socket = lstatSync(socketPath)
  report.socket = { mode: (socket.mode & 0o777).toString(8), directoryMode: (lstatSync('/run/maestrly-desktop/probe').mode & 0o777).toString(8) }
  report.tcpListeners = sh("ss -ltnH | wc -l")
  const client = await RfbClient.connect(socketPath)
  await client.update(false)
  report.firstFramebufferMs = Math.round(performance.now() - connectStarted)
  report.framebuffer = { width: client.width, height: client.height }
  // A real X change reaches the viewer through RFB.
  sh('xsetroot -solid "#ff0000"')
  report.pixelChangeMs = Math.round(await client.waitForPixel(1000, 700, ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60))
  // Hostile viewer: RFB input, clipboard and resize are all ignored by the server.
  const pointerBefore = sh('xdotool getmouselocation')
  client.sendPointer(900, 700, 1)
  client.sendPointer(900, 700, 0)
  client.sendKey(0x61, true)
  client.sendKey(0x61, false)
  client.sendCutText('segredo-do-observador')
  client.sendSetDesktopSize(640, 480)
  await sleep(600)
  const x = await X11Connection.open({ display: ':10', xauthority: process.env.XAUTHORITY })
  report.hostile = {
    pointerUnchanged: sh('xdotool getmouselocation') === pointerBefore,
    typed: readFileSync(typedFile, 'utf8'),
    dimensions: sh("xdpyinfo | awk '/dimensions/{print $2}'"),
    clipboardOwner: await x.selectionOwner(await x.internAtom('CLIPBOARD')),
    serverCutTexts: client.serverCutTexts.length,
    connectionAlive: !client.closed,
  }
  // Human input through XTEST: pointer, accents and Unicode reach the focused terminal.
  sh('xdotool search --class xterm windowfocus')
  const input = new HumanInput(x)
  await input.apply([{ kind: 'pointer', x: 50, y: 50 }])
  await input.apply([{ kind: 'text', text: 'ação €' }, { kind: 'key', code: 'Enter', keysym: 0xff0d, down: true }, { kind: 'key', code: 'Enter', keysym: 0xff0d, down: false }])
  await sleep(400)
  report.human = { pointer: await x.pointer(), typed: readFileSync(typedFile, 'utf8') }
  // Input-to-pixel: an XTEST click on a fresh color block, measured at the viewer.
  const samples: number[] = []
  for (let i = 0; i < 30; i++) {
    const color = i % 2 ? '#00ff00' : '#0000ff'
    const started = performance.now()
    await input.apply([{ kind: 'pointer', x: 640 + (i % 5), y: 400 }])
    sh(`xsetroot -solid "${color}"`)
    await client.waitForPixel(1000, 700, ([, g, b]: number[]) => (i % 2 ? g > 200 && b < 60 : b > 200 && g < 60))
    samples.push(performance.now() - started)
  }
  report.inputToPixelMs = { p50: Math.round(percentile(samples, 50)), p95: Math.round(percentile(samples, 95)), samples: samples.length, note: 'XTEST event plus X change to RFB pixel inside the guest; excludes Host and SSH transport' }
  // Update rate under a continuously changing screen: a terminal that scrolls without pause
  // (one long-lived X client, so the generator is not limited by process start-up).
  const animation = spawn('xterm', ['-geometry', '120x45+0+0', '-e', '/bin/sh', '-c', 'while :; do date +%s%N; done'], { stdio: 'ignore', env: process.env })
  await sleep(700)
  const start = client.updates
  const window = performance.now()
  while (performance.now() - window < 3000) await client.update(true, 1000).catch(() => {})
  animation.kill()
  report.updatesPerSecond = Math.round(((client.updates - start) / (performance.now() - window)) * 10000) / 10
  report.rssKiB = { Xvfb: rss('Xvfb'), X0tigervnc: rss('X0tigervnc') }
  client.close()
  // The last viewer leaving stops only the transmitter.
  transmitter.release()
  await sleep(1200)
  report.transmitterStoppedAfterLastViewer = !transmitter.running
  report.xStillRunning = sh('xdpyinfo >/dev/null 2>&1 && echo yes || echo no') === 'yes'
  x.close()
  const hostile = report.hostile as Record<string, unknown>
  const human = report.human as { typed: string }
  report.verified =
    (report.network as string[]).length === 0 &&
    report.tcpListeners === '0' &&
    (report.socket as { mode: string }).mode === '600' &&
    hostile.pointerUnchanged === true && hostile.typed === '' && hostile.dimensions === '1280x800' && hostile.clipboardOwner === 0 &&
    human.typed === 'ação €\n' &&
    report.transmitterStoppedAfterLastViewer === true && report.xStillRunning === true
  process.stdout.write(`${JSON.stringify(report)}\n`)
}
main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ verified: false, error: String(error?.message ?? error).slice(0, 400) })}\n`)
  process.exitCode = 1
})
