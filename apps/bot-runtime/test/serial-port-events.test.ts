import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { closeSync, constants, openSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { Socket } from 'node:net'
import { SerialPort, PolledPort } from '../src/control/serial-port.js'
import { parseUnitStates } from '../src/vm/systemd-driver.js'
import { vncArguments } from '../src/desktop/vnc-server.js'

it.skipIf(process.platform === 'win32')('delivers each message as soon as it is written, without a polling timer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'serial-events-'))
  try {
    const path = join(dir, 'port')
    execFileSync('mkfifo', [path])
    const port = await SerialPort.open(path)
    // FIFOs support poll(): the event-driven stream is used, not the polling fallback.
    expect(port).toBeInstanceOf(Socket)
    const writer = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK)
    const latencies: number[] = []
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15)) // idle between messages, like a person
      const received = once(port, 'data')
      const started = performance.now()
      writeSync(writer, `m${i}\n`)
      expect(String((await received)[0])).toBe(`m${i}\n`)
      latencies.push(performance.now() - started)
    }
    closeSync(writer)
    latencies.sort((a, b) => a - b)
    // The polling port waited up to 10 ms per idle read; readiness makes it immediate.
    expect(latencies[Math.floor(latencies.length * 0.9)]).toBeLessThan(5)
    const closed = once(port, 'close')
    port.destroy()
    await closed
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 10_000)

it.skipIf(process.platform === 'win32')('keeps the polling fallback for descriptors without poll support', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'serial-events-'))
  try {
    const path = join(dir, 'port')
    execFileSync('mkfifo', [path])
    const port = await SerialPort.open(path, { eventDriven: false })
    expect(port).toBeInstanceOf(PolledPort)
    const closed = once(port, 'close')
    port.destroy()
    await closed
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('reads the three session units from one systemctl call', () => {
  const units = ['maestrly-bot-desktop@a.service', 'maestrly-bot-desktop-services@a.service', 'maestrly-bot-runtime@a.service']
  const stdout = 'Id=maestrly-bot-desktop@a.service\nActiveState=active\n\nId=maestrly-bot-desktop-services@a.service\nActiveState=active\n\nId=maestrly-bot-runtime@a.service\nActiveState=inactive\n'
  expect(parseUnitStates(stdout, units)).toEqual(['running', 'running', 'stopped'])
  // Missing or unexpected output never reads as running.
  expect(parseUnitStates('Id=other.service\nActiveState=active\n', units)).toEqual(['unknown', 'unknown', 'unknown'])
  expect(parseUnitStates('ActiveState=activating\nId=maestrly-bot-runtime@a.service\n', units)).toEqual(['unknown', 'unknown', 'unknown'])
})

it('sends at most 60 frames per second by default: the frame timer is the floor of screen latency', () => {
  const probe = { version: '1.13.1', parameters: ['UseBlacklist'], clipboard: 'absent' as const }
  const args = vncArguments(probe, { display: ':10', socketPath: '/run/maestrly-desktop/a/rfb.sock' })
  expect(args).toContain('-FrameRate=60')
  expect(vncArguments(probe, { display: ':10', socketPath: '/run/maestrly-desktop/a/rfb.sock', frameRate: 240 })).toContain('-FrameRate=60')
  expect(args).toEqual(expect.arrayContaining(['-rfbport=-1', '-AcceptKeyEvents=0', '-AcceptPointerEvents=0', '-AcceptSetDesktopSize=0']))
})
