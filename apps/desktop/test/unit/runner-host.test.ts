import path from 'node:path'
import {
  FLEET_RUNNER_JOBS_CAPABILITY,
  FLEET_RUNNERS_FEATURE,
  type FleetGatewayEvent,
  type FleetRunnerCapabilities,
  type FleetRunnerJob,
  type FleetRunnerJobEvent,
  type FleetRunnerLinkView,
  fleetRunnerAssignedSpecSchema,
} from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FleetClientError } from '../../src/main/fleet/client/api'
import { RunnerHost, type RunnerHostClient, type RunnerHostOptions } from '../../src/main/fleet/client/runner-host'
import { RUNNER_SETTING_KEYS, type RunnerSettingsStore } from '../../src/main/fleet/client/runner-settings'
import type { FleetRunnerPort } from '../../src/main/fleet/client/service'
import type { RunnerExecutor, RunnerExecutorJob } from '../../src/main/runner/executor'
import { RunnerStorage } from '../../src/main/runner/storage'
import type { RunnerJobUsage, RunnerWorkerDeps } from '../../src/main/runner/worker'
import type { FleetServerId } from '../../src/shared/fleet-servers'
import { GIB } from '../../src/shared/runner'
import { cleanTempDirs, JOB_ID, tempDir } from '../helpers/runner-core'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const OTHER_SERVER = 'bbbbbbbb-0000-4000-8000-000000000002' as FleetServerId
const BOT = 'scout'
const RUNNER_ID = 'rnr_AAAAAAAAAAAAAAAA0001'
const OTHER_RUNNER_ID = 'rnr_BBBBBBBBBBBBBBBB0002'
const NOW = '2026-10-29T10:00:00.000Z'

afterEach(() => {
  cleanTempDirs()
  vi.unstubAllGlobals()
})

function memoryStore(initial: Record<string, string> = {}): RunnerSettingsStore {
  const values = new Map(Object.entries(initial))
  return {
    getFlag: (key, fallback) => (values.has(key) ? values.get(key) === '1' : fallback),
    getSetting: (key) => values.get(key) ?? null,
    setFlag: (key, value) => void values.set(key, value ? '1' : '0'),
    setSetting: (key, value) => void values.set(key, value),
  }
}

const capabilities = (patch: Partial<FleetRunnerCapabilities> = {}): FleetRunnerCapabilities => ({
  protocol: 1,
  os: 'linux',
  arch: 'x64',
  cpus: 8,
  memoryBytes: 16 * GIB,
  executor: 'native',
  gpu: { vendor: 'nvidia', name: 'RTX 4090', memoryBytes: 24 * GIB },
  slots: 1,
  ...patch,
})

const link = (patch: Partial<FleetRunnerLinkView> = {}): FleetRunnerLinkView => ({
  runnerId: RUNNER_ID,
  name: 'Studio',
  online: true,
  capabilities: capabilities(),
  busySlots: 0,
  lastSeenAt: NOW,
  linkedAt: NOW,
  self: true,
  ...patch,
})

type Answers = Partial<Record<string, (params: Record<string, string>) => unknown>>
/** A paired server's client: what it answers to each route, and every call made to it. */
function fakeClient(
  options: {
    serverId?: FleetServerId
    features?: string[]
    state?: 'connected' | 'reconnecting'
    answers?: Answers
    bots?: Array<{ id: string; name: string; environmentId?: string; capabilities?: string[] }>
  } = {}
) {
  const calls: Array<{ key: string; params: Record<string, string>; body?: unknown }> = []
  const access = { origin: 'http://gateway.test', headers: { Authorization: 'Bearer one' } as Record<string, string> }
  const client = {
    serverId: options.serverId ?? SERVER,
    features: options.features ?? [FLEET_RUNNERS_FEATURE],
    state: options.state ?? 'connected',
    answers: options.answers ?? {},
    calls,
    access,
    runnerHost: null as FleetRunnerPort | null,
    hasFeature(feature: string) {
      return client.features.includes(feature)
    },
    getConnection: () => ({
      features: client.features,
      state: client.state,
      deviceId: 'device-1',
      url: 'http://gateway.test:7443',
      hostname: 'vps',
      error: null,
      tokenPersistence: 'secure' as const,
    }),
    getSnapshot: () => ({
      host: null,
      bots: (options.bots ?? [{ id: BOT, name: 'Scout' }]).map((bot) => ({
        ...bot,
        capabilities: bot.capabilities ?? [],
      })),
      environments: [],
      inbox: [],
      peerMessages: [],
    }),
    hostFilesAccess: () => access,
    deviceName: () => 'Studio Mac mini',
    syncRunnerStream: vi.fn(() => false),
    call: vi.fn(async (key: string, callOptions?: { params?: Record<string, string>; body?: unknown }) => {
      calls.push({ key, params: callOptions?.params ?? {}, body: callOptions?.body })
      const answer = client.answers[key]
      if (!answer) return undefined
      return answer(callOptions?.params ?? {})
    }),
  }
  return client
}

