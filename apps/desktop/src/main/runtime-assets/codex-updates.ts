import type {
  RuntimeAssetStatus,
  RuntimeAssetUpdateError as PublicUpdateError,
  RuntimeAssetUpdateInfo,
  RuntimeAssetUpdateState,
} from '../../shared/runtime-assets'
import { CODEX_COMPATIBILITY_REVISION } from './codex-compatibility'
import type { CodexReleaseStore } from './codex-release-store'
import { compareStableVersions } from './codex-releases'
import type { RuntimeAssetDefinition, RuntimeTargetId } from './registry'
import { RuntimeAssetUpdateError, type RuntimeAssetService, type RuntimeAssetUpdateProgress } from './service'

const ID = 'codex-runtime' as const
export const CODEX_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
export const CODEX_UPDATE_INITIAL_DELAY_MS = 60_000

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
>

export interface CodexUpdateControllerOptions {
  readonly service: ServicePort
  readonly store: CodexReleaseStore
  readonly target: RuntimeTargetId
  readonly embedded: RuntimeAssetDefinition
  readonly discover: (target: RuntimeTargetId, signal: AbortSignal) => Promise<RuntimeAssetDefinition>
  readonly validate: (
    installationPath: string,
    definition: RuntimeAssetDefinition,
    signal: AbortSignal
  ) => Promise<void>
  readonly onChanged?: () => void
  /** Background checks run only in packaged production builds; development and E2E stay manual. */
  readonly schedule?: boolean
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
 * Orchestrates Codex releases independently of Maestrly releases: manual and scheduled checks, installation of a
 * newer stable release beside the active one, validation before activation, and rollback. Default policy is
 * notify-only; automatic installation is opt-in and never applies to a component the user has not installed.
 * Operations are single-flight and publish snapshots through `onChanged`; open connections keep their leased
 * runtime, so activation never interrupts running work.
 */
export class CodexUpdateController {
  private readonly options: CodexUpdateControllerOptions
  private readonly now: () => Date
  private readonly intervalMs: number
  private operation: Operation | null = null
  private initialInstall: { controller: AbortController; promise: Promise<RuntimeAssetStatus> } | null = null
  private progress: Progress | null = null
  private lastError: PublicUpdateError | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(options: CodexUpdateControllerOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.intervalMs = options.intervalMs ?? CODEX_UPDATE_CHECK_INTERVAL_MS
  }

  private changed(): void {
    try {
      this.options.onChanged?.()
    } catch {
      // Renderer notifications never change the operation result.
    }
  }

