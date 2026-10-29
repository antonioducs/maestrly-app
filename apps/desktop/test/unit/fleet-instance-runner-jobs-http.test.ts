import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import {
  FLEET_PROTOCOL_HEADER,
  FLEET_RUNNER_HEADERS,
  FLEET_RUNNER_LIMITS,
  fleetRunnerManifestSchema,
} from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import { InstanceHttpError } from '../../src/main/fleet/instance/http'
import { RunnerJobFiles } from '../../src/main/fleet/instance/runner-jobs/files'
import { type RunnerJobRecord, RunnerJobRecords } from '../../src/main/fleet/instance/runner-jobs/records'
import {
  createInstanceControlServer,
  InstanceEvents,
  type InstanceEnvironment,
} from '../../src/main/fleet/instance/server'
import {
  cleanTemps,
  collector,
  craftArchive,
  JOB_ID,
  jobSpec,
  runnerJob,
  runnerRecord,
  sha256,
  tempFolder,
  untar,
  writeTree,
} from '../helpers/runner-jobs'

const token = randomBytes(32).toString('base64url')
const config = parseBotInstanceConfig({
  MAESTRLY_BOT_MODE: '1',
  MAESTRLY_BOT_CONTROL_TOKEN: token,
  MAESTRLY_BOT_CONTROL_HOST: '127.0.0.1',
  MAESTRLY_BOT_CONTROL_PORT: '0',
})!

const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  )
  vi.restoreAllMocks()
  cleanTemps()
})