function fakeWorker() {
  return {
    start: vi.fn(async (): Promise<void> => undefined),
    connected: vi.fn(async (_serverId: string) => undefined),
    refresh: vi.fn(async () => undefined),
    disconnected: vi.fn((_serverId: string) => undefined),
    handleJob: vi.fn(),
    handleCancel: vi.fn(),
    jobs: vi.fn(
      (): Array<{
        serverId: string
        botId: string
        jobId: string
        command: string
        state: 'preparing' | 'running' | 'uploading' | 'finishing'
        startedAt: number
        usage: RunnerJobUsage | null
      }> => []
    ),
    cancel: vi.fn(),
    clearCaches: vi.fn(async (_scope?: string) => undefined),
    removeBot: vi.fn(async (_serverId: string, _botId: string) => undefined),
    stop: vi.fn(async () => undefined),
  }
}

function setup(
  options: {
    config?: Record<string, string>
    available?: boolean
    platform?: NodeJS.Platform
    container?: () => RunnerExecutor
    overrides?: Partial<RunnerHostOptions>
  } = {}
) {
  const enabled: Record<string, string> = { [RUNNER_SETTING_KEYS.enabled]: '1' }
  const store = memoryStore({ ...enabled, ...options.config })
  const userData = tempDir('runner-host-')
  const worker = fakeWorker()
  const created: { deps: RunnerWorkerDeps | null; roots: string[] } = { deps: null, roots: [] }
  const changed = vi.fn()
  const accessChanged = vi.fn()
  const probe = vi.fn(async (probeOptions: { executor: 'native' | 'container'; slots: number }) =>
    capabilities({ executor: probeOptions.executor, slots: probeOptions.slots })
  )
  const holdAwake = vi.fn((_key: string) => vi.fn())
  const host = new RunnerHost({
    available: options.available ?? true,
    settings: store,
    userDataDir: () => userData,
    notifyChanged: changed,
    notifyAccess: accessChanged,
    holdAwake,
    docker: vi.fn(async () => ({ state: 'ready' as const, engine: 'Docker Desktop', version: '27.0.0' })),
    platform: options.platform ?? 'linux',
    probe,
    container: options.container,
    createStorage: (root) => {
      created.roots.push(root)
      return new RunnerStorage(root)
    },
    createWorker: (deps) => {
      created.deps = deps
      return worker
    },
    ...options.overrides,
  })
  /** What the worker was built with: after the host started or was asked for its status. */
  const deps = (): RunnerWorkerDeps => created.deps as RunnerWorkerDeps
  return { host, store, worker, created, deps, changed, accessChanged, probe, holdAwake, userData }
}

/** Attaches a client the way the app does and starts the worker. */
async function attached(
  options: Parameters<typeof setup>[0] = {},
  clientOptions: Parameters<typeof fakeClient>[0] = {}
) {
  const parts = setup(options)
  const client = fakeClient(clientOptions)
  const port = parts.host.forClient(client as unknown as RunnerHostClient)
  client.runnerHost = port
  await parts.host.start()
  return { ...parts, client, port }
}

