import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  type FleetRunnerCapabilities,
  type FleetRunnerJobEvent,
  fleetRunnerAssignedSpecSchema,
} from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunnerApiError } from '../../src/main/runner/api'
import { NativeExecutor } from '../../src/main/runner/native-executor'
import { RunnerStorage } from '../../src/main/runner/storage'
import { RunnerWorker, type RunnerSettings } from '../../src/main/runner/worker'
import {
  cleanTempDirs,
  environmentOfFolder,
  FakeRunnerApi,
  JOB_ID,
  readZstdTar,
  tempDir,
  transient,
  writeFiles,
} from '../helpers/runner-core'

const suite = process.platform === 'win32' ? describe.skip : describe
const SERVER = 'server-1'
const BOT = 'bot-1'
const SECOND_JOB = 'job_RunnerCoreTest0002'
const capabilities: FleetRunnerCapabilities = {
  protocol: 1,
  os: 'linux',
  arch: 'x64',
  cpus: 8,
  memoryBytes: 16 * 1024 ** 3,
  executor: 'native',
  gpu: null,
  slots: 1,
}

const jobFolders = (storage: RunnerStorage): string[] =>
  existsSync(storage.jobsRoot()) ? readdirSync(storage.jobsRoot()) : []

const workers: RunnerWorker[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()))
  cleanTempDirs()
})

interface EventOptions {
  jobId?: string
  command?: string
  outputs?: string[]
  caches?: Array<{ name: string; path: string }>
  env?: Record<string, string>
  timeoutMinutes?: number
  acceptInMs?: number
}
function jobEvent(options: EventOptions = {}): FleetRunnerJobEvent {
  const spec = fleetRunnerAssignedSpecSchema.parse({
    folder: '/home/bot/project',
    command: options.command ?? 'mkdir -p out && cat in.txt > out/result.txt',
    outputs: options.outputs ?? ['out/**'],
    caches: options.caches ?? [],
    env: options.env ?? {},
  })
  return {
    type: 'runner.job',
    at: new Date().toISOString(),
    jobId: options.jobId ?? JOB_ID,
    botId: BOT,
    runnerId: 'rnr_AAAAAAAAAAAAAAAA0001',
    // The schema's smallest timeout is a minute: tests that time out set a fraction of one.
    spec: { ...spec, timeoutMinutes: options.timeoutMinutes ?? spec.timeoutMinutes },
    acceptBy: new Date(Date.now() + (options.acceptInMs ?? 30_000)).toISOString(),
  }
}

async function setup(
  options: { settings?: Partial<RunnerSettings>; inputs?: Record<string, string>; holdAwake?: () => () => void } = {}
) {
  const root = tempDir()
  const storage = new RunnerStorage(root)
  const api = new FakeRunnerApi()
  const input = tempDir()
  writeFiles(input, options.inputs ?? { 'in.txt': 'hello runner', 'keep/unchanged.txt': 'same' })
  const environment = await environmentOfFolder(input)
  api.serve(JOB_ID, environment)
  api.serve(SECOND_JOB, { ...environment, manifest: { ...environment.manifest, jobId: SECOND_JOB } })
  const settings: RunnerSettings = {
    accepting: true,
    slots: 1,
    blobCapBytes: 1024 ** 3,
    executor: 'native',
    ...options.settings,
  }
  const changes = { count: 0 }
  const worker = new RunnerWorker({
    storage,
    executors: () =>
      new NativeExecutor({ loginPath: async () => process.env.PATH ?? '/usr/bin:/bin', killGraceMs: 200 }),
    settings: () => settings,
    capabilities: async () => ({ ...capabilities, slots: settings.slots }),
    api: (serverId) => (serverId === SERVER ? api : null),
    holdAwake: options.holdAwake,
    onChange: () => changes.count++,
    tuning: {
      sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, Math.min(ms, 5))
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(signal.reason)
            },
            { once: true }
          )
        }),
      log: { intervalMs: 10, backoff: () => 1 },
      restartFinishWaitMs: 2_000,
    },
  })
  workers.push(worker)
  await worker.start()
  await worker.connected(SERVER)
  const finished = (count = 1) => vi.waitFor(() => expect(api.finished).toHaveLength(count), { timeout: 15_000 })
  const archive = () => readZstdTar(api.outputBytes)
  return { root, storage, api, worker, settings, changes, finished, archive, scope: storage.scope(SERVER, BOT) }
}

