import { describe, expect, it } from 'vitest'
import {
  FLEET_PROTOCOL_HEADER,
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
})
