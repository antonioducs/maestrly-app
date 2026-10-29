import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import {
  FLEET_MESSAGE_TEXT_MAX,
  fleetInstanceInputSchema,
  type FleetInstanceInput,
  type FleetRunnerJob,
} from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstanceHttpError } from '../../src/main/fleet/instance/http'
import { uuidFromSeed } from '../../src/main/fleet/instance/gateway-client'
import { runnerContinuationText } from '../../src/main/fleet/instance/runner-jobs/completion'
import { RunnerJobFiles } from '../../src/main/fleet/instance/runner-jobs/files'
import { RunnerJobRecords, type RunnerJobRecord } from '../../src/main/fleet/instance/runner-jobs/records'
import { RUNNER_FOLDER_STATE, RUNNER_JOB_FILES } from '../../src/main/fleet/instance/runner-jobs/shared'
import { BotRuntime } from '../../src/main/fleet/instance/runtime'
import { cleanTemps, JOB_ID, runnerJob, runnerRecord, tempFolder } from '../helpers/runner-jobs'

const servers: Server[] = []
afterEach(async () => {
  cleanTemps()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

type Lane = { kind: 'routine'; runId: string } | { kind: 'thread'; runId: string; threadId: string; title: string }

/** A runtime built from the parts a runner job's completion uses, with the job files wired to it as the constructor does. */
function fixture(options: { lanes?: Lane[]; input?: (value: FleetInstanceInput) => Promise<unknown> } = {}) {
  const root = tempFolder('runner-continuation-')
  const folder = path.join(root, 'work')
  mkdirSync(folder, { recursive: true })
  const records = new RunnerJobRecords(path.join(root, 'bot', 'runner-jobs'))
  const sent: FleetInstanceInput[] = []
  const input = vi.fn(async (value: FleetInstanceInput) => {
    await options.input?.(value)
    sent.push(value)
    return { inputId: 'input', itemId: 'item', queued: true }
  })
  const lanes = options.lanes ?? []
  const runtime = Object.create(BotRuntime.prototype) as BotRuntime
  Object.assign(runtime, {
    disposed: false,
    jobRecords: records,
    runs: { get: (id: string) => lanes.find((lane) => lane.runId === id) },
    input,
  })
  const files = new RunnerJobFiles({
    records,
    botFolder: path.join(root, 'bot'),
    onState: (record) => runtime.continueRunnerJob(record),
  })
  Object.assign(runtime, { jobFiles: files })
  return { root, folder, records, files, runtime, sent, input }
}

const seed = (records: RunnerJobRecords, folder: string, extra: Partial<RunnerJobRecord> = {}) =>
  records.create(runnerRecord(folder, extra))
const parsed = (value: FleetInstanceInput) => fleetInstanceInputSchema.parse(value)

// The bot environment runs in a Linux container: the folders of its jobs are POSIX paths.
describe.skipIf(process.platform === 'win32')('runner job completion', () => {
  it('continues the bot conversation once, with the result, when a job ends', async () => {
    const { folder, records, files, sent } = fixture()
    await seed(records, folder)
    writeFileSync(path.join(records.dir(JOB_ID), RUNNER_JOB_FILES.log), 'frame 1\nframe 2\nencoded 2 frames\n')
    await records.update(JOB_ID, (record) => ({
      ...record,
      outputs: { files: [{ path: 'out/video.mp4', size: 4_500_000 }], bytes: 4_500_000, sha256: 'a'.repeat(64) },
    }))

    // A job still going tells nobody.
    await files.state(JOB_ID, runnerJob(JOB_ID, 'running'))
    expect(sent).toEqual([])

    await files.state(
      JOB_ID,
      runnerJob(JOB_ID, 'succeeded', {
        exitCode: 0,
        startedAt: '2026-10-29T10:00:05.000Z',
        endedAt: '2026-10-29T10:03:17.000Z',
      })
    )
    expect(sent).toHaveLength(1)
    const [input] = sent
    expect(parsed(input)).toMatchObject({ source: 'continuation', attachments: [] })
    expect(input.run).toBeUndefined()
    expect(input.thread).toBeUndefined()
    expect(input.idempotencyKey).toBe(uuidFromSeed(`${JOB_ID}:succeeded`))
    expect(input.text).toContain(`Runner job ${JOB_ID} succeeded.`)
    expect(input.text).toContain('Runner: Studio.')
    expect(input.text).toContain('Exit code: 0.')
    expect(input.text).toContain('Ran for 3m 12s.')
    expect(input.text).toContain(`Folder: ${folder}`)
    expect(input.text).toContain('- out/video.mp4 (4.3 MiB)')
    expect(input.text).toContain('```\nframe 1\nframe 2\nencoded 2 frames\n```')
    expect((await records.get(JOB_ID))?.continued).toBe(true)

    // The same state sent again, or a later report of one it left, tells nobody twice.
    await files.state(JOB_ID, runnerJob(JOB_ID, 'succeeded', { exitCode: 0 }))
    await files.state(JOB_ID, runnerJob(JOB_ID, 'running'))
    expect(sent).toHaveLength(1)
  })

  it('tells why a job that failed, expired or was lost did not succeed', async () => {
    const { folder, records, files, sent } = fixture()
    await seed(records, folder)
    await files.state(
      JOB_ID,
      runnerJob(JOB_ID, 'failed', {
        exitCode: 2,
        error: { code: 'exit_code', message: 'The command exited with code 2.' },
        startedAt: '2026-10-29T10:00:00.000Z',
        endedAt: '2026-10-29T10:00:42.000Z',
      })
    )
    expect(sent[0].text).toContain('failed.')
    expect(sent[0].text).toContain('Exit code: 2.')
    expect(sent[0].text).toContain('Error exit_code: The command exited with code 2.')
    expect(sent[0].text).toContain('Ran for 42s.')
    expect(sent[0].text).toContain('No output files came back into the folder.')

    const expired = fixture()
    await seed(expired.records, expired.folder)
    await expired.files.state(
      JOB_ID,
      runnerJob(JOB_ID, 'expired', {
        runnerId: null,
        runnerName: null,
        error: { code: 'queue_timeout', message: 'No runner took the job in 60 minutes.' },
        endedAt: '2026-10-29T11:00:00.000Z',
      })
    )
    expect(expired.sent[0].text).toContain('expired: no runner took it in time')
    expect(expired.sent[0].text).toContain('Never started; queued for 1h 00m.')
    expect(expired.sent[0].text).not.toContain('Runner:')
  })

  it('continues the routine run or the thread that submitted the job as such', async () => {
    const run = fixture({ lanes: [{ kind: 'routine', runId: 'run-1' }] })
    await seed(run.records, run.folder, { conversation: { kind: 'run', runId: 'run-1' } })
    await run.files.state(JOB_ID, runnerJob(JOB_ID, 'succeeded', { exitCode: 0 }))
    expect(run.sent).toHaveLength(1)
    expect(run.sent[0]).toMatchObject({ source: 'continuation', run: { id: 'run-1' } })
    expect(run.sent[0].thread).toBeUndefined()
    expect(run.sent[0].text).not.toContain('no longer exists')

    const thread = fixture({ lanes: [{ kind: 'thread', runId: 'thread-1', threadId: 'thread-1', title: 'Plan' }] })
    await seed(thread.records, thread.folder, {
      conversation: { kind: 'thread', threadId: 'thread-1', title: 'Plan' },
    })
    await thread.files.state(JOB_ID, runnerJob(JOB_ID, 'failed', { exitCode: 1 }))
    expect(thread.sent).toHaveLength(1)
    expect(thread.sent[0]).toMatchObject({ source: 'continuation', thread: { id: 'thread-1', title: 'Plan' } })
    expect(thread.sent[0].run).toBeUndefined()
    expect(parsed(thread.sent[0])).toBeTruthy()
  })

  it('tells the bot conversation instead when the run or thread that submitted the job is gone', async () => {
    const run = fixture()
    await seed(run.records, run.folder, { conversation: { kind: 'run', runId: 'run-gone' } })
    await run.files.state(JOB_ID, runnerJob(JOB_ID, 'succeeded', { exitCode: 0 }))
    expect(run.sent).toHaveLength(1)
    expect(run.sent[0].run).toBeUndefined()
    expect(run.sent[0].text).toContain('submitted from the routine run run-gone, which no longer exists')
    expect((await run.records.get(JOB_ID))?.continued).toBe(true)

    // The conversation can also go between the check and the input.
    let first = true
    const thread = fixture({
      lanes: [{ kind: 'thread', runId: 'thread-1', threadId: 'thread-1', title: 'Plan' }],
      input: async (value) => {
        if (value.thread && first) {
          first = false
          throw new InstanceHttpError(404, 'NOT_FOUND', 'This conversation with another bot is not here.')
        }
      },
    })
    await seed(thread.records, thread.folder, {
      conversation: { kind: 'thread', threadId: 'thread-1', title: 'Plan' },
    })
    await thread.files.state(JOB_ID, runnerJob(JOB_ID, 'succeeded', { exitCode: 0 }))
    expect(thread.input).toHaveBeenCalledTimes(2)
    expect(thread.sent).toHaveLength(1)
    expect(thread.sent[0].thread).toBeUndefined()
    expect(thread.sent[0].text).toContain('submitted from the conversation "Plan", which no longer exists')
  })

  it('fails the state delivery when the conversation cannot be told, so the gateway sends it again', async () => {
    let failing = true
    const { folder, records, files, sent, input } = fixture({
      input: async () => {
        if (failing) throw new Error('disk full')
      },
    })
    await seed(records, folder)
    const ended = runnerJob(JOB_ID, 'succeeded', { exitCode: 0 })
    await expect(files.state(JOB_ID, ended)).rejects.toThrow('disk full')
    // The state is kept; only the telling is outstanding.
    expect(await records.get(JOB_ID)).toMatchObject({ job: { state: 'succeeded' }, continued: false })
    expect(sent).toEqual([])

    failing = false
    await files.state(JOB_ID, ended)
    expect(sent).toHaveLength(1)
    expect(input.mock.calls[0][0].idempotencyKey).toBe(input.mock.calls[1][0].idempotencyKey)
    expect((await records.get(JOB_ID))?.continued).toBe(true)
  })

  it('fails the state delivery while the bot is stopped', async () => {
    const { folder, records, files, runtime, sent } = fixture()
    await seed(records, folder)
    Object.assign(runtime, { disposed: true })
    await expect(files.state(JOB_ID, runnerJob(JOB_ID, 'succeeded', { exitCode: 0 }))).rejects.toMatchObject({
      status: 404,
    })
    expect(sent).toEqual([])
    expect((await records.get(JOB_ID))?.continued).toBe(false)
  })

  it('keeps the message within the input limit however large the log, the list of files and the error are', async () => {
    const { folder, records, files, sent } = fixture()
    await seed(records, folder)
    // 3 MiB of log, with backticks that could close a fence; the tail the job keeps is 16 KiB, more than fits.
    const line = '```' + 'e'.repeat(300) + '\n'
    writeFileSync(path.join(records.dir(JOB_ID), RUNNER_JOB_FILES.log), line.repeat(10_000) + 'the last line\n')
    await records.update(JOB_ID, (record) => ({
      ...record,
      outputs: {
        files: Array.from({ length: 300 }, (_, n) => ({ path: `out/${'d'.repeat(800)}/${n}.bin`, size: n * 1000 })),
        bytes: 1,
        sha256: 'b'.repeat(64),
      },
    }))
    await files.state(
      JOB_ID,
      runnerJob(JOB_ID, 'failed', {
        runnerName: 'R'.repeat(60),
        exitCode: 137,
        error: { code: 'timeout', message: 'm'.repeat(1_000) },
        startedAt: '2026-10-29T10:00:00.000Z',
        endedAt: '2026-10-29T12:00:00.000Z',
      })
    )
    expect(sent).toHaveLength(1)
    const { text } = sent[0]
    expect(text.length).toBeLessThanOrEqual(FLEET_MESSAGE_TEXT_MAX)
    expect(parsed(sent[0])).toBeTruthy()
    expect(text).toMatch(/and \d+ more\n/)
    expect(text).toContain('(earlier lines omitted)')
    // The log is cut from its start, and ends where the job's did, in a fence its own backticks cannot close.
    expect(text.trimEnd().endsWith('the last line\n````')).toBe(true)
    expect(text).toContain('\n````\n')
  })

  it("reads the runner's own copy of the log from the job folder when it holds more than the environment's", async () => {
    const { folder, records, files, sent } = fixture()
    await seed(records, folder)
    writeFileSync(path.join(records.dir(JOB_ID), RUNNER_JOB_FILES.log), 'partial\n')
    mkdirSync(path.join(folder, RUNNER_FOLDER_STATE), { recursive: true })
    writeFileSync(path.join(folder, RUNNER_FOLDER_STATE, `${JOB_ID}.log`), 'partial\nand the rest\n')
    await files.state(JOB_ID, runnerJob(JOB_ID, 'succeeded', { exitCode: 0 }))
    expect(sent[0].text).toContain('and the rest')
  })

  it('gives a distinct key to each final state of a job', () => {
    expect(uuidFromSeed(`${JOB_ID}:failed`)).not.toBe(uuidFromSeed(`${JOB_ID}:succeeded`))
    expect(uuidFromSeed(`${JOB_ID}:failed`)).toBe(uuidFromSeed(`${JOB_ID}:failed`))
    expect(fleetInstanceInputSchema.shape.idempotencyKey.safeParse(uuidFromSeed(JOB_ID)).success).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('runner job continuation text', () => {
  const job = (extra: Partial<FleetRunnerJob> = {}) => runnerJob(JOB_ID, 'succeeded', { exitCode: 0, ...extra })

  it('is bounded for the worst inputs of every part at once', () => {
    const text = runnerContinuationText({
      record: {
        folder: `/${'f'.repeat(1_000)}`,
        outputs: {
          files: Array.from({ length: 1_000 }, (_, n) => ({ path: `${'p'.repeat(1_000)}${n}`, size: 1 })),
          bytes: 1,
          sha256: 'c'.repeat(64),
        },
      },
      job: job({
        runnerName: 'n'.repeat(60),
        error: { code: 'transfer_failed', message: 'e'.repeat(1_000) },
        startedAt: '2026-10-29T10:00:00.000Z',
        endedAt: '2026-10-29T10:00:01.000Z',
      }),
      log: 'x'.repeat(200_000),
      from: `the conversation "${'t'.repeat(200)}"`,
    })
    expect(text.length).toBeLessThanOrEqual(FLEET_MESSAGE_TEXT_MAX)
    expect(text).toContain('and ')
    expect(text).toContain('(earlier lines omitted)')
  })

  it('lists at most 50 output files and counts the rest', () => {
    const text = runnerContinuationText({
      record: {
        folder: '/work',
        outputs: {
          files: Array.from({ length: 80 }, (_, n) => ({ path: `out/${n}.png`, size: 10 })),
          bytes: 800,
          sha256: 'c'.repeat(64),
        },
      },
      job: job(),
      log: '',
    })
    expect(text).toContain('- out/49.png (10 B)')
    expect(text).not.toContain('out/50.png')
    expect(text).toContain('and 30 more')
    expect(text).not.toContain('```')
  })

  it('keeps whole lines at the start of a cut log', () => {
    const log = Array.from({ length: 2_000 }, (_, n) => `line number ${n}`).join('\n')
    const text = runnerContinuationText({ record: { folder: '/work', outputs: null }, job: job(), log })
    const shown = text.slice(text.indexOf('(earlier lines omitted)\n') + '(earlier lines omitted)\n'.length)
    expect(shown.startsWith('line number ')).toBe(true)
    expect(text).toContain('line number 1999\n```')
  })
})

describe.skipIf(process.platform === 'win32')('runner job reconciliation', () => {
  async function gateway(jobs: FleetRunnerJob[]) {
    const asked: string[] = []
    const server = createServer((request, response) => {
      asked.push(`${request.method} ${request.url}`)
      response.setHeader('content-type', 'application/json')
      const found = jobs.find((candidate) => request.url === `/internal/v1/runner-jobs/${candidate.jobId}`)
      response.statusCode = found ? 200 : 404
      response.end(JSON.stringify(found ?? { code: 'NOT_FOUND', message: 'Runner job not found' }))
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked }
  }
  const A = 'job_AAAAAAAAAAAAAAAA0001'
  const B = 'job_AAAAAAAAAAAAAAAA0002'
  const C = 'job_AAAAAAAAAAAAAAAA0003'
  const D = 'job_AAAAAAAAAAAAAAAA0004'

  it('feeds the final states the gateway reports for jobs that were running when the bot stopped', async () => {
    const { folder, records, runtime, sent } = fixture()
    const api = await gateway([
      runnerJob(A, 'succeeded', { exitCode: 0 }),
      runnerJob(B, 'running'),
      runnerJob(D, 'succeeded', { exitCode: 0 }),
    ])
    Object.assign(runtime, {
      stored: { profile: { gateway: { runnersEnabled: true } }, primaryConversationId: 'primary' },
      gatewayToken: 't',
      host: { gatewayUrl: api.url },
    })
    await seed(records, folder, { jobId: A, job: runnerJob(A, 'running') })
    await seed(records, folder, { jobId: B, job: runnerJob(B, 'queued') })
    // The gateway never heard of this one; one that was told already is not asked about.
    await seed(records, folder, { jobId: C, job: null })
    await seed(records, folder, { jobId: D, job: runnerJob(D, 'succeeded'), continued: true })

    await runtime.reconcileRunnerJobs()

    expect(sent.map((item) => item.text.split('\n')[0])).toEqual([`Runner job ${A} succeeded.`])
    expect(await records.get(A)).toMatchObject({ job: { state: 'succeeded' }, continued: true })
    expect(await records.get(B)).toMatchObject({ job: { state: 'running' }, continued: false })
    expect(await records.get(C)).toMatchObject({ job: null, continued: false })
    expect(api.asked.some((entry) => entry.endsWith(D))).toBe(false)
  })

  it('tells the conversation of a job that ended but was not told, and does nothing without runners', async () => {
    const { folder, records, runtime, sent } = fixture()
    const api = await gateway([])
    Object.assign(runtime, {
      stored: { profile: { gateway: { runnersEnabled: false } }, primaryConversationId: 'primary' },
      gatewayToken: 't',
      host: { gatewayUrl: api.url },
    })
    await seed(records, folder, { jobId: A, job: runnerJob(A, 'failed', { exitCode: 1 }) })
    await runtime.reconcileRunnerJobs()
    expect(sent).toEqual([])
    expect(api.asked).toEqual([])

    Object.assign(runtime, { stored: { profile: { gateway: { runnersEnabled: true } }, primaryConversationId: 'p' } })
    await runtime.reconcileRunnerJobs()
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain(`Runner job ${A} failed.`)
    expect(api.asked).toEqual([])
  })
})