async function setup() {
  const base = tempFolder()
  const botFolder = path.join(base, 'bot')
  const work = path.join(base, 'work')
  mkdirSync(work, { recursive: true })
  const records = new RunnerJobRecords(path.join(botFolder, 'runner-jobs'))
  const states: RunnerJobRecord[] = []
  const files = new RunnerJobFiles({
    records,
    botFolder,
    onState: (record) => {
      states.push(record)
    },
  })
  const environment = {
    events: new InstanceEvents(),
    bot: vi.fn((botId: string) => {
      if (botId !== 'alpha') throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
      return { botId, runnerJobs: () => files }
    }),
  }
  const server = createInstanceControlServer(config, environment as unknown as InstanceEnvironment)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = (
    method: string,
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
    jobId = JOB_ID,
    botId = 'alpha'
  ) =>
    fetch(`${origin}/v1/bots/${botId}/runner-jobs/${jobId}${route}`, {
      method,
      headers: {
        [FLEET_PROTOCOL_HEADER]: '1',
        Authorization: `Bearer ${token}`,
        ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
    })
  await records.create(runnerRecord(work))
  return { base, work, botFolder, records, files, states, environment, origin, call }
}

const json = async (response: Response) => (await response.json()) as { code?: string; message?: string }

describe('runner job routes', () => {
  it('answers 404 for a bot or a job the environment does not hold, and 401 without credentials', async () => {
    const { call, origin } = await setup()
    const other = 'job_BBBBBBBBBBBBBBBB0002'
    const digest = sha256('x')
    const chunk = { [FLEET_RUNNER_HEADERS.sha256]: digest }
    const requests: Array<[string, string, unknown?, Record<string, string>?]> = [
      ['POST', '/state', { job: runnerJob(other, 'running') }],
      ['GET', '/manifest'],
      ['POST', '/blobs', { digests: [digest] }],
      ['POST', '/log?offset=0', Buffer.from('x')],
      ['GET', '/log'],
      ['GET', '/outputs'],
      ['PUT', '/outputs/0', Buffer.from('x'), chunk],
      ['POST', '/outputs/commit', { bytes: 1, sha256: digest }],
    ]
    for (const [method, route, body, headers] of requests) {
      const unknownJob = await call(method, route, body, headers, other)
      expect([method + route, unknownJob.status]).toEqual([method + route, 404])
      expect(await json(unknownJob)).toMatchObject({ code: 'NOT_FOUND' })
      const unknownBot = await call(method, route, body, headers, JOB_ID, 'ghost')
      expect([method + route, unknownBot.status]).toEqual([method + route, 404])
      expect((await call(method, route, body, headers, JOB_ID, 'Not_A_Bot')).status).toBe(404)
    }
    expect((await call('GET', '/outputs', undefined, {}, 'not-a-job')).status).toBe(404)
    const denied = await fetch(`${origin}/v1/bots/alpha/runner-jobs/${JOB_ID}/outputs`, {
      headers: { [FLEET_PROTOCOL_HEADER]: '1' },
    })
    expect(denied.status).toBe(401)
  })

  it('stores a job state, tells the hook, and ignores a state a job left', async () => {
    const { call, records, states } = await setup()
    const running = await call('POST', '/state', { job: runnerJob(JOB_ID, 'running') })
    expect(running.status).toBe(204)
    expect((await records.get(JOB_ID))?.job?.state).toBe('running')
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ jobId: JOB_ID, job: { state: 'running' }, continued: false })

    const done = await call('POST', '/state', { job: runnerJob(JOB_ID, 'succeeded', { exitCode: 0 }) })
    expect(done.status).toBe(204)
    expect((await records.get(JOB_ID))?.job).toMatchObject({ state: 'succeeded', exitCode: 0 })
    expect(states).toHaveLength(2)

    // A late report of an earlier state changes nothing.
    expect((await call('POST', '/state', { job: runnerJob(JOB_ID, 'running') })).status).toBe(204)
    expect((await records.get(JOB_ID))?.job?.state).toBe('succeeded')
    expect(states).toHaveLength(2)
  })

  it('refuses a state that is not for the job in the path or is not a job', async () => {
    const { call, states } = await setup()
    const mismatch = await call('POST', '/state', { job: runnerJob('job_BBBBBBBBBBBBBBBB0002', 'running') })
    expect(mismatch.status).toBe(400)
    expect((await call('POST', '/state', { job: { state: 'running' } })).status).toBe(400)
    expect((await call('POST', '/state', Buffer.from('{}'), { 'content-type': 'text/plain' })).status).toBe(400)
    expect(states).toHaveLength(0)
  })

  it('fails the state call when the hook fails, so the gateway sends it again', async () => {
    const { call, files, records } = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    files.setOnState(() => {
      throw new Error('conversation unavailable')
    })
    expect((await call('POST', '/state', { job: runnerJob(JOB_ID, 'succeeded') })).status).toBe(500)
    expect((await records.get(JOB_ID))?.job?.state).toBe('succeeded')
    const again = vi.fn()
    files.setOnState(again)
    expect((await call('POST', '/state', { job: runnerJob(JOB_ID, 'succeeded') })).status).toBe(204)
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('copies the log into the job folder when the job ends', async () => {
    const { call, work, botFolder } = await setup()
    const log = path.join(work, '.maestrly', 'runner-jobs', `${JOB_ID}.log`)
    expect((await call('POST', '/log?offset=0', Buffer.from('first line\n'))).status).toBe(204)
    expect((await call('POST', '/log?offset=11', Buffer.from('second line\n'))).status).toBe(204)
    await call('POST', '/state', { job: runnerJob(JOB_ID, 'running') })
    expect(existsSync(log)).toBe(false)
    await call('POST', '/state', { job: runnerJob(JOB_ID, 'failed', { exitCode: 2 }) })
    expect(readFileSync(log, 'utf8')).toBe('first line\nsecond line\n')
    expect(readFileSync(path.join(botFolder, 'runner-jobs', JOB_ID, 'job.log'), 'utf8')).toBe(
      'first line\nsecond line\n'
    )
  })

  it("keeps the runner's copy of the log when it is the longer one", async () => {
    const { call, work } = await setup()
    const log = path.join(work, '.maestrly', 'runner-jobs', `${JOB_ID}.log`)
    mkdirSync(path.dirname(log), { recursive: true })
    writeFileSync(log, 'the whole log from the runner\n')
    await call('POST', '/log?offset=0', Buffer.from('part of it\n'))
    await call('POST', '/state', { job: runnerJob(JOB_ID, 'succeeded') })
    expect(readFileSync(log, 'utf8')).toBe('the whole log from the runner\n')
  })

  it('drops the manifest and a half-received archive when the job ends, and keeps the rest', async () => {
    const { call, work, records } = await setup()
    writeTree(work, { 'a.txt': 'alpha' })
    await call('GET', '/manifest')
    await call('POST', '/log?offset=0', Buffer.from('log\n'))
    const bytes = Buffer.from('half an archive')
    await call('PUT', '/outputs/0', bytes, { [FLEET_RUNNER_HEADERS.sha256]: sha256(bytes) })
    const dir = records.dir(JOB_ID)
    expect(readdirSync(dir).sort()).toEqual(['job.log', 'manifest.json', 'outputs.tar.zst.partial', 'record.json'])
    await call('POST', '/state', { job: runnerJob(JOB_ID, 'failed') })
    expect(readdirSync(dir).sort()).toEqual(['job.log', 'record.json'])
  })

  it('does not fail a final state when the log cannot be copied', async () => {
    const { call, work, states } = await setup()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await call('POST', '/log?offset=0', Buffer.from('log\n'))
    writeFileSync(path.join(work, '.maestrly'), 'a file where the folder should be')
    expect((await call('POST', '/state', { job: runnerJob(JOB_ID, 'succeeded') })).status).toBe(204)
    expect(states).toHaveLength(1)
  })

  it('writes log batches at their offsets and answers a gap with a conflict', async () => {
    const { call, botFolder } = await setup()
    const log = path.join(botFolder, 'runner-jobs', JOB_ID, 'job.log')
    expect((await call('POST', '/log?offset=0', Buffer.from('abc'))).status).toBe(204)
    expect((await call('POST', '/log?offset=0', Buffer.from('abc'))).status).toBe(204)
    expect((await call('POST', '/log?offset=3', Buffer.from('def'))).status).toBe(204)
    expect(readFileSync(log, 'utf8')).toBe('abcdef')
    const gap = await call('POST', '/log?offset=10', Buffer.from('late'))
    expect(gap.status).toBe(409)
    expect(await json(gap)).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('6 bytes') })
    for (const query of ['', '?offset=', '?offset=-1', '?offset=1.5', '?offset=abc'])
      expect((await call('POST', `/log${query}`, Buffer.from('x'))).status).toBe(400)
    const large = Buffer.alloc(FLEET_RUNNER_LIMITS.logBatchBytesMax + 1)
    expect((await call('POST', '/log?offset=6', large)).status).toBe(400)
    expect(readFileSync(log, 'utf8')).toBe('abcdef')
  })

  it('reads the log in pieces: its end, from an offset, within a limit, and after the job ended', async () => {
    const { call, work } = await setup()
    const read = async (query = '') => {
      const response = await call('GET', `/log${query}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      return (await response.json()) as { start: number; next: number; size: number; text: string }
    }
    // A log that has not started is empty, not missing.
    expect(await read()).toEqual({ start: 0, next: 0, size: 0, text: '' })
    await call('POST', '/log?offset=0', Buffer.from('first line\nsecond line\nthird\n'))
    expect(await read()).toEqual({ start: 0, next: 29, size: 29, text: 'first line\nsecond line\nthird\n' })
    // Without an offset, the end of the log from the start of a line.
    expect((await read('?limit=10')).text).toBe('third\n')
    const first = await read('?offset=0&limit=5')
    expect(first).toEqual({ start: 0, next: 5, size: 29, text: 'first' })
    const second = await read(`?offset=${first.next}`)
    expect(second).toEqual({ start: 5, next: 29, size: 29, text: ' line\nsecond line\nthird\n' })
    // Reading on from the end finds what the runner sends next.
    await call('POST', '/log?offset=29', Buffer.from('fourth\n'))
    expect(await read(`?offset=${second.next}`)).toEqual({ start: 29, next: 36, size: 36, text: 'fourth\n' })
    // The log stays readable once the job ended, from the runner's whole copy when it is the longer one.
    await call('POST', '/state', { job: runnerJob(JOB_ID, 'succeeded', { exitCode: 0 }) })
    expect((await read('?offset=29')).text).toBe('fourth\n')
    const own = path.join(work, '.maestrly', 'runner-jobs', `${JOB_ID}.log`)
    writeFileSync(own, 'first line\nsecond line\nthird\nfourth\nfifth\n')
    expect(await read('?offset=36')).toEqual({ start: 36, next: 42, size: 42, text: 'fifth\n' })
  })

  it('refuses a log read with a bad offset or limit', async () => {
    const { call } = await setup()
    await call('POST', '/log?offset=0', Buffer.from('abc'))
    const tooMany = FLEET_RUNNER_LIMITS.logPageBytesMax + 1
    for (const query of [
      '?offset=',
      '?offset=-1',
      '?offset=1.5',
      '?offset=abc',
      '?limit=',
      '?limit=0',
      '?limit=-5',
      '?limit=2.5',
      '?limit=x',
      `?limit=${tooMany}`,
    ])
      expect([query, (await call('GET', `/log${query}`)).status]).toEqual([query, 400])
    expect((await call('GET', `/log?offset=0&limit=${FLEET_RUNNER_LIMITS.logPageBytesMax}`)).status).toBe(200)
  })

  it('serves the manifest of the job folder as JSON', async () => {
    const { call, work, botFolder, records } = await setup()
    writeTree(work, { 'src/a.txt': 'alpha', 'node_modules/x.js': 'left out', 'b.txt': 'beta' })
    const response = await call('GET', '/manifest')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const manifest = fleetRunnerManifestSchema.parse(await response.json())
    expect(manifest).toMatchObject({ jobId: JOB_ID, bytes: 9, skipped: 0 })
    expect(manifest.entries.map((entry) => entry.path)).toEqual(['b.txt', 'src', 'src/a.txt'])
    // The manifest and the digest index are kept, apart from the folder.
    expect(existsSync(path.join(records.dir(JOB_ID), 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(botFolder, 'runner-digests'))).toBe(true)
    expect(existsSync(path.join(work, '.maestrly'))).toBe(false)
  })

  it('answers 409 for a folder that is gone and 400 for one past the limits', async () => {
    const { call, files, records } = await setup()
    await records.create(runnerRecord(path.join(tempFolder(), 'gone'), { jobId: 'job_CCCCCCCCCCCCCCCC0003' }))
    expect((await call('GET', '/manifest', undefined, {}, 'job_CCCCCCCCCCCCCCCC0003')).status).toBe(409)
    vi.spyOn(files, 'manifest').mockRejectedValue(new InstanceHttpError(400, 'INVALID_REQUEST', 'Too many files.'))
    const refused = await call('GET', '/manifest')
    expect(refused.status).toBe(400)
    expect((await json(refused)).message).toBe('Too many files.')
  })

  it('streams the blobs asked for as a zstd tar', async () => {
    const { call, work } = await setup()
    writeTree(work, { 'a.txt': 'alpha', 'dir/b.txt': 'beta' })
    await call('GET', '/manifest')
    const response = await call('POST', '/blobs', { digests: [sha256('beta'), sha256('alpha')] })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    const entries = await untar(Buffer.from(await response.arrayBuffer()))
    expect(entries.map((entry) => [entry.name, entry.content.toString()])).toEqual([
      [sha256('beta'), 'beta'],
      [sha256('alpha'), 'alpha'],
    ])
  })

  it('serves blobs of a manifest built before this process restarted', async () => {
    const { call, work, botFolder, records } = await setup()
    writeTree(work, { 'a.txt': 'alpha' })
    await call('GET', '/manifest')
    // A fresh set of files over the same folders, as after a restart.
    const restarted = new RunnerJobFiles({ records, botFolder })
    const out = collector()
    await restarted.blobs(JOB_ID, [sha256('alpha')], out.sink)
    await out.done
    expect((await untar(out.bytes()))[0].content.toString()).toBe('alpha')
  })

  it('refuses blobs before a manifest, unknown blobs and a bad request as proper JSON errors', async () => {
    const { call, work } = await setup()
    writeTree(work, { 'a.txt': 'alpha' })
    const early = await call('POST', '/blobs', { digests: [sha256('alpha')] })
    expect(early.status).toBe(409)
    expect(early.headers.get('content-type')).toContain('application/json')

    await call('GET', '/manifest')
    const unknown = await call('POST', '/blobs', { digests: [sha256('alpha'), sha256('nope')] })
    expect(unknown.status).toBe(400)
    expect(unknown.headers.get('content-type')).toContain('application/json')
    expect((await json(unknown)).message).toContain(sha256('nope'))

    for (const digests of [[], ['not-a-digest'], 'x'])
      expect((await call('POST', '/blobs', { digests })).status).toBe(400)
    expect((await call('POST', '/blobs', { digests: [sha256('alpha')], extra: 1 })).status).toBe(400)

    writeFileSync(path.join(work, 'a.txt'), 'changed')
    const changed = await call('POST', '/blobs', { digests: [sha256('alpha')] })
    expect(changed.status).toBe(409)
    expect(changed.headers.get('content-type')).toContain('application/json')
  })

  it('stops packing blobs when the client goes away', async () => {
    const { call, work, files } = await setup()
    const big = randomBytes(48 * 1024 * 1024)
    writeFileSync(path.join(work, 'big.bin'), big)
    await call('GET', '/manifest')
    let seen: AbortSignal | undefined
    const real = files.blobs.bind(files)
    vi.spyOn(files, 'blobs').mockImplementation((jobId, digests, output, signal) => {
      seen = signal
      return real(jobId, digests, output, signal)
    })
    const response = await call('POST', '/blobs', { digests: [sha256(big)] })
    const reader = response.body!.getReader()
    await reader.read()
    expect(seen?.aborted).toBe(false)
    await reader.cancel()
    await vi.waitFor(() => expect(seen?.aborted).toBe(true))
  })

  it('receives the outputs: status, chunks, commit and the files in place', async () => {
    const { call, work, records } = await setup()
    writeFileSync(path.join(work, 'keep.txt'), 'untouched')
    const archive = path.join(tempFolder(), 'outputs.tar.zst')
    await craftArchive(archive, [
      { name: 'out/', type: 'directory' },
      { name: 'out/video.mp4', content: Buffer.alloc(200_000, 7) },
      { name: `.maestrly/runner-jobs/${JOB_ID}.log`, content: 'runner log' },
    ])
    const data = readFileSync(archive)
    const put = (offset: number, bytes: Buffer, digest = sha256(bytes), extra: Record<string, string> = {}) =>
      call('PUT', `/outputs/${offset}`, bytes, { [FLEET_RUNNER_HEADERS.sha256]: digest, ...extra })

    const status = await call('GET', '/outputs')
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ received: 0 })

    const half = Math.floor(data.length / 2)
    expect((await put(0, data.subarray(0, half))).status).toBe(204)
    expect(await (await call('GET', '/outputs')).json()).toEqual({ received: half })
    // A chunk sent again, a digest that does not match, an offset past the end.
    expect((await put(0, data.subarray(0, half))).status).toBe(204)
    const wrong = await put(half, data.subarray(half), sha256('other'))
    expect(wrong.status).toBe(400)
    const gap = await put(half + 5, data.subarray(half))
    expect(gap.status).toBe(409)
    expect((await json(gap)).message).toContain(`${half} bytes`)
    expect(await (await call('GET', '/outputs')).json()).toEqual({ received: half })
    expect((await put(half, data.subarray(half))).status).toBe(204)

    const commit = { bytes: data.length, sha256: sha256(data) }
    expect((await call('POST', '/outputs/commit', commit)).status).toBe(204)
    expect(readFileSync(path.join(work, 'out', 'video.mp4')).equals(Buffer.alloc(200_000, 7))).toBe(true)
    expect(readFileSync(path.join(work, '.maestrly', 'runner-jobs', `${JOB_ID}.log`), 'utf8')).toBe('runner log')
    expect(readFileSync(path.join(work, 'keep.txt'), 'utf8')).toBe('untouched')
    const record = await records.get(JOB_ID)
    expect(record?.outputs).toEqual({
      files: [
        { path: `.maestrly/runner-jobs/${JOB_ID}.log`, size: 10 },
        { path: 'out/video.mp4', size: 200_000 },
      ],
      bytes: data.length,
      sha256: sha256(data),
    })
    // A commit asked for again.
    expect((await call('POST', '/outputs/commit', commit)).status).toBe(204)
    expect((await call('POST', '/outputs/commit', { bytes: 1, sha256: sha256('x') })).status).toBe(409)
  })

  it('refuses output chunks without a length, with a bad digest or offset, or too large', async () => {
    const { call, origin } = await setup()
    const bytes = Buffer.from('abc')
    const header = { [FLEET_RUNNER_HEADERS.sha256]: sha256(bytes) }
    expect((await call('PUT', '/outputs/abc', bytes, header)).status).toBe(400)
    expect((await call('PUT', '/outputs/commit', bytes, header)).status).toBe(400)
    expect((await call('PUT', '/outputs/-1', bytes, header)).status).toBe(400)
    expect((await call('PUT', '/outputs/0', bytes)).status).toBe(400)
    expect((await call('PUT', '/outputs/0', bytes, { [FLEET_RUNNER_HEADERS.sha256]: 'XYZ' })).status).toBe(400)
    expect((await call('PUT', '/outputs/0', Buffer.alloc(0), header)).status).toBe(400)
    const tooLarge = Buffer.alloc(FLEET_RUNNER_LIMITS.outputChunkBytes + FLEET_RUNNER_LIMITS.chunkBodySlackBytes + 1)
    expect(
      (await call('PUT', '/outputs/0', tooLarge, { [FLEET_RUNNER_HEADERS.sha256]: sha256(tooLarge) })).status
    ).toBe(400)
    // No Content-Length: the body comes chunked.
    const streamed = await fetch(`${origin}/v1/bots/alpha/runner-jobs/${JOB_ID}/outputs/0`, {
      method: 'PUT',
      headers: { [FLEET_PROTOCOL_HEADER]: '1', Authorization: `Bearer ${token}`, ...header },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit)
    expect(streamed.status).toBe(400)
    expect(await (await call('GET', '/outputs')).json()).toEqual({ received: 0 })
  })

  it('refuses a hostile output archive at commit with a 400 and keeps the folder as it was', async () => {
    const { call, work } = await setup()
    const archive = path.join(tempFolder(), 'outputs.tar.zst')
    await craftArchive(archive, [
      { name: 'good.txt', content: 'good' },
      { name: '../evil.txt', content: 'evil' },
    ])
    const data = readFileSync(archive)
    await call('PUT', '/outputs/0', data, { [FLEET_RUNNER_HEADERS.sha256]: sha256(data) })
    const refused = await call('POST', '/outputs/commit', { bytes: data.length, sha256: sha256(data) })
    expect(refused.status).toBe(400)
    expect(existsSync(path.join(work, 'good.txt'))).toBe(false)
    expect(existsSync(path.join(work, '..', 'evil.txt'))).toBe(false)
    expect(await (await call('GET', '/outputs')).json()).toEqual({ received: 0 })
  })
})

describe('runner job files', () => {
  it('knows its jobs by id only', async () => {
    const { files, records } = await setup()
    await expect(files.outputs('../x')).rejects.toMatchObject({ status: 404 })
    expect(await files.outputs(JOB_ID)).toEqual({ received: 0 })
    expect(records.dir(JOB_ID)).toContain(JOB_ID)
  })

  it('sweeps old records at the retention of the gateway', async () => {
    const { files, records, work } = await setup()
    const old = 'job_DDDDDDDDDDDDDDDD0004'
    await records.create(
      runnerRecord(work, {
        jobId: old,
        spec: jobSpec(work),
        job: runnerJob(old, 'cancelled', { endedAt: '2026-10-01T00:00:00.000Z' }),
      })
    )
    await files.sweep(Date.parse('2026-10-29T12:00:00.000Z'))
    expect(await records.get(old)).toBeNull()
    expect(await records.get(JOB_ID)).not.toBeNull()
  })
})