  private log(message: string, error?: unknown): void {
    ;(this.options.log ?? ((text, cause) => console.warn(`[codex-runtime-updates] ${text}`, cause ?? '')))(
      message,
      error
    )
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
    let rejected: ReturnType<CodexReleaseStore['rejected']> = null
    try {
      automatic = store.automatic
      lastCheckedAt = store.lastCheckedAt
      candidate = store.candidate()
      rejected = store.rejected()
    } catch {
      // Unavailable metadata only hides release details; the installation status reports its own failure.
    }
    const status = await service.status(ID).catch(() => null)
    const installed = status?.state === 'ready' ? status.version : undefined
    const availableVersion = isNewer(candidate?.version, installed) ? candidate?.version : undefined
    const previous = installed ? await service.previousInstallation(ID).catch(() => null) : null
    // "Back" only: after a rollback the newer version stays installed but is offered as an explicit update.
    const rollbackVersion = previous && isNewer(installed, previous.version) ? previous.version : undefined
    const restartRequired = Boolean(
      status?.path && service.leasedInstallations(ID).some((leased) => leased.path !== status.path)
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
      const status = await this.options.service.status(ID)
      if (status.state !== 'ready' || !status.version) {
        this.lastError = 'not-installed'
        return
      }
      const latest = await this.discover(signal)
      if (!latest || !isNewer(latest.version, status.version)) return
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
        commit: (definition) => store.accept(definition, CODEX_COMPATIBILITY_REVISION),
        onProgress: (progress) => this.setProgress(this.mapProgress(progress, target?.downloadBytes)),
      })
      store.clearRejection(candidate.version)
    } catch (error) {
      const code = signal.aborted ? 'cancelled' : errorCode(error)
      this.lastError = code
      this.log(`Codex ${candidate.version} was not activated (${code})`, error)
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
      const before = await service.status(ID)
      const previous = await service.previousInstallation(ID)
      if (before.state !== 'ready' || !previous || !isNewer(before.version, previous.version)) {
        this.lastError = 'rollback-unavailable'
        return
      }
      this.setProgress({ state: 'rolling-back' })
      await service.rollback(ID)
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
      this.operation.controller.abort(new Error('Codex runtime update cancelled'))
      cancelled = true
    }
    if (this.initialInstall) {
      this.initialInstall.controller.abort(new Error('Codex runtime installation cancelled'))
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
    const current = await service.status(ID)
    if (current.state === 'ready') return current
    if (current.path) return service.install(ID, signal)

    let candidate: RuntimeAssetDefinition | null = null
    try {
      candidate = await this.options.discover(this.options.target, signal)
      store.recordCheck(candidate)
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      this.log('Release check before installation failed; installing the embedded version', error)
    }
    let rejected: ReturnType<CodexReleaseStore['rejected']> = null
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
          commit: (definition) => store.accept(definition, CODEX_COMPATIBILITY_REVISION),
        })
        this.changed()
        return installed
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        const code = errorCode(error)
        this.log(`Codex ${candidate.version} could not be installed (${code}); using the embedded version`, error)
        if (RELEASE_FAILURES.has(code)) store.reject(candidate.version, 'failed')
      }
    }
    const installed = await service.install(ID, signal)
    this.changed()
    return installed
  }

  /**
   * An accepted release validated under an older compatibility contract is revalidated locally (no download)
   * before it is trusted again; on failure the previous installation is reactivated.
   */
  async revalidateIfStale(): Promise<void> {
    const { service, store } = this.options
    const status = await service.status(ID).catch(() => null)
    if (status?.state !== 'ready' || !status.version || !status.path) return
    let release: ReturnType<CodexReleaseStore['acceptedRelease']> = null
    try {
      release = store.acceptedRelease(status.version)
    } catch {
      return
    }
    if (!release || release.compatibilityRevision >= CODEX_COMPATIBILITY_REVISION) return
    const accepted = release
    const version = status.version
    const expectedPath = status.path
    await this.run('revalidate', async (signal) => {
      this.setProgress({ state: 'validating' })
      const lease = await service.acquireLease(ID, expectedPath)
      try {
        await this.options.validate(lease.path, accepted.definition, signal)
        store.markValidated(version, CODEX_COMPATIBILITY_REVISION)
      } catch (error) {
        if (signal.aborted) throw error
        this.log(`Codex ${version} no longer passes the compatibility contract`, error)
        store.reject(version, 'failed')
        const previous = await service.previousInstallation(ID).catch(() => null)
        if (previous) await service.rollback(ID)
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
        ...(await service.pointedVersions(ID)),
        ...service.leasedInstallations(ID).map((installation) => installation.version),
      ]
      store.prune(keep)
    } catch (error) {
      this.log('Unable to prune accepted release metadata', error)
    }
  }

  /** One background cycle: only for an installed component; installs only when automatic updates are enabled. */
  async cycle(force: boolean): Promise<void> {
    if (this.disposed) return
    const { service, store } = this.options
    const status = await service.status(ID).catch(() => null)
    if (status?.state !== 'ready' || !status.version) return
    await this.revalidateIfStale()
    await this.check(force)
    await this.prune()
    let automatic = false
    let candidate: RuntimeAssetDefinition | null = null
    let rejected: ReturnType<CodexReleaseStore['rejected']> = null
    try {
      automatic = store.automatic
      candidate = store.candidate()
      rejected = store.rejected()
    } catch {
      return
    }
    if (!automatic || this.lastError || !candidate || this.disposed) return
    const current = await service.status(ID).catch(() => null)
    if (current?.state !== 'ready' || !isNewer(candidate.version, current.version)) return
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
    }, this.options.initialDelayMs ?? CODEX_UPDATE_INITIAL_DELAY_MS)
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
