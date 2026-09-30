import type {
  RuntimeAssetStatus,
  RuntimeAssetUpdateError as PublicUpdateError,
  RuntimeAssetUpdateInfo,
  RuntimeAssetUpdateState,
} from '../../shared/runtime-assets'
import { compareStableVersions, isStableRuntimeVersion } from './npm-registry'
import type { RuntimeAssetDefinition, RuntimeTargetId } from './registry'
import type { RuntimeReleaseProfile } from './release-profile'
import type { RuntimeReleaseStore } from './release-store'
import { RuntimeAssetUpdateError, type RuntimeAssetService, type RuntimeAssetUpdateProgress } from './service'

export const RUNTIME_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
export const RUNTIME_UPDATE_INITIAL_DELAY_MS = 60_000

/**
 * Failures attributable to the release itself. Only these exclude a version from automatic installation; network,
 * disk, lease, activation, and metadata failures are retried by a later cycle.
 */
const RELEASE_FAILURES = new Set<PublicUpdateError>(['integrity', 'incompatible'])

type ServicePort = Pick<
  RuntimeAssetService,
  | 'status'
  | 'install'
  | 'update'
  | 'rollback'
  | 'acquireLease'
  | 'previousInstallation'
  | 'leasedInstallations'
  | 'pointedVersions'
  | 'remove'
>

/** A runtime provided outside the service, such as the one in a bot image. */
export interface RuntimeBaseline {
  readonly version: string
}

export interface RuntimeUpdateControllerOptions {
  readonly profile: RuntimeReleaseProfile
  /** Compatibility contract a release is validated against; older accepted releases are revalidated. */
  readonly compatibilityRevision: number
  readonly service: ServicePort
  readonly store: RuntimeReleaseStore
  readonly target: RuntimeTargetId
  readonly embedded: RuntimeAssetDefinition
  readonly discover: (target: RuntimeTargetId, signal: AbortSignal) => Promise<RuntimeAssetDefinition>
  readonly validate: (
    installationPath: string,
    definition: RuntimeAssetDefinition,
    signal: AbortSignal
  ) => Promise<void>
  readonly onChanged?: () => void
  /** Whether `start()` schedules background checks; development and E2E builds stay manual. */
  readonly schedule?: boolean
  /**
   * Runtime provided outside the service (a bot image). It counts as installed and is never downgraded: releases
   * install only when newer than both it and the managed installation.
   */
  readonly baseline?: () => Promise<RuntimeBaseline | null>
  readonly initialDelayMs?: number
  readonly intervalMs?: number
  readonly now?: () => Date
  readonly log?: (message: string, error?: unknown) => void
}

type OperationKind = 'check' | 'update' | 'rollback' | 'revalidate'

interface Operation {
  readonly kind: OperationKind
  readonly controller: AbortController
  readonly promise: Promise<void>
}

interface Progress {
  readonly state: RuntimeAssetUpdateState
  readonly bytesDownloaded?: number
  readonly totalBytes?: number
}

function isNewer(candidate: string | undefined, installed: string | undefined): boolean {
  if (!candidate || !installed) return false
  return (compareStableVersions(candidate, installed) ?? 0) > 0
}

function errorCode(error: unknown): PublicUpdateError {
  return error instanceof RuntimeAssetUpdateError ? error.code : 'failed'
}

/**
 * Orchestrates the releases of one runtime independently of Maestrly releases: manual and scheduled checks,
 * installation of a newer stable release beside the active one, validation before activation, and rollback. The
 * store decides the default policy; automatic installation never applies to a component that is not installed,
 * unless a baseline provides it. Operations are single-flight and publish snapshots through `onChanged`; open
 * connections keep their leased runtime, so activation never interrupts running work.
 */
export class RuntimeUpdateController {
  private readonly options: RuntimeUpdateControllerOptions
  private readonly id: RuntimeReleaseProfile['id']
  private readonly now: () => Date
  private readonly intervalMs: number
  private operation: Operation | null = null
  private initialInstall: { controller: AbortController; promise: Promise<RuntimeAssetStatus> } | null = null
  private progress: Progress | null = null
  private lastError: PublicUpdateError | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(options: RuntimeUpdateControllerOptions) {
    this.options = options
    this.id = options.profile.id
    this.now = options.now ?? (() => new Date())
    this.intervalMs = options.intervalMs ?? RUNTIME_UPDATE_CHECK_INTERVAL_MS
  }

  private async baselineVersion(): Promise<string | null> {
    if (!this.options.baseline) return null
    try {
      const baseline = await this.options.baseline()
      return baseline && isStableRuntimeVersion(baseline.version) ? baseline.version : null
    } catch (error) {
      this.log('Unable to read the provided runtime version', error)
      return null
    }
  }

