// Linux-only benchmark of the screen server frame rate: input-to-pixel latency (Raw client),
// then updates, bandwidth and X0tigervnc CPU with a Tight/JPEG client (what noVNC asks for)
// while a terminal scrolls. Runs in the same disposable, network-less container as the probe.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { VncTransmitter } from '../../apps/bot-runtime/src/desktop/vnc-server.js'
import { X11Connection } from '../../apps/bot-runtime/src/desktop/x11.js'
import { HumanInput } from '../../apps/bot-runtime/src/desktop/human-input.js'
// @ts-expect-error plain ESM test client
import { RfbClient, RFB_ENCODING_DESKTOP_SIZE, RFB_ENCODING_LAST_RECT, RFB_ENCODING_TIGHT, rfbCompressLevel, rfbQualityLevel } from './rfb-client.mjs'

const sh = (command: string) => execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }).trim()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))]
/** CPU seconds (user + system) consumed so far by a process. */
const cpuSeconds = (pid: number) => {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
  return (Number(fields[11]) + Number(fields[12])) / 100
}

async function measure(frameRate: number, x: X11Connection) {
  const socketPath = `/run/maestrly-desktop/bench-${frameRate}/rfb.sock`
  const transmitter = new VncTransmitter({ display: ':10', socketPath, environment: process.env, idleMs: 100, frameRate })
  await transmitter.acquire()
  const pid = Number(sh('pgrep -n -x X0tigervnc'))
  const input = new HumanInput(x)
  // Input to pixel: an XTEST event followed by a colour change, seen by a Raw client.
  const raw = await RfbClient.connect(socketPath)
  await raw.update(false)
  const samples: number[] = []
  for (let i = 0; i < 30; i++) {
    const color = i % 2 ? '#00ff00' : '#0000ff'
    const started = performance.now()
    await input.apply([{ kind: 'pointer', x: 640 + (i % 5), y: 400 }])
    sh(`xsetroot -solid "${color}"`)
    await raw.waitForPixel(1000, 700, ([, g, b]: number[]) => (i % 2 ? g > 200 && b < 60 : b > 200 && g < 60))
    samples.push(performance.now() - started)
  }
  raw.close()
  // Continuous change seen through Tight/JPEG quality 6, compression 2 (noVNC defaults).
  const tight = await RfbClient.connect(socketPath, { encodings: [RFB_ENCODING_TIGHT, rfbQualityLevel(6), rfbCompressLevel(2), RFB_ENCODING_DESKTOP_SIZE, RFB_ENCODING_LAST_RECT] })
  await tight.update(false)
  const scroller = spawn('xterm', ['-geometry', '160x50+0+0', '-e', '/bin/sh', '-c', 'while :; do date +%s%N; done'], { stdio: 'ignore', env: process.env })
  await sleep(800)
  const updates = tight.updates
  const bytes = tight.bytesReceived
  const cpu = cpuSeconds(pid)
  const started = performance.now()
  while (performance.now() - started < 4000) await tight.update(true, 1000).catch(() => {})
  const seconds = (performance.now() - started) / 1000
  const result = {
    frameRate,
    inputToPixelMs: { p50: Math.round(percentile(samples, 50)), p95: Math.round(percentile(samples, 95)) },
    scrolling: {
      updatesPerSecond: Math.round(((tight.updates - updates) / seconds) * 10) / 10,
      kbPerSecond: Math.round((tight.bytesReceived - bytes) / seconds / 1024),
      serverCpuPercent: Math.round(((cpuSeconds(pid) - cpu) / seconds) * 100),
    },
  }
  scroller.kill()
  tight.close()
  await transmitter.close()
  await sleep(500)
  return result
}

async function main() {
  const x = await X11Connection.open({ display: ':10', xauthority: process.env.XAUTHORITY })
  const rates = (process.env.MAESTRLY_BENCH_FRAME_RATES ?? '15,30,60').split(',').map(Number)
  const results = []
  for (const rate of rates) results.push(await measure(rate, x))
  x.close()
  process.stdout.write(`${JSON.stringify({ results })}\n`)
}
main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ error: String(error?.stack ?? error).slice(0, 800) })}\n`)
  process.exitCode = 1
})
