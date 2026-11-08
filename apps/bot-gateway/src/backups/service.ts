import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  FLEET_BACKUP_LIMITS,
  FLEET_BACKUP_RETENTION_DEFAULT,
  type FleetBackupConnectRequest,
  type FleetBackupConnectResponse,
  type FleetBackupDestination,
  type FleetBackupDestinationView,
  type FleetBackupEligibility,
  type FleetBackupEnvironmentStatus,
  type FleetBackupError,
  type FleetBackupProbeResponse,
  type FleetBackupRestorePreview,
  type FleetBackupRestoreRequest,
  type FleetBackupSnapshotGroup,
  type FleetBackupSnapshotsResponse,
  type FleetBackupRun,
  type FleetBackupRunRequest,
  type FleetBackupStatus,
  type FleetBackupUpdateRequest,
  type FleetGatewayEvent,
  type FleetInstanceBackupSnapshot,
  fleetBackupDestinationLabel,
} from '@maestrly/bot-fleet-protocol'
import { sha256 } from '../auth.js'
import type { GatewayConfig } from '../config.js'
import type { HelperMount, HelperResult } from '../docker.js'
import { GatewayError } from '../errors.js'
import { helperLabel, type Lifecycle } from '../lifecycle.js'
import { Logger } from '../logger.js'
import { nextRun } from '../routines.js'
import type { Store, StoredBackupRun, StoredBackupSettings } from '../store.js'
import { BACKUP_HELPER, type BackupHelper } from './helper.js'
import {
  BACKUP_HOME,
  BACKUP_SLICE_ENTRY,
  BACKUP_SLICE_PATH,
  BACKUP_STAGING_NAME,
  type ParsedSnapshot,
  backupArgs,
  backupExcludes,
  forgetArgs,
  formatRecoveryKey,
  newRecoveryKey,
  normalizeRecoveryKey,
  parseSnapshots,
  redact,
  resticBackupSummary,
  resticFailure,
  resticProgress,
  resticStatsBytes,
  restoreArgs,
  snapshotTags,
} from './restic.js'
import { type BackupSlice, buildBackupSlice, readBackupSlice } from './slice.js'

export type BackupsDeps = {
  store: Store
  lifecycle: Lifecycle
  helper: BackupHelper
  config: GatewayConfig
  emit: (event: FleetGatewayEvent) => void
  gatewayVersion: string
  serverName: () => string
  now?: () => number
  random?: (size: number) => Buffer
  tickMs?: number
}

const WRONG_KEY = 'This recovery key does not open this backup.'
/** How long a due backup waits before it looks again at an environment that is busy updating or changing its bots. */
const DEFER_RETRY_MS = 60_000
/** The runs one list of runs holds, newest first. */
const RUNS_LISTED = 200
/** Why an environment cannot be backed up now, as a run refused or failed for it says. */
const INELIGIBLE: Record<Exclude<FleetBackupEligibility, 'ok'>, string> = {
  'update-environment': 'Update this environment to back it up while it runs.',
  'shared-folder': "This environment uses the server's shared folder. Give it a folder of its own to back it up.",
  archived: 'This environment is archived.',
  'not-ready': 'The environment is not ready.',
}
/** What a restore restores: the gateway's part of the snapshot, read again when it was asked for. */
export type RestoreJob = { snapshotId: string; slice: BackupSlice; withProjects: boolean }
type QueueItem = { run: StoredBackupRun; notBefore: number; restore?: RestoreJob }
/** What restic may print when it lists snapshots or reads the gateway's part of one. */
const LISTING_LIMIT_BYTES = 16 * 1024 * 1024
/** A restore that failed in a way the run reports as it is. */
class RestoreFailure extends Error {
  constructor(readonly failure: FleetBackupError) {
    super(failure.message)
  }
}
/** A failure of the destination, for a request that waited for it: its code travels in the details. */
function backupError(failure: FleetBackupError): GatewayError {
  return new GatewayError('CONFLICT', failure.message || 'The backup storage failed.', { backupError: failure.code })
}

/** A Google service account key as the app pasted it: its account, and the key that must never show. */
function serviceAccount(json: string): { clientEmail: string; privateKey: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new GatewayError('INVALID_REQUEST', 'Not a service account key')
  }
  const key = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  if (key.type !== 'service_account' || typeof key.client_email !== 'string' || typeof key.private_key !== 'string')
    throw new GatewayError('INVALID_REQUEST', 'Not a service account key')
  return { clientEmail: key.client_email, privateKey: key.private_key }
}
/** The secrets of a destination, which no message of restic or rclone may show. */
export function destinationSecrets(destination: FleetBackupDestination): string[] {
  if (destination.provider === 's3') return [destination.secretAccessKey]
  if (destination.provider === 'gcs') {
    let privateKey: string[] = []
    try {
      privateKey = [serviceAccount(destination.serviceAccountJson).privateKey]
    } catch {}
    return [destination.serviceAccountJson, ...privateKey]
  }
  return [destination.token.accessToken, destination.token.refreshToken, destination.clientSecret]
}
function accountOf(destination: FleetBackupDestination): string | null {
  if (destination.provider === 's3') return '…' + destination.accessKeyId.slice(-4)
  if (destination.provider === 'gcs') return serviceAccount(destination.serviceAccountJson).clientEmail.slice(0, 320)
  return destination.account
}
/** A run as devices see it: the volume a restore created stays the gateway's own business. */
export function publicRun(run: StoredBackupRun): FleetBackupRun {
  const { volumeName: _volume, ...view } = run
  return view
}