  /** The version in use: the newer of the managed installation and the baseline; null when neither exists. */
  async effectiveVersion(): Promise<string | null> {
    const status = await this.options.service.status(this.id).catch(() => null)
    const managed = status?.state === 'ready' ? (status.version ?? null) : null
    const baseline = await this.baselineVersion()
    if (!managed) return baseline
    if (!baseline) return managed
    return isNewer(baseline, managed) ? baseline : managed
  }

  /** A managed installation the baseline caught up with is never used again; it is removed once nothing leases it. */
  private async removeShadowed(): Promise<void> {
    const baseline = await this.baselineVersion()
    if (!baseline) return
    const { service } = this.options
    const status = await service.status(this.id).catch(() => null)
    if (status?.state !== 'ready' || !status.version || isNewer(status.version, baseline)) return
    if (service.leasedInstallations(this.id).length > 0) return
    try {
      await service.remove(this.id)
      this.log(`Removed ${this.options.profile.label} ${status.version}: the provided ${baseline} is not older`)
      this.changed()
    } catch (error) {
      this.log('Unable to remove a runtime the baseline replaced', error)
    }
  }

  private changed(): void {
    try {
      this.options.onChanged?.()
    } catch {
      // Renderer notifications never change the operation result.
    }
  }

  private log(message: string, error?: unknown): void {
    ;(this.options.log ?? ((text, cause) => console.warn(`[${this.id}-updates] ${text}`, cause ?? '')))(message, error)
  }

  private setProgress(progress: Progress | null): void {
    this.progress = progress
    this.changed()
  }

  /** Renderer-safe snapshot; reading it never touches the network or starts an operation. */
  async snapshot(): Promise<RuntimeAssetUpdateInfo> {
    const { service, store } = this.options
    let automatic = false
    let lastCheckedAt: string | undefined
    let candidate: RuntimeAssetDefinition | null = null
    let rejected: ReturnType<RuntimeReleaseStore['rejected']> = null
    try {
      automatic = store.automatic
      lastCheckedAt = store.lastCheckedAt
      candidate = store.candidate()
      rejected = store.rejected()
    } catch {
      // Unavailable metadata only hides release details; the installation status reports its own failure.
    }
    const status = await service.status(this.id).catch(() => null)
    const managed = status?.state === 'ready' ? status.version : undefined
    const installed = (await this.effectiveVersion()) ?? undefined
    const availableVersion = isNewer(candidate?.version, installed) ? candidate?.version : undefined
    const previous = managed ? await service.previousInstallation(this.id).catch(() => null) : null
    // "Back" only: after a rollback the newer version stays installed but is offered as an explicit update.
    const rollbackVersion = previous && isNewer(managed, previous.version) ? previous.version : undefined
    const restartRequired = Boolean(
      status?.path && service.leasedInstallations(this.id).some((leased) => leased.path !== status.path)
    )
    const state: RuntimeAssetUpdateState =
      this.progress?.state ??
      (this.lastError ? 'failed' : availableVersion ? 'available' : lastCheckedAt && installed ? 'up-to-date' : 'idle')
    return {
      state,
      automatic,
      restartRequired,
      ...(availableVersion ? { availableVersion } : {}),
      ...(lastCheckedAt ? { lastCheckedAt } : {}),
      ...(this.progress?.bytesDownloaded === undefined ? {} : { bytesDownloaded: this.progress.bytesDownloaded }),
      ...(this.progress?.totalBytes === undefined ? {} : { totalBytes: this.progress.totalBytes }),
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(rollbackVersion ? { rollbackVersion } : {}),
      ...(rejected && rejected.version === availableVersion ? { rejectedVersion: rejected.version } : {}),
    }
  }

  /**
   * Single-flight operations: the same kind joins the running one, a check during any operation reports that
   * operation's result, and other kinds run after it. Tasks record failures instead of throwing.
   */
  private run(kind: OperationKind, task: (signal: AbortSignal) => Promise<void>): Promise<RuntimeAssetUpdateInfo> {
    const running = this.operation
    if (running) {
      if (running.kind === kind || kind === 'check') return running.promise.then(() => this.snapshot())
      return running.promise.then(() => this.run(kind, task))
    }
    if (this.disposed) return this.snapshot()
    const controller = new AbortController()
    const operation: { kind: OperationKind; controller: AbortController; promise: Promise<void> } = {
      kind,
      controller,
      promise: Promise.resolve(),
    }
    operation.promise = (async () => {
      this.lastError = null
      try {
        await task(controller.signal)
      } catch (error) {
        this.lastError = controller.signal.aborted ? 'cancelled' : errorCode(error)
        this.log(`${kind} failed`, error)
      } finally {
        if (this.operation === operation) this.operation = null
        this.setProgress(null)
      }
    })()
    this.operation = operation
    const promise = operation.promise
    this.changed()
    return promise.then(() => this.snapshot())
  }