const jobEvent = (patch: Partial<FleetRunnerJobEvent> = {}): FleetRunnerJobEvent => ({
  type: 'runner.job',
  at: NOW,
  jobId: JOB_ID,
  botId: BOT,
  runnerId: RUNNER_ID,
  spec: fleetRunnerAssignedSpecSchema.parse({ folder: '/home/bot/project', command: 'make', outputs: ['out/**'] }),
  acceptBy: '2026-10-29T10:00:30.000Z',
  ...patch,
})
const linksEvent = (links: FleetRunnerLinkView[], botId = BOT): FleetGatewayEvent => ({
  type: 'runner_link.updated',
  at: NOW,
  botId,
  links,
})
/** Waits for what the host does in the background: it reads files and asks the server. */
const until = (check: () => void) => vi.waitFor(check, { timeout: 5_000 })
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('runner host: when a server carries jobs', () => {
  it('wants jobs only while the runner is on and the server announces runners', async () => {
    const { host, store } = setup({ config: { [RUNNER_SETTING_KEYS.enabled]: '0' } })
    const client = fakeClient()
    const port = host.forClient(client as unknown as RunnerHostClient)
    expect(port.wants()).toBe(false)
    await host.updateConfig({ enabled: true })
    expect(port.wants()).toBe(true)
    client.features = []
    expect(port.wants()).toBe(false)
    client.features = [FLEET_RUNNERS_FEATURE]
    store.setFlag(RUNNER_SETTING_KEYS.enabled, false)
    expect(port.wants()).toBe(false)
  })

  it('reopens the stream of every server when the settings change, and tells the connected ones', async () => {
    const { host, worker, client } = await attached()
    const other = fakeClient({ serverId: OTHER_SERVER })
    host.forClient(other as unknown as RunnerHostClient)
    await host.updateConfig({ slots: 2 })
    expect(client.syncRunnerStream).toHaveBeenCalledTimes(1)
    expect(other.syncRunnerStream).toHaveBeenCalledTimes(1)
    expect(worker.refresh).toHaveBeenCalled()
  })

  it('reports to a server once it is connected, after the worker loaded what the last run left', async () => {
    const { port, worker, client } = await attached()
    const order: string[] = []
    worker.start.mockImplementationOnce(async () => void order.push('start'))
    worker.connected.mockImplementation(async () => void order.push('connected'))
    await port.connected()
    expect(worker.connected).toHaveBeenCalledWith(client.serverId)
    // Started once at app start-up (before this test hooked it), and never again.
    expect(order).toEqual(['connected'])
  })

  it('waits for the worker to start before it reports to a server', async () => {
    const { host, worker } = setup()
    const client = fakeClient()
    const port = host.forClient(client as unknown as RunnerHostClient)
    const order: string[] = []
    let release!: () => void
    worker.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push('started')
            resolve()
          }
        })
    )
    worker.connected.mockImplementation(async () => void order.push('connected'))
    const connecting = port.connected()
    await flush()
    expect(order).toEqual([])
    release()
    await connecting
    expect(order).toEqual(['started', 'connected'])
  })

  it('does not report while the runner is off or the server has no runners', async () => {
    const off = await attached({ config: { [RUNNER_SETTING_KEYS.enabled]: '0' } })
    await off.port.connected()
    expect(off.worker.connected).not.toHaveBeenCalled()
    expect(off.worker.start).not.toHaveBeenCalled()
    const old = await attached({}, { features: [] })
    await old.port.connected()
    expect(old.worker.connected).not.toHaveBeenCalled()
  })

  it('tells the worker when a stream closes', async () => {
    const { port, worker, client } = await attached()
    port.disconnected()
    expect(worker.disconnected).toHaveBeenCalledWith(client.serverId)
  })

  it('is not built at all in a bot container', async () => {
    const { host, worker, created, store } = setup({ available: false })
    expect(host.available).toBe(false)
    expect(host.enabled()).toBe(false)
    expect(host.config().enabled).toBe(false)
    await host.start()
    await host.stop()
    expect(await host.status()).toMatchObject({ available: false, jobs: [] })
    await expect(host.updateConfig({ enabled: true })).rejects.toThrow()
    expect(created.deps).toBeNull()
    expect(worker.start).not.toHaveBeenCalled()
    expect(store.getFlag(RUNNER_SETTING_KEYS.enabled, false)).toBe(true)
  })
})

describe('runner host: events', () => {
  it('hands a job to the worker once it started, and no window ever sees it', async () => {
    const { port, worker, client } = await attached()
    const event = jobEvent()
    expect(port.handle(event)).toBe(true)
    expect(worker.handleJob).toHaveBeenCalledExactlyOnceWith(client.serverId, event)
  })

  it('ignores a job that arrives before the worker started, or while the runner is off', async () => {
    const { host, worker, store } = setup()
    const client = fakeClient()
    const port = host.forClient(client as unknown as RunnerHostClient)
    expect(port.handle(jobEvent())).toBe(true)
    expect(worker.handleJob).not.toHaveBeenCalled()
    await host.start()
    store.setFlag(RUNNER_SETTING_KEYS.enabled, false)
    expect(port.handle(jobEvent())).toBe(true)
    expect(worker.handleJob).not.toHaveBeenCalled()
  })

  it('hands a cancel to the worker', async () => {
    const { port, worker, client } = await attached()
    expect(port.handle({ type: 'runner.cancel', at: NOW, jobId: JOB_ID })).toBe(true)
    expect(worker.handleCancel).toHaveBeenCalledExactlyOnceWith(client.serverId, JOB_ID)
  })

  it('tells the bot settings which bot changed when its links or jobs do', async () => {
    const { port, accessChanged, client } = await attached()
    port.handle(linksEvent([link()]))
    const job: FleetRunnerJob = {
      jobId: JOB_ID,
      botId: 'other-bot',
      runnerId: RUNNER_ID,
      runnerName: 'Studio',
      state: 'running',
      requires: {},
      cancelRequested: false,
      createdAt: NOW,
      queueDeadline: NOW,
      assignedAt: NOW,
      startedAt: NOW,
      endedAt: null,
      exitCode: null,
      error: null,
    }
    expect(port.handle({ type: 'runner_job.updated', at: NOW, job })).toBe(true)
    expect(accessChanged.mock.calls).toEqual([
      [client.serverId, BOT],
      [client.serverId, 'other-bot'],
    ])
  })

  it('leaves other events to the window', async () => {
    const { port } = await attached()
    expect(port.handle({ type: 'hello', at: NOW, lastActivitySeq: 0 })).toBe(false)
  })
})

