import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  FLEET_PROTOCOL_HEADER,
  FLEET_RUNNER_LIMITS,
  fleetGatewayEventSchema,
  type FleetGatewayEvent,
  type FleetRunnerJobEvent,
} from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { harness } from './harness.js'
import { studio } from './runner-fixtures.js'

type Harness = Awaited<ReturnType<typeof harness>>

/** A paired computer that runs jobs: its token, and a stream that reads runner events once opened. */
async function computer(h: Harness, name: string) {
  const auth = new Auth(h.store)
  const { token, deviceId } = auth.pair(auth.createPairing().code, name, name)
  const headers = { [FLEET_PROTOCOL_HEADER]: '1', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  const events: FleetGatewayEvent[] = []
  let controller: AbortController | null = null
  const request = (method: string, route: string, body?: unknown) =>
    fetch(h.origin + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return {
    deviceId,
    events,
    request,
    async connect(runners = true) {
      controller = new AbortController()
      const response = await fetch(h.origin + '/v1/events' + (runners ? '?runners=1' : ''), {
        headers,
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) return
            buffer += decoder.decode(value, { stream: true })
            let boundary: number
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data: '))
                .map((line) => line.slice(6))
                .join('\n')
              if (data) events.push(fleetGatewayEventSchema.parse(JSON.parse(data)))
            }
          }
        } catch {
          // The stream was closed by the test.
        }
      })()
      await expect.poll(() => events.some((event) => event.type === 'hello')).toBe(true)
    },
    disconnect() {
      controller?.abort()
    },
    jobs: () => events.filter((event): event is FleetRunnerJobEvent => event.type === 'runner.job'),
  }
}

const spec = { folder: '/home/bot/video', command: 'npm run render', outputs: ['out/**'] }

