import {
  FLEET_RUNNER_LIMITS,
  FLEET_RUNNER_TRANSFER_LIMITS,
  type FleetRunnerAssignedSpec,
  type FleetRunnerCapabilities,
  type FleetRunnerError,
  type FleetRunnerJobEvent,
  type FleetRunnerManifest,
} from '@maestrly/bot-fleet-protocol'
import { mkdir } from 'node:fs/promises'
import { isTransientApiError, RunnerApiError, type RunnerJobApi } from './api'
import { assembleJobFolder } from './assemble'
import { BlobCache } from './blob-cache'
import { isDiskFull, RunnerJobError } from './errors'
import type { RunnerExecutor } from './executor'
import { RunnerLogPump, type RunnerLogPumpOptions, redactEnvValues } from './log-pump'
import { collectRunnerOutputs, packRunnerOutputs } from './outputs'
import { abortableSleep } from './sleep'
import { removeTree, type RunnerStorage } from './storage'
import { type RunnerUploadOptions, uploadRunnerOutputs } from './upload'

/** What a job is doing now, for the settings list: fetching its inputs, running, sending outputs, or ending. */
export type RunnerJobPhase = 'preparing' | 'running' | 'uploading' | 'finishing'

export interface RunnerJobView {
  serverId: string
  botId: string
  jobId: string
  /** The first line of the command. */
  command: string
  state: RunnerJobPhase
  /** When this computer took the job, in milliseconds since the epoch. */
  startedAt: number
}

export interface RunnerSettings {
  accepting: boolean
  /** Jobs at once. */
  slots: number
  /** Bytes of blobs kept across jobs, all bots together. */
  blobCapBytes: number
  executor: 'native' | 'container'
}

export interface RunnerWorkerDeps {
  storage: RunnerStorage
  /** The executor the runner is configured for. */
  executors: () => RunnerExecutor
  settings: () => RunnerSettings
  capabilities: () => Promise<FleetRunnerCapabilities>
  /** The routes of a paired server, or null when this computer is not paired with it. */
  api: (serverId: string) => RunnerJobApi | null
  /** Keeps the computer awake until the returned function is called. */
  holdAwake?: () => () => void
  now?: () => number
  /** The jobs or the storage changed: the interface refreshes. */
  onChange?: () => void
  /** Timings the tests shorten. */
  tuning?: {
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    upload?: Partial<Omit<RunnerUploadOptions, 'signal'>>
    log?: Partial<Pick<RunnerLogPumpOptions, 'intervalMs' | 'sendBytes' | 'backoff'>>
    /** How long `start` waits for the gateways to hear about jobs a restart ended. */
    restartFinishWaitMs?: number
  }
}

type Outcome = { exitCode: number | null; error: FleetRunnerError | null }
type Step = 'transfer' | 'command' | 'outputs'

interface HeldJob {
  serverId: string
  botId: string
  jobId: string
  key: string
  scope: string
  spec: FleetRunnerAssignedSpec
  phase: RunnerJobPhase
  step: Step
  startedAt: number
  abort: AbortController
  /** Stopped on request: by the bot, the owner, or a link that went away. */
  cancelled: boolean
  /** The gateway no longer expects anything of the job: no result is sent for it. */
  forgotten: boolean
  /** The result is on its way: the gateway counts the slot free, and so does this computer. */
  ending: boolean
  exitCode: number | null
  release: (() => void) | null
  task: Promise<void>
}

interface PersistedJob {
  serverId: string
  botId: string
  jobId: string
  key: string
  startedAt: number
}

