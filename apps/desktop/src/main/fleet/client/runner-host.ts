import {
  FLEET_RUNNER_LIMITS,
  FLEET_RUNNER_JOBS_CAPABILITY,
  FLEET_RUNNERS_FEATURE,
  type FleetGatewayEvent,
  type FleetRunnerCapabilities,
  type FleetRunnerJobLogPage,
  type FleetRunnerJobsResponse,
  type FleetRunnerLinksResponse,
  type FleetRunnerLinkView,
  fleetRunnerIdSchema,
  fleetRunnerNameSchema,
} from '@maestrly/bot-fleet-protocol'
import path from 'node:path'
import type { FleetServerId } from '../../../shared/fleet-servers'
import type {
  RunnerAccessView,
  RunnerConfig,
  RunnerDockerView,
  RunnerHistoryItem,
  RunnerJobItem,
  RunnerScopeInput,
  RunnerServerItem,
  RunnerStatus,
  RunnerStorageItem,
  RunnerStorageView,
} from '../../../shared/runner'
import { httpRunnerJobApi } from '../../runner/api'
import { probeRunnerCapabilities } from '../../runner/capabilities'
import type { RunnerExecutor } from '../../runner/executor'
import { NativeExecutor } from '../../runner/native-executor'
import { RunnerStorage } from '../../runner/storage'
import { RunnerWorker, type RunnerWorkerDeps } from '../../runner/worker'
import { FleetClientError } from './api'
import {
  defaultRunnerConfig,
  nativeExecutorAllowed,
  readRunnerConfig,
  type RunnerSettingsStore,
  writeRunnerConfig,
} from './runner-settings'
import type { FleetClientService, FleetRunnerPort } from './service'

/** What the host uses of a paired server's client. */
export type RunnerHostClient = Pick<
  FleetClientService,
  | 'serverId'
  | 'hasFeature'
  | 'getConnection'
  | 'getSnapshot'
  | 'hostFilesAccess'
  | 'call'
  | 'deviceName'
  | 'syncRunnerStream'
> & { runnerHost: FleetRunnerPort | null }

/** What the host uses of the worker. */
export type RunnerWorkerPort = Pick<
  RunnerWorker,
  | 'start'
  | 'connected'
  | 'refresh'
  | 'disconnected'
  | 'handleJob'
  | 'handleCancel'
  | 'jobs'
  | 'history'
  | 'log'
  | 'cancel'
  | 'clearCaches'
  | 'removeBot'
  | 'stop'
>

export interface RunnerHostOptions {
  /** False where no runner exists, as in a bot container: nothing is built and nothing is accepted. */
  available: boolean
  settings: RunnerSettingsStore
  /** The folder of the app's data, where the runner keeps its files unless the owner picks another. */
  userDataDir(): string
  /** Called after the jobs, the storage, or the settings changed. */
  notifyChanged(): void
  /** Called after the runners or the jobs of one bot changed. */
  notifyAccess(serverId: FleetServerId, botId: string): void
  /** The executor of Container jobs; until the app has one, such jobs fail with `executor_unavailable`. */
  container?: () => RunnerExecutor
  /** Whether Docker hands containers an NVIDIA GPU on this computer. */
  containerSupport?: () => Promise<{ gpu: boolean }>
  /** What Container jobs leave behind: containers of jobs a previous run held, and a bot's cache volumes. */
  containerCleanup?: {
    removeOrphans(keep: Set<string>): Promise<void>
    removeScopeVolumes(scope: string): Promise<void>
  }
  /** Keeps the computer awake for `key` until the returned function is called. */
  holdAwake?(key: string): () => void
  /** Docker's state on this computer, asked only for Container. */
  docker?: () => Promise<RunnerDockerView>
  platform?: NodeJS.Platform
  now?: () => number
  // The pieces the tests replace.
  probe?: typeof probeRunnerCapabilities
  createStorage?: (root: string) => RunnerStorage
  createWorker?: (deps: RunnerWorkerDeps) => RunnerWorkerPort
  native?: () => RunnerExecutor
}

