import { randomBytes } from 'node:crypto'
import {
  FLEET_BACKUP_LIMITS,
  FLEET_BACKUP_RETENTION_DEFAULT,
  type FleetBackupConnectRequest,
  type FleetBackupConnectResponse,
  type FleetBackupDestination,
  type FleetBackupDestinationView,
  type FleetBackupEnvironmentStatus,
  type FleetBackupProbeResponse,
  type FleetBackupRun,
  type FleetBackupStatus,
  type FleetBackupUpdateRequest,
  type FleetGatewayEvent,
  fleetBackupDestinationLabel,
} from '@maestrly/bot-fleet-protocol'
import { sha256 } from '../auth.js'
import type { GatewayConfig } from '../config.js'
import { GatewayError } from '../errors.js'
import type { Lifecycle } from '../lifecycle.js'
import { Logger } from '../logger.js'
import { nextRun } from '../routines.js'
import type { Store, StoredBackupRun, StoredBackupSettings } from '../store.js'
import type { BackupHelper } from './helper.js'
import { formatRecoveryKey, newRecoveryKey, normalizeRecoveryKey, resticFailure } from './restic.js'

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

/** A Google service account key as the app pasted it: its account, and the key that must never show. */
function serviceAccount(json: string): { clientEmail: string; privateKey: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new GatewayError('INVALID_REQUEST', 'Not a service account key')
  }
  const key = parsed as Record<string, unknown> | null
  if (
    !key ||
    key.type !== 'service_account' ||
    typeof key.client_email !== 'string' ||
    typeof key.private_key !== 'string'
  )
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
  protected async cancelAll(): Promise<void> {}

  /** The recovery key, formatted, for the owner to keep. */
  recoveryKey(): string {
    const settings = this.store.backupSettings()
    if (!settings) throw new GatewayError('NOT_FOUND', 'No backup destination')
    return formatRecoveryKey(settings.recoveryKey)
  }
}
