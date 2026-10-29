import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FLEET_PROTOCOL_HEADER,
  FLEET_RUNNER_JOB_FINAL_STATES,
  type FleetGatewayEvent,
  type FleetRunnerJobSpec,
  fleetGatewayEventSchema,
} from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { harness, type InstanceRoutes } from './harness.js'
// The bot environment's and the runner's own code, from the desktop app: plain Node modules.
import { routeFor } from '../../desktop/src/main/fleet/instance/http.js'
import { runnerContinuationText, runnerLogTail } from '../../desktop/src/main/fleet/instance/runner-jobs/completion.js'
import { RunnerJobFiles } from '../../desktop/src/main/fleet/instance/runner-jobs/files.js'
import { isRunnerJobsRoute, serveRunnerJobsRoute } from '../../desktop/src/main/fleet/instance/runner-jobs/http.js'
import { RunnerJobRecords } from '../../desktop/src/main/fleet/instance/runner-jobs/records.js'
import { httpRunnerJobApi } from '../../desktop/src/main/runner/api.js'
import { NativeExecutor } from '../../desktop/src/main/runner/native-executor.js'
import { RunnerStorage } from '../../desktop/src/main/runner/storage.js'
import { RunnerWorker } from '../../desktop/src/main/runner/worker.js'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001'
const dirs: string[] = []
const stops: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** The bot's environment: its job records and files, served on the fake instance's runner-job routes. */
function environment() {
  const botFolder = tempDir('runner-e2e-bot-')
  const records = new RunnerJobRecords(path.join(botFolder, 'runner-jobs'))
  const continuations: Array<{ jobId: string; state: string; text: string }> = []
  const files = new RunnerJobFiles({
    records,
    botFolder,
    // What the bot's runtime does: one continuation per final state, into the conversation that sent the job.
    onState: async (record) => {
      if (!record.job || !FLEET_RUNNER_JOB_FINAL_STATES.includes(record.job.state) || record.continued) return
      const log = await runnerLogTail(records, record)
      continuations.push({
        jobId: record.jobId,
        state: record.job.state,
        text: runnerContinuationText({ record, job: record.job, log }),
      })
      await records.update(record.jobId, (current) => ({ ...current, continued: true }))
    },
  })
  const blobRequests: string[][] = []
  const serveBlobs = files.blobs.bind(files)
  files.blobs = (jobId, digests, ...rest) => {
    blobRequests.push(digests)
    return serveBlobs(jobId, digests, ...rest)
  }
  const routes: InstanceRoutes = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://instance')
    const match = routeFor(req.method ?? 'GET', url.pathname)
    if (!match || !isRunnerJobsRoute(match.key)) return false
    serveRunnerJobsRoute(files, match, req, res, url).catch((error: { status?: number; code?: string }) => {
      if (res.headersSent) return void res.destroy()
      res.writeHead(error.status ?? 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: error.code ?? 'INTERNAL', message: (error as Error).message }))
    })
    return true
  }
  return { records, continuations, blobRequests, routes }
}

/** A paired computer that runs jobs natively with the desktop's worker, reading its jobs on its event stream. */
async function runner(h: Awaited<ReturnType<typeof harness>>) {
  const auth = new Auth(h.store)
  const { token } = auth.pair(auth.createPairing().code, 'Studio', 'Studio')
  const headers = { [FLEET_PROTOCOL_HEADER]: '1', Authorization: 'Bearer ' + token }
  const storage = new RunnerStorage(tempDir('runner-e2e-runner-'))
  const worker = new RunnerWorker({
    storage,
    executors: () => new NativeExecutor({ loginPath: async () => process.env.PATH ?? '/usr/bin:/bin' }),
    settings: () => ({ accepting: true, slots: 1, blobCapBytes: 1024 ** 3, executor: 'native' }),
    capabilities: async () => ({
      protocol: 1,
      os: process.platform === 'darwin' ? 'macos' : 'linux',
      arch: 'x64',
      cpus: 2,
      memoryBytes: 8 * 1024 ** 3,
      executor: 'native',
      gpu: null,
      slots: 1,
    }),
    api: (serverId) => (serverId === SERVER ? httpRunnerJobApi({ origin: h.origin, headers: () => headers }) : null),
    tuning: { log: { intervalMs: 50 } },
  })
  await worker.start()
  stops.push(() => worker.stop())
  const linked = await fetch(`${h.origin}/v1/bots/${h.bot.id}/runner-link`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Studio' }),
  })
  expect(linked.status).toBe(200)
  const controller = new AbortController()
  stops.push(() => controller.abort())
  const response = await fetch(`${h.origin}/v1/events?runners=1`, { headers, signal: controller.signal })
  expect(response.status).toBe(200)
  const events: FleetGatewayEvent[] = []
  void (async () => {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const data = buffer
            .slice(0, boundary)
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n')
          buffer = buffer.slice(boundary + 2)
          if (!data) continue
          const event = fleetGatewayEventSchema.parse(JSON.parse(data))
          events.push(event)
          // What the app's fleet client does with the events of its stream.
          if (event.type === 'runner.job') worker.handleJob(SERVER, event)
          if (event.type === 'runner.cancel') worker.handleCancel(SERVER, event.jobId)
        }
      }
    } catch {
      // The stream was closed by the test.
    }
  })()
  await expect.poll(() => events.some((event) => event.type === 'hello')).toBe(true)
  await worker.connected(SERVER)
  return { worker, storage }
}

