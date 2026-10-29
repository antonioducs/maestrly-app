import { describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import type { FleetGatewayEvent, FleetInternalRunnerJobRequest, FleetRunnerJob } from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { EventHub } from '../src/events.js'
import { Runners } from '../src/runners.js'
import { harness } from './harness.js'
import { studio } from './runner-fixtures.js'

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

describe('runner jobs', () => {
  async function ready(capabilities = studio) {
    const t = await setup()
    const mac = t.computer('Studio')
    mac.open()
    const link = t.runners.linkDevice(t.botId, mac.device(), 'Mac Studio')
    t.runners.report(mac.deviceId, { accepting: true, capabilities, jobs: [] })
    return { ...t, mac, link }
  }

  it('sends a queued job to a free matching runner, and only that runner moves it on', async () => {
    const t = await ready()
    const other = t.computer('Intruder')
    const submitted = t.runners.submit(t.botId, t.job())
    expect(submitted).toMatchObject({ ok: true, job: { state: 'assigned', runnerName: 'Mac Studio' } })
    const sent = t.mac.jobs().at(-1)!
    expect(sent).toMatchObject({ botId: t.botId, runnerId: t.link.runnerId, spec: { command: 'npm run render' } })
    expect('queueTimeoutMinutes' in sent.spec).toBe(false)
    // The slot is taken: a second job waits.
    const second = t.runners.submit(t.botId, t.job())
    expect(second).toMatchObject({ ok: true, job: { state: 'queued' }, queuedAhead: 0 })
    expect(() => t.runners.accept(sent.jobId, other.deviceId)).toThrow('another computer')
    t.runners.accept(sent.jobId, t.mac.deviceId)
    expect(t.runners.job(t.botId, sent.jobId).state).toBe('running')
    t.runners.progress(sent.jobId, t.mac.deviceId)
    t.runners.finish(sent.jobId, t.mac.deviceId, { exitCode: 0, error: null })
    expect(t.runners.job(t.botId, sent.jobId)).toMatchObject({ state: 'succeeded', exitCode: 0, error: null })
    // Its slot went to the waiting job.
    expect(t.runners.job(t.botId, second.ok ? second.job.jobId : '').state).toBe('assigned')
    // A failing command is a failed job.
    const next = t.mac.jobs().at(-1)!
    t.runners.accept(next.jobId, t.mac.deviceId)
    t.runners.finish(next.jobId, t.mac.deviceId, { exitCode: 2, error: null })
    expect(t.runners.job(t.botId, next.jobId)).toMatchObject({ state: 'failed', error: { code: 'exit_code' } })
  })

  it('refuses a job no linked runner can run, one for an unknown runner, and one past the per-bot limit', async () => {
    const lonely = await setup()
    expect(lonely.runners.submit(lonely.botId, lonely.job())).toMatchObject({
      ok: false,
      error: { code: 'runner_not_linked' },
    })
    const t = await ready()
    expect(t.runners.submit(t.botId, t.job({ requires: { os: 'linux' } }))).toMatchObject({
      ok: false,
      error: { code: 'runner_unmatched', message: expect.stringContaining('"Mac Studio" is macos arm64') },
    })
    expect(t.runners.submit(t.botId, t.job({ runnerId: 'rnr_unknown0123456789ab' }))).toMatchObject({
      ok: false,
      error: { code: 'runner_not_linked' },
    })
    for (let index = 0; index < 20; index++) expect(t.runners.submit(t.botId, t.job()).ok).toBe(true)
    expect(t.runners.submit(t.botId, t.job())).toMatchObject({ ok: false, error: { code: 'runner_busy' } })
  })

  it('submits a job once for its id, and refuses that id from another bot', async () => {
    const t = await ready()
    const request = t.job()
    const first = t.runners.submit(t.botId, request)
    expect(t.runners.submit(t.botId, request)).toEqual(first)
    expect(t.mac.jobs()).toHaveLength(1)
    expect(() => t.runners.submit('another-bot', request)).toThrow('taken')
  })

  it('puts an unaccepted job back in the queue and skips that runner for a while', async () => {
    const t = await ready()
    const submitted = t.runners.submit(t.botId, t.job())
    const jobId = submitted.ok ? submitted.job.jobId : ''
    t.advance(31_000)
    expect(t.runners.job(t.botId, jobId).state).toBe('queued')
    t.advance(60_000)
    expect(t.runners.job(t.botId, jobId).state).toBe('queued')
    t.advance(5 * 60_000)
    expect(t.runners.job(t.botId, jobId).state).toBe('assigned')
    expect(t.mac.jobs()).toHaveLength(2)
  })

  it('expires a job no runner took before its queue timeout', async () => {
    const t = await ready()
    t.runners.report(t.mac.deviceId, { accepting: false, capabilities: null, jobs: [] })
    const submitted = t.runners.submit(t.botId, t.job({ spec: { ...t.job().spec, queueTimeoutMinutes: 1 } }))
    const jobId = submitted.ok ? submitted.job.jobId : ''
    t.advance(30_000)
    expect(t.runners.job(t.botId, jobId).state).toBe('queued')
    t.advance(31_000)
    expect(t.runners.job(t.botId, jobId)).toMatchObject({ state: 'expired', error: { code: 'queue_timeout' } })
  })

  it("loses a runner's jobs when it stays away past the grace period, and keeps them when it returns", async () => {
    const t = await ready()
    const kept = t.runners.submit(t.botId, t.job())
    const keptId = kept.ok ? kept.job.jobId : ''
    t.runners.accept(keptId, t.mac.deviceId)
    t.mac.close()
    t.advance(5 * 60_000)
    t.mac.open()
    expect(t.runners.report(t.mac.deviceId, { accepting: true, capabilities: studio, jobs: [keptId] })).toEqual({
      stop: [],
    })
    t.advance(10 * 60_000)
    expect(t.runners.job(t.botId, keptId).state).toBe('running')
    t.mac.close()
    t.advance(10 * 60_000 + 1)
    expect(t.runners.job(t.botId, keptId)).toMatchObject({ state: 'lost', error: { code: 'runner_lost' } })
  })

  it('reconciles a reconnecting runner: it stops jobs that ended here, and a running job it no longer has is lost', async () => {
    const t = await ready({ ...studio, slots: 2 })
    const a = t.runners.submit(t.botId, t.job())
    const b = t.runners.submit(t.botId, t.job())
    const [aId, bId] = [a.ok ? a.job.jobId : '', b.ok ? b.job.jobId : '']
    t.runners.accept(aId, t.mac.deviceId)
    t.runners.accept(bId, t.mac.deviceId)
    t.runners.cancel(t.botId, aId)
    t.advance(10 * 60_000)
    expect(t.runners.job(t.botId, aId).state).toBe('cancelled')
    const response = t.runners.report(t.mac.deviceId, {
      accepting: true,
      capabilities: studio,
      jobs: [aId, 'job_unknown000000000000'],
    })
    expect(response.stop.sort()).toEqual([aId, 'job_unknown000000000000'].sort())
    expect(t.runners.job(t.botId, bId)).toMatchObject({ state: 'lost', error: { code: 'runner_restarted' } })
  })

  it('cancels a queued job at once, and a running one when its runner finishes it', async () => {
    const t = await ready()
    const running = t.runners.submit(t.botId, t.job())
    const queued = t.runners.submit(t.botId, t.job())
    const [runningId, queuedId] = [running.ok ? running.job.jobId : '', queued.ok ? queued.job.jobId : '']
    t.runners.accept(runningId, t.mac.deviceId)
    expect(t.runners.cancel(t.botId, queuedId).state).toBe('cancelled')
    expect(t.runners.cancel(t.botId, runningId)).toMatchObject({ state: 'running', cancelRequested: true })
    expect(t.mac.events().some((event) => event.type === 'runner.cancel' && event.jobId === runningId)).toBe(true)
    t.runners.finish(runningId, t.mac.deviceId, { exitCode: null, error: null })
    expect(t.runners.job(t.botId, runningId)).toMatchObject({ state: 'cancelled', error: null })
    expect(() => t.runners.cancel('another-bot', runningId)).toThrow('not found')
  })

  it('tells the environment the latest state, again after it was unreachable, and forgets the command at the end', async () => {
    const t = await ready()
    t.setReachable(false)
    const submitted = t.runners.submit(t.botId, t.job())
    const jobId = submitted.ok ? submitted.job.jobId : ''
    t.runners.accept(jobId, t.mac.deviceId)
    t.runners.finish(jobId, t.mac.deviceId, { exitCode: 0, error: null })
    expect(t.notified).toEqual([])
    t.setReachable(true)
    await t.runners.retry(t.botId)
    expect(t.notified.map((job) => job.state)).toEqual(['succeeded'])
    expect(t.h.store.runnerJob(jobId)?.spec).toBeNull()
    expect(JSON.stringify(t.notified)).not.toContain('secret')
  })

  it("ends a bot's jobs on a runner whose link is removed", async () => {
    const t = await ready()
    const submitted = t.runners.submit(t.botId, t.job())
    const jobId = submitted.ok ? submitted.job.jobId : ''
    t.runners.accept(jobId, t.mac.deviceId)
    const named = t.runners.submit(t.botId, t.job({ runnerId: t.link.runnerId }))
    t.runners.remove(t.botId, t.link.runnerId)
    expect(t.runners.job(t.botId, jobId)).toMatchObject({ state: 'cancelled', error: { code: 'runner_unlinked' } })
    expect(t.mac.events().some((event) => event.type === 'runner.cancel' && event.jobId === jobId)).toBe(true)
    expect(t.runners.job(t.botId, named.ok ? named.job.jobId : '')).toMatchObject({
      state: 'failed',
      error: { code: 'runner_unlinked' },
    })
  })
})