/**
 * Backups of the server's environments: where they go, when, and which. Each run backs up one environment into a
 * restic repository at the destination, encrypted with the recovery key; restoring one brings it back as a new
 * environment with its ids.
 */
export class Backups {
  protected readonly store: Store
  protected readonly lifecycle: Lifecycle
  protected readonly helper: BackupHelper
  protected readonly logger = new Logger()
  protected readonly now: () => number
  protected readonly random: (size: number) => Buffer
  /** Connections in progress, by idempotency key: the same request sent twice waits for the first. */
  private readonly connecting = new Map<string, Promise<FleetBackupConnectResponse>>()
  /** Restores being queued, by idempotency key. */
  private readonly restoring = new Map<string, Promise<FleetBackupRun>>()
  constructor(protected readonly deps: BackupsDeps) {
    this.store = deps.store
    this.lifecycle = deps.lifecycle
    this.helper = deps.helper
    this.now = deps.now ?? Date.now
    this.random = deps.random ?? randomBytes
  }
  protected iso(): string {
    return new Date(this.now()).toISOString()
  }
  protected requireSettings(): StoredBackupSettings {
    const settings = this.store.backupSettings()
    if (!settings) throw new GatewayError('CONFLICT', 'Set up a backup destination first')
    return settings
  }
  /** The secrets no message may show: the destination's and the recovery key. */
  protected secrets(settings: Pick<StoredBackupSettings, 'destination' | 'recoveryKey'>): string[] {
    return [...destinationSecrets(settings.destination), settings.recoveryKey, formatRecoveryKey(settings.recoveryKey)]
  }
  protected emitStatus() {
    this.deps.emit({ type: 'backup.updated', at: this.iso(), status: this.status() })
  }

  status(): FleetBackupStatus {
    const settings = this.store.backupSettings()
    const selection = settings?.selection ?? { mode: 'all' as const }
    const schedules = new Map(this.store.backupEnvironments().map((row) => [row.environmentId, row.nextRunAt]))
    const environments = this.store.listEnvironments().map((environment): FleetBackupEnvironmentStatus => {
      const runs = this.store.backupRuns({
        environmentId: environment.id,
        limit: FLEET_BACKUP_LIMITS.runsKeptPerEnvironment + 10,
      })
      const success = runs.find(
        (run) => run.kind === 'backup' && (run.state === 'succeeded' || run.state === 'partial')
      )
      return {
        environmentId: environment.id,
        included: selection.mode === 'all' || selection.environments.includes(environment.id),
        eligibility: this.lifecycle.backupSource(environment.id)?.eligibility ?? 'not-ready',
        nextRunAt: settings?.enabled ? (schedules.get(environment.id) ?? null) : null,
        lastRun: runs[0] ? publicRun(runs[0]) : null,
        lastSuccessAt: success ? (success.finishedAt ?? success.startedAt) : null,
      }
    })
    return {
      destination: settings ? this.view(settings) : null,
      enabled: settings?.enabled ?? false,
      schedule: settings?.schedule ?? null,
      retention: settings?.retention ?? { ...FLEET_BACKUP_RETENTION_DEFAULT },
      selection,
      environments,
      active: this.store.unfinishedBackupRuns().map(publicRun),
    }
  }
  private view(settings: StoredBackupSettings): FleetBackupDestinationView {
    let account: string | null = null
    try {
      account = accountOf(settings.destination)
    } catch {}
    return {
      provider: settings.destination.provider,
      label: fleetBackupDestinationLabel(settings.destination),
      account,
      repositoryBytes: settings.repositoryBytes,
    }
  }
  /** Refuses a destination the helper could not use, before any container starts. */
  private validate(destination: FleetBackupDestination) {
    if (destination.provider === 'gcs') serviceAccount(destination.serviceAccountJson)
  }

  /** Whether the destination holds a Maestrly backup already, by opening it with a key that cannot be its own. */
  async probe(destination: FleetBackupDestination): Promise<FleetBackupProbeResponse> {
    this.validate(destination)
    const password = normalizeRecoveryKey(newRecoveryKey(this.random))!
    const result = await this.helper.restic({
      destination,
      password,
      args: ['cat', 'config'],
      timeoutMs: FLEET_BACKUP_LIMITS.quickTimeoutMs,
    })
    if (result.ending === 'exited' && (result.exitCode === 12 || result.exitCode === 0)) return { state: 'existing' }
    if (result.ending === 'exited' && result.exitCode === 10) return { state: 'empty' }
    return { state: 'error', error: resticFailure(result, [...destinationSecrets(destination), password]) }
  }