describe.skipIf(process.platform === 'win32')('runners end to end', () => {
  it('runs a bot’s job on a linked computer and continues the conversation with its outputs', async () => {
    const env = environment()
    const h = await harness(Date.now, {
      environments: true,
      instanceCapabilities: ['runner-jobs'],
      instanceRoutes: env.routes,
      runnerRelay: true,
    })
    const { worker, storage } = await runner(h)

    const folder = tempDir('runner-e2e-folder-')
    await mkdir(path.join(folder, 'src'))
    await mkdir(path.join(folder, 'node_modules', 'dep'), { recursive: true })
    await writeFile(path.join(folder, 'in.txt'), 'hello runner\n')
    await writeFile(path.join(folder, 'src', 'data.txt'), 'first data\n')
    await writeFile(path.join(folder, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    await symlink('in.txt', path.join(folder, 'link.txt'))

    /** What `runner_submit` does: the record first, then the job to the gateway with the bot's token. */
    const submit = async (spec: FleetRunnerJobSpec) => {
      const jobId = 'job_' + randomBytes(12).toString('base64url')
      await env.records.create({
        jobId,
        conversationId: 'primary-conversation',
        conversation: { kind: 'primary' },
        folder,
        spec,
        createdAt: new Date().toISOString(),
        job: null,
        outputs: null,
        continued: false,
      })
      const response = await h.request('POST', '/internal/v1/runner-jobs', { jobId, spec }, true)
      expect(await response.json()).toMatchObject({ ok: true, job: { jobId } })
      return jobId
    }
    const ended = async (jobId: string) => {
      await expect
        .poll(() => env.continuations.find((item) => item.jobId === jobId), { timeout: 30_000, interval: 50 })
        .toBeTruthy()
      // The runner has let the job go and deleted its folder.
      await expect.poll(() => worker.jobs().length, { timeout: 10_000 }).toBe(0)
      await expect.poll(async () => readdir(storage.jobsRoot()).catch(() => []), { timeout: 10_000 }).toEqual([])
      return env.continuations.find((item) => item.jobId === jobId)!
    }

    const first = await submit({
      folder,
      command:
        'mkdir -p out && cat link.txt src/data.txt > out/result.txt && printf %s "$MAESTRLY_JOB_ID" > out/id.txt' +
        ' && test ! -e node_modules && echo rendered',
      outputs: ['out/**'],
    })
    const done = await ended(first)
    expect(done.state).toBe('succeeded')
    expect(done.text).toContain('out/result.txt')
    expect(done.text).toContain('rendered')
    expect(await readFile(path.join(folder, 'out', 'result.txt'), 'utf8')).toBe('hello runner\nfirst data\n')
    expect(await readFile(path.join(folder, 'out', 'id.txt'), 'utf8')).toBe(first)
    expect(await readFile(path.join(folder, '.maestrly', 'runner-jobs', `${first}.log`), 'utf8')).toContain('rendered')
    // The inputs travelled once each; node_modules stayed behind.
    expect(env.blobRequests.flat().sort()).toEqual([sha256('hello runner\n'), sha256('first data\n')].sort())
    const job = await (await h.request('GET', `/internal/v1/runner-jobs/${first}`, undefined, true)).json()
    expect(job).toMatchObject({ state: 'succeeded', exitCode: 0, runnerName: 'Studio' })

    // A changed input travels alone; a failing command still returns its outputs and log.
    await writeFile(path.join(folder, 'src', 'data.txt'), 'second data\n')
    env.blobRequests.length = 0
    const second = await submit({
      folder,
      command: 'cat in.txt src/data.txt > out/result.txt; echo broken >&2; exit 3',
      outputs: ['out/**'],
    })
    const failed = await ended(second)
    expect(failed.state).toBe('failed')
    expect(failed.text).toContain('exit_code')
    expect(failed.text).toContain('broken')
    // The first job's outputs are in the folder now, so they are inputs of this one; `in.txt` is already there.
    expect(env.blobRequests.flat().sort()).toEqual(
      [sha256('second data\n'), sha256('hello runner\nfirst data\n'), sha256(first)].sort()
    )
    expect(await readFile(path.join(folder, 'out', 'result.txt'), 'utf8')).toBe('hello runner\nsecond data\n')
    expect(await (await h.request('GET', `/internal/v1/runner-jobs/${second}`, undefined, true)).json()).toMatchObject({
      state: 'failed',
      exitCode: 3,
      error: { code: 'exit_code' },
    })
  }, 60_000)

  it('stops a running job the bot cancels, and its conversation hears it was cancelled', async () => {
    const env = environment()
    const h = await harness(Date.now, {
      environments: true,
      instanceCapabilities: ['runner-jobs'],
      instanceRoutes: env.routes,
      runnerRelay: true,
    })
    const { worker } = await runner(h)
    const folder = tempDir('runner-e2e-folder-')
    await writeFile(path.join(folder, 'in.txt'), 'input\n')
    const spec = { folder, command: 'echo started; sleep 60', outputs: ['out/**'] }
    const jobId = 'job_' + randomBytes(12).toString('base64url')
    await env.records.create({
      jobId,
      conversationId: 'primary-conversation',
      conversation: { kind: 'primary' },
      folder,
      spec,
      createdAt: new Date().toISOString(),
      job: null,
      outputs: null,
      continued: false,
    })
    await h.request('POST', '/internal/v1/runner-jobs', { jobId, spec }, true)
    await expect.poll(() => worker.jobs()[0]?.state, { timeout: 20_000, interval: 50 }).toBe('running')
    const cancelled = await h.request('POST', `/internal/v1/runner-jobs/${jobId}/cancel`, undefined, true)
    expect(cancelled.status).toBe(200)
    await expect
      .poll(() => env.continuations.find((item) => item.jobId === jobId)?.state, { timeout: 30_000, interval: 50 })
      .toBe('cancelled')
    await expect.poll(() => worker.jobs().length, { timeout: 15_000 }).toBe(0)
  }, 60_000)
})