  /** Query the official stable release. `force = false` reuses a check made within the scheduling interval. */
  check(force = true): Promise<RuntimeAssetUpdateInfo> {
    let last = Number.NaN
    try {
      last = Date.parse(this.options.store.lastCheckedAt ?? '')
    } catch {
      // Unavailable metadata: query again; recording the result reports its own failure.
    }
    if (!force && Number.isFinite(last) && this.now().getTime() - last < this.intervalMs) return this.snapshot()
    return this.run('check', async (signal) => {
      await this.discover(signal)
    })
  }

  private async discover(signal: AbortSignal): Promise<RuntimeAssetDefinition | null> {
    this.setProgress({ state: 'checking' })
    try {
      const latest = await this.options.discover(this.options.target, signal)
      this.options.store.recordCheck(latest)
      return latest
    } catch (error) {
      if (signal.aborted) throw error
      this.lastError = 'check-failed'
      this.log('Release check failed', error)
      return null
    }
  }

  /**
   * Explicit update to the latest stable release, including a version previously rejected by failure or rollback.
   * The active installation is preserved when anything fails.
   */
  update(): Promise<RuntimeAssetUpdateInfo> {
    return this.run('update', async (signal) => {
      const installed = await this.effectiveVersion()
      if (!installed) {
        this.lastError = 'not-installed'
        return
      }
      const latest = await this.discover(signal)
      if (!latest || !isNewer(latest.version, installed)) return
      await this.installCandidate(latest, signal)
    })
  }

  private async installCandidate(candidate: RuntimeAssetDefinition, signal: AbortSignal): Promise<void> {
    const { service, store } = this.options
    const target = candidate.targets[this.options.target]
    this.setProgress({ state: 'downloading', bytesDownloaded: 0, totalBytes: target?.downloadBytes })
    try {
      await service.update(candidate, {
        signal,
        validate: (installationPath, definition, validationSignal) =>
          this.options.validate(installationPath, definition, validationSignal),
        commit: (definition) => store.accept(definition, this.options.compatibilityRevision),
        onProgress: (progress) => this.setProgress(this.mapProgress(progress, target?.downloadBytes)),
      })
      store.clearRejection(candidate.version)
    } catch (error) {
      const code = signal.aborted ? 'cancelled' : errorCode(error)
      this.lastError = code
      this.log(`${this.options.profile.label} ${candidate.version} was not activated (${code})`, error)
      if (RELEASE_FAILURES.has(code)) store.reject(candidate.version, 'failed')
    } finally {
      await this.prune()
    }
  }

  private mapProgress(progress: RuntimeAssetUpdateProgress, estimate: number | undefined): Progress {
    if (progress.phase !== 'downloading') return { state: progress.phase }
    return {
      state: 'downloading',
      bytesDownloaded: progress.bytesDownloaded ?? 0,
      ...(progress.totalBytes || estimate ? { totalBytes: progress.totalBytes ?? estimate } : {}),
    }
  }

  /** Reactivate the previous installed version; the version left behind is excluded from automatic updates. */
  rollback(): Promise<RuntimeAssetUpdateInfo> {
    return this.run('rollback', async () => {
      const { service, store } = this.options
      const before = await service.status(this.id)
      const previous = await service.previousInstallation(this.id)
      if (before.state !== 'ready' || !previous || !isNewer(before.version, previous.version)) {
        this.lastError = 'rollback-unavailable'
        return
      }
      this.setProgress({ state: 'rolling-back' })
      await service.rollback(this.id)
      if (before.version) store.reject(before.version, 'rollback')
      await this.prune()
    })
  }

  async setAutomatic(enabled: boolean): Promise<RuntimeAssetUpdateInfo> {
    this.options.store.setAutomatic(enabled)
    this.changed()
    if (enabled && this.options.schedule) void this.cycle(false)
    return this.snapshot()
  }

  /** Cancel the running operation or explicit first install; the active installation is never affected. */
  cancel(): boolean {
    let cancelled = false
    if (this.operation) {
      this.operation.controller.abort(new Error(`${this.options.profile.label} runtime update cancelled`))
      cancelled = true
    }
    if (this.initialInstall) {
      this.initialInstall.controller.abort(new Error(`${this.options.profile.label} runtime installation cancelled`))
      cancelled = true
    }
    return cancelled
  }