describe('runner routes', () => {
  it('advertises runners past the features older desktops read', async () => {
    const h = await harness(Date.now, { environments: true })
    expect((await (await h.request('GET', '/v1/meta')).json()).moreFeatures).toContain('runners')
  })

  it("runs a bot's job on the computer that linked it, and tells the bot's environment where it stands", async () => {
    const h = await harness(Date.now, { environments: true })
    const studioMac = await computer(h, 'Studio')
    const intruder = await computer(h, 'Intruder')
    await studioMac.connect()
    await intruder.connect()
    const linked = await studioMac.request('PUT', `/v1/bots/${h.bot.id}/runner-link`, { name: 'Mac Studio' })
    expect(linked.status).toBe(200)
    expect(
      await (
        await studioMac.request('PUT', '/v1/runner/state', { accepting: true, capabilities: studio, jobs: [] })
      ).json()
    ).toEqual({ stop: [] })
    const runners = await (await h.request('GET', '/internal/v1/runners', undefined, true)).json()
    expect(runners.runners).toEqual([expect.objectContaining({ name: 'Mac Studio', online: true })])

    const jobId = 'job_0123456789abcdef'
    const submitted = await (await h.request('POST', '/internal/v1/runner-jobs', { jobId, spec }, true)).json()
    expect(submitted).toMatchObject({ ok: true, job: { jobId, state: 'assigned' } })
    await expect.poll(() => studioMac.jobs().map((event) => event.jobId)).toEqual([jobId])
    expect(intruder.jobs()).toEqual([])
    // Only the runner the job went to moves it on.
    expect((await intruder.request('POST', `/v1/runner-jobs/${jobId}/accept`)).status).toBe(403)
    expect((await studioMac.request('POST', `/v1/runner-jobs/${jobId}/accept`)).status).toBe(204)
    expect((await studioMac.request('POST', `/v1/runner-jobs/${jobId}/progress`, { state: 'finishing' })).status).toBe(
      204
    )
    expect(
      (await studioMac.request('POST', `/v1/runner-jobs/${jobId}/finish`, { exitCode: 0, error: null })).status
    ).toBe(204)
    expect(await (await h.request('GET', `/internal/v1/runner-jobs/${jobId}`, undefined, true)).json()).toMatchObject({
      state: 'succeeded',
      exitCode: 0,
    })
    await expect.poll(() => h.instance.runnerJobStates.at(-1)?.state).toBe('succeeded')
    // The owner's computers list the bot's jobs.
    const jobs = await (await studioMac.request('GET', `/v1/bots/${h.bot.id}/runner-jobs`)).json()
    expect(jobs.jobs.map((job: { jobId: string }) => job.jobId)).toEqual([jobId])
  })

  it('lets the owner cancel a running job, which its runner is told to stop', async () => {
    const h = await harness(Date.now, { environments: true })
    const runner = await computer(h, 'Studio')
    await runner.connect()
    await runner.request('PUT', `/v1/bots/${h.bot.id}/runner-link`, { name: 'Studio' })
    await runner.request('PUT', '/v1/runner/state', { accepting: true, capabilities: studio, jobs: [] })
    const jobId = 'job_cancel0123456789ab'
    await h.request('POST', '/internal/v1/runner-jobs', { jobId, spec }, true)
    await expect.poll(() => runner.jobs().length).toBe(1)
    await runner.request('POST', `/v1/runner-jobs/${jobId}/accept`)
    const cancelled = await (await runner.request('POST', `/v1/bots/${h.bot.id}/runner-jobs/${jobId}/cancel`)).json()
    expect(cancelled).toMatchObject({ state: 'running', cancelRequested: true })
    await expect
      .poll(() => runner.events.some((event) => event.type === 'runner.cancel' && event.jobId === jobId))
      .toBe(true)
    await runner.request('POST', `/v1/runner-jobs/${jobId}/finish`, { exitCode: null, error: null })
    expect(await (await h.request('GET', `/internal/v1/runner-jobs/${jobId}`, undefined, true)).json()).toMatchObject({
      state: 'cancelled',
    })
  })

  it('keeps runner events from streams that did not ask for them, and refuses a report without its stream', async () => {
    const h = await harness(Date.now, { environments: true })
    const older = await computer(h, 'Older')
    await older.connect(false)
    await older.request('PUT', `/v1/bots/${h.bot.id}/runner-link`, { name: 'Older' })
    const report = await older.request('PUT', '/v1/runner/state', { accepting: true, capabilities: studio, jobs: [] })
    expect(report.status).toBe(409)
    expect(older.events.some((event) => event.type.startsWith('runner'))).toBe(false)
  })
  describe('usage', () => {
    const sample = { cpuPercent: 350, memoryBytes: 2 * 1024 ** 3, peakMemoryBytes: 3 * 1024 ** 3, processes: 4 }
    /** A computer linked and online, with one job sent to it. */
    async function sent(jobId: string) {
      const h = await harness(Date.now, { environments: true })
      const mac = await computer(h, 'Studio')
      await mac.connect()
      await mac.request('PUT', `/v1/bots/${h.bot.id}/runner-link`, { name: 'Studio' })
      await mac.request('PUT', '/v1/runner/state', { accepting: true, capabilities: studio, jobs: [] })
      await h.request('POST', '/internal/v1/runner-jobs', { jobId, spec }, true)
      await expect.poll(() => mac.jobs().length).toBe(1)
      return { h, mac }
    }
    const usageOf = async (h: Harness, jobId: string) =>
      (await (await h.request('GET', `/internal/v1/runner-jobs/${jobId}`, undefined, true)).json()).usage

    it("shows what a running job uses to the bot and the owner's computers, until the job ends", async () => {
      const jobId = 'job_usage0123456789abc'
      const { h, mac } = await sent(jobId)
      const intruder = await computer(h, 'Intruder')
      // A job its runner has not accepted yet is not running: there is nothing to sample.
      expect((await mac.request('POST', `/v1/runner-jobs/${jobId}/usage`, sample)).status).toBe(409)
      expect((await mac.request('POST', `/v1/runner-jobs/${jobId}/accept`)).status).toBe(204)
      expect(await usageOf(h, jobId)).toBeUndefined()
      await expect.poll(() => h.instance.runnerJobStates.at(-1)?.state).toBe('running')

      const events = mac.events.length
      const states = h.instance.runnerJobStates.length
      expect((await mac.request('POST', `/v1/runner-jobs/${jobId}/usage`, sample)).status).toBe(204)
      expect(await usageOf(h, jobId)).toEqual({ ...sample, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) })
      const listed = await (await intruder.request('GET', `/v1/bots/${h.bot.id}/runner-jobs`)).json()
      expect(listed.jobs[0]).toMatchObject({ jobId, state: 'running', usage: sample })
      // A sample is read, not announced: no event, and nothing for the bot's environment.
      expect(mac.events.length).toBe(events)
      expect(h.instance.runnerJobStates).toHaveLength(states)
      // It is not stored either.
      expect(JSON.stringify(h.store.runnerJob(jobId))).not.toContain('cpuPercent')

      // The latest sample replaces the one before; the environment is told states only.
      expect(
        (await mac.request('POST', `/v1/runner-jobs/${jobId}/usage`, { ...sample, cpuPercent: 12.5 })).status
      ).toBe(204)
      expect(await usageOf(h, jobId)).toMatchObject({ cpuPercent: 12.5 })
      expect((await mac.request('POST', `/v1/runner-jobs/${jobId}/progress`, { state: 'finishing' })).status).toBe(204)
      await expect.poll(() => h.instance.runnerJobStates.at(-1)?.state).toBe('finishing')
      expect(h.instance.runnerJobStates.at(-1)).not.toHaveProperty('usage')
      expect(await usageOf(h, jobId)).toMatchObject({ cpuPercent: 12.5 })

      expect((await mac.request('POST', `/v1/runner-jobs/${jobId}/finish`, { exitCode: 0, error: null })).status).toBe(
        204
      )
      expect(await usageOf(h, jobId)).toBeUndefined()
      expect((await mac.request('POST', `/v1/runner-jobs/${jobId}/usage`, sample)).status).toBe(409)
      const done = await (await intruder.request('GET', `/v1/bots/${h.bot.id}/runner-jobs`)).json()
      expect(done.jobs[0]).toMatchObject({ jobId, state: 'succeeded' })
      expect(done.jobs[0]).not.toHaveProperty('usage')
    })

    it("refuses a sample from another computer, for an unknown job, or that is not a runner's", async () => {
      const jobId = 'job_usage9876543210abc'
      const { h, mac } = await sent(jobId)
      const intruder = await computer(h, 'Intruder')
      await mac.request('POST', `/v1/runner-jobs/${jobId}/accept`)
      expect((await intruder.request('POST', `/v1/runner-jobs/${jobId}/usage`, sample)).status).toBe(403)
      expect((await mac.request('POST', '/v1/runner-jobs/job_unknown0123456789a/usage', sample)).status).toBe(404)
      for (const bad of [
        { ...sample, cpuPercent: -1 },
        { ...sample, memoryBytes: 1.5 },
        { ...sample, processes: -1 },
        { ...sample, at: '2026-10-29T10:00:00.000Z' },
        { cpuPercent: 1 },
      ])
        expect((await mac.request('POST', `/v1/runner-jobs/${jobId}/usage`, bad)).status).toBe(400)
      // A job that never reached its runner has nobody to sample it.
      await h.request('POST', '/internal/v1/runner-jobs', { jobId: 'job_queued0123456789abc', spec }, true)
      expect((await mac.request('POST', '/v1/runner-jobs/job_queued0123456789abc/usage', sample)).status).toBe(403)
      expect(await usageOf(h, jobId)).toBeUndefined()
    })
  })

  describe('log reads', () => {
    const jobId = 'job_log0123456789abcde'
    const page = { start: 6, next: 20, size: 20, text: 'second line\nthird\n' }
    /** A bot's environment that serves `runner-jobs` and answers log reads with `page`, recording the paths asked. */
    async function environment(
      options: { capabilities?: string[]; answer?: (req: http.IncomingMessage) => unknown } = {}
    ) {
      const asked: string[] = []
      const h = await harness(Date.now, {
        environments: true,
        instanceCapabilities: options.capabilities ?? ['runner-jobs'],
        // The route the gateway asks, with its bot in the path and the query it was given.
        instanceRoutes: (req, res) => {
          if (req.method !== 'GET' || !/^\/v1\/bots\/[^/]+\/runner-jobs\/[^/?]+\/log(\?.*)?$/.test(req.url ?? ''))
            return false
          asked.push(req.url!)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(options.answer?.(req) ?? page))
          return true
        },
      })
      const mac = await computer(h, 'Studio')
      await mac.connect()
      await mac.request('PUT', `/v1/bots/${h.bot.id}/runner-link`, { name: 'Studio' })
      await mac.request('PUT', '/v1/runner/state', { accepting: true, capabilities: studio, jobs: [] })
      await h.request('POST', '/internal/v1/runner-jobs', { jobId, spec }, true)
      return {
        h,
        mac,
        asked,
        read: (query = '') => mac.request('GET', `/v1/bots/${h.bot.id}/runner-jobs/${jobId}/log${query}`),
      }
    }

    it("reads a job's log from its bot's environment, which the gateway keeps nothing of", async () => {
      const { h, asked, read } = await environment()
      const response = await read()
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(page)
      expect(asked).toEqual([`/v1/bots/${h.bot.id}/runner-jobs/${jobId}/log`])
      // Where to read on from, and how much, go through as they are asked.
      expect((await (await read('?offset=6&limit=1024')).json()).next).toBe(20)
      expect(asked.at(-1)).toBe(`/v1/bots/${h.bot.id}/runner-jobs/${jobId}/log?offset=6&limit=1024`)
      expect((await read(`?offset=0&limit=${FLEET_RUNNER_LIMITS.logPageBytesMax}`)).status).toBe(200)
      expect((await read('?limit=1')).status).toBe(200)
      expect(asked.at(-1)).toBe(`/v1/bots/${h.bot.id}/runner-jobs/${jobId}/log?limit=1`)
      expect(JSON.stringify(h.store.runnerJob(jobId))).not.toContain('third')
    })

    it("refuses the log of another bot's job or of a bot that does not exist, and bad queries", async () => {
      const { h, asked, read } = await environment()
      const other = h.lifecycle.create({
        name: 'Other',
        instructions: '',
        ceiling: 'ask',
        talksTo: [],
        idempotencyKey: 'runner-log-other',
      })
      const mac = await computer(h, 'Reader')
      expect((await mac.request('GET', `/v1/bots/${other.id}/runner-jobs/${jobId}/log`)).status).toBe(404)
      expect((await mac.request('GET', `/v1/bots/${h.bot.id}/runner-jobs/job_unknown0123456789a/log`)).status).toBe(404)
      expect((await mac.request('GET', `/v1/bots/bot_missing/runner-jobs/${jobId}/log`)).status).toBe(404)
      for (const query of [
        '?offset=',
        '?offset=-1',
        '?offset=1.5',
        '?offset=abc',
        '?offset=99999999999999999999',
        '?limit=',
        '?limit=0',
        '?limit=-1',
        '?limit=2.5',
        `?limit=${FLEET_RUNNER_LIMITS.logPageBytesMax + 1}`,
      ])
        expect([query, (await read(query)).status]).toEqual([query, 400])
      expect(asked).toEqual([])
      expect((await read()).status).toBe(200)
    })

    it('says so when the bot environment cannot serve runner jobs, and relays what it refuses', async () => {
      const without = await environment({ capabilities: [] })
      const unavailable = await without.read()
      expect(unavailable.status).toBe(409)
      expect(await unavailable.json()).toMatchObject({
        code: 'CONFLICT',
        message: "The bot's environment is not running, so this job's log cannot be read now.",
      })
      expect(without.asked).toEqual([])
      const garbled = await environment({ answer: () => ({ text: 'no offsets' }) })
      expect((await garbled.read()).status).toBe(503)
    })
  })
})