describe('runner host: a bot whose link to this computer is gone', () => {
  async function withFiles(answers: Answers) {
    const parts = await attached({}, { answers })
    // What the runner kept for the bot while it was linked.
    const storage = new RunnerStorage(parts.created.roots[0])
    await storage.remember(parts.client.serverId, BOT)
    return { ...parts, storage }
  }

  it('deletes what it keeps for the bot once the server confirms that this computer is not linked', async () => {
    const { port, worker, client } = await withFiles({ botRunnerLinks: () => ({ links: [link({ self: false })] }) })
    port.handle(linksEvent([link({ self: false })]))
    await until(() => expect(worker.removeBot).toHaveBeenCalledExactlyOnceWith(client.serverId, BOT))
    expect(client.calls.filter((call) => call.key === 'botRunnerLinks')).toEqual([
      { key: 'botRunnerLinks', params: { id: BOT }, body: undefined },
    ])
  })

  it('keeps it when the server says this computer is still linked: the event may predate its own link', async () => {
    const { port, worker, client } = await withFiles({ botRunnerLinks: () => ({ links: [link()] }) })
    port.handle(linksEvent([]))
    await until(() => expect(client.calls.some((call) => call.key === 'botRunnerLinks')).toBe(true))
    await flush()
    expect(worker.removeBot).not.toHaveBeenCalled()
  })

  it('keeps it when the server cannot be asked', async () => {
    const { port, worker, client } = await withFiles({
      botRunnerLinks: () => {
        throw new FleetClientError('INSTANCE_UNAVAILABLE', 0, 'down')
      },
    })
    port.handle(linksEvent([]))
    await until(() => expect(client.calls.some((call) => call.key === 'botRunnerLinks')).toBe(true))
    await flush()
    expect(worker.removeBot).not.toHaveBeenCalled()
  })

  it('deletes it when the bot no longer exists', async () => {
    const { port, worker } = await withFiles({
      botRunnerLinks: () => {
        throw new FleetClientError('NOT_FOUND', 404, 'gone')
      },
    })
    port.handle(linksEvent([]))
    await until(() => expect(worker.removeBot).toHaveBeenCalledTimes(1))
  })

  it('does not ask the server about a bot it keeps nothing for, nor when the link is there', async () => {
    const { port, worker, client } = await attached({}, { answers: { botRunnerLinks: () => ({ links: [] }) } })
    port.handle(linksEvent([], 'never-linked'))
    port.handle(linksEvent([link()]))
    await flush()
    await flush()
    expect(client.calls).toEqual([])
    expect(worker.removeBot).not.toHaveBeenCalled()
  })

  it('checks the bots it keeps files for when it connects, and drops those that lost their link', async () => {
    const { port, worker, client, storage } = await withFiles({
      botRunnerLinks: (params) => ({ links: params.id === 'kept' ? [link()] : [] }),
    })
    await storage.remember(client.serverId, 'kept')
    await storage.remember(OTHER_SERVER, 'elsewhere')
    await port.connected()
    expect(worker.removeBot.mock.calls).toEqual([[client.serverId, BOT]])
  })

  it('deletes what it keeps for a server it is no longer paired with, and its bots’ jobs stop', async () => {
    const { port, worker, client, storage } = await withFiles({})
    await storage.remember(client.serverId, 'second')
    await storage.remember(OTHER_SERVER, 'elsewhere')
    worker.jobs.mockReturnValue([
      {
        serverId: client.serverId,
        botId: 'running-only',
        jobId: JOB_ID,
        command: 'make',
        state: 'running',
        startedAt: 1,
        usage: null,
      },
    ])
    await port.unpaired()
    expect(worker.removeBot.mock.calls.map((args) => args.join('/')).sort()).toEqual(
      [`${client.serverId}/${BOT}`, `${client.serverId}/running-only`, `${client.serverId}/second`].sort()
    )
  })
})