suite('runner worker', () => {
  it('runs a job end to end: accepts, fetches the inputs, runs, uploads the outputs, finishes', async () => {
    const { api, worker, storage, finished, archive, root } = await setup()
    worker.handleJob(SERVER, jobEvent())
    await finished()

    expect(api.accepted).toEqual([JOB_ID])
    expect(api.progressed).toEqual([JOB_ID])
    expect(api.finished).toEqual([{ jobId: JOB_ID, result: { exitCode: 0, error: null } }])
    // Everything the environment held was fetched once, in one request.
    expect(api.blobRequests).toHaveLength(1)
    expect(api.blobRequests[0]).toHaveLength(2)
    // Outputs: the new file and the log, not the unchanged inputs.
    expect(api.commit?.bytes).toBe(api.outputBytes.length)
    const entries = await archive()
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      [`.maestrly/runner-jobs/${JOB_ID}.log`, 'out/result.txt'].sort()
    )
    expect(entries.find((entry) => entry.name === 'out/result.txt')?.content.toString()).toBe('hello runner')
    // The job's folder is gone and nothing is held, once the gateway has its result.
    await vi.waitFor(() => {
      expect(worker.jobs()).toEqual([])
      expect(jobFolders(storage)).toEqual([])
      expect(JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'))).toEqual({ jobs: [] })
    })
  })

  it('reports its state when it connects and after every change of its jobs', async () => {
    const { api, worker, finished } = await setup()
    expect(api.reports).toHaveLength(1)
    expect(api.reports[0]).toMatchObject({ accepting: true, jobs: [], capabilities: { slots: 1, executor: 'native' } })
    worker.handleJob(SERVER, jobEvent())
    await finished()
    await vi.waitFor(() => expect(api.reports.at(-1)?.jobs).toEqual([]))
    expect(api.reports.some((report) => report.jobs.includes(JOB_ID))).toBe(true)
    expect(api.reports.every((report) => report.jobs.length <= 1)).toBe(true)
  })

  it('lists its jobs for the settings while they run', async () => {
    const { worker, api, changes, finished } = await setup()
    worker.handleJob(SERVER, jobEvent({ command: 'echo started\nsleep 30' }))
    expect(worker.jobs()).toMatchObject([
      { serverId: SERVER, botId: BOT, jobId: JOB_ID, command: 'echo started', state: 'preparing' },
    ])
    await vi.waitFor(() => expect(worker.jobs()[0]?.state).toBe('running'))
    expect(worker.jobs()[0]?.startedAt).toBeGreaterThan(Date.now() - 60_000)
    expect(changes.count).toBeGreaterThan(1)
    worker.cancel(SERVER, JOB_ID)
    await finished()
    expect(api.finished[0]?.result).toEqual({ exitCode: null, error: null })
  })

  it('still sends the outputs and the log when the command exits with an error', async () => {
    const { api, worker, finished, archive } = await setup()
    worker.handleJob(
      SERVER,
      jobEvent({ command: 'mkdir -p out; echo partial > out/partial.txt; echo oops >&2; exit 3' })
    )
    await finished()
    expect(api.finished[0]?.result).toEqual({ exitCode: 3, error: null })
    expect(api.progressed).toEqual([JOB_ID])
    const entries = await archive()
    expect(entries.find((entry) => entry.name === 'out/partial.txt')?.content.toString()).toBe('partial\n')
    expect(entries.find((entry) => entry.name.endsWith('.log'))?.content.toString()).toContain('oops')
    expect(api.logBytes.toString()).toContain('oops')
  })

  it('finishes with the code timeout, after sending the outputs, when the command runs too long', async () => {
    const { api, worker, finished, archive } = await setup()
    worker.handleJob(
      SERVER,
      jobEvent({ command: 'mkdir -p out; echo early > out/early.txt; sleep 30', timeoutMinutes: 0.004 })
    )
    await finished()
    const result = api.finished[0]?.result
    expect(result?.error?.code).toBe('timeout')
    expect(result?.error?.message).toContain('stopped')
    expect((await archive()).some((entry) => entry.name === 'out/early.txt')).toBe(true)
  })

  it('stops a running job on cancel, sends no outputs, and finishes without an exit code or error', async () => {
    const { api, worker, finished, storage } = await setup()
    worker.handleJob(SERVER, jobEvent({ command: 'echo started; sleep 30' }))
    await vi.waitFor(() => expect(api.logBytes.toString()).toContain('started'))
    worker.handleCancel(SERVER, JOB_ID)
    await finished()
    expect(api.finished[0]?.result).toEqual({ exitCode: null, error: null })
    expect(api.progressed).toEqual([])
    expect(api.commit).toBeNull()
    await vi.waitFor(() => expect(worker.jobs()).toEqual([]))
    expect(jobFolders(storage)).toEqual([])
  })

  it('stops a job the gateway no longer knows, without telling the gateway anything more', async () => {
    const { api, worker, storage } = await setup()
    worker.handleJob(SERVER, jobEvent({ command: 'echo started; sleep 30' }))
    await vi.waitFor(() => expect(api.logBytes.toString()).toContain('started'))
    api.stop = [JOB_ID]
    await worker.refresh()
    await vi.waitFor(() => expect(worker.jobs()).toEqual([]))
    expect(api.finished).toEqual([])
    expect(jobFolders(storage)).toEqual([])
  })

  describe('refusing jobs', () => {
    it('ignores a job while every slot is busy', async () => {
      const { api, worker, finished } = await setup()
      worker.handleJob(SERVER, jobEvent({ command: 'sleep 30' }))
      worker.handleJob(SERVER, jobEvent({ jobId: SECOND_JOB }))
      worker.handleJob(SERVER, jobEvent({ command: 'sleep 30' }))
      await vi.waitFor(() => expect(api.accepted).toEqual([JOB_ID]))
      expect(worker.jobs().map((job) => job.jobId)).toEqual([JOB_ID])
      worker.cancel(SERVER, JOB_ID)
      await finished()
      expect(api.accepted).toEqual([JOB_ID])
    })

    it('frees the slot when it sends the result, so the next job is not turned away', async () => {
      const { api, worker, finished } = await setup()
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      // The gateway starts the next job as soon as it has the result, before the answer reaches the runner.
      api.fault = async ({ method }) => {
        if (method === 'finish') await held
        return undefined
      }
      worker.handleJob(SERVER, jobEvent())
      await vi.waitFor(() => expect(worker.jobs()[0]?.state).toBe('finishing'))
      worker.handleJob(SERVER, jobEvent({ jobId: SECOND_JOB }))
      await vi.waitFor(() => expect(api.accepted).toEqual([JOB_ID, SECOND_JOB]))
      release()
      await finished(2)
    })

    it('takes several jobs at once when it has several slots', async () => {
      const { api, worker, finished } = await setup({ settings: { slots: 2 } })
      worker.handleJob(SERVER, jobEvent())
      worker.handleJob(SERVER, jobEvent({ jobId: SECOND_JOB }))
      await finished(2)
      expect(api.accepted.sort()).toEqual([JOB_ID, SECOND_JOB].sort())
    })

    it('ignores jobs while it does not take jobs, for an unknown server, or past their accept time', async () => {
      const { api, worker, settings } = await setup()
      settings.accepting = false
      worker.handleJob(SERVER, jobEvent())
      settings.accepting = true
      worker.handleJob('other-server', jobEvent())
      worker.handleJob(SERVER, jobEvent({ acceptInMs: -1_000 }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(api.accepted).toEqual([])
      expect(worker.jobs()).toEqual([])
    })

    it('drops a job the gateway no longer lets it accept', async () => {
      const { api, worker, storage } = await setup()
      api.fault = ({ method }) =>
        method === 'accept' ? new RunnerApiError(409, 'CONFLICT', 'not waiting', false) : undefined
      worker.handleJob(SERVER, jobEvent())
      await vi.waitFor(() => expect(worker.jobs()).toEqual([]))
      expect(api.finished).toEqual([])
      expect(api.calls.some((call) => call.method === 'manifest')).toBe(false)
      expect(jobFolders(storage)).toEqual([])
    })

    it('tries accepting again while the gateway does not answer', async () => {
      const { api, worker, finished } = await setup()
      let failures = 2
      api.fault = ({ method }) => (method === 'accept' && failures-- > 0 ? transient() : undefined)
      worker.handleJob(SERVER, jobEvent())
      await finished()
      expect(api.accepted).toEqual([JOB_ID])
      expect(api.finished[0]?.result.exitCode).toBe(0)
    })
  })

  describe('inputs', () => {
    it('asks only for the blobs the cache lacks, and the next job asks for none', async () => {
      const { api, worker, finished } = await setup()
      worker.handleJob(SERVER, jobEvent())
      await finished()
      expect(api.blobRequests).toHaveLength(1)
      api.outputBytes = Buffer.alloc(0)
      worker.handleJob(SERVER, jobEvent({ jobId: SECOND_JOB }))
      await finished(2)
      expect(api.blobRequests).toHaveLength(1)
      expect(api.finished[1]?.result.exitCode).toBe(0)
    })

    it('asks again for the blobs that arrived corrupted, and only for those', async () => {
      const { api, worker, finished } = await setup()
      api.corruptBlobAnswers = 1
      worker.handleJob(SERVER, jobEvent())
      await finished()
      expect(api.blobRequests).toHaveLength(2)
      expect(api.blobRequests[1]).toHaveLength(1)
      expect(api.blobRequests[1]?.[0]).toBe(api.blobRequests[0]?.[0])
      expect(api.finished[0]?.result).toEqual({ exitCode: 0, error: null })
    })

    it('fails with transfer_failed, without running the command, after three corrupted answers', async () => {
      const { api, worker, finished } = await setup()
      api.corruptBlobAnswers = 10
      worker.handleJob(SERVER, jobEvent({ command: 'touch ran' }))
      await finished()
      // The first ask brings one blob whole; the corrupted one is asked for again three times, then the job fails.
      expect(api.blobRequests.map((request) => request.length)).toEqual([2, 1, 1, 1])
      expect(api.finished[0]?.result.error?.code).toBe('transfer_failed')
      expect(api.finished[0]?.result.exitCode).toBeNull()
      expect(api.progressed).toEqual([])
      expect(api.commit).toBeNull()
      expect(api.logBytes.toString()).toContain('[runner]')
    })

    it('fails with transfer_failed when the environment refuses the manifest', async () => {
      const { api, worker, finished } = await setup()
      api.fault = ({ method }) =>
        method === 'manifest' ? new RunnerApiError(409, 'CONFLICT', 'cancelled', false) : undefined
      worker.handleJob(SERVER, jobEvent())
      await finished()
      expect(api.finished[0]?.result.error?.code).toBe('transfer_failed')
    })

    it('waits for an environment that is unavailable, then goes on', async () => {
      const { api, worker, finished } = await setup()
      let failures = 3
      api.fault = ({ method }) => (method === 'manifest' && failures-- > 0 ? transient() : undefined)
      worker.handleJob(SERVER, jobEvent())
      await finished()
      expect(api.finished[0]?.result).toEqual({ exitCode: 0, error: null })
    })

    it('evicts old blobs to the cap between jobs, never the ones a job needs', async () => {
      const { api, worker, finished, storage, scope } = await setup({ settings: { blobCapBytes: 1 } })
      const stale = path.join(storage.blobsDir(scope), 'ab')
      mkdirSync(stale, { recursive: true })
      writeFileSync(path.join(stale, 'a'.repeat(64)), 'stale blob')
      worker.handleJob(SERVER, jobEvent())
      await finished()
      expect(existsSync(path.join(stale, 'a'.repeat(64)))).toBe(false)
      expect(api.finished[0]?.result.exitCode).toBe(0)
      expect((await storage.usage()).blobBytes).toBeGreaterThan(0)
    })
  })

  it('links named caches and keeps them for the next job, without sending their content back', async () => {
    const { api, worker, finished, storage, scope, archive } = await setup()
    const caches = [{ name: 'deps', path: 'node_modules' }]
    worker.handleJob(
      SERVER,
      jobEvent({
        caches,
        command: 'mkdir -p out; echo module > node_modules/m.txt; echo done > out/a.txt',
        outputs: ['**'],
      })
    )
    await finished()
    expect(readFileSync(path.join(storage.cacheDir(scope, 'deps'), 'm.txt'), 'utf8')).toBe('module\n')
    expect((await archive()).map((entry) => entry.name).filter((name) => !name.startsWith('.maestrly'))).toEqual([
      'out/a.txt',
    ])
    api.outputBytes = Buffer.alloc(0)
    worker.handleJob(
      SERVER,
      jobEvent({ jobId: SECOND_JOB, caches, command: 'mkdir -p out; cat node_modules/m.txt > out/b.txt' })
    )
    await finished(2)
    expect((await archive()).find((entry) => entry.name === 'out/b.txt')?.content.toString()).toBe('module\n')
  })

  it('hides the values of the job environment in the log and in the result', async () => {
    const { api, worker, finished, archive } = await setup()
    worker.handleJob(SERVER, jobEvent({ command: 'echo "token=$TOKEN"; exit 4', env: { TOKEN: 'sup3r-secret-value' } }))
    await finished()
    expect(api.logBytes.toString()).toBe('token=***\n')
    expect(JSON.stringify(api.finished)).not.toContain('sup3r-secret-value')
    expect((await archive()).find((entry) => entry.name.endsWith('.log'))?.content.toString()).toBe('token=***\n')
  })

  it('fails with outputs_too_large when the outputs pass the limit, and still sends the log', async () => {
    const { api, worker, finished } = await setup()
    worker.handleJob(
      SERVER,
      jobEvent({
        command:
          'echo working; mkdir -p out; dd if=/dev/null of=out/huge.bin bs=1 seek=53687091201 count=0 2>/dev/null',
      })
    )
    await finished()
    const result = api.finished[0]?.result
    if (result?.error?.code !== 'outputs_too_large') {
      // A file system without sparse files cannot make the file: nothing more to check.
      return
    }
    expect(result.exitCode).toBe(0)
    expect(api.commit).toBeNull()
    expect(api.logBytes.toString()).toContain('working')
  })

  it('holds the computer awake for as long as a job runs', async () => {
    let held = 0
    let released = 0
    const { worker, api, finished } = await setup({
      holdAwake: () => {
        held++
        return () => void released++
      },
    })
    worker.handleJob(SERVER, jobEvent({ command: 'sleep 30' }))
    await vi.waitFor(() => expect(held).toBe(1))
    expect(released).toBe(0)
    worker.cancel(SERVER, JOB_ID)
    await finished()
    await vi.waitFor(() => expect(released).toBe(1))
    expect(api.finished).toHaveLength(1)
  })

  describe('gateways', () => {
    it('reports again when the settings change, and not to a server that is disconnected', async () => {
      const { api, worker, settings } = await setup()
      settings.accepting = false
      await worker.refresh()
      expect(api.reports.at(-1)?.accepting).toBe(false)
      settings.accepting = true
      settings.slots = 3
      await worker.refresh()
      expect(api.reports.at(-1)).toMatchObject({ accepting: true, capabilities: { slots: 3 } })
      worker.disconnected(SERVER)
      const count = api.reports.length
      await worker.refresh()
      expect(api.reports).toHaveLength(count)
    })

    it('reports that it does not take jobs when it cannot tell what it is', async () => {
      const api = new FakeRunnerApi()
      const worker = new RunnerWorker({
        storage: new RunnerStorage(tempDir()),
        executors: () => new NativeExecutor(),
        settings: () => ({ accepting: true, slots: 1, blobCapBytes: 1, executor: 'native' }),
        capabilities: async () => {
          throw new Error('no probe')
        },
        api: () => api,
      })
      workers.push(worker)
      await worker.connected(SERVER)
      expect(api.reports).toEqual([{ accepting: false, capabilities: null, jobs: [] }])
    })

    it('tries a report again, with pauses, when the gateway did not get it', async () => {
      const api = new FakeRunnerApi()
      let failures = 2
      api.fault = ({ method }) => (method === 'report' && failures-- > 0 ? transient() : undefined)
      const worker = new RunnerWorker({
        storage: new RunnerStorage(tempDir()),
        executors: () => new NativeExecutor(),
        settings: () => ({ accepting: true, slots: 1, blobCapBytes: 1, executor: 'native' }),
        capabilities: async () => capabilities,
        api: () => api,
        tuning: { sleep: async () => undefined },
      })
      workers.push(worker)
      await worker.connected(SERVER)
      await vi.waitFor(() => expect(api.reports).toHaveLength(1))
      expect(api.calls.filter((call) => call.method === 'report')).toHaveLength(3)
    })
  })

  describe('restarts', () => {
    it('finishes the jobs a previous run left with runner_restarted and deletes their folders', async () => {
      const root = tempDir()
      const storage = new RunnerStorage(root)
      const api = new FakeRunnerApi()
      const key = storage.jobKey(SERVER, JOB_ID)
      mkdirSync(storage.workDir(key), { recursive: true })
      writeFileSync(path.join(storage.workDir(key), 'left.txt'), 'x')
      mkdirSync(path.join(storage.jobsRoot(), 'orphan-without-state'), { recursive: true })
      mkdirSync(path.join(storage.blobsDir('scopeaaaa'), '.tmp'), { recursive: true })
      await storage.writeState({ jobs: [{ serverId: SERVER, botId: BOT, jobId: JOB_ID, key, startedAt: 1 }] })

      const worker = new RunnerWorker({
        storage,
        executors: () => new NativeExecutor(),
        settings: () => ({ accepting: true, slots: 1, blobCapBytes: 1, executor: 'native' }),
        capabilities: async () => capabilities,
        api: (serverId) => (serverId === SERVER ? api : null),
      })
      workers.push(worker)
      await worker.start()

      expect(api.finished).toHaveLength(1)
      expect(api.finished[0]).toMatchObject({
        jobId: JOB_ID,
        result: { exitCode: null, error: { code: 'runner_restarted' } },
      })
      expect(jobFolders(storage)).toEqual([])
      expect(existsSync(path.join(storage.blobsDir('scopeaaaa'), '.tmp'))).toBe(false)
      expect(await storage.readState()).toEqual({ jobs: [] })
      // A second start finds nothing more to report.
      await worker.start()
      expect(api.finished).toHaveLength(1)
    })

    it('starts even when the gateway cannot be told, and for a server that is no longer paired', async () => {
      const root = tempDir()
      const storage = new RunnerStorage(root)
      const api = new FakeRunnerApi()
      api.fault = () => new RunnerApiError(404, 'NOT_FOUND', 'gone', false)
      await storage.writeState({
        jobs: [
          { serverId: SERVER, botId: BOT, jobId: JOB_ID, key: storage.jobKey(SERVER, JOB_ID), startedAt: 1 },
          {
            serverId: 'unpaired',
            botId: BOT,
            jobId: SECOND_JOB,
            key: storage.jobKey('unpaired', SECOND_JOB),
            startedAt: 1,
          },
        ],
      })
      const worker = new RunnerWorker({
        storage,
        executors: () => new NativeExecutor(),
        settings: () => ({ accepting: true, slots: 1, blobCapBytes: 1, executor: 'native' }),
        capabilities: async () => capabilities,
        api: (serverId) => (serverId === SERVER ? api : null),
      })
      workers.push(worker)
      await expect(worker.start()).resolves.toBeUndefined()
      expect(await storage.readState()).toEqual({ jobs: [] })
    })

    it('keeps a running job on disk when it stops, so the next start reports it', async () => {
      const { api, worker, storage, root } = await setup()
      worker.handleJob(SERVER, jobEvent({ command: 'echo started; sleep 30' }))
      await vi.waitFor(() => expect(api.logBytes.toString()).toContain('started'))
      expect(JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8')).jobs).toMatchObject([
        { jobId: JOB_ID, botId: BOT },
      ])
      await worker.stop()
      expect(api.finished).toEqual([])
      expect(JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8')).jobs).toHaveLength(1)

      const restarted = new RunnerWorker({
        storage,
        executors: () => new NativeExecutor(),
        settings: () => ({ accepting: true, slots: 1, blobCapBytes: 1, executor: 'native' }),
        capabilities: async () => capabilities,
        api: () => api,
      })
      workers.push(restarted)
      await restarted.start()
      expect(api.finished).toMatchObject([{ jobId: JOB_ID, result: { error: { code: 'runner_restarted' } } }])
    })
  })

  describe('bots and caches', () => {
    it('cancels a bot’s jobs and forgets its blobs and caches when its link is removed', async () => {
      const { api, worker, storage, scope } = await setup()
      worker.handleJob(
        SERVER,
        jobEvent({ caches: [{ name: 'deps', path: 'node_modules' }], command: 'echo started; sleep 30' })
      )
      await vi.waitFor(() => expect(api.logBytes.toString()).toContain('started'))
      await worker.removeBot(SERVER, BOT)
      expect(worker.jobs()).toEqual([])
      expect(api.finished).toEqual([])
      expect((await storage.usage()).scopes.find((item) => item.scope === scope)).toBeUndefined()
      expect(existsSync(storage.blobsDir(scope))).toBe(false)
    })

    it('clears named caches but leaves the blobs, and spares a bot whose job is running', async () => {
      const { api, worker, storage, scope, finished } = await setup()
      const caches = [{ name: 'deps', path: 'node_modules' }]
      worker.handleJob(SERVER, jobEvent({ caches, command: 'echo kept > node_modules/k.txt' }))
      await finished()
      expect((await storage.usage()).cacheBytes).toBeGreaterThan(0)
      worker.handleJob(SERVER, jobEvent({ jobId: SECOND_JOB, caches, command: 'echo started; sleep 30' }))
      await vi.waitFor(() => expect(api.logBytes.toString()).toContain('started'))
      await worker.clearCaches()
      expect((await storage.usage()).cacheBytes).toBeGreaterThan(0)
      worker.cancel(SERVER, SECOND_JOB)
      await vi.waitFor(() => expect(worker.jobs()).toEqual([]))
      await worker.clearCaches(scope)
      const usage = await storage.usage()
      expect(usage.cacheBytes).toBe(0)
      expect(usage.blobBytes).toBeGreaterThan(0)
    })
  })
})