  /**
   * Connects the server to a destination: `create` makes a new repository there with a new recovery key, shown once;
   * `connect` opens the one there with the key the owner kept. Backups stay off until the owner chooses when.
   */
  connect(request: FleetBackupConnectRequest, deviceName: string): Promise<FleetBackupConnectResponse> {
    const hash = sha256(JSON.stringify(request))
    const prior = this.store.priorIdempotency<FleetBackupConnectResponse>('backupConnect', request.idempotencyKey, hash)
    if (prior) return Promise.resolve(prior.response)
    const pending = this.connecting.get(request.idempotencyKey)
    if (pending) return pending
    const work = this.connectOnce(request, deviceName, hash).finally(() =>
      this.connecting.delete(request.idempotencyKey)
    )
    this.connecting.set(request.idempotencyKey, work)
    return work
  }
  private async connectOnce(
    request: FleetBackupConnectRequest,
    deviceName: string,
    hash: string
  ): Promise<FleetBackupConnectResponse> {
    const { destination } = request
    if (this.store.backupSettings()) throw new GatewayError('CONFLICT', 'Disconnect the current destination first')
    this.validate(destination)
    let key: string
    if (request.mode === 'create') {
      const probe = await this.probe(destination)
      if (probe.state === 'existing') throw new GatewayError('CONFLICT', 'A backup already exists there')
      if (probe.state === 'error') return { ok: false, error: probe.error }
      key = normalizeRecoveryKey(newRecoveryKey(this.random))!
      const init = await this.helper.restic({
        destination,
        password: key,
        args: ['init'],
        timeoutMs: FLEET_BACKUP_LIMITS.quickTimeoutMs,
      })
      if (init.exitCode !== 0 || init.ending !== 'exited')
        return { ok: false, error: resticFailure(init, this.secrets({ destination, recoveryKey: key })) }
    } else {
      const normalized = normalizeRecoveryKey(request.recoveryKey)
      if (!normalized) return { ok: false, error: { code: 'wrong-key', message: WRONG_KEY } }
      key = normalized
      const opened = await this.helper.restic({
        destination,
        password: key,
        args: ['cat', 'config'],
        timeoutMs: FLEET_BACKUP_LIMITS.quickTimeoutMs,
      })
      if (opened.exitCode !== 0 || opened.ending !== 'exited')
        return { ok: false, error: resticFailure(opened, this.secrets({ destination, recoveryKey: key })) }
    }
    // Another connection may have finished while this one talked to the storage.
    if (this.store.backupSettings()) throw new GatewayError('CONFLICT', 'Disconnect the current destination first')
    this.store.saveBackupSettings({
      destination,
      recoveryKey: key,
      enabled: false,
      schedule: null,
      retention: { ...FLEET_BACKUP_RETENTION_DEFAULT },
      selection: { mode: 'all' },
      lastPruneAt: null,
      repositoryBytes: null,
      updatedAt: this.iso(),
      updatedBy: deviceName,
    })
    this.logger.info('Backup destination connected', {
      provider: destination.provider,
      mode: request.mode,
      device: deviceName,
    })
    const response: FleetBackupConnectResponse = {
      ok: true,
      status: this.status(),
      recoveryKey: request.mode === 'create' ? formatRecoveryKey(key) : null,
    }
    this.store.saveIdempotency('backupConnect', request.idempotencyKey, hash, response, 200)
    this.emitStatus()
    return response
  }