/** What the owner is told while Docker jobs have no executor in this version of the app. */
const DOCKER_UNAVAILABLE = 'Docker jobs are not available in this version.'
const unavailableContainerExecutor = (): RunnerExecutor => ({
  kind: 'container',
  run: async () => ({
    exitCode: null,
    timedOut: false,
    cancelled: false,
    error: { code: 'executor_unavailable', message: DOCKER_UNAVAILABLE },
  }),
})

const USAGE_TTL_MS = 10_000
const DOCKER_TTL_MS = 10_000
// A cancel the server does not hear of in time is not waited for: the job stops here anyway.
const GATEWAY_CANCEL_WAIT_MS = 4_000
const RECONCILED_BOTS_MAX = 200
/** What the owner is told when no log can be read: this computer keeps the logs of the jobs it ran lately only. */
const LOG_GONE = 'This job’s log is no longer kept on this computer.'
const LOG_ENVIRONMENT_STOPPED = 'This bot’s environment is not running, so the job’s log cannot be read now.'
const LOG_NOT_FOUND = 'The bot’s environment no longer has this job’s log.'

interface Core {
  storage: RunnerStorage
  worker: RunnerWorkerPort
}

const notFound = (error: unknown): boolean =>
  error instanceof FleetClientError && (error.status === 404 || error.code === 'NOT_FOUND')

/** How a paired server is named: the host name it reports, else its address. */
function serverName(connection: { hostname: string | null; url: string | null }): string {
  if (connection.hostname) return connection.hostname
  try {
    return connection.url ? new URL(connection.url).host : ''
  } catch {
    return connection.url ?? ''
  }
}

const keyOf = (serverId: string, botId: string) => `${serverId}\n${botId}`

/**
 * This computer as a runner: it holds the one worker that runs the jobs of every paired server's bots, decides from the
 * settings and from what each server announces whether a server's event stream carries jobs, and keeps what it holds
 * for a bot in step with that bot's link. The worker is built when it is first needed, and the storage folder it uses
 * is the one chosen then.
 */
export class RunnerHost {
  private core: Core | null = null
  private readonly clients = new Map<FleetServerId, RunnerHostClient>()
  private started: Promise<void> | null = null
  private startedDone = false
  private stopping = false
  private probes = new Map<string, Promise<FleetRunnerCapabilities>>()
  private native: RunnerExecutor | null = null
  private containerExecutor: RunnerExecutor | null = null
  /** Whether the last probe found a GPU that Docker gives containers. */
  private containerGpu = false
  private awakeSeq = 0
  private usage: { at: number; value: RunnerStorageView } | null = null
  private dockerView: { at: number; value: RunnerDockerView } | null = null
  /** Bots whose link is being checked, so that a burst of events asks the server once. */
  private readonly checking = new Set<string>()

