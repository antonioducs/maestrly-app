import { describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import type {
  FleetGatewayEvent,
  FleetInternalRunnerJobRequest,
  FleetRunnerCapabilities,
  FleetRunnerJob,
} from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { EventHub } from '../src/events.js'
import { Runners } from '../src/runners.js'
import { harness } from './harness.js'

/** A device's stream as the hub writes to it: it keeps what it was sent and can be closed. */
function stream() {
  const frames: string[] = []
  const closers: Array<() => void> = []
  const response = {
    destroyed: false,
    writableLength: 0,
    writeHead: () => response,
    write: (chunk: string) => {
      frames.push(chunk)
      return true
    },
    on: (event: string, handler: () => void) => {
      if (event === 'close') closers.push(handler)
      return response
    },
    destroy: () => {},
    end: () => {},
  }
  return {
    response: response as unknown as ServerResponse,
    sent: () =>
      frames
        .filter((frame) => frame.startsWith('event: fleet'))
        .map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as FleetGatewayEvent),
    close() {
      response.destroyed = true
      for (const close of closers) close()
    },
  }
}

export const studio: FleetRunnerCapabilities = {
  protocol: 1,
  os: 'macos',
  arch: 'arm64',
  cpus: 12,
  memoryBytes: 36 * 1024 ** 3,
  executor: 'native',
  gpu: { vendor: 'apple', name: 'Apple M3 Pro', memoryBytes: null },
  slots: 1,
}
export const gpuPc: FleetRunnerCapabilities = {
  ...studio,
  os: 'linux',
  arch: 'x64',
  executor: 'container',
  gpu: { vendor: 'nvidia', name: 'RTX 4090', memoryBytes: 24 * 1024 ** 3 },
  slots: 2,
}
let serial = 0
const job = (overrides: Partial<FleetInternalRunnerJobRequest> = {}): FleetInternalRunnerJobRequest => ({
  jobId: 'job_' + String(++serial).padStart(16, '0'),
  spec: {
    folder: '/home/bot/video',
    command: 'npm run render',
    outputs: ['out/**'],
    caches: [],
    env: { API_TOKEN: 'secret' },
    timeoutMinutes: 60,
    queueTimeoutMinutes: 60,
  },
  requires: {},
  ...overrides,
})

async function setup() {
  const h = await harness(Date.now, { environments: true })
  // The gateway's own broker shares the store and runs on the real clock: this one starts there too.
  let now = Date.now()
  let reachable = true
  const notified: FleetRunnerJob[] = []
  const hub = new EventHub(async () => {})
  const runners = new Runners(
    h.store,
    hub,
    {
      notify: async (value) => {
        if (!reachable) return false
        notified.push(value)
        return true
      },
    },
    { now: () => now }
  )
  hub.onRunnerChange = (deviceId) => runners.deviceChanged(deviceId)
  const auth = new Auth(h.store)
  const computer = (name: string) => {
    const { deviceId } = auth.pair(auth.createPairing().code, name, name)
    let current = stream()
    return {
      deviceId,
      device: () => h.store.device(deviceId)!,
      open() {
        current = stream()
        hub.add(current.response, 0, deviceId, { runners: true })
      },
      close: () => current.close(),
      events: () => current.sent(),
      jobs: () =>
        current
          .sent()
          .filter((event): event is Extract<FleetGatewayEvent, { type: 'runner.job' }> => event.type === 'runner.job'),
    }
  }
  return {
    h,
    hub,
    runners,
    computer,
    notified,
    botId: h.bot.id,
    job,
    advance(ms: number) {
      now += ms
      runners.tick()
    },
    setReachable(value: boolean) {
      reachable = value
    },
  }
}

describe('runner links', () => {
  it('links a computer, which runs jobs only while its stream is open and it accepts them', async () => {
    const t = await setup()
    const mac = t.computer('Studio')
    const pc = t.computer('Tower')
    const link = t.runners.linkDevice(t.botId, mac.device(), 'Mac Studio')
    expect(link).toMatchObject({ name: 'Mac Studio', self: true, online: false, capabilities: null, busySlots: 0 })
    expect(link.runnerId).toMatch(/^rnr_/)
    expect(link.runnerId).not.toContain(mac.deviceId)
    mac.open()
    expect(t.runners.links(t.botId)[0].online).toBe(false)
    expect(t.runners.report(mac.deviceId, { accepting: true, capabilities: studio, jobs: [] })).toEqual({ stop: [] })
    expect(t.runners.links(t.botId)[0]).toMatchObject({ online: true, capabilities: studio })
    // Every computer that reads runner events sees the bot's links, its own marked as self.
    pc.open()
    t.runners.linkDevice(t.botId, pc.device(), 'Tower')
    const seen = pc
      .events()
      .filter((event) => event.type === 'runner_link.updated')
      .at(-1)
    expect(seen?.type === 'runner_link.updated' && seen.links.map((item) => item.self)).toEqual([false, true])
    // A runner that stops accepting, or closes its stream, is offline; its last report is kept.
    t.runners.report(mac.deviceId, { accepting: false, capabilities: null, jobs: [] })
    expect(t.runners.links(t.botId)[0].online).toBe(false)
    t.runners.report(mac.deviceId, { accepting: true, capabilities: studio, jobs: [] })
    mac.close()
    expect(t.runners.links(t.botId)[0]).toMatchObject({ online: false, capabilities: studio })
    // A report without its stream is refused.
    expect(() => t.runners.report(mac.deviceId, { accepting: true, capabilities: studio, jobs: [] })).toThrow(
      'runners=1'
    )
    // Removing another computer's link, and a computer taking back its own.
    t.runners.remove(t.botId, link.runnerId)
    expect(t.runners.links(t.botId).map((item) => item.name)).toEqual(['Tower'])
    t.runners.unlinkDevice(t.botId, pc.deviceId)
    expect(t.runners.links(t.botId)).toEqual([])
    expect(() => t.runners.remove(t.botId, link.runnerId)).toThrow('Runner link not found')
  })

  it('caps the runners of one bot, and a revoked computer loses every link', async () => {
    const t = await setup()
    const computers = Array.from({ length: 10 }, (_, index) => t.computer('Runner ' + index))
    for (const item of computers) t.runners.linkDevice(t.botId, item.device(), item.device().name)
    const extra = t.computer('One too many')
    expect(() => t.runners.linkDevice(t.botId, extra.device(), 'Extra')).toThrow('at most 10')
    // Renaming an existing link is not a new one.
    expect(t.runners.linkDevice(t.botId, computers[0].device(), 'Renamed').name).toBe('Renamed')
    t.runners.revokeDevice(computers[0].deviceId)
    expect(t.runners.links(t.botId)).toHaveLength(9)
  })
})