  /**
   * Explicit first installation: prefer the latest validated stable release, falling back to the embedded pin
   * when discovery, download, or validation fails. An existing (even damaged) installation is reinstalled at its
   * accepted version instead of switching releases.
   */
  installInitial(signal?: AbortSignal): Promise<RuntimeAssetStatus> {
    if (this.initialInstall) return this.initialInstall.promise
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) controller.abort(signal.reason)
    const promise = this.performInitialInstall(controller.signal).finally(() => {
      signal?.removeEventListener('abort', onAbort)
      if (this.initialInstall?.promise === promise) this.initialInstall = null
    })
    this.initialInstall = { controller, promise }
    return promise
  }

  private async performInitialInstall(signal: AbortSignal): Promise<RuntimeAssetStatus> {
    const { service, store, embedded } = this.options
    const current = await service.status(this.id)
    if (current.state === 'ready') return current
    if (current.path) return service.install(this.id, signal)

    let candidate: RuntimeAssetDefinition | null = null
    try {
      candidate = await this.options.discover(this.options.target, signal)
      store.recordCheck(candidate)
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      this.log('Release check before installation failed; installing the embedded version', error)
    }
    let rejected: ReturnType<RuntimeReleaseStore['rejected']> = null
    try {
      rejected = store.rejected()
    } catch {
      candidate = null
    }
    if (candidate && isNewer(candidate.version, embedded.version) && rejected?.version !== candidate.version) {
      try {
        const installed = await service.update(candidate, {
          signal,
          validate: (installationPath, definition, validationSignal) =>
            this.options.validate(installationPath, definition, validationSignal),
          commit: (definition) => store.accept(definition, this.options.compatibilityRevision),
        })
        this.changed()
        return installed
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        const code = errorCode(error)
        this.log(
          `${this.options.profile.label} ${candidate.version} could not be installed (${code}); using the embedded version`,
          error
        )
        if (RELEASE_FAILURES.has(code)) store.reject(candidate.version, 'failed')
      }
    }
    const installed = await service.install(this.id, signal)
    this.changed()
    return installed
  }

  /**
   * An accepted release validated under an older compatibility contract is revalidated locally (no download)
   * before it is trusted again; on failure the previous installation is reactivated.
   */
  async revalidateIfStale(): Promise<void> {
    const { service, store } = this.options
    const status = await service.status(this.id).catch(() => null)
    if (status?.state !== 'ready' || !status.version || !status.path) return
    let release: ReturnType<RuntimeReleaseStore['acceptedRelease']> = null
    try {
      release = store.acceptedRelease(status.version)
    } catch {
      return
    }
    if (!release || release.compatibilityRevision >= this.options.compatibilityRevision) return
    const accepted = release
    const version = status.version
    const expectedPath = status.path
    await this.run('revalidate', async (signal) => {
      this.setProgress({ state: 'validating' })
      const lease = await service.acquireLease(this.id, expectedPath)
      try {
        await this.options.validate(lease.path, accepted.definition, signal)
        store.markValidated(version, this.options.compatibilityRevision)
      } catch (error) {
        if (signal.aborted) throw error
        this.log(`${this.options.profile.label} ${version} no longer passes the compatibility contract`, error)
        store.reject(version, 'failed')
        const previous = await service.previousInstallation(this.id).catch(() => null)
        if (previous) await service.rollback(this.id)
        else this.lastError = 'incompatible'
      } finally {
        lease.release()
      }
    })
  }

  /** Drop accepted metadata that no installation, pointer, or open connection still needs. */
  async prune(): Promise<void> {
    const { service, store } = this.options
    try {
      const keep = [
        ...(await service.pointedVersions(this.id)),
        ...service.leasedInstallations(this.id).map((installation) => installation.version),
      ]
      store.prune(keep)
    } catch (error) {
      this.log('Unable to prune accepted release metadata', error)
    }
  }

  /**
   * One background cycle: only for an installed (or provided) component; installs only when automatic updates are
   * enabled.
   */
  async cycle(force: boolean): Promise<void> {
    if (this.disposed) return
    const { store } = this.options
    if (!(await this.effectiveVersion())) return
    await this.removeShadowed()
    await this.revalidateIfStale()
    await this.check(force)
    await this.prune()
    let automatic = false
    let candidate: RuntimeAssetDefinition | null = null
    let rejected: ReturnType<RuntimeReleaseStore['rejected']> = null
    try {
      automatic = store.automatic
      candidate = store.candidate()
      rejected = store.rejected()
    } catch {
      return
    }
    if (!automatic || this.lastError || !candidate || this.disposed) return
    const current = await this.effectiveVersion()
    if (!current || !isNewer(candidate.version, current)) return
    if (rejected?.version === candidate.version) return
    await this.update()
  }

  start(): void {
    if (!this.options.schedule || this.disposed || this.startupTimer || this.intervalTimer) return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      void this.cycle(false)
      this.intervalTimer = setInterval(() => void this.cycle(true), this.intervalMs)
      this.intervalTimer.unref?.()
    }, this.options.initialDelayMs ?? RUNTIME_UPDATE_INITIAL_DELAY_MS)
    this.startupTimer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.startupTimer = null
    this.intervalTimer = null
    this.cancel()
  }
}