  /** Changes when and what the server backs up; the schedule of each environment follows. */
  update(patch: FleetBackupUpdateRequest): FleetBackupStatus {
    const settings = this.requireSettings()
    const next: StoredBackupSettings = {
      ...settings,
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.schedule === undefined ? {} : { schedule: patch.schedule }),
      ...(patch.retention === undefined ? {} : { retention: patch.retention }),
      ...(patch.selection === undefined ? {} : { selection: patch.selection }),
      updatedAt: this.iso(),
    }
    if (next.enabled && !next.schedule) throw new GatewayError('INVALID_REQUEST', 'Choose when to back up first')
    if (patch.selection?.mode === 'selected')
      for (const id of patch.selection.environments) {
        const environment = this.store.getEnvironment(id)
        if (!environment || environment.archivedAt) throw new GatewayError('INVALID_REQUEST', 'Unknown environment')
      }
    // An unknown time zone fails here, before anything is saved.
    if (next.schedule) nextRun(next.schedule, new Date(this.now()))
    this.store.saveBackupSettings(next)
    this.syncSchedule(patch.schedule !== undefined || patch.enabled !== undefined)
    this.emitStatus()
    return this.status()
  }
  /**
   * Gives each included environment its next backup: those without one yet, or every one when the schedule changed.
   * Environments that left the selection lose theirs.
   */
  protected syncSchedule(reset: boolean) {
    const settings = this.store.backupSettings()
    if (!settings) return
    const rows = new Map(this.store.backupEnvironments().map((row) => [row.environmentId, row.nextRunAt]))
    const included = new Set<string>()
    for (const environment of this.store.listEnvironments()) {
      const { selection } = settings
      if (selection.mode === 'selected' && !selection.environments.includes(environment.id)) continue
      included.add(environment.id)
      if (rows.has(environment.id) && !reset) continue
      if (!rows.has(environment.id) && this.lifecycle.backupSource(environment.id)?.eligibility !== 'ok') continue
      const next = settings.enabled && settings.schedule ? nextRun(settings.schedule, new Date(this.now())) : null
      this.store.setBackupNextRun(environment.id, next)
    }
    for (const id of rows.keys()) if (!included.has(id)) this.store.removeBackupEnvironment(id)
  }

  /** Forgets the destination; the backups already made stay there, and the recovery key opens them again. */
  async disconnect(): Promise<FleetBackupStatus> {
    await this.cancelAll()
    this.store.clearBackupSettings()
    this.logger.info('Backup destination disconnected')
    this.emitStatus()
    return this.status()
  }
  /** Cancels every queued and running run and waits for them to end. */
  protected async cancelAll(): Promise<void> {
    for (const item of [...this.queue]) this.cancel(item.run.id)
    const current = this.current
    if (current) {
      current.controller.abort()
      await current.done
    }
  }

  /** Runs one at a time, oldest first; `notBefore` holds one that waits for its environment. */
  private readonly queue: QueueItem[] = []
  private current: { item: QueueItem; controller: AbortController; done: Promise<void> } | null = null
  private working: Promise<void> | null = null
  private wakeTimer: NodeJS.Timeout | null = null
  private tickTimer: NodeJS.Timeout | null = null
  private ticking = false
  private stopped = false

  /** Ends what a restart of the gateway interrupted, then checks the schedule every `tickMs`. */
  async start(): Promise<void> {
    this.stopped = false
    // Helpers left running by the gateway before: what they did is lost, and they still hold their volumes.
    try {
      for (const container of await this.helper.docker.list(`${helperLabel}=${BACKUP_HELPER}`))
        await this.helper.docker.remove(container.id, true).catch(() => undefined)
    } catch (error) {
      this.logger.warn('Backup helpers not cleaned up', { failure: (error as Error).message })
    }
    for (const run of this.store.unfinishedBackupRuns()) {
      if (run.kind === 'restore' && run.volumeName && !this.store.getEnvironment(run.environmentId))
        await this.lifecycle.discardRestoreTarget(run.volumeName)
      this.finish(run, 'failed', { code: 'interrupted', message: 'The server restarted during the operation.' })
    }
    this.tickTimer = setInterval(() => void this.tick(), this.deps.tickMs ?? 60_000)
    this.tickTimer.unref?.()
    await this.tick()
  }
  stop(): void {
    this.stopped = true
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.tickTimer = null
    this.wakeTimer = null
  }
  /** Queues the environments whose backup is due, and gives each its next one. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const settings = this.store.backupSettings()
      if (!settings?.enabled || !settings.schedule) return
      this.syncSchedule(false)
      const now = this.now()
      for (const row of this.store.backupEnvironments()) {
        if (!row.nextRunAt || Date.parse(row.nextRunAt) > now) continue
        if (!this.activeRun(row.environmentId)) this.enqueue(row.environmentId, 'schedule')
        this.store.setBackupNextRun(row.environmentId, nextRun(settings.schedule, new Date(now)))
      }
    } catch (error) {
      this.logger.warn('Backup schedule not checked', { failure: (error as Error).message })
    } finally {
      this.ticking = false
      this.wake()
    }
  }
  /** Settles once no run is ready to go: the queue is empty, or what is in it waits. */
  async idle(): Promise<void> {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve))
      if (!this.working) return
      await this.working
    }
  }
  private activeRun(environmentId: string): StoredBackupRun | null {
    if (this.current?.item.run.environmentId === environmentId) return this.current.item.run
    return this.queue.find((item) => item.run.environmentId === environmentId)?.run ?? null
  }
  protected enqueue(environmentId: string, trigger: FleetBackupRun['trigger'], restore?: RestoreJob): StoredBackupRun {
    const run: StoredBackupRun = {
      id: randomUUID(),
      kind: restore ? 'restore' : 'backup',
      environmentId,
      environmentName: (
        restore?.slice.environment.name ??
        this.store.getEnvironment(environmentId)?.name ??
        environmentId
      ).slice(0, 200),
      trigger,
      state: 'queued',
      phase: 'queued',
      progress: null,
      snapshotId: restore?.snapshotId ?? null,
      bytesAdded: null,
      bytesTotal: null,
      error: null,
      startedAt: this.iso(),
      finishedAt: null,
      volumeName: null,
    }
    this.store.saveBackupRun(run)
    this.queue.push({ run, notBefore: this.now(), ...(restore ? { restore } : {}) })
    this.emitRun(run)
    // After the caller's transaction: the worker changes the run as soon as it starts.
    queueMicrotask(() => this.wake())
    return run
  }
  private wake() {
    if (this.working || this.stopped) return
    this.working = this.work().finally(() => {
      this.working = null
    })
  }
  private async work(): Promise<void> {
    for (;;) {
      if (this.stopped) return
      const now = this.now()
      const index = this.queue.findIndex((item) => item.notBefore <= now)
      if (index === -1) return this.armWake()
      const [item] = this.queue.splice(index, 1)
      const controller = new AbortController()
      const done = (item.restore ? this.runRestore(item, controller.signal) : this.runBackup(item, controller.signal))
        .catch((error: unknown) => {
          this.logger.warn('Backup run failed', { runId: item.run.id, failure: (error as Error).message })
          this.finish(item.run, 'failed', {
            code: 'failed',
            message: redact((error as Error).message ?? 'Internal error', this.currentSecrets()).slice(0, 500),
          })
        })
        .then(() => undefined)
      this.current = { item, controller, done }
      try {
        await done
      } finally {
        this.current = null
      }
    }
  }
  /** Wakes the worker when the first waiting run may go. */
  private armWake() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    if (!this.queue.length || this.stopped) return
    const next = Math.min(...this.queue.map((item) => item.notBefore))
    this.wakeTimer = setTimeout(() => this.wake(), Math.max(1000, next - this.now()))
    this.wakeTimer.unref?.()
  }
  private currentSecrets(): string[] {
    const settings = this.store.backupSettings()
    return settings ? this.secrets(settings) : []
  }
  protected emitRun(run: StoredBackupRun) {
    this.deps.emit({ type: 'backup_run.updated', at: this.iso(), run: publicRun(run) })
  }
  protected change(run: StoredBackupRun, changes: Partial<StoredBackupRun>) {
    Object.assign(run, changes)
    this.store.saveBackupRun(run)
    this.emitRun(run)
  }
  protected finish(
    run: StoredBackupRun,
    state: 'succeeded' | 'partial' | 'failed' | 'cancelled',
    error: FleetBackupError | null
  ): StoredBackupRun {
    Object.assign(run, {
      state,
      phase: 'finish',
      error,
      finishedAt: this.iso(),
      ...(state === 'succeeded' || state === 'partial' ? { progress: 1 } : {}),
    })
    this.store.saveBackupRun(run)
    this.store.pruneBackupRuns(run.environmentId, FLEET_BACKUP_LIMITS.runsKeptPerEnvironment)
    this.emitRun(run)
    this.emitStatus()
    return run
  }
  /** Updates a run's progress from restic's status lines, telling devices at most once a second. */
  protected progress(run: StoredBackupRun): (line: string) => void {
    let told = 0
    return (line) => {
      const status = resticProgress(line)
      if (!status) return
      run.progress = status.percent
      if (status.totalBytes !== null) run.bytesTotal = status.totalBytes
      const now = this.now()
      if (now - told < 1000) return
      told = now
      this.change(run, {})
    }
  }

  /** Backs up one environment now, unless it is being backed up already. */
  runNow(request: FleetBackupRunRequest): FleetBackupRun {
    this.requireSettings()
    const source = this.lifecycle.backupSource(request.environmentId)
    if (!source || source.eligibility === 'archived') throw new GatewayError('NOT_FOUND', 'Environment not found')
    if (source.eligibility !== 'ok') throw new GatewayError('CONFLICT', INELIGIBLE[source.eligibility])
    const active = this.activeRun(request.environmentId)
    if (active) return publicRun(active)
    const hash = sha256(JSON.stringify(request))
    return this.store.idempotent('backupRun', request.idempotencyKey, hash, () => ({
      response: publicRun(this.enqueue(request.environmentId, 'manual')),
      status: 201,
    })).response
  }
  /** Ends a queued or running backup or restore; one already ended stays as it ended. */
  cancel(runId: string): FleetBackupRun {
    const index = this.queue.findIndex((item) => item.run.id === runId)
    if (index !== -1) {
      const [item] = this.queue.splice(index, 1)
      return publicRun(this.finish(item.run, 'cancelled', { code: 'cancelled', message: 'Cancelled.' }))
    }
    if (this.current?.item.run.id === runId) {
      this.current.controller.abort()
      return publicRun(this.current.item.run)
    }
    const run = this.store.backupRun(runId)
    if (!run) throw new GatewayError('NOT_FOUND', 'Backup run not found')
    throw new GatewayError('CONFLICT', 'This run already ended')
  }
  runs(environmentId?: string): FleetBackupRun[] {
    return this.store.backupRuns({ ...(environmentId ? { environmentId } : {}), limit: RUNS_LISTED }).map(publicRun)
  }
  /** An archived environment is about to be deleted: its backup ends first, so its volume is free to remove. */
  async beforePurge(environmentId: string): Promise<void> {
    for (const item of this.queue.filter((queued) => queued.run.environmentId === environmentId && !queued.restore))
      this.cancel(item.run.id)
    const current = this.current
    if (current && current.item.run.environmentId === environmentId && !current.item.restore) {
      current.controller.abort()
      await current.done
    }
  }

  private async runBackup(item: QueueItem, signal: AbortSignal): Promise<void> {
    const { run } = item
    const settings = this.store.backupSettings()
    if (!settings) return void this.finish(run, 'cancelled', { code: 'cancelled', message: 'Cancelled.' })
    const source = this.lifecycle.backupSource(run.environmentId)
    if (source?.eligibility !== 'ok')
      return void this.finish(
        run,
        'failed',
        source?.eligibility === 'update-environment'
          ? { code: 'update-environment', message: INELIGIBLE['update-environment'] }
          : { code: 'environment-unavailable', message: 'The environment was not ready.' }
      )
    if (this.lifecycle.backupDeferred(run.environmentId)) {
      if (this.now() - Date.parse(run.startedAt) < FLEET_BACKUP_LIMITS.deferMaxMs) {
        this.queue.push({ ...item, notBefore: this.now() + DEFER_RETRY_MS })
        return
      }
      return void this.finish(run, 'failed', {
        code: 'busy',
        message: 'The environment stayed busy updating or changing its bots.',
      })
    }
    const { environment, running, projects } = source
    const secrets = this.secrets(settings)
    this.change(run, { state: 'running', phase: running ? 'snapshot' : 'upload' })
    let prepared: FleetInstanceBackupSnapshot | null = null
    let result: HelperResult
    try {
      if (running) {
        try {
          prepared = await this.lifecycle.prepareBackupSnapshot(run.environmentId)
        } catch {
          return void this.finish(run, 'failed', {
            code: 'environment-unavailable',
            message: 'The environment could not copy its database.',
          })
        }
        if (signal.aborted) return void this.finish(run, 'cancelled', { code: 'cancelled', message: 'Cancelled.' })
      }
      const slice = buildBackupSlice({
        store: this.store,
        environmentId: environment.id,
        server: { id: this.store.serverId(), name: this.deps.serverName() },
        gatewayVersion: this.deps.gatewayVersion,
        now: this.iso(),
        database: prepared ? { snapshot: prepared.snapshot, live: prepared.database } : null,
        projects,
      })
      this.change(run, { phase: 'upload', progress: 0 })
      result = await this.helper.restic({
        destination: settings.destination,
        password: settings.recoveryKey,
        args: backupArgs({
          host: this.store.serverId(),
          tags: snapshotTags({ environment, serverName: this.deps.serverName() }),
          paths: [BACKUP_HOME, ...(projects ? [projects] : []), BACKUP_SLICE_PATH],
          excludes: backupExcludes({ running, database: prepared && { live: prepared.database }, projects }),
        }),
        mounts: [
          { type: 'volume', source: environment.volumeName, target: BACKUP_HOME, readOnly: true },
          ...(projects ? [{ type: 'bind' as const, source: projects, target: projects, readOnly: true }] : []),
        ],
        files: [{ path: BACKUP_SLICE_ENTRY, content: JSON.stringify(slice), mode: 0o600 }],
        timeoutMs: FLEET_BACKUP_LIMITS.helperTimeoutMs,
        signal,
        onStdoutLine: this.progress(run),
      })
    } finally {
      if (prepared) await this.lifecycle.releaseBackupSnapshot(run.environmentId)
    }
    if (result.ending !== 'exited' || (result.exitCode !== 0 && result.exitCode !== 3)) {
      const failure = resticFailure(result, secrets)
      return void this.finish(run, failure.code === 'cancelled' ? 'cancelled' : 'failed', failure)
    }
    const summary = resticBackupSummary(result.stdout)
    if (!summary) return void this.finish(run, 'failed', { code: 'failed', message: 'restic reported no summary' })
    this.change(run, {
      phase: 'retention',
      progress: 1,
      snapshotId: summary.snapshotId,
      bytesAdded: summary.bytesAdded,
      bytesTotal: summary.bytesTotal,
    })
    const retention = await this.retain(settings, run.environmentId, signal)
    if (result.exitCode === 3)
      return void this.finish(run, 'partial', {
        code: 'failed',
        message: resticFailure(result, secrets).message || 'Some files could not be read.',
      })
    if (retention) return void this.finish(run, 'partial', retention)
    this.finish(run, 'succeeded', null)
  }
  /**
   * Forgets the environment's snapshots beyond the retention, prunes and checks the repository once a week, and
   * measures it. The backup itself is made by then: a failure here only makes the run partial.
   */
  private async retain(
    settings: StoredBackupSettings,
    environmentId: string,
    signal: AbortSignal
  ): Promise<FleetBackupError | null> {
    const secrets = this.secrets(settings)
    const restic = (args: string[], timeoutMs: number) =>
      this.helper.restic({ destination: settings.destination, password: settings.recoveryKey, args, timeoutMs, signal })
    const failed = (result: HelperResult) => result.exitCode !== 0 || result.ending !== 'exited'
    const forget = await restic(
      forgetArgs({ host: this.store.serverId(), environmentId, retention: settings.retention }),
      FLEET_BACKUP_LIMITS.helperTimeoutMs
    )
    if (failed(forget)) return resticFailure(forget, secrets)
    const lastPruneAt = this.store.backupSettings()?.lastPruneAt
    if (!lastPruneAt || this.now() - Date.parse(lastPruneAt) >= FLEET_BACKUP_LIMITS.pruneEveryMs) {
      const prune = await restic(['prune'], FLEET_BACKUP_LIMITS.helperTimeoutMs)
      if (failed(prune)) return resticFailure(prune, secrets)
      const check = await restic(['check'], FLEET_BACKUP_LIMITS.helperTimeoutMs)
      if (failed(check)) return resticFailure(check, secrets)
      const current = this.store.backupSettings()
      if (current) this.store.saveBackupSettings({ ...current, lastPruneAt: this.iso() })
    }
    const stats = await restic(['stats', '--json', '--mode', 'raw-data'], FLEET_BACKUP_LIMITS.quickTimeoutMs)
    const bytes = failed(stats) ? null : resticStatsBytes(stats.stdout)
    const current = this.store.backupSettings()
    if (bytes !== null && current) this.store.saveBackupSettings({ ...current, repositoryBytes: bytes })
    else if (bytes === null) this.logger.warn('Backup repository not measured', { environmentId })
    return null
  }
  /** The environments backed up at the destination, from this server and others, newest backup first. */
  async snapshots(): Promise<FleetBackupSnapshotsResponse> {
    const settings = this.requireSettings()
    const listed = await this.listSnapshots(settings, [])
    const serverId = this.store.serverId()
    const groups = new Map<string, FleetBackupSnapshotGroup>()
    for (const snapshot of listed.sort((a, b) => b.at.localeCompare(a.at))) {
      const key = snapshot.environmentId + '\u0000' + snapshot.host
      let group = groups.get(key)
      if (!group) {
        group = {
          environmentId: snapshot.environmentId,
          name: snapshot.name,
          kind: snapshot.kind,
          serverId: snapshot.host.slice(0, 200),
          serverName: snapshot.serverName,
          thisServer: snapshot.host === serverId,
          taken: !!this.store.getEnvironment(snapshot.environmentId),
          snapshots: [],
        }
        groups.set(key, group)
      }
      group.snapshots.push({ id: snapshot.id, at: snapshot.at, format: snapshot.format })
    }
    return { environments: [...groups.values()] }
  }
  private async listSnapshots(settings: StoredBackupSettings, ids: string[]): Promise<ParsedSnapshot[]> {
    const result = await this.helper.restic({
      destination: settings.destination,
      password: settings.recoveryKey,
      args: ['snapshots', '--json', '--tag', 'maestrly', ...ids],
      timeoutMs: FLEET_BACKUP_LIMITS.quickTimeoutMs,
      stdoutLimitBytes: LISTING_LIMIT_BYTES,
    })
    if (result.exitCode !== 0 || result.ending !== 'exited')
      throw backupError(resticFailure(result, this.secrets(settings)))
    return parseSnapshots(result.stdout)
  }
  /** What a snapshot would restore, as its own records say; read from the destination each time. */
  private async inspect(
    snapshotId: string
  ): Promise<{ preview: FleetBackupRestorePreview; slice: BackupSlice | null }> {
    const settings = this.requireSettings()
    const [snapshot] = await this.listSnapshots(settings, [snapshotId])
    if (snapshot?.id !== snapshotId) throw new GatewayError('NOT_FOUND', 'Backup not found')
    const newer = (): { preview: FleetBackupRestorePreview; slice: null } => ({
      preview: {
        snapshotId,
        at: snapshot.at,
        environment: { id: snapshot.environmentId, name: snapshot.name, kind: snapshot.kind },
        bots: [],
        projects: null,
        problems: ['format-newer'],
      },
      slice: null,
    })
    if (snapshot.format > FLEET_BACKUP_LIMITS.sliceFormat) return newer()
    const dumped = await this.helper.restic({
      destination: settings.destination,
      password: settings.recoveryKey,
      args: ['dump', snapshotId, BACKUP_SLICE_PATH],
      timeoutMs: FLEET_BACKUP_LIMITS.quickTimeoutMs,
      stdoutLimitBytes: LISTING_LIMIT_BYTES,
    })
    if (dumped.exitCode !== 0 || dumped.ending !== 'exited')
      throw backupError(resticFailure(dumped, this.secrets(settings)))
    const read = readBackupSlice(dumped.stdout)
    if (!read.ok) {
      if (read.problem === 'format-newer') return newer()
      throw backupError({ code: 'failed', message: 'This backup cannot be read.' })
    }
    const { slice } = read
    const { problems, takenBots, projectsPath } = this.lifecycle.restoreProblems(slice)
    const projects = slice.files.projects
      ? {
          path: slice.files.projects,
          state: projectsPath ? await this.projectsFolderState(slice.environment.id) : ('absent' as const),
        }
      : null
    return {
      preview: {
        snapshotId,
        at: snapshot.at,
        environment: { id: slice.environment.id, name: slice.environment.name, kind: slice.environment.kind },
        bots: slice.bots.map(({ bot }) => ({ id: bot.id, name: bot.name, taken: takenBots.includes(bot.id) })),
        projects,
        problems,
      },
      slice,
    }
  }
  /**
   * Whether the environment's own server folder exists and has files: restoring the projects into one with files of
   * its own needs the owner's choice to keep them. A folder that cannot be read counts as one with files.
   */
  private async projectsFolderState(environmentId: string): Promise<'absent' | 'empty' | 'not-empty'> {
    const root = this.deps.config.workspacesRoot
    if (!root) return 'absent'
    const result = await this.helper.command({
      command: ['find', '/mnt/root/' + environmentId, '-mindepth', '1', '-maxdepth', '1', '-print', '-quit'],
      mounts: [{ type: 'bind', source: root, target: '/mnt/root', readOnly: true }],
      timeoutMs: FLEET_BACKUP_LIMITS.quickTimeoutMs,
    })
    if (result.ending === 'exited' && result.exitCode !== 0 && /No such file/i.test(result.stderr)) return 'absent'
    if (result.ending === 'exited' && result.exitCode === 0 && !result.stdout.trim()) return 'empty'
    return 'not-empty'
  }
  async restorePreview(snapshotId: string): Promise<FleetBackupRestorePreview> {
    return (await this.inspect(snapshotId)).preview
  }
  /**
   * Restores a snapshot as a new environment with its ids, once nothing on this server takes them. Its projects come
   * back into the environment's own server folder unless the owner chose to keep the files already there.
   */
  restore(request: FleetBackupRestoreRequest): Promise<FleetBackupRun> {
    this.requireSettings()
    const hash = sha256(JSON.stringify(request))
    const prior = this.store.priorIdempotency<FleetBackupRun>('backupRestore', request.idempotencyKey, hash)
    if (prior) return Promise.resolve(prior.response)
    const pending = this.restoring.get(request.idempotencyKey)
    if (pending) return pending
    const work = this.queueRestore(request, hash).finally(() => this.restoring.delete(request.idempotencyKey))
    this.restoring.set(request.idempotencyKey, work)
    return work
  }
  private async queueRestore(request: FleetBackupRestoreRequest, hash: string): Promise<FleetBackupRun> {
    const { preview, slice } = await this.inspect(request.snapshotId)
    if (!slice || preview.problems.length)
      throw new GatewayError('CONFLICT', 'This backup cannot be restored here: ' + preview.problems.join(', '), {
        problems: preview.problems,
      })
    const keep = preview.projects?.state === 'not-empty'
    if (keep && !request.keepExistingProjects)
      throw new GatewayError('CONFLICT', "The environment's server folder is not empty")
    if (this.activeRun(slice.environment.id))
      throw new GatewayError('CONFLICT', 'This environment is being restored already')
    const run = publicRun(
      this.enqueue(slice.environment.id, 'manual', {
        snapshotId: request.snapshotId,
        slice,
        withProjects: !!slice.files.projects && !keep,
      })
    )
    this.store.saveIdempotency('backupRestore', request.idempotencyKey, hash, run, 202)
    return run
  }
  /**
   * Restores the snapshot into a new home volume (and the projects into the environment's own folder), puts the
   * database copy in place of the live database, then adopts the environment. On failure only the volume it created
   * goes; the server folder keeps whatever it has.
   */
  protected async runRestore(item: QueueItem, signal: AbortSignal): Promise<void> {
    const { run } = item
    const { slice, snapshotId, withProjects } = item.restore!
    const settings = this.store.backupSettings()
    if (!settings) return void this.finish(run, 'cancelled', { code: 'cancelled', message: 'Cancelled.' })
    const secrets = this.secrets(settings)
    this.change(run, { state: 'running', phase: 'download', progress: 0 })
    if (this.lifecycle.restoreProblems(slice).problems.length)
      return void this.finish(run, 'failed', {
        code: 'failed',
        message: 'This backup cannot be restored here anymore.',
      })
    let target: { volumeName: string; projects: string | null }
    try {
      target = await this.lifecycle.createRestoreTarget(slice, withProjects)
    } catch (error) {
      return void this.finish(run, 'failed', { code: 'failed', message: (error as Error).message.slice(0, 500) })
    }
    this.change(run, { volumeName: target.volumeName })
    const home = { type: 'volume' as const, source: target.volumeName, target: BACKUP_HOME, readOnly: false }
    const restic = (path: string, mounts: HelperMount[]) =>
      this.helper.restic({
        destination: settings.destination,
        password: settings.recoveryKey,
        args: restoreArgs(snapshotId, path),
        mounts,
        timeoutMs: FLEET_BACKUP_LIMITS.helperTimeoutMs,
        signal,
        onStdoutLine: this.progress(run),
      })
    try {
      const restored = await restic(BACKUP_HOME, [home])
      if (restored.exitCode !== 0 || restored.ending !== 'exited')
        throw new RestoreFailure(resticFailure(restored, secrets))
      const projects = slice.files.projects
      if (withProjects && target.projects && projects) {
        const folder = await restic(projects, [
          { type: 'bind', source: target.projects, target: projects, readOnly: false },
        ])
        if (folder.exitCode !== 0 || folder.ending !== 'exited')
          throw new RestoreFailure(resticFailure(folder, secrets))
      }
      if (slice.files.database) await this.placeDatabase(target.volumeName, slice.files.database)
      if (signal.aborted) throw new RestoreFailure({ code: 'cancelled', message: 'Cancelled.' })
      this.change(run, { phase: 'finish', progress: 1 })
      this.lifecycle.adoptRestoredEnvironment(slice)
    } catch (error) {
      await this.lifecycle.discardRestoreTarget(target.volumeName)
      const failure =
        error instanceof RestoreFailure
          ? error.failure
          : { code: 'failed' as const, message: redact((error as Error).message, secrets).slice(0, 500) }
      return void this.finish(run, failure.code === 'cancelled' ? 'cancelled' : 'failed', failure)
    }
    try {
      // A selection of environments takes the restored one in; `all` includes it already.
      const current = this.store.backupSettings()
      if (current?.selection.mode === 'selected' && !current.selection.environments.includes(slice.environment.id)) {
        this.store.saveBackupSettings({
          ...current,
          selection: { mode: 'selected', environments: [...current.selection.environments, slice.environment.id] },
        })
      }
      this.syncSchedule(false)
    } catch (error) {
      this.logger.warn('Restored environment not scheduled', {
        environmentId: slice.environment.id,
        failure: (error as Error).message,
      })
    }
    this.finish(run, 'succeeded', null)
  }
  /** Moves the database copy the backup holds over the live database, with nothing of the live one left behind. */
  private async placeDatabase(volumeName: string, database: { snapshot: string; live: string }) {
    const folder = path.posix.dirname(database.snapshot)
    if (path.posix.basename(folder) !== BACKUP_STAGING_NAME)
      throw new RestoreFailure({ code: 'failed', message: 'The backup keeps its database copy in an unknown folder.' })
    const moved = await this.helper.command({
      command: [
        'sh',
        '-c',
        'mv -f -- "$1" "$2" && rm -f -- "$2-wal" "$2-shm" && rm -rf -- "$3"',
        'sh',
        BACKUP_HOME + '/' + database.snapshot,
        BACKUP_HOME + '/' + database.live,
        BACKUP_HOME + '/' + folder,
      ],
      mounts: [{ type: 'volume', source: volumeName, target: BACKUP_HOME, readOnly: false }],
      user: '1000',
      timeoutMs: FLEET_BACKUP_LIMITS.quickTimeoutMs,
    })
    if (moved.exitCode !== 0 || moved.ending !== 'exited')
      throw new RestoreFailure({ code: 'failed', message: 'The restored database could not be put in place.' })
  }

  /** The recovery key, formatted, for the owner to keep. */
  recoveryKey(): string {
    const settings = this.store.backupSettings()
    if (!settings) throw new GatewayError('NOT_FOUND', 'No backup destination')
    return formatRecoveryKey(settings.recoveryKey)
  }
}