const RESTART_MESSAGE = 'The Maestrly app on the runner computer restarted while the job was running.'
const RESTART_FINISH_WAIT_MS = 10_000
const MESSAGE_MAX = 900
const idOf = (serverId: string, jobId: string): string => `${serverId}\n${jobId}`
const clip = (text: string): string => (text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}…` : text)

function parsePersisted(value: unknown): PersistedJob[] {
  const jobs = (value as { jobs?: unknown } | null)?.jobs
  if (!Array.isArray(jobs)) return []
  return jobs.filter(
    (job): job is PersistedJob =>
      typeof job?.serverId === 'string' &&
      typeof job.botId === 'string' &&
      typeof job.jobId === 'string' &&
      typeof job.key === 'string'
  )
}

/**
 * Takes the bots' jobs of every paired gateway and runs them: it reports whether this computer takes jobs, accepts the
 * jobs the gateway sends while it has a free slot, fetches each job's inputs through the blob cache, runs the command
 * with the configured executor, sends the outputs and the log back, and ends the job with its result. The jobs it holds
 * are written to disk so that, after a restart, the gateways hear that those jobs ended with `runner_restarted`.
 */
export class RunnerWorker {
  private readonly held = new Map<string, HeldJob>()
  private readonly connections = new Set<string>()
  /** Blobs each preparing job needs, which eviction leaves alone. */
  private readonly pins = new Map<string, Set<string>>()
  private readonly reports = new Map<string, Promise<void>>()
  private readonly dirtyReports = new Set<string>()
  private readonly reportFailures = new Map<string, number>()
  private readonly retryingReports = new Set<string>()
  private readonly shutdown = new AbortController()
  private stateWrites: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: RunnerWorkerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const wait = this.deps.tuning?.sleep ?? abortableSleep
    return wait(ms, signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal)
  }
  private changed(): void {
    try {
      this.deps.onChange?.()
    } catch {
      // A failing interface does not stop the jobs.
    }
  }

  /**
   * Loads what the last run left: its jobs ended with the app, so each is finished with `runner_restarted` (a gateway
   * that cannot be reached finds out when this computer reports) and every job folder is deleted.
   */
  async start(): Promise<void> {
    const { storage } = this.deps
    const left = parsePersisted(await storage.readState().catch(() => null))
    await BlobCache.sweepTemporary(storage.blobsRoot())
    await storage.removeAllJobs()
    await storage.writeState({ jobs: [] })
    const finished = left.map((job) =>
      Promise.resolve()
        .then(() =>
          this.deps.api(job.serverId)?.finish(job.jobId, {
            exitCode: null,
            error: { code: 'runner_restarted', message: RESTART_MESSAGE },
          })
        )
        .catch(() => undefined)
    )
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all(finished),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.deps.tuning?.restartFinishWaitMs ?? RESTART_FINISH_WAIT_MS)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    this.changed()
  }

  /** A gateway's event stream opened or reopened: tells it what this computer is and which of its jobs it holds. */
  async connected(serverId: string): Promise<void> {
    if (this.stopped) return
    this.connections.add(serverId)
    await this.report(serverId)
  }

  /** The settings changed: every connected gateway hears the new state. */
  async refresh(): Promise<void> {
    await Promise.all([...this.connections].map((serverId) => this.report(serverId)))
  }

  disconnected(serverId: string): void {
    this.connections.delete(serverId)
  }

  private report(serverId: string): Promise<void> {
    const running = this.reports.get(serverId)
    if (running) {
      this.dirtyReports.add(serverId)
      return running
    }
    const run = (async () => {
      await Promise.resolve()
      try {
        do {
          this.dirtyReports.delete(serverId)
          await this.reportOnce(serverId)
        } while (this.dirtyReports.has(serverId) && !this.stopped)
      } catch {
        // A report that could not even be made is tried again like one the gateway did not get.
        this.retryReport(serverId)
      } finally {
        this.reports.delete(serverId)
      }
    })()
    this.reports.set(serverId, run)
    return run
  }

  private async reportOnce(serverId: string): Promise<void> {
    const api = this.deps.api(serverId)
    if (!api || !this.connections.has(serverId)) return
    let capabilities: FleetRunnerCapabilities | null = null
    try {
      capabilities = await this.deps.capabilities()
    } catch {
      // A computer that cannot tell what it is takes no jobs.
    }
    const jobs = [...this.held.values()]
      .filter((job) => job.serverId === serverId && !job.forgotten)
      .map((job) => job.jobId)
      .slice(0, FLEET_RUNNER_LIMITS.slotsMax * 4)
    try {
      const { stop } = await api.report({
        accepting: this.deps.settings().accepting && capabilities !== null,
        capabilities,
        jobs,
      })
      this.reportFailures.delete(serverId)
      for (const jobId of stop) {
        const job = this.held.get(idOf(serverId, jobId))
        if (job) this.stopJob(job, true)
      }
    } catch {
      this.retryReport(serverId)
    }
  }

  /** A report the gateway did not get leaves this computer invisible to it: try again, with growing pauses. */
  private retryReport(serverId: string): void {
    if (this.stopped || this.retryingReports.has(serverId)) return
    const failures = this.reportFailures.get(serverId) ?? 0
    this.reportFailures.set(serverId, failures + 1)
    this.retryingReports.add(serverId)
    this.sleep(Math.min(60_000, 1_000 * 2 ** failures)).then(
      () => {
        this.retryingReports.delete(serverId)
        if (this.connections.has(serverId) && !this.stopped) void this.report(serverId)
      },
      () => this.retryingReports.delete(serverId)
    )
  }

  private reportAll(): void {
    for (const serverId of this.connections) void this.report(serverId)
  }

  /** A job from a gateway. It is taken only when this computer accepts jobs, has a free slot, and is in time. */
  handleJob(serverId: string, event: FleetRunnerJobEvent): void {
    if (this.stopped || this.held.has(idOf(serverId, event.jobId))) return
    const settings = this.deps.settings()
    if (!settings.accepting || this.busySlots() >= settings.slots) return
    const acceptBy = Date.parse(event.acceptBy)
    if (!(acceptBy > this.now())) return
    const api = this.deps.api(serverId)
    if (!api) return
    const job: HeldJob = {
      serverId,
      botId: event.botId,
      jobId: event.jobId,
      key: this.deps.storage.jobKey(serverId, event.jobId),
      scope: this.deps.storage.scope(serverId, event.botId),
      spec: event.spec,
      phase: 'preparing',
      step: 'transfer',
      startedAt: this.now(),
      abort: new AbortController(),
      cancelled: false,
      forgotten: false,
      ending: false,
      exitCode: null,
      release: null,
      task: Promise.resolve(),
    }
    this.held.set(idOf(serverId, event.jobId), job)
    job.task = this.run(job, api, acceptBy).catch(() => undefined)
    this.changed()
  }

  /** Jobs that take a slot: not those whose result is on its way, nor those the gateway let go of. */
  private busySlots(): number {
    return [...this.held.values()].filter((job) => !job.ending && !job.forgotten).length
  }

  /** A gateway asks to stop a job. */
  handleCancel(serverId: string, jobId: string): void {
    const job = this.held.get(idOf(serverId, jobId))
    if (job) this.stopJob(job, false)
  }

  /** The owner stops a job from the settings. */
  cancel(serverId: string, jobId: string): void {
    this.handleCancel(serverId, jobId)
  }

  private stopJob(job: HeldJob, forget: boolean): void {
    job.cancelled = true
    job.forgotten ||= forget
    job.abort.abort()
  }

  /** The jobs this computer holds, for the settings list. */
  jobs(): RunnerJobView[] {
    return [...this.held.values()].map((job) => ({
      serverId: job.serverId,
      botId: job.botId,
      jobId: job.jobId,
      command: this.commandLine(job),
      state: job.phase,
      startedAt: job.startedAt,
    }))
  }

  private commandLine(job: HeldJob): string {
    const line = job.spec.command.split(/\r?\n/).find((candidate) => candidate.trim()) ?? ''
    return redactEnvValues(line.trim().slice(0, 200), job.spec.env)
  }

  /** Deletes the named caches of one bot's scope, or of every scope; a scope with a job running is left alone. */
  async clearCaches(scope?: string): Promise<void> {
    const busy = new Set([...this.held.values()].map((job) => job.scope))
    const scopes = scope === undefined ? await this.deps.storage.scopes() : [scope]
    for (const candidate of scopes) if (!busy.has(candidate)) await this.deps.storage.clearCaches(candidate)
    this.changed()
  }

  /** A bot's link was removed: its jobs stop, and this computer forgets its blobs and caches. */
  async removeBot(serverId: string, botId: string): Promise<void> {
    const jobs = [...this.held.values()].filter((job) => job.serverId === serverId && job.botId === botId)
    for (const job of jobs) this.stopJob(job, true)
    await Promise.allSettled(jobs.map((job) => job.task))
    await this.deps.storage.clearScope(this.deps.storage.scope(serverId, botId))
    this.changed()
  }

  /**
   * Stops every job and waits for their commands to end. The jobs stay written to disk: the next `start` reports them
   * as ended by a restart.
   */
  async stop(): Promise<void> {
    this.stopped = true
    this.shutdown.abort()
    const jobs = [...this.held.values()]
    for (const job of jobs) job.abort.abort()
    await Promise.allSettled(jobs.map((job) => job.task))
    await this.stateWrites
  }

  private persist(): Promise<void> {
    const write = async () => {
      const jobs: PersistedJob[] = [...this.held.values()].map((job) => ({
        serverId: job.serverId,
        botId: job.botId,
        jobId: job.jobId,
        key: job.key,
        startedAt: job.startedAt,
      }))
      await this.deps.storage.writeState({ jobs })
    }
    // A state that cannot be written costs the report after a restart, not the job.
    this.stateWrites = this.stateWrites.then(write).catch(() => undefined)
    return this.stateWrites
  }

  /** Runs one job from accepting it to ending it. Never rejects. */
  private async run(job: HeldJob, api: RunnerJobApi, acceptBy: number): Promise<void> {
    try {
      job.release = this.deps.holdAwake?.() ?? null
    } catch {
      job.release = null
    }
    let outcome: Outcome | null = null
    let accepted = false
    try {
      await this.persist()
      accepted = await this.accept(job, api, acceptBy)
      if (accepted) {
        this.changed()
        this.reportAll()
        outcome = await this.execute(job, api)
      }
    } catch (error) {
      outcome = this.failureOf(job, error)
    }
    // An app that is quitting leaves the job on disk, to be reported by the next start.
    if (!this.stopped) {
      if (accepted && outcome && !job.forgotten) await this.finish(job, api, outcome)
      await this.deps.storage.removeJob(job.key).catch(() => undefined)
      this.held.delete(idOf(job.serverId, job.jobId))
      await this.persist()
      this.changed()
      this.reportAll()
    }
    try {
      job.release?.()
    } catch {
      // Nothing more to release.
    }
  }

  /** Whether the gateway took this computer's word that it runs the job. */
  private async accept(job: HeldJob, api: RunnerJobApi, acceptBy: number): Promise<boolean> {
    try {
      await this.retry(() => api.accept(job.jobId), acceptBy - this.now(), 500)
      return true
    } catch {
      // Not accepted in time, or the gateway gave the job back: it is not ours.
      return false
    }
  }

  /** Calls `action` again after a failure of the network or the gateway, for at most `limitMs`. */
  private async retry<T>(action: () => Promise<T>, limitMs: number, baseMs: number, signal?: AbortSignal): Promise<T> {
    const started = this.now()
    for (let attempt = 0; ; attempt++) {
      try {
        return await action()
      } catch (error) {
        if (!isTransientApiError(error) || this.stopped || this.now() - started >= limitMs) throw error
        await this.sleep(Math.min(30_000, baseMs * 2 ** attempt), signal)
      }
    }
  }

  private async execute(job: HeldJob, api: RunnerJobApi): Promise<Outcome> {
    const { storage } = this.deps
    await mkdir(storage.jobDir(job.key), { recursive: true })
    const pump = new RunnerLogPump({
      api,
      jobId: job.jobId,
      file: storage.logFile(job.key),
      env: job.spec.env,
      sleep: this.deps.tuning?.sleep,
      ...this.deps.tuning?.log,
    })
    let outcome: Outcome
    try {
      outcome = await this.process(job, api, pump)
    } catch (error) {
      outcome = this.failureOf(job, error)
      if (outcome.error && !job.cancelled) pump.write(Buffer.from(`\n[runner] ${outcome.error.message}\n`))
    }
    if (!this.stopped) await pump.flush().catch(() => false)
    await pump.close()
    return outcome
  }

  private async process(job: HeldJob, api: RunnerJobApi, pump: RunnerLogPump): Promise<Outcome> {
    const { storage } = this.deps
    const { spec } = job
    const { signal } = job.abort
    const workDir = storage.workDir(job.key)
    const aborted = () => {
      signal.throwIfAborted()
    }

    const manifest = await this.retry(
      () => api.manifest(job.jobId, signal),
      FLEET_RUNNER_LIMITS.lostGraceMs,
      1_000,
      signal
    )
    if (manifest.jobId !== job.jobId)
      throw new RunnerJobError('transfer_failed', 'The job manifest is for another job.')
    await this.fetchInputs(job, api, manifest, workDir)
    aborted()

    job.step = 'command'
    job.phase = 'running'
    this.changed()
    const result = await this.deps.executors().run({
      jobId: job.jobId,
      serverId: job.serverId,
      botId: job.botId,
      scope: job.scope,
      folder: spec.folder,
      workDir,
      command: spec.command,
      env: spec.env,
      caches: spec.caches.map((cache) => ({
        name: cache.name,
        path: cache.path,
        dir: storage.cacheDir(job.scope, cache.name),
      })),
      image: spec.image,
      timeoutMs: spec.timeoutMinutes * 60_000,
      onOutput: (chunk) => pump.write(chunk),
      signal,
    })
    job.exitCode = result.exitCode
    if (job.cancelled || result.cancelled) return { exitCode: null, error: null }
    if (result.error) return { exitCode: null, error: result.error }

    job.step = 'outputs'
    job.phase = 'uploading'
    this.changed()
    await this.retry(() => api.progress(job.jobId), FLEET_RUNNER_LIMITS.lostGraceMs, 1_000, signal)
    const ended = this.endedBy(job, result.exitCode, result.timedOut)
    if (result.timedOut) pump.write(Buffer.from(`\n[runner] ${ended.error?.message}\n`))
    // The log goes into the archive whole, so what was held back in case it completed a secret is released first.
    await pump.flush().catch(() => false)
    const entries = await collectRunnerOutputs(workDir, spec.outputs, manifest)
    let packed: Awaited<ReturnType<typeof packRunnerOutputs>>
    try {
      packed = await packRunnerOutputs(workDir, entries, storage.outputsFile(job.key), {
        extras: [{ name: `.maestrly/runner-jobs/${job.jobId}.log`, file: storage.logFile(job.key) }],
        signal,
      })
    } catch (error) {
      // The log still returns, through the log route; the outputs do not.
      if (error instanceof RunnerJobError && error.code === 'outputs_too_large')
        return { exitCode: result.exitCode, error: { code: error.code, message: error.message } }
      throw error
    }
    await uploadRunnerOutputs(api, job.jobId, storage.outputsFile(job.key), packed, {
      signal,
      ...this.deps.tuning?.upload,
      sleep: this.deps.tuning?.upload?.sleep ?? ((ms, abort) => this.sleep(ms, abort)),
    })
    return ended
  }

  private endedBy(job: HeldJob, exitCode: number | null, timedOut: boolean): Outcome {
    if (timedOut)
      return {
        exitCode,
        error: { code: 'timeout', message: `The command was stopped after ${job.spec.timeoutMinutes} minutes.` },
      }
    if (exitCode === null)
      return { exitCode, error: { code: 'exit_code', message: 'The command was ended by a signal.' } }
    return { exitCode, error: null }
  }

  /** Brings the job's inputs to its work folder: the blobs the cache lacks, then the folder built from the cache. */
  private async fetchInputs(
    job: HeldJob,
    api: RunnerJobApi,
    manifest: FleetRunnerManifest,
    workDir: string
  ): Promise<void> {
    const { storage } = this.deps
    const { signal } = job.abort
    const sizes = new Map<string, number>()
    for (const entry of manifest.entries) {
      if (entry.kind !== 'file') continue
      if (sizes.get(entry.sha256) !== undefined && sizes.get(entry.sha256) !== entry.size)
        throw new RunnerJobError('transfer_failed', 'The job manifest gives one file two sizes.')
      sizes.set(entry.sha256, entry.size)
    }
    const cache = new BlobCache(storage.blobsRoot(), job.scope)
    this.pins.set(job.key, new Set(sizes.keys()))
    try {
      await storage.remember(job.serverId, job.botId)
      for (const batch of this.batches(cache.missing(sizes.keys()), sizes))
        await this.fetchBatch(job, api, cache, batch, sizes)
      await cache.touch(sizes.keys())
      await cache.evict(this.deps.settings().blobCapBytes, this.pinned())
      signal.throwIfAborted()
      await removeTree(workDir)
      await assembleJobFolder(manifest, cache, workDir)
    } finally {
      this.pins.delete(job.key)
    }
  }

  private pinned(): Set<string> {
    return new Set([...this.pins.values()].flatMap((digests) => [...digests]))
  }

  /** The digests split into requests of bounded count and size; a blob larger than the bound goes alone. */
  private batches(digests: readonly string[], sizes: ReadonlyMap<string, number>): string[][] {
    const batches: string[][] = []
    let current: string[] = []
    let bytes = 0
    for (const digest of digests) {
      const size = sizes.get(digest) ?? 0
      if (
        current.length &&
        (current.length >= FLEET_RUNNER_TRANSFER_LIMITS.blobBatchDigestsMax ||
          bytes + size > FLEET_RUNNER_TRANSFER_LIMITS.blobBatchBytesMax)
      ) {
        batches.push(current)
        current = []
        bytes = 0
      }
      current.push(digest)
      bytes += size
    }
    if (current.length) batches.push(current)
    return batches
  }

  /**
   * Asks for a batch of blobs, again for those that did not arrive whole. A request the gateway or the network failed
   * is repeated while they stay unavailable; asks that bring nothing new are limited to the allowed attempts.
   */
  private async fetchBatch(
    job: HeldJob,
    api: RunnerJobApi,
    cache: BlobCache,
    batch: string[],
    sizes: ReadonlyMap<string, number>
  ): Promise<void> {
    const { signal } = job.abort
    let remaining = batch
    let fruitless = 0
    let freed = false
    let lastError = ''
    while (remaining.length) {
      if (fruitless >= FLEET_RUNNER_TRANSFER_LIMITS.blobBatchAttempts)
        throw new RunnerJobError(
          'transfer_failed',
          lastError || `${remaining.length} files of the job did not arrive intact after ${fruitless} attempts.`
        )
      const asked = remaining.length
      try {
        const stream = await this.retry(
          () => api.blobs(job.jobId, remaining, signal),
          FLEET_RUNNER_LIMITS.lostGraceMs,
          1_000,
          signal
        )
        await cache.ingest(stream, new Map(remaining.map((digest) => [digest, sizes.get(digest) ?? 0])), signal)
      } catch (error) {
        signal.throwIfAborted()
        if (isDiskFull(error)) {
          if (freed) throw new RunnerJobError('runner_disk_full', 'This computer is out of disk space.')
          // Everything the other jobs do not need goes before the job is given up.
          freed = true
          await cache.evict(0, this.pinned())
          continue
        }
        if (error instanceof RunnerApiError)
          throw new RunnerJobError('transfer_failed', `The job's files were refused: ${error.message}`)
        lastError = `The job's files could not be fetched: ${(error as Error).message}`
      }
      remaining = cache.missing(remaining)
      if (remaining.length < asked) fruitless = 0
      else {
        fruitless++
        await this.sleep(Math.min(10_000, 1_000 * fruitless), signal)
      }
    }
  }

  /** Sends the job's result, trying again while the gateway does not answer. */
  private async finish(job: HeldJob, api: RunnerJobApi, outcome: Outcome): Promise<void> {
    // The gateway frees the slot when it gets the result and may send the next job before the answer comes back.
    job.ending = true
    job.phase = 'finishing'
    this.changed()
    const error = outcome.error && {
      code: outcome.error.code,
      message: clip(redactEnvValues(outcome.error.message, job.spec.env)),
    }
    try {
      await this.retry(
        () => api.finish(job.jobId, { exitCode: outcome.exitCode, error }),
        FLEET_RUNNER_LIMITS.lostGraceMs,
        1_000
      )
    } catch {
      // The gateway already ended the job, or it will count it lost after its grace period.
    }
  }

  /** How a failure ends a job: a stop is not a failure, and nothing in the message may be a value of the job's env. */
  private failureOf(job: HeldJob, error: unknown): Outcome {
    if (job.cancelled) return { exitCode: null, error: null }
    const fail = (code: FleetRunnerError['code'], message: string): Outcome => ({
      exitCode: job.exitCode,
      error: { code, message: clip(redactEnvValues(message, job.spec.env)) },
    })
    if (error instanceof RunnerJobError) return fail(error.code, error.message)
    if (isDiskFull(error)) return fail('runner_disk_full', 'This computer is out of disk space.')
    const detail = error instanceof Error ? error.message : String(error)
    if (error instanceof RunnerApiError) return fail('transfer_failed', `The gateway refused a request: ${detail}`)
    if (job.step === 'command') return fail('executor_unavailable', `The command could not run: ${detail}`)
    const what =
      job.step === 'transfer' ? "The job's files could not be prepared" : "The job's outputs could not be sent"
    return fail('transfer_failed', `${what}: ${detail.replaceAll(this.deps.storage.root, '<runner folder>')}`)
  }
}