  constructor(private readonly options: RunnerHostOptions) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform
  }
  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Whether this app can run jobs at all: a bot container cannot. */
  get available(): boolean {
    return this.options.available
  }

  // ---- Settings ----

  config(): RunnerConfig {
    return this.options.available
      ? readRunnerConfig(this.options.settings, this.platform)
      : defaultRunnerConfig(this.platform)
  }

  /** Whether this computer runs bots' jobs. */
  enabled(): boolean {
    return this.options.available && this.config().enabled
  }

  /**
   * Saves a change of the settings and applies it: what the servers are told about this computer is read again, a
   * server's stream is opened or closed as the runner is turned on or off, and turning it off stops its jobs.
   */
  async updateConfig(input: unknown): Promise<RunnerConfig> {
    if (!this.options.available) throw new Error('This app does not run jobs for bots.')
    const before = this.config()
    const after = writeRunnerConfig(this.options.settings, input, this.platform)
    this.probes.clear()
    this.dockerView = null
    if (before.enabled && !after.enabled) this.cancelAll()
    if (after.enabled) void this.begin().catch(() => undefined)
    for (const client of this.clients.values()) client.syncRunnerStream()
    // Slots, executor and GPU change what the connected servers are told.
    void this.core?.worker.refresh().catch(() => undefined)
    this.options.notifyChanged()
    return after
  }

  // ---- The worker ----

  private ensureCore(): Core {
    if (this.core) return this.core
    const config = this.config()
    const root = config.storageDir ?? path.join(this.options.userDataDir(), 'runner')
    const storage = (this.options.createStorage ?? ((dir) => new RunnerStorage(dir)))(root)
    const deps: RunnerWorkerDeps = {
      storage,
      executors: () => this.executor(),
      settings: () => {
        const current = this.config()
        return {
          accepting: this.options.available && current.enabled && !this.stopping,
          slots: current.slots,
          blobCapBytes: current.blobCapBytes,
          executor: current.executor,
        }
      },
      capabilities: () => this.capabilities(),
      api: (serverId) => this.api(serverId),
      holdAwake: () => this.options.holdAwake?.(`runner-job-${++this.awakeSeq}`) ?? noop,
      now: this.options.now,
      onChange: (what) => {
        // A running job's usage changes every few seconds; the storage it would make the settings walk again does not.
        if (what !== 'usage') this.usage = null
        this.options.notifyChanged()
      },
    }
    const worker = (this.options.createWorker ?? ((workerDeps) => new RunnerWorker(workerDeps)))(deps)
    this.core = { storage, worker }
    return this.core
  }

  private executor(): RunnerExecutor {
    if (this.config().executor === 'container')
      return (this.containerExecutor ??= this.options.container?.() ?? unavailableContainerExecutor())
    return (this.native ??= this.options.native?.() ?? new NativeExecutor())
  }

  /** What this computer tells the servers it is, probed once for each executor, number of slots and GPU choice. */
  private capabilities(gpuAllowed?: boolean): Promise<FleetRunnerCapabilities> {
    const config = this.config()
    const { executor, slots } = config
    const gpu = gpuAllowed ?? config.gpu
    const key = `${executor}|${slots}|${gpu}`
    const known = this.probes.get(key)
    if (known) return known
    const probe = (this.options.probe ?? probeRunnerCapabilities)({ executor, slots, platform: this.platform }).then(
      async (found): Promise<FleetRunnerCapabilities> => {
        let detected = found.gpu
        // A container reaches only an NVIDIA GPU, and only when Docker hands it over: never Metal on a Mac.
        if (executor === 'container' && this.options.containerSupport) {
          const support = await this.options.containerSupport().catch(() => null)
          this.containerGpu = detected?.vendor === 'nvidia' && support?.gpu === true
          if (!this.containerGpu) detected = null
        }
        // The GPU is told to the servers only when the owner lets jobs use it.
        return { ...found, gpu: gpu ? detected : null }
      }
    )
    this.probes.set(key, probe)
    probe.catch(() => this.probes.delete(key))
    return probe
  }

  /** The limits of one Container job: the GPU only when the owner allows it and Docker gives it. */
  containerLimits(): { cpus: number | null; memoryBytes: number | null; gpu: boolean } {
    const config = this.config()
    return { cpus: config.jobCpus, memoryBytes: config.jobMemoryBytes, gpu: config.gpu && this.containerGpu }
  }

  /** The routes of a paired server, with the device token it holds now. */
  private api(serverId: string) {
    const client = this.clients.get(serverId as FleetServerId)
    const access = client?.hostFilesAccess()
    if (!client || !access) return null
    return httpRunnerJobApi({
      origin: access.origin,
      headers: () => client.hostFilesAccess()?.headers ?? access.headers,
    })
  }

  /** Loads what the last run left, once; every report to a server waits for it. */
  private begin(): Promise<void> {
    if (!this.started) {
      const { worker } = this.ensureCore()
      this.started = worker.start().then(() => {
        this.startedDone = true
        // The containers of the jobs a previous run held ended with those jobs.
        const held = new Set(worker.jobs().map((job) => job.jobId))
        void this.options.containerCleanup?.removeOrphans(held).catch(() => undefined)
      })
    }
    return this.started
  }

  /** Starts the worker when the runner is on; the app calls it once it has opened its servers. */
  async start(): Promise<void> {
    if (!this.enabled()) return
    await this.begin()
  }

  /** Stops every job and waits for their commands to end. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.core) await this.core.worker.stop()
  }

  // ---- Servers ----

  /** The runner's part in one paired server's client. */
  forClient(client: RunnerHostClient): FleetRunnerPort {
    this.clients.set(client.serverId, client)
    const serverId = client.serverId
    return {
      wants: () => this.enabled() && client.hasFeature(FLEET_RUNNERS_FEATURE),
      connected: () => this.connected(client),
      disconnected: () => this.core?.worker.disconnected(serverId),
      handle: (event) => this.handle(client, event),
      unpaired: () => this.unpaired(client),
    }
  }

  private async connected(client: RunnerHostClient): Promise<void> {
    if (!this.enabled() || !client.hasFeature(FLEET_RUNNERS_FEATURE) || this.stopping) return
    // What the last run left is reported ended before this computer says it takes jobs again.
    await this.begin()
    await this.ensureCore().worker.connected(client.serverId)
    await this.reconcile(client)
  }

  private handle(client: RunnerHostClient, event: FleetGatewayEvent): boolean {
    switch (event.type) {
      case 'runner.job':
        if (this.startedDone && this.enabled() && this.core) this.core.worker.handleJob(client.serverId, event)
        return true
      case 'runner.cancel':
        this.core?.worker.handleCancel(client.serverId, event.jobId)
        return true
      case 'runner_link.updated':
        // Without this computer's own link, what it keeps for the bot goes once the server confirms it.
        if (!event.links.some((link) => link.self)) void this.dropIfUnlinked(client, event.botId).catch(() => undefined)
        this.options.notifyAccess(client.serverId, event.botId)
        return true
      case 'runner_job.updated':
        this.options.notifyAccess(client.serverId, event.job.botId)
        return true
      default:
        return false
    }
  }

  /**
   * A bot's link to this computer may be gone. The event that says so may predate this computer's own last change, so
   * the server is asked before anything is deleted: the bot's jobs stop and its blobs and caches go.
   */
  private async dropIfUnlinked(client: RunnerHostClient, botId: string): Promise<void> {
    const core = this.core
    if (!core || !this.startedDone) return
    const { serverId } = client
    const key = keyOf(serverId, botId)
    if (this.checking.has(key)) return
    this.checking.add(key)
    try {
      const holds =
        core.worker.jobs().some((job) => job.serverId === serverId && job.botId === botId) ||
        (await core.storage.records()).some((record) => record.serverId === serverId && record.botId === botId)
      if (!holds) return
      if (await this.linkedHere(client, botId)) return
      await this.removeBot(core, serverId, botId)
      this.usage = null
    } finally {
      this.checking.delete(key)
    }
  }

  /** Whether the server says this computer is linked to the bot; a failure to ask counts as linked. */
  private async linkedHere(client: RunnerHostClient, botId: string): Promise<boolean> {
    try {
      const { links } = (await client.call('botRunnerLinks', { params: { id: botId } })) as FleetRunnerLinksResponse
      return links.some((link) => link.self)
    } catch (error) {
      return !notFound(error)
    }
  }

  /** Once connected: the bots this computer keeps files for are checked against the server, which may have removed them. */
  private async reconcile(client: RunnerHostClient): Promise<void> {
    const core = this.core
    if (!core) return
    const bots = new Set(
      (await core.storage.records().catch(() => []))
        .filter((record) => record.serverId === client.serverId)
        .map((record) => record.botId)
    )
    for (const botId of [...bots].slice(0, RECONCILED_BOTS_MAX)) {
      if (!this.enabled() || client.getConnection().state !== 'connected') return
      await this.dropIfUnlinked(client, botId).catch(() => undefined)
    }
  }

  /** The bot's jobs here stop, and its blobs, caches and cache volumes go. */
  private async removeBot(core: Core, serverId: string, botId: string): Promise<void> {
    await core.worker.removeBot(serverId, botId)
    await this.options.containerCleanup?.removeScopeVolumes(core.storage.scope(serverId, botId)).catch(() => undefined)
  }

  /** This computer leaves a server: its bots' jobs stop and everything kept for them goes. */
  private async unpaired(client: RunnerHostClient): Promise<void> {
    this.clients.delete(client.serverId)
    const core = this.core
    if (!core) return
    const bots = new Set([
      ...core.worker
        .jobs()
        .filter((job) => job.serverId === client.serverId)
        .map((job) => job.botId),
      ...(await core.storage.records().catch(() => []))
        .filter((record) => record.serverId === client.serverId)
        .map((record) => record.botId),
    ])
    for (const botId of bots) await this.removeBot(core, client.serverId, botId).catch(() => undefined)
    this.usage = null
  }

  // ---- Jobs and storage ----

  private cancelAll(): void {
    const worker = this.core?.worker
    for (const job of worker?.jobs() ?? []) worker?.cancel(job.serverId, job.jobId)
  }

  /**
   * Stops a job from the settings: the server is told first, so that it records the cancel, then the job stops here.
   * The server's answer is not waited for long and its failure does not matter.
   */
  async cancelJob(serverId: string, jobId: string): Promise<void> {
    const worker = this.core?.worker
    const job = worker?.jobs().find((item) => item.serverId === serverId && item.jobId === jobId)
    if (!worker || !job) return
    const client = this.clients.get(serverId as FleetServerId)
    if (client) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        client.call('botRunnerJobCancel', { params: { id: job.botId, jobId } }).catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, GATEWAY_CANCEL_WAIT_MS)
          timer.unref?.()
        }),
      ])
      clearTimeout(timer)
    }
    worker.cancel(serverId, jobId)
  }

  /** Deletes the named caches of one bot, or of all, but not of a bot with a job running. */
  async clearCaches(scope?: RunnerScopeInput): Promise<void> {
    const core = this.core
    if (!core) return
    await core.worker.clearCaches(scope ? core.storage.scope(scope.serverId, scope.botId) : undefined)
    this.usage = null
    this.options.notifyChanged()
  }

  /**
   * A piece of the log of a job this computer holds or ran lately, from the byte `offset` or, when null, from the end
   * (see `FleetRunnerJobLogPage`).
   */
  async jobLog(serverId: string, jobId: string, offset: number | null): Promise<FleetRunnerJobLogPage> {
    const page = await this.localLog(serverId, jobId, offset)
    if (!page) throw new Error(LOG_GONE)
    return page
  }

  private async localLog(
    serverId: string,
    jobId: string,
    offset: number | null
  ): Promise<FleetRunnerJobLogPage | null> {
    const worker = this.core?.worker
    if (!worker) return null
    // What the last run left is loaded before the worker knows its jobs.
    await this.started?.catch(() => undefined)
    try {
      return await worker.log(serverId, jobId, offset)
    } catch {
      return null
    }
  }

  // ---- What the settings show ----

  async status(options: { recheckDocker?: boolean } = {}): Promise<RunnerStatus> {
    const config = this.config()
    const available = this.options.available
    const nativeAllowed = nativeExecutorAllowed(this.platform)
    const clients = [...this.clients.values()]
    const servers: RunnerServerItem[] = clients.map((client) => ({
      serverId: client.serverId,
      name: serverName(client.getConnection()),
      connected: client.getConnection().state === 'connected',
      supported: client.hasFeature(FLEET_RUNNERS_FEATURE),
    }))
    const nameOfServer = (serverId: string) => servers.find((server) => server.serverId === serverId)?.name ?? ''
    const nameOfBot = (serverId: string, botId: string) =>
      this.clients
        .get(serverId as FleetServerId)
        ?.getSnapshot()
        .bots.find((bot) => bot.id === botId)?.name ?? null
    if (!available)
      return {
        available,
        config,
        nativeAllowed,
        capabilities: null,
        detectedGpu: null,
        docker: null,
        storage: { dir: '', bots: [], blobBytes: 0, cacheBytes: 0 },
        servers: [],
        jobs: [],
        history: [],
      }
    const core = this.ensureCore()
    const [capabilities, detected, docker, storage] = await Promise.all([
      this.capabilities().catch(() => null),
      this.capabilities(true).catch(() => null),
      config.executor === 'container' ? this.docker(options.recheckDocker === true) : Promise.resolve(null),
      this.storageView(core, nameOfServer, nameOfBot),
    ])
    const jobs: RunnerJobItem[] = core.worker.jobs().map((job) => ({
      serverId: job.serverId as FleetServerId,
      serverName: nameOfServer(job.serverId),
      botId: job.botId,
      botName: nameOfBot(job.serverId, job.botId),
      jobId: job.jobId,
      command: job.command,
      phase: job.state,
      startedAt: job.startedAt,
      usage: job.usage,
    }))
    const history: RunnerHistoryItem[] = core.worker.history().map((entry) => ({
      serverId: entry.serverId as FleetServerId,
      serverName: nameOfServer(entry.serverId),
      botId: entry.botId,
      botName: nameOfBot(entry.serverId, entry.botId),
      jobId: entry.jobId,
      command: entry.command,
      outcome: entry.outcome,
      exitCode: entry.exitCode,
      error: entry.error,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      peakMemoryBytes: entry.peakMemoryBytes,
      cpuSeconds: entry.cpuSeconds,
    }))
    return {
      available,
      config,
      nativeAllowed,
      capabilities,
      detectedGpu: detected?.gpu ?? null,
      docker,
      storage,
      servers,
      jobs,
      history,
    }
  }

  private async docker(recheck: boolean): Promise<RunnerDockerView | null> {
    const read = this.options.docker
    if (!read) return null
    if (!recheck && this.dockerView && this.now() - this.dockerView.at < DOCKER_TTL_MS) return this.dockerView.value
    try {
      const value = await read()
      this.dockerView = { at: this.now(), value }
      return value
    } catch {
      // Docker that cannot be asked is Docker that does not answer.
      return { state: 'stopped', engine: null, version: null }
    }
  }

  private async storageView(
    core: Core,
    nameOfServer: (serverId: string) => string,
    nameOfBot: (serverId: string, botId: string) => string | null
  ): Promise<RunnerStorageView> {
    if (!this.usage || this.now() - this.usage.at >= USAGE_TTL_MS) {
      const found = await core.storage.usage().catch(() => ({ scopes: [], blobBytes: 0, cacheBytes: 0 }))
      const bots: RunnerStorageItem[] = found.scopes.map((scope) => ({
        serverId: scope.serverId as FleetServerId | null,
        serverName: scope.serverId ? nameOfServer(scope.serverId) : null,
        botId: scope.botId,
        botName: scope.serverId && scope.botId ? nameOfBot(scope.serverId, scope.botId) : null,
        scope: scope.scope,
        blobBytes: scope.blobBytes,
        cacheBytes: scope.cacheBytes,
      }))
      this.usage = {
        at: this.now(),
        value: { dir: core.storage.root, bots, blobBytes: found.blobBytes, cacheBytes: found.cacheBytes },
      }
    }
    return this.usage.value
  }

  // ---- A bot's runners ----

  /** One bot's runners as its settings on this computer show them. */
  async access(client: RunnerHostClient, botId: string): Promise<RunnerAccessView> {
    const config = this.config()
    const supported = client.hasFeature(FLEET_RUNNERS_FEATURE)
    const connected = client.getConnection().state === 'connected'
    let links: FleetRunnerLinkView[] | null = null
    let jobs: RunnerAccessView['jobs'] = null
    if (supported && connected)
      [links, jobs] = await Promise.all([
        client
          .call('botRunnerLinks', { params: { id: botId } })
          .then((response) => (response as FleetRunnerLinksResponse).links)
          .catch(() => null),
        client
          .call('botRunnerJobs', { params: { id: botId } })
          .then((response) => (response as FleetRunnerJobsResponse).jobs)
          .catch(() => null),
      ])
    return {
      supported,
      connected,
      botSupported: this.botSupported(client, botId),
      runnerEnabled: this.enabled(),
      executor: config.executor,
      self: links?.find((link) => link.self) ?? null,
      links,
      jobs,
      defaultName: (client.deviceName() ?? '').slice(0, FLEET_RUNNER_LIMITS.nameMax) || 'Computer',
    }
  }

  /** Whether the bot's environment has what it takes to send jobs: a bot that is not running reports nothing itself. */
  private botSupported(client: RunnerHostClient, botId: string): boolean {
    const snapshot = client.getSnapshot()
    const bot = snapshot.bots.find((item) => item.id === botId)
    const environment = snapshot.environments.find((item) => item.id === bot?.environmentId)
    return [...(bot?.capabilities ?? []), ...(environment?.capabilities ?? [])].includes(FLEET_RUNNER_JOBS_CAPABILITY)
  }

  /** Lets the bot run jobs on this computer, under the name it sees. */
  async link(client: RunnerHostClient, botId: string, name: unknown): Promise<RunnerAccessView> {
    if (!this.enabled()) throw new Error('Turn on Run jobs for bots in Settings → Runner first.')
    if (!client.hasFeature(FLEET_RUNNERS_FEATURE)) throw new Error('Update the bot server before linking a runner.')
    await client.call('botRunnerLinkPut', { params: { id: botId }, body: { name: fleetRunnerNameSchema.parse(name) } })
    this.options.notifyAccess(client.serverId, botId)
    return this.access(client, botId)
  }

  /** Takes this computer's link away: the bot's jobs on it stop, and its blobs and caches are deleted here. */
  async unlink(client: RunnerHostClient, botId: string): Promise<RunnerAccessView> {
    try {
      await client.call('botRunnerLinkDelete', { params: { id: botId } })
    } catch (error) {
      if (!notFound(error)) throw error
    }
    if (this.core) await this.removeBot(this.core, client.serverId, botId).catch(() => undefined)
    this.usage = null
    this.options.notifyAccess(client.serverId, botId)
    return this.access(client, botId)
  }

  /** Removes another computer's link; that computer deletes what it kept when it hears of it. */
  async removeOther(client: RunnerHostClient, botId: string, runnerId: unknown): Promise<RunnerAccessView> {
    const id = fleetRunnerIdSchema.parse(runnerId)
    const { self } = await this.access(client, botId)
    if (self?.runnerId === id) throw new Error('Turn off this computer’s switch instead.')
    await client.call('botRunnerLinkRemove', { params: { id: botId, runnerId: id } })
    this.options.notifyAccess(client.serverId, botId)
    return this.access(client, botId)
  }

  /**
   * Cancels one of the bot's jobs, on whichever computer has it: the server tells that computer, this one included.
   * Any paired device may; a job that already ended is refused by the server and said so.
   */
  async cancelBotJob(client: RunnerHostClient, botId: string, jobId: string): Promise<RunnerAccessView> {
    await client.call('botRunnerJobCancel', { params: { id: botId, jobId } })
    this.options.notifyAccess(client.serverId, botId)
    return this.access(client, botId)
  }

  /**
   * A piece of the log of one of the bot's jobs. This computer's own copy is read when it holds or ran the job, which
   * is fresher than what the bot's environment has received; else the bot's environment is asked, through the server.
   */
  async botJobLog(
    client: RunnerHostClient,
    botId: string,
    jobId: string,
    offset: number | null
  ): Promise<FleetRunnerJobLogPage> {
    const local = await this.localLog(client.serverId, jobId, offset)
    if (local) return local
    try {
      return (await client.call('botRunnerJobLogRead', {
        params: { id: botId, jobId },
        query: offset === null ? undefined : { offset },
      })) as FleetRunnerJobLogPage
    } catch (error) {
      if (error instanceof FleetClientError && error.status === 409) throw new Error(LOG_ENVIRONMENT_STOPPED)
      if (notFound(error)) throw new Error(LOG_NOT_FOUND)
      throw error
    }
  }
}

function noop(): void {}