describe('runner host: cancelling from the settings', () => {
  const held = (serverId: string = SERVER) => ({
    serverId,
    botId: BOT,
    jobId: JOB_ID,
    command: 'make',
    state: 'running' as const,
    startedAt: 1,
    usage: null,
  })

  it('tells the server first, so that it records the cancel, then stops the job here', async () => {
    const { host, worker, client } = await attached()
    worker.jobs.mockReturnValue([held()])
    const order: string[] = []
    client.answers.botRunnerJobCancel = () => void order.push('gateway')
    worker.cancel.mockImplementation(() => void order.push('worker'))
    await host.cancelJob(client.serverId, JOB_ID)
    expect(order).toEqual(['gateway', 'worker'])
    expect(client.calls.at(-1)).toEqual({
      key: 'botRunnerJobCancel',
      params: { id: BOT, jobId: JOB_ID },
      body: undefined,
    })
    expect(worker.cancel).toHaveBeenCalledExactlyOnceWith(client.serverId, JOB_ID)
  })

  it('stops the job here even when the server refuses or does not answer', async () => {
    const { host, worker, client } = await attached()
    worker.jobs.mockReturnValue([held()])
    client.answers.botRunnerJobCancel = () => {
      throw new FleetClientError('CONFLICT', 409, 'ended')
    }
    await host.cancelJob(client.serverId, JOB_ID)
    expect(worker.cancel).toHaveBeenCalledTimes(1)
    vi.useFakeTimers()
    try {
      worker.cancel.mockClear()
      client.call.mockImplementationOnce(() => new Promise(() => undefined))
      const waiting = host.cancelJob(client.serverId, JOB_ID)
      await vi.advanceTimersByTimeAsync(5_000)
      await waiting
      expect(worker.cancel).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does nothing for a job this computer does not hold', async () => {
    const { host, worker, client } = await attached()
    await host.cancelJob(client.serverId, JOB_ID)
    await host.cancelJob(OTHER_SERVER, JOB_ID)
    expect(client.calls).toEqual([])
    expect(worker.cancel).not.toHaveBeenCalled()
  })

  it('stops every job when the runner is turned off', async () => {
    const { host, worker, client } = await attached()
    worker.jobs.mockReturnValue([held()])
    await host.updateConfig({ enabled: false })
    expect(worker.cancel).toHaveBeenCalledExactlyOnceWith(client.serverId, JOB_ID)
    expect(client.syncRunnerStream).toHaveBeenCalled()
  })
})

describe('runner host: what the worker runs with', () => {
  it('builds the worker once, in the folder chosen or in the app’s data', async () => {
    const parts = await attached()
    await parts.host.status()
    expect(parts.created.roots).toEqual([path.join(parts.userData, 'runner')])
    const chosen = await attached({ config: { [RUNNER_SETTING_KEYS.storageDir]: path.join(tempDir(), 'files') } })
    expect(chosen.created.roots[0]).toMatch(/files$/)
  })

  it('takes jobs only while the runner is on, and keeps the slots and the blob cap of the settings', async () => {
    const { deps, host } = await attached({
      config: { [RUNNER_SETTING_KEYS.slots]: '3', [RUNNER_SETTING_KEYS.blobCapBytes]: String(80 * GIB) },
    })
    expect(deps().settings()).toEqual({ accepting: true, slots: 3, blobCapBytes: 80 * GIB, executor: 'native' })
    await host.updateConfig({ enabled: false, slots: 5 })
    expect(deps().settings()).toEqual({ accepting: false, slots: 5, blobCapBytes: 80 * GIB, executor: 'native' })
  })

  it('keeps the computer awake for each job under a key of its own', async () => {
    const { deps, holdAwake } = await attached()
    const release = [deps().holdAwake?.(), deps().holdAwake?.()]
    expect(holdAwake.mock.calls.map(([key]) => key)).toEqual(['runner-job-1', 'runner-job-2'])
    expect(release.every((fn) => typeof fn === 'function')).toBe(true)
  })

  it('tells the worker when the jobs or the storage change, and the settings screen follows', async () => {
    const { deps, changed } = await attached()
    changed.mockClear()
    deps().onChange?.()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('uses the native executor, and the container factory the app gives for Container', async () => {
    const container: RunnerExecutor = {
      kind: 'container',
      run: vi.fn(async () => ({ exitCode: 0, timedOut: false, cancelled: false })),
    }
    const factory = vi.fn(() => container)
    const { deps, host } = await attached({ container: factory })
    expect(deps().executors().kind).toBe('native')
    expect(factory).not.toHaveBeenCalled()
    await host.updateConfig({ executor: 'container' })
    expect(deps().executors()).toBe(container)
    expect(deps().executors()).toBe(container)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('fails Docker jobs with executor_unavailable while the app has no container executor', async () => {
    const { deps } = await attached({ platform: 'win32' })
    const executor = deps().executors()
    expect(executor.kind).toBe('container')
    const job = { jobId: JOB_ID } as RunnerExecutorJob
    await expect(executor.run(job)).resolves.toEqual({
      exitCode: null,
      timedOut: false,
      cancelled: false,
      error: { code: 'executor_unavailable', message: 'Docker jobs are not available in this version.' },
    })
  })

  it('tells a GPU for Container only when Docker hands containers the NVIDIA GPU found', async () => {
    const support = vi.fn(async () => ({ gpu: false }))
    const { deps, host } = await attached({
      config: { [RUNNER_SETTING_KEYS.gpu]: '1', [RUNNER_SETTING_KEYS.executor]: 'container' },
      overrides: { containerSupport: support },
    })
    expect((await deps().capabilities()).gpu).toBeNull()
    expect(host.containerLimits()).toEqual({ cpus: null, memoryBytes: null, gpu: false })
    support.mockResolvedValue({ gpu: true })
    await host.updateConfig({ jobCpus: 2, jobMemoryBytes: 4 * 1024 ** 3 })
    expect((await deps().capabilities()).gpu).toMatchObject({ vendor: 'nvidia' })
    expect(host.containerLimits()).toEqual({ cpus: 2, memoryBytes: 4 * 1024 ** 3, gpu: true })
    // The owner's choice still decides.
    await host.updateConfig({ gpu: false })
    expect(host.containerLimits().gpu).toBe(false)
    expect((await deps().capabilities()).gpu).toBeNull()
  })

  it('never offers containers an Apple GPU, which Docker cannot hand over', async () => {
    const { deps } = await attached({
      platform: 'darwin',
      config: { [RUNNER_SETTING_KEYS.gpu]: '1', [RUNNER_SETTING_KEYS.executor]: 'container' },
      overrides: {
        containerSupport: async () => ({ gpu: true }),
        probe: async (probeOptions) =>
          capabilities({
            executor: probeOptions.executor,
            gpu: { vendor: 'apple', name: 'Apple M3 Pro', memoryBytes: null },
          }),
      },
    })
    expect((await deps().capabilities()).gpu).toBeNull()
  })

  it('removes the containers a previous run left once the worker started, keeping those of held jobs', async () => {
    const cleanup = { removeOrphans: vi.fn(async (_keep: Set<string>) => undefined), removeScopeVolumes: vi.fn() }
    const { worker } = await attached({ overrides: { containerCleanup: cleanup } })
    expect(worker.start).toHaveBeenCalledTimes(1)
    expect(cleanup.removeOrphans).toHaveBeenCalledExactlyOnceWith(new Set())
  })

  it('removes a bot’s cache volumes with its files when its link goes away', async () => {
    const cleanup = {
      removeOrphans: vi.fn(async () => undefined),
      removeScopeVolumes: vi.fn(async (_scope: string) => undefined),
    }
    const { host, client, worker } = await attached(
      { overrides: { containerCleanup: cleanup } },
      { answers: { botRunnerLinkDelete: () => undefined } }
    )
    await host.unlink(client as unknown as RunnerHostClient, BOT)
    expect(worker.removeBot).toHaveBeenCalledExactlyOnceWith(client.serverId, BOT)
    expect(cleanup.removeScopeVolumes).toHaveBeenCalledExactlyOnceWith(
      new RunnerStorage(tempDir('runner-scope-')).scope(client.serverId, BOT)
    )
  })

  it('probes what the computer is once for each executor, slots and GPU choice, and again after a change', async () => {
    const { deps, host, probe } = await attached()
    const first = await deps().capabilities()
    expect(first).toMatchObject({ executor: 'native', slots: 1, gpu: null })
    await deps().capabilities()
    expect(probe).toHaveBeenCalledTimes(1)
    await host.updateConfig({ gpu: true })
    expect((await deps().capabilities()).gpu).toMatchObject({ name: 'RTX 4090' })
    expect(probe).toHaveBeenCalledTimes(2)
    await host.updateConfig({ slots: 4 })
    expect(await deps().capabilities()).toMatchObject({ slots: 4 })
    await deps().capabilities()
    expect(probe).toHaveBeenCalledTimes(3)
    await host.updateConfig({ executor: 'container' })
    expect(await deps().capabilities()).toMatchObject({ executor: 'container', slots: 4 })
    // Any change of the settings probes again: a GPU installed meanwhile is found.
    expect(probe).toHaveBeenCalledTimes(4)
    await host.updateConfig({ jobCpus: 2 })
    await deps().capabilities()
    expect(probe).toHaveBeenCalledTimes(5)
  })

  it('reaches a server with the headers it holds at each request', async () => {
    const { deps, client } = await attached()
    const requests: Array<{ url: string; authorization: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, authorization: new Headers(init.headers).get('authorization') })
        return new Response(null, { status: 204 })
      })
    )
    const api = deps().api(client.serverId)
    expect(api).not.toBeNull()
    await api?.accept(JOB_ID)
    client.access.headers = { Authorization: 'Bearer two' }
    await api?.accept(JOB_ID)
    expect(requests).toEqual([
      { url: `http://gateway.test/v1/runner-jobs/${JOB_ID}/accept`, authorization: 'Bearer one' },
      { url: `http://gateway.test/v1/runner-jobs/${JOB_ID}/accept`, authorization: 'Bearer two' },
    ])
    expect(deps().api(OTHER_SERVER)).toBeNull()
  })
})

describe('runner host: what the settings show', () => {
  it('lists the servers, the jobs by bot and server name, the storage by bot, and Docker only for Container', async () => {
    const { host, worker, client, created } = await attached({
      config: { [RUNNER_SETTING_KEYS.slots]: '2' },
    })
    const other = fakeClient({ serverId: OTHER_SERVER, features: [], state: 'reconnecting' })
    host.forClient(other as unknown as RunnerHostClient)
    worker.jobs.mockReturnValue([
      {
        serverId: client.serverId,
        botId: BOT,
        jobId: JOB_ID,
        command: 'ffmpeg -i in.mov',
        state: 'running',
        startedAt: 5,
        usage: null,
      },
    ])
    await new RunnerStorage(created.roots[0]).remember(client.serverId, BOT)
    const status = await host.status()
    expect(status).toMatchObject({
      available: true,
      nativeAllowed: true,
      config: { enabled: true, executor: 'native', slots: 2 },
      capabilities: { executor: 'native', slots: 2, gpu: null },
      detectedGpu: { name: 'RTX 4090' },
      docker: null,
      servers: [
        { serverId: client.serverId, name: 'vps', connected: true, supported: true },
        { serverId: OTHER_SERVER, name: 'vps', connected: false, supported: false },
      ],
      jobs: [
        {
          serverId: client.serverId,
          serverName: 'vps',
          botId: BOT,
          botName: 'Scout',
          jobId: JOB_ID,
          command: 'ffmpeg -i in.mov',
          phase: 'running',
          startedAt: 5,
        },
      ],
      storage: {
        dir: created.roots[0],
        bots: [{ serverId: client.serverId, botId: BOT, botName: 'Scout', serverName: 'vps' }],
      },
    })
    await host.updateConfig({ executor: 'container' })
    expect((await host.status()).docker).toEqual({ state: 'ready', engine: 'Docker Desktop', version: '27.0.0' })
  })

  it('offers Container only on Windows', async () => {
    const { host } = await attached({ platform: 'win32' })
    const status = await host.status()
    expect(status.nativeAllowed).toBe(false)
    expect(status.config.executor).toBe('container')
  })

  it('deletes the caches of one bot, or of all, through the worker', async () => {
    const { host, worker, client, created } = await attached()
    await host.status()
    await host.clearCaches({ serverId: client.serverId, botId: BOT })
    await host.clearCaches()
    const storage = new RunnerStorage(created.roots[0])
    expect(worker.clearCaches.mock.calls).toEqual([[storage.scope(client.serverId, BOT)], [undefined]])
  })
})

describe('runner host: a bot’s runners', () => {
  const bots = [{ id: BOT, name: 'Scout', capabilities: [FLEET_RUNNER_JOBS_CAPABILITY] }]

  it('shows this computer’s link, every runner and the bot’s jobs', async () => {
    const { host, client } = await attached(
      {},
      {
        bots,
        answers: {
          botRunnerLinks: () => ({ links: [link(), link({ runnerId: OTHER_RUNNER_ID, name: 'Rack', self: false })] }),
          botRunnerJobs: () => ({ jobs: [] }),
        },
      }
    )
    const view = await host.access(client as unknown as RunnerHostClient, BOT)
    expect(view).toMatchObject({
      supported: true,
      connected: true,
      botSupported: true,
      runnerEnabled: true,
      executor: 'native',
      self: { runnerId: RUNNER_ID, name: 'Studio' },
      jobs: [],
      defaultName: 'Studio Mac mini',
    })
    expect(view.links?.map((item) => item.name)).toEqual(['Studio', 'Rack'])
  })

  it('says what is missing without asking a server that cannot answer', async () => {
    const old = await attached({}, { features: [] })
    expect(await old.host.access(old.client as unknown as RunnerHostClient, BOT)).toMatchObject({
      supported: false,
      botSupported: false,
      links: null,
      jobs: null,
      self: null,
    })
    expect(old.client.calls).toEqual([])
    const off = await attached({ config: { [RUNNER_SETTING_KEYS.enabled]: '0' } }, { bots })
    expect(await off.host.access(off.client as unknown as RunnerHostClient, BOT)).toMatchObject({
      runnerEnabled: false,
      botSupported: true,
    })
    const down = await attached({}, { state: 'reconnecting' })
    expect(await down.host.access(down.client as unknown as RunnerHostClient, BOT)).toMatchObject({
      connected: false,
      links: null,
    })
  })

  it('links this computer under a name, only while the runner is on and the server has runners', async () => {
    const { host, client, accessChanged } = await attached({}, { bots, answers: { botRunnerLinkPut: () => link() } })
    await host.link(client as unknown as RunnerHostClient, BOT, '  Render box ')
    expect(client.calls.find((call) => call.key === 'botRunnerLinkPut')).toEqual({
      key: 'botRunnerLinkPut',
      params: { id: BOT },
      body: { name: 'Render box' },
    })
    expect(accessChanged).toHaveBeenCalledWith(client.serverId, BOT)
    await expect(host.link(client as unknown as RunnerHostClient, BOT, '   ')).rejects.toThrow()
    await expect(host.link(client as unknown as RunnerHostClient, BOT, 'x'.repeat(61))).rejects.toThrow()

    const off = await attached({ config: { [RUNNER_SETTING_KEYS.enabled]: '0' } })
    await expect(off.host.link(off.client as unknown as RunnerHostClient, BOT, 'Studio')).rejects.toThrow(/Settings/)
    const old = await attached({}, { features: [] })
    await expect(old.host.link(old.client as unknown as RunnerHostClient, BOT, 'Studio')).rejects.toThrow(/Update/)
    expect(off.client.calls).toEqual([])
    expect(old.client.calls).toEqual([])
  })

  it('unlinks, then deletes the bot’s jobs, blobs and caches from this computer', async () => {
    const { host, client, worker } = await attached({}, { bots, answers: { botRunnerLinkDelete: () => undefined } })
    await host.unlink(client as unknown as RunnerHostClient, BOT)
    expect(client.calls[0]).toMatchObject({ key: 'botRunnerLinkDelete', params: { id: BOT } })
    expect(worker.removeBot).toHaveBeenCalledExactlyOnceWith(client.serverId, BOT)
  })

  it('unlinks even when the server no longer has the link', async () => {
    const { host, client, worker } = await attached(
      {},
      {
        answers: {
          botRunnerLinkDelete: () => {
            throw new FleetClientError('NOT_FOUND', 404, 'gone')
          },
        },
      }
    )
    await host.unlink(client as unknown as RunnerHostClient, BOT)
    expect(worker.removeBot).toHaveBeenCalledTimes(1)
  })

  it('removes another computer’s link, never its own', async () => {
    const { host, client, worker } = await attached(
      {},
      {
        bots,
        answers: {
          botRunnerLinks: () => ({ links: [link(), link({ runnerId: OTHER_RUNNER_ID, name: 'Rack', self: false })] }),
          botRunnerJobs: () => ({ jobs: [] }),
          botRunnerLinkRemove: () => undefined,
        },
      }
    )
    await host.removeOther(client as unknown as RunnerHostClient, BOT, OTHER_RUNNER_ID)
    expect(client.calls.find((call) => call.key === 'botRunnerLinkRemove')).toEqual({
      key: 'botRunnerLinkRemove',
      params: { id: BOT, runnerId: OTHER_RUNNER_ID },
      body: undefined,
    })
    await expect(host.removeOther(client as unknown as RunnerHostClient, BOT, RUNNER_ID)).rejects.toThrow()
    await expect(host.removeOther(client as unknown as RunnerHostClient, BOT, 'not-a-runner')).rejects.toThrow()
    expect(client.calls.filter((call) => call.key === 'botRunnerLinkRemove')).toHaveLength(1)
    expect(worker.removeBot).not.toHaveBeenCalled()
  })
})

describe('runner host: quitting', () => {
  it('stops the worker, and takes no more jobs', async () => {
    const { host, worker, deps } = await attached()
    await host.stop()
    expect(worker.stop).toHaveBeenCalledTimes(1)
    expect(deps().settings().accepting).toBe(false)
  })
})
