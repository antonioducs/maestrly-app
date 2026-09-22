import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeAssetId, RuntimeAssetLease, RuntimeAssetStatus } from '../../shared/runtime-assets'
import { extractArchive, type ExtractOptions } from './archive'
import { createHttpsDownloader, type RuntimeDownloader } from './downloader'
import {
  RUNTIME_ASSET_REGISTRY,
  hostRuntimeTarget,
  type ArchiveFormat,
  type RuntimeAssetDefinition,
  type RuntimeAssetTarget,
  type RuntimeTargetId,
} from './registry'

interface MarkerFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
}
interface InstallMarker {
  readonly schema: 1
  readonly id: RuntimeAssetId
  readonly version: string
  readonly target: RuntimeTargetId
  readonly archiveHash: RuntimeAssetTarget['hash']
  readonly criticalPaths: readonly string[]
  readonly files: readonly MarkerFile[]
  readonly installedAt: string
}
interface Pointer {
  readonly directory: string
}
interface VerifiedGeneration {
  readonly path: string
  readonly marker: InstallMarker
}
interface StatusInspection {
  readonly status: RuntimeAssetStatus
  readonly promotion?: {
    readonly current: Pointer
    readonly previous: Pointer
    readonly generation: VerifiedGeneration
  }
}

interface InstallFlight {
  readonly controller: AbortController
  readonly promise: Promise<RuntimeAssetStatus>
  consumers: number
  settled: boolean
}

export interface RuntimeAssetServiceDependencies {
  readonly downloader?: RuntimeDownloader
  readonly extract?: (
    archive: string,
    destination: string,
    format: ArchiveFormat,
    options: ExtractOptions
  ) => Promise<void>
  /** Full verification manifest provider; production uses the recursive archive verifier. */
  readonly fullManifestFiles?: (root: string) => Promise<
    readonly {
      readonly path: string
      readonly size: number
      readonly sha256: string
    }[]
  >
  readonly availableBytes?: (directory: string) => Promise<number>
  readonly registry?: Readonly<Record<RuntimeAssetId, RuntimeAssetDefinition>>
  /**
   * Accepted non-embedded definition for an exact version (independently updated runtimes). The embedded registry
   * always wins for its own version; `null` rejects the installation. Throwing means the metadata is temporarily
   * unavailable: status then fails without promoting, replacing, or removing any installation.
   */
  readonly acceptedDefinition?: (id: RuntimeAssetId, version: string) => RuntimeAssetDefinition | null
  readonly target?: RuntimeTargetId
  readonly now?: () => Date
  /** Receives status changes from explicit install/repair/remove operations. */
  readonly onStatusChanged?: (status: RuntimeAssetStatus) => void
}

export type RuntimeAssetUpdatePhase = 'downloading' | 'verifying' | 'installing' | 'validating'

export interface RuntimeAssetUpdateProgress {
  readonly phase: RuntimeAssetUpdatePhase
  readonly bytesDownloaded?: number
  readonly totalBytes?: number
}

export interface RuntimeAssetUpdateOptions {
  readonly signal?: AbortSignal
  /** Runs against the staged installation before activation; a rejection leaves the active version untouched. */
  readonly validate?: (
    installationPath: string,
    definition: RuntimeAssetDefinition,
    signal: AbortSignal
  ) => Promise<void>
  /** Persists the metadata needed to recognize the version offline; runs before the active pointer moves. */
  readonly commit?: (definition: RuntimeAssetDefinition) => void | Promise<void>
  readonly onProgress?: (progress: RuntimeAssetUpdateProgress) => void
}

export type RuntimeAssetUpdateErrorCode =
  | 'download-failed'
  | 'integrity'
  | 'disk-space'
  | 'incompatible'
  | 'in-use'
  | 'cancelled'
  | 'rollback-unavailable'
  | 'failed'

/** Typed update failure: the active installation is always preserved when one of these is thrown. */
export class RuntimeAssetUpdateError extends Error {
  constructor(
    readonly code: RuntimeAssetUpdateErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RuntimeAssetUpdateError'
  }
}

export interface RuntimeAssetInstallation {
  readonly version: string
  readonly path: string
}

export interface RuntimeAssetServiceOptions extends RuntimeAssetServiceDependencies {
  readonly userDataPath: string
}

const MARKER = '.runtime-asset.json'
const CURRENT = 'current.json'
const PREVIOUS = 'previous.json'
export const RUNTIME_ASSET_DISK_SAFETY_MARGIN_BYTES = 32 * 1024 * 1024

export function requiredRuntimeAssetDiskBytes(target: RuntimeAssetTarget): number {
  return target.maxDownloadBytes + target.unpackedBytes + RUNTIME_ASSET_DISK_SAFETY_MARGIN_BYTES
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class RuntimeAssetInUseError extends Error {
  constructor(id: RuntimeAssetId) {
    super(`Cannot replace ${id} while its installation is leased`)
    this.name = 'RuntimeAssetInUseError'
  }
}

async function defaultAvailableBytes(directory: string): Promise<number> {
  const stats = await statfs(directory)
  return Number(stats.bavail) * Number(stats.bsize)
}

async function hashFile(file: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk)
    size += chunk.length
  }
  return { size, sha256: hash.digest('hex') }
}

async function manifestFiles(root: string, relative = ''): Promise<MarkerFile[]> {
  const result: MarkerFile[] = []
  const entries = await readdir(path.join(root, relative), { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    const absolute = path.join(root, ...rel.split('/'))
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`Extracted archive contains a symbolic link: ${rel}`)
    if (info.isDirectory()) result.push(...(await manifestFiles(root, rel)))
    else if (info.isFile()) result.push({ path: rel, ...(await hashFile(absolute)) })
    else throw new Error(`Extracted archive contains a special entry: ${rel}`)
  }
  return result
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

function isSafeRelativePath(relative: string): boolean {
  return (
    relative.length > 0 &&
    !relative.includes('\0') &&
    !relative.startsWith('/') &&
    !relative.includes('\\') &&
    relative.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  )
}

export class RuntimeAssetService {
  readonly root: string
  private readonly downloader: RuntimeDownloader
  private readonly extract: NonNullable<RuntimeAssetServiceDependencies['extract']>
  private readonly fullManifestFiles: NonNullable<RuntimeAssetServiceDependencies['fullManifestFiles']>
  private readonly availableBytes: NonNullable<RuntimeAssetServiceDependencies['availableBytes']>
  private readonly registry: Readonly<Record<RuntimeAssetId, RuntimeAssetDefinition>>
  private readonly acceptedDefinition?: RuntimeAssetServiceDependencies['acceptedDefinition']
  private readonly target: RuntimeTargetId
  private readonly now: () => Date
  private readonly onStatusChanged?: (status: RuntimeAssetStatus) => void
  private readonly flights = new Map<RuntimeAssetId, InstallFlight>()
  private readonly volatile = new Map<RuntimeAssetId, RuntimeAssetStatus>()
  private readonly assetMutations = new Map<RuntimeAssetId, Promise<void>>()
  /** Serializes updates/rollbacks per asset; only their final pointer swap takes the asset mutation lock. */
  private readonly updateLocks = new Map<RuntimeAssetId, Promise<void>>()
  /** Full verification is shared by concurrent leases and retained only while that lease session is active. */
  private readonly fullVerifications = new Map<string, Promise<VerifiedGeneration | string>>()
  private readonly leases = new Map<string, number>()

  constructor(options: RuntimeAssetServiceOptions) {
    this.root = path.join(options.userDataPath, 'runtime-assets')
    this.downloader = options.downloader ?? createHttpsDownloader()
    this.extract = options.extract ?? extractArchive
    this.fullManifestFiles = options.fullManifestFiles ?? manifestFiles
    this.availableBytes = options.availableBytes ?? defaultAvailableBytes
    this.registry = options.registry ?? RUNTIME_ASSET_REGISTRY
    this.acceptedDefinition = options.acceptedDefinition
    this.target = options.target ?? hostRuntimeTarget()
    this.now = options.now ?? (() => new Date())
    this.onStatusChanged = options.onStatusChanged
  }

  private assetRoot(id: RuntimeAssetId) {
    return path.join(this.root, id)
  }
  private versionsRoot(id: RuntimeAssetId) {
    return path.join(this.assetRoot(id), 'versions')
  }
  private set(status: RuntimeAssetStatus, notify = false) {
    this.volatile.set(status.id, status)
    if (notify) {
      try {
        this.onStatusChanged?.(status)
      } catch {
        // A renderer notification must never change the installation result.
      }
    }
    return status
  }

  private verificationKey(id: RuntimeAssetId, directory: string): string {
    return `${id}\0${directory}`
  }

  private invalidateFullVerifications(id: RuntimeAssetId): void {
    const prefix = `${id}\0`
    for (const key of this.fullVerifications.keys()) {
      if (key.startsWith(prefix)) this.fullVerifications.delete(key)
    }
  }

  private withAssetMutation<T>(id: RuntimeAssetId, operation: () => Promise<T>): Promise<T> {
    return this.serialize(this.assetMutations, id, operation)
  }

  private withUpdateLock<T>(id: RuntimeAssetId, operation: () => Promise<T>): Promise<T> {
    return this.serialize(this.updateLocks, id, operation)
  }

  private async serialize<T>(
    locks: Map<RuntimeAssetId, Promise<void>>,
    id: RuntimeAssetId,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    locks.set(id, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (locks.get(id) === current) locks.delete(id)
    }
  }

  /** Embedded registry for its own version, otherwise the accepted dynamic definition (may throw if unavailable). */
  definitionFor(id: RuntimeAssetId, version: string): RuntimeAssetDefinition | null {
    const embedded = this.registry[id]
    if (embedded.version === version) return embedded
    return this.acceptedDefinition?.(id, version) ?? null
  }

  private versionFromDirectory(directory: string): string | null {
    const suffix = `-${this.target}`
    return directory.endsWith(suffix) && directory.length > suffix.length ? directory.slice(0, -suffix.length) : null
  }

  private async readGenerationMarker(id: RuntimeAssetId, directory: string): Promise<InstallMarker | string> {
    const installed = path.join(this.versionsRoot(id), directory)
    const marker = await readJson<InstallMarker>(path.join(installed, MARKER))
    if (marker?.schema !== 1 || marker.id !== id || marker.target !== this.target) {
      return 'Missing or invalid installation marker'
    }
    if (
      typeof marker.version !== 'string' ||
      !Array.isArray(marker.criticalPaths) ||
      marker.criticalPaths.some((relative) => typeof relative !== 'string' || !isSafeRelativePath(relative)) ||
      !Array.isArray(marker.files) ||
      marker.files.some(
        (file) =>
          !file ||
          typeof file.path !== 'string' ||
          !isSafeRelativePath(file.path) ||
          !Number.isSafeInteger(file.size) ||
          file.size < 0 ||
          typeof file.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(file.sha256)
      )
    ) {
      return 'Missing or invalid installation marker'
    }
    return marker
  }

  /** Passive probe: marker/layout metadata plus metadata for critical files only. */
  private async verifyGenerationQuick(id: RuntimeAssetId, directory: string): Promise<VerifiedGeneration | string> {
    const installed = path.join(this.versionsRoot(id), directory)
    const marker = await this.readGenerationMarker(id, directory)
    if (typeof marker === 'string') return marker

    try {
      for (const relative of marker.criticalPaths) {
        const expected = marker.files.find((file) => file.path === relative)
        if (!expected) return `Missing critical file: ${relative}`
        const filePath = path.join(installed, ...relative.split('/'))
        const info = await lstat(filePath)
        if (!info.isFile()) return `Critical path is not a regular file: ${relative}`
        if (info.size !== expected.size) return `Critical file size verification failed: ${relative}`
      }
      return { path: installed, marker }
    } catch (error) {
      return message(error)
    }
  }

  /** Active-use probe: the complete manifest/hash comparison. */
  private async verifyGenerationFull(
    id: RuntimeAssetId,
    directory: string,
    options: { readonly cache: boolean }
  ): Promise<VerifiedGeneration | string> {
    const key = this.verificationKey(id, directory)
    const installed = path.join(this.versionsRoot(id), directory)
    const leased = this.leases.has(installed)
    if (!leased) this.fullVerifications.delete(key)
    const existing = this.fullVerifications.get(key)
    if (existing) return existing

    const verification = (async (): Promise<VerifiedGeneration | string> => {
      const marker = await this.readGenerationMarker(id, directory)
      if (typeof marker === 'string') return marker
      try {
        const actualFiles = (await this.fullManifestFiles(installed)).filter((file) => file.path !== MARKER)
        if (JSON.stringify(actualFiles) !== JSON.stringify(marker.files))
          throw new Error('Installed layout or file verification failed')
        return { path: installed, marker }
      } catch (error) {
        return message(error)
      }
    })()
    if (options.cache && this.leases.has(installed)) this.fullVerifications.set(key, verification)
    return verification
  }

  /**
   * Compare an installation with the accepted definition of ITS OWN version, so a newer accepted release does not
   * invalidate the installation that is still active. Metadata unavailability propagates instead of being reported
   * as a mismatch that would trigger promotion or reinstallation.
   */
  private registryMismatch(id: RuntimeAssetId, marker: InstallMarker): string | null {
    const definition = this.definitionFor(id, marker.version)
    try {
      const target = definition?.targets[this.target]
      if (
        !definition ||
        !target ||
        marker.version !== definition.version ||
        JSON.stringify(marker.archiveHash) !== JSON.stringify(target.hash)
      ) {
        return 'Installation marker does not match the pinned registry entry'
      }
      const critical = new Set(marker.criticalPaths)
      if (
        marker.criticalPaths.length !== target.criticalPaths.length ||
        target.criticalPaths.some((item) => !critical.has(item))
      ) {
        return 'Installation marker has an incomplete layout'
      }
      for (const relative of target.criticalPaths) {
        if (!marker.files.some((file) => file.path === relative)) return `Missing critical file: ${relative}`
      }
      return null
    } catch {
      return 'Missing or invalid installation marker'
    }
  }

  private async promotePrevious(id: RuntimeAssetId, current: Pointer, previous: Pointer): Promise<void> {
    await this.writePointer(id, CURRENT, previous)
    try {
      await this.writePointer(id, PREVIOUS, current)
    } catch (error) {
      await this.writePointer(id, CURRENT, current).catch(() => undefined)
      throw error
    }
  }

  private async inspectStatus(id: RuntimeAssetId): Promise<StatusInspection> {
    const active = this.volatile.get(id)
    if (
      active &&
      active.state !== 'ready' &&
      ['downloading', 'verifying', 'installing', 'removing', 'failed', 'corrupt'].includes(active.state)
    ) {
      return { status: active }
    }
    const pointer = await readJson<Pointer>(path.join(this.assetRoot(id), CURRENT))
    if (!pointer || !/^[A-Za-z0-9._-]+$/.test(pointer.directory)) return { status: { id, state: 'not-installed' } }
    const current = await this.verifyGenerationQuick(id, pointer.directory)
    const currentPath = path.join(this.versionsRoot(id), pointer.directory)
    const mismatch = typeof current === 'string' ? null : this.registryMismatch(id, current.marker)
    if (typeof current !== 'string' && !mismatch) {
      return {
        status: this.set({
          id,
          state: 'ready',
          version: current.marker.version,
          target: current.marker.target,
          path: current.path,
        }),
      }
    }

    const previous = await readJson<Pointer>(path.join(this.assetRoot(id), PREVIOUS))
    if (previous && /^[A-Za-z0-9._-]+$/.test(previous.directory) && previous.directory !== pointer.directory) {
      const previousGeneration = await this.verifyGenerationQuick(id, previous.directory)
      if (typeof previousGeneration !== 'string') {
        const previousMismatch = this.registryMismatch(id, previousGeneration.marker)
        if (!previousMismatch) {
          return {
            status: {
              id,
              state: 'corrupt',
              ...(typeof current === 'string'
                ? {}
                : { version: current.marker.version, target: current.marker.target }),
              path: currentPath,
              error:
                typeof current === 'string' ? current : (mismatch ?? 'Installed layout or file verification failed'),
            },
            promotion: { current: pointer, previous, generation: previousGeneration },
          }
        }
      }
    }

    return {
      status: this.set({
        id,
        state: 'corrupt',
        ...(typeof current === 'string' ? {} : { version: current.marker.version, target: current.marker.target }),
        path: currentPath,
        error: typeof current === 'string' ? current : (mismatch ?? 'Installed layout or file verification failed'),
      }),
    }
  }

  private async statusWithinAssetMutation(id: RuntimeAssetId): Promise<RuntimeAssetStatus> {
    const inspection = await this.inspectStatus(id)
    if (!inspection.promotion) return inspection.status

    const { current, previous, generation } = inspection.promotion
    try {
      await this.promotePrevious(id, current, previous)
    } catch (error) {
      return this.set({
        id,
        state: 'corrupt',
        ...(inspection.status.version && inspection.status.target
          ? { version: inspection.status.version, target: inspection.status.target }
          : {}),
        path: inspection.status.path,
        error: `Unable to promote previous installation: ${message(error)}`,
      })
    }
    return this.set({
      id,
      state: 'ready',
      version: generation.marker.version,
      target: generation.marker.target,
      path: generation.path,
    })
  }

  async status(id: RuntimeAssetId): Promise<RuntimeAssetStatus> {
    const inspection = await this.inspectStatus(id)
    if (!inspection.promotion) return inspection.status
    return this.withAssetMutation(id, () => this.statusWithinAssetMutation(id))
  }

  async list(): Promise<readonly RuntimeAssetStatus[]> {
    return Promise.all((Object.keys(this.registry) as RuntimeAssetId[]).map((id) => this.status(id)))
  }

  install(id: RuntimeAssetId, signal?: AbortSignal): Promise<RuntimeAssetStatus> {
    return this.startInstall(id, false, signal)
  }

  private startInstall(id: RuntimeAssetId, force: boolean, signal?: AbortSignal): Promise<RuntimeAssetStatus> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Runtime asset installation cancelled'))

    let flight = this.flights.get(id)
    if (flight?.controller.signal.aborted) {
      const retry = flight.promise.then(
        () => this.startInstall(id, force, signal),
        () => this.startInstall(id, force, signal)
      )
      return this.waitForAbortable(retry, signal)
    }
    if (!flight) {
      const controller = new AbortController()
      const promise = this.performInstall(id, controller.signal, force).finally(() => {
        const current = this.flights.get(id)
        if (current?.promise === promise) {
          current.settled = true
          this.flights.delete(id)
        }
      })
      flight = { controller, promise, consumers: 0, settled: false }
      this.flights.set(id, flight)
    }

    return this.waitForInstall(flight, signal)
  }

  cancel(id: RuntimeAssetId): boolean {
    const flight = this.flights.get(id)
    if (!flight) return false
    flight.controller.abort(new Error('Runtime asset installation cancelled'))
    return true
  }

  async repair(id: RuntimeAssetId, signal?: AbortSignal): Promise<RuntimeAssetStatus> {
    const current = await this.status(id)
    if (current.path && this.leases.has(current.path)) {
      throw new Error(`Cannot repair ${id} while its installation is leased`)
    }
    return this.startInstall(id, true, signal)
  }

  private waitForAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise

    let onAbort: (() => void) | undefined
    const aborted = new Promise<T>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('Runtime asset installation cancelled'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const result = Promise.race([promise, aborted])
    return result.finally(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    })
  }

  private waitForInstall(flight: InstallFlight, signal?: AbortSignal): Promise<RuntimeAssetStatus> {
    flight.consumers += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      flight.consumers = Math.max(0, flight.consumers - 1)
      if (flight.consumers === 0 && !flight.settled) {
        flight.controller.abort(new Error('Runtime asset installation has no active consumers'))
      }
    }

    return this.waitForAbortable(flight.promise, signal).finally(release)
  }

  /**
   * Install/repair reinstalls the accepted version of the active pointer, so repairing an independently updated
   * runtime never silently downgrades it to the embedded pin. Without an accepted active version, use the pin.
   */
  private async installDefinition(id: RuntimeAssetId): Promise<RuntimeAssetDefinition> {
    const pointer = await readJson<Pointer>(path.join(this.assetRoot(id), CURRENT))
    if (pointer && /^[A-Za-z0-9._-]+$/.test(pointer.directory)) {
      const marker = await this.readGenerationMarker(id, pointer.directory)
      const version = typeof marker === 'string' ? this.versionFromDirectory(pointer.directory) : marker.version
      const definition = version ? this.definitionFor(id, version) : null
      if (definition?.targets[this.target]) return definition
    }
    return this.registry[id]
  }

  private async performInstall(id: RuntimeAssetId, signal: AbortSignal, force: boolean): Promise<RuntimeAssetStatus> {
    return this.withAssetMutation(id, async () => {
      const current = await this.statusWithinAssetMutation(id)
      const definition = await this.installDefinition(id)
      const target = definition.targets[this.target]
      if (!target)
        return this.set({ id, state: 'failed', error: `No ${this.target} target is configured for ${id}` }, true)
      if (!force && current.state === 'ready' && current.path) {
        const verified = await this.verifyGenerationFull(id, path.basename(current.path), { cache: false })
        if (typeof verified !== 'string' && !this.registryMismatch(id, verified.marker)) return this.set(current, true)
      }
      const directory = `${definition.version}-${this.target}`
      const destination = path.join(this.versionsRoot(id), directory)
      if (this.leases.has(destination)) throw new RuntimeAssetInUseError(id)
      this.volatile.delete(id)
      this.invalidateFullVerifications(id)
      await mkdir(this.versionsRoot(id), { recursive: true, mode: 0o700 })
      const available = await this.availableBytes(this.root)
      const required = requiredRuntimeAssetDiskBytes(target)
      if (available < required) {
        return this.set(
          {
            id,
            state: 'failed',
            error: `Insufficient disk space (need ${required} bytes, have ${available})`,
          },
          true
        )
      }
      const operation = `.tmp-${id}-${randomUUID()}`
      const temporary = path.join(this.root, operation)
      const archive = path.join(temporary, `download.${target.archive === 'zip' ? 'zip' : 'tgz'}`)
      const staging = path.join(temporary, 'staging')
      try {
        await mkdir(temporary, { recursive: true, mode: 0o700 })
        this.set(
          { id, state: 'downloading', version: definition.version, target: this.target, bytesDownloaded: 0 },
          true
        )
        const downloaded = await this.downloader(target, archive, {
          signal,
          onProgress: (bytesDownloaded, totalBytes) =>
            this.set(
              {
                id,
                state: 'downloading',
                version: definition.version,
                target: this.target,
                bytesDownloaded,
                totalBytes,
              },
              true
            ),
        })
        this.set(
          {
            id,
            state: 'verifying',
            version: definition.version,
            target: this.target,
            bytesDownloaded: downloaded.bytes,
          },
          true
        )
        if (downloaded.digest !== target.hash.digest)
          throw new Error(`Archive hash mismatch (expected ${target.hash.digest}, got ${downloaded.digest})`)
        this.set({ id, state: 'installing', version: definition.version, target: this.target }, true)
        await this.extract(archive, staging, target.archive, { stripPrefix: target.stripPrefix, signal })
        const files = await manifestFiles(staging)
        for (const critical of target.criticalPaths) {
          if (!files.some((file) => file.path === critical))
            throw new Error(`Archive is missing critical file: ${critical}`)
        }
        const marker: InstallMarker = {
          schema: 1,
          id,
          version: definition.version,
          target: this.target,
          archiveHash: target.hash,
          criticalPaths: target.criticalPaths,
          files,
          installedAt: this.now().toISOString(),
        }
        await writeFile(path.join(staging, MARKER), `${JSON.stringify(marker, null, 2)}\n`, {
          flag: 'wx',
          mode: 0o600,
        })
        const backup = path.join(temporary, 'replaced')
        let replaced = false
        try {
          if (this.leases.has(destination)) throw new RuntimeAssetInUseError(id)
          await rename(destination, backup)
          replaced = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        try {
          await rename(staging, destination)
        } catch (error) {
          if (replaced) await rename(backup, destination)
          throw error
        }
        const oldPointer = await readJson<Pointer>(path.join(this.assetRoot(id), CURRENT))
        if (oldPointer && oldPointer.directory !== directory) await this.writePointer(id, PREVIOUS, oldPointer)
        await this.writePointer(id, CURRENT, { directory })
        await rm(backup, { recursive: true, force: true })
        await this.garbageCollect(id)
        this.volatile.delete(id)
        return this.set(await this.statusWithinAssetMutation(id), true)
      } catch (error) {
        if (error instanceof RuntimeAssetInUseError) throw error
        const failed = this.set(
          {
            id,
            state: 'failed',
            version: definition.version,
            target: this.target,
            error: message(error),
          },
          true
        )
        return failed
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    })
  }

  /**
   * Install `definition` beside the active version and activate it only after download, hash, layout, and the
   * caller's validation succeed. Staging runs without the asset mutation lock, so leases on the active version
   * stay available during the download; only the rename and pointer swap are serialized. Any failure throws a
   * `RuntimeAssetUpdateError` and leaves the active installation untouched. Without a ready installation (first
   * install), progress and failure are also published through `status` like `install`.
   */
  update(definition: RuntimeAssetDefinition, options: RuntimeAssetUpdateOptions = {}): Promise<RuntimeAssetStatus> {
    return this.withUpdateLock(definition.id, () => this.performUpdate(definition, options))
  }

  private async performUpdate(
    definition: RuntimeAssetDefinition,
    options: RuntimeAssetUpdateOptions
  ): Promise<RuntimeAssetStatus> {
    const id = definition.id
    const signal = options.signal ?? new AbortController().signal
    const target = definition.targets[this.target]
    if (!target) throw new RuntimeAssetUpdateError('failed', `No ${this.target} target is configured for ${id}`)
    if (!/^[A-Za-z0-9.]+(?:-[A-Za-z0-9.]+)*$/.test(definition.version)) {
      throw new RuntimeAssetUpdateError('failed', `Invalid runtime version: ${definition.version}`)
    }
    if (signal.aborted) throw new RuntimeAssetUpdateError('cancelled', 'Runtime asset update cancelled')
    const directory = `${definition.version}-${this.target}`
    const destination = path.join(this.versionsRoot(id), directory)
    const before = await this.status(id)
    if (before.state === 'ready' && before.path === destination) return before
    const reportStatus = before.state !== 'ready'
    const report = (phase: RuntimeAssetUpdatePhase, bytesDownloaded?: number, totalBytes?: number): void => {
      options.onProgress?.({
        phase,
        ...(bytesDownloaded === undefined ? {} : { bytesDownloaded }),
        ...(totalBytes === undefined ? {} : { totalBytes }),
      })
      if (reportStatus) {
        const state = phase === 'validating' ? 'installing' : phase
        this.set(
          {
            id,
            state,
            version: definition.version,
            target: this.target,
            ...(bytesDownloaded === undefined ? {} : { bytesDownloaded }),
            ...(totalBytes === undefined ? {} : { totalBytes }),
          },
          true
        )
      }
    }
    if (this.leases.has(destination)) {
      throw new RuntimeAssetUpdateError('in-use', `Cannot replace ${id} ${definition.version} while it is leased`)
    }

    await mkdir(this.versionsRoot(id), { recursive: true, mode: 0o700 })
    const available = await this.availableBytes(this.root)
    const required = requiredRuntimeAssetDiskBytes(target)
    if (available < required) {
      const error = new RuntimeAssetUpdateError(
        'disk-space',
        `Insufficient disk space (need ${required} bytes, have ${available})`
      )
      if (reportStatus) this.set({ id, state: 'failed', error: error.message }, true)
      throw error
    }

    const temporary = path.join(this.root, `.tmp-${id}-${randomUUID()}`)
    const archive = path.join(temporary, `download.${target.archive === 'zip' ? 'zip' : 'tgz'}`)
    const staging = path.join(temporary, 'staging')
    let phase: RuntimeAssetUpdatePhase = 'downloading'
    try {
      await mkdir(temporary, { recursive: true, mode: 0o700 })
      report('downloading', 0)
      const downloaded = await this.downloader(target, archive, {
        signal,
        onProgress: (bytesDownloaded, totalBytes) => report('downloading', bytesDownloaded, totalBytes),
      })
      phase = 'verifying'
      report('verifying', downloaded.bytes)
      if (downloaded.digest !== target.hash.digest) {
        throw new RuntimeAssetUpdateError(
          'integrity',
          `Archive hash mismatch (expected ${target.hash.digest}, got ${downloaded.digest})`
        )
      }
      phase = 'installing'
      report('installing')
      await this.extract(archive, staging, target.archive, { stripPrefix: target.stripPrefix, signal })
      const files = await manifestFiles(staging)
      for (const critical of target.criticalPaths) {
        if (!files.some((file) => file.path === critical)) {
          throw new RuntimeAssetUpdateError('integrity', `Archive is missing critical file: ${critical}`)
        }
      }
      const marker: InstallMarker = {
        schema: 1,
        id,
        version: definition.version,
        target: this.target,
        archiveHash: target.hash,
        criticalPaths: target.criticalPaths,
        files,
        installedAt: this.now().toISOString(),
      }
      await writeFile(path.join(staging, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      phase = 'validating'
      report('validating')
      if (options.validate) {
        try {
          await options.validate(staging, definition, signal)
        } catch (error) {
          if (signal.aborted) throw error
          throw new RuntimeAssetUpdateError('incompatible', `Runtime validation failed: ${message(error)}`, {
            cause: error,
          })
        }
      }
      if (signal.aborted) throw signal.reason ?? new Error('Runtime asset update cancelled')
      return await this.withAssetMutation(id, () => this.activateStaged(definition, staging, temporary, options))
    } catch (error) {
      const failure =
        error instanceof RuntimeAssetUpdateError
          ? error
          : signal.aborted
            ? new RuntimeAssetUpdateError('cancelled', 'Runtime asset update cancelled', { cause: error })
            : new RuntimeAssetUpdateError(
                phase === 'downloading' ? 'download-failed' : phase === 'installing' ? 'integrity' : 'failed',
                message(error),
                { cause: error }
              )
      if (reportStatus) {
        this.set(
          { id, state: 'failed', version: definition.version, target: this.target, error: failure.message },
          true
        )
      }
      throw failure
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  private async activateStaged(
    definition: RuntimeAssetDefinition,
    staging: string,
    temporary: string,
    options: RuntimeAssetUpdateOptions
  ): Promise<RuntimeAssetStatus> {
    const id = definition.id
    const directory = `${definition.version}-${this.target}`
    const destination = path.join(this.versionsRoot(id), directory)
    if (this.leases.has(destination)) {
      throw new RuntimeAssetUpdateError('in-use', `Cannot replace ${id} ${definition.version} while it is leased`)
    }
    const oldCurrent = await readJson<Pointer>(path.join(this.assetRoot(id), CURRENT))
    const validOldCurrent = oldCurrent && /^[A-Za-z0-9._-]+$/.test(oldCurrent.directory) ? oldCurrent : null
    const backup = path.join(temporary, 'replaced')
    let replaced = false
    try {
      await rename(destination, backup)
      replaced = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await rename(staging, destination)
    } catch (error) {
      if (replaced) await rename(backup, destination).catch(() => undefined)
      throw error
    }
    let currentWritten = false
    try {
      await options.commit?.(definition)
      if (validOldCurrent && validOldCurrent.directory !== directory) {
        await this.writePointer(id, PREVIOUS, validOldCurrent)
      }
      await this.writePointer(id, CURRENT, { directory })
      currentWritten = true
    } catch (error) {
      if (!currentWritten) {
        await rm(destination, { recursive: true, force: true }).catch(() => undefined)
        if (replaced) await rename(backup, destination).catch(() => undefined)
      }
      throw new RuntimeAssetUpdateError('failed', `Unable to activate ${id} ${definition.version}: ${message(error)}`, {
        cause: error,
      })
    }
    await rm(backup, { recursive: true, force: true })
    this.volatile.delete(id)
    this.invalidateFullVerifications(id)
    await this.garbageCollect(id)
    return this.set(await this.statusWithinAssetMutation(id), true)
  }

  /**
   * Reactivate the previous installation without downloading. It is fully re-hashed and must still match accepted
   * metadata before the pointers swap; leased generations are never removed by the swap.
   */
  rollback(id: RuntimeAssetId): Promise<RuntimeAssetStatus> {
    return this.withUpdateLock(id, () =>
      this.withAssetMutation(id, async () => {
        const current = await readJson<Pointer>(path.join(this.assetRoot(id), CURRENT))
        const previous = await readJson<Pointer>(path.join(this.assetRoot(id), PREVIOUS))
        if (!previous || !/^[A-Za-z0-9._-]+$/.test(previous.directory) || previous.directory === current?.directory) {
          throw new RuntimeAssetUpdateError('rollback-unavailable', `No previous ${id} installation is available`)
        }
        const verified = await this.verifyGenerationFull(id, previous.directory, { cache: false })
        if (typeof verified === 'string') {
          throw new RuntimeAssetUpdateError(
            'rollback-unavailable',
            `Previous ${id} installation is invalid: ${verified}`
          )
        }
        const mismatch = this.registryMismatch(id, verified.marker)
        if (mismatch) throw new RuntimeAssetUpdateError('rollback-unavailable', mismatch)
        if (current && /^[A-Za-z0-9._-]+$/.test(current.directory)) await this.promotePrevious(id, current, previous)
        else await this.writePointer(id, CURRENT, previous)
        this.volatile.delete(id)
        this.invalidateFullVerifications(id)
        return this.set(await this.statusWithinAssetMutation(id), true)
      })
    )
  }

  /** Previous installation that passes the cheap layout probe and still matches accepted metadata. */
  async previousInstallation(id: RuntimeAssetId): Promise<RuntimeAssetInstallation | null> {
    const current = await readJson<Pointer>(path.join(this.assetRoot(id), CURRENT))
    const previous = await readJson<Pointer>(path.join(this.assetRoot(id), PREVIOUS))
    if (!previous || !/^[A-Za-z0-9._-]+$/.test(previous.directory) || previous.directory === current?.directory) {
      return null
    }
    const generation = await this.verifyGenerationQuick(id, previous.directory)
    if (typeof generation === 'string' || this.registryMismatch(id, generation.marker)) return null
    return { version: generation.marker.version, path: generation.path }
  }

  /** Installed version directories currently held by runtime leases (active connections). */
  leasedInstallations(id: RuntimeAssetId): readonly RuntimeAssetInstallation[] {
    const prefix = `${this.versionsRoot(id)}${path.sep}`
    return [...this.leases.keys()]
      .filter((leased) => leased.startsWith(prefix))
      .flatMap((leased) => {
        const version = this.versionFromDirectory(path.basename(leased))
        return version ? [{ version, path: leased }] : []
      })
  }

  /** Versions referenced by the current and previous pointers, used to prune accepted metadata. */
  async pointedVersions(id: RuntimeAssetId): Promise<readonly string[]> {
    const versions: string[] = []
    for (const name of [CURRENT, PREVIOUS]) {
      const pointer = await readJson<Pointer>(path.join(this.assetRoot(id), name))
      if (!pointer || !/^[A-Za-z0-9._-]+$/.test(pointer.directory)) continue
      const marker = await this.readGenerationMarker(id, pointer.directory)
      const version = typeof marker === 'string' ? this.versionFromDirectory(pointer.directory) : marker.version
      if (version) versions.push(version)
    }
    return versions
  }

  private async writePointer(id: RuntimeAssetId, name: string, pointer: Pointer) {
    const temporary = path.join(this.assetRoot(id), `.${name}-${randomUUID()}`)
    await writeFile(temporary, `${JSON.stringify(pointer)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path.join(this.assetRoot(id), name))
  }

  acquireLease(id: RuntimeAssetId, expectedPath?: string): Promise<RuntimeAssetLease> {
    return this.withAssetMutation(id, async () => {
      const status = await this.statusWithinAssetMutation(id)
      if (status.state !== 'ready' || !status.path) throw new Error(`${id} is not ready`)
      if (expectedPath) {
        const relative = path.relative(path.resolve(status.path), path.resolve(expectedPath))
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`${id} changed before its runtime lease could be acquired`)
        }
      }
      const leasedPath = status.path
      this.leases.set(leasedPath, (this.leases.get(leasedPath) ?? 0) + 1)
      return { status, leasedPath }
    }).then(async ({ status, leasedPath }) => {
      try {
        const verified = await this.verifyGenerationFull(id, path.basename(leasedPath), { cache: true })
        if (typeof verified === 'string') throw new Error(`Runtime verification failed: ${verified}`)
        const mismatch = this.registryMismatch(id, verified.marker)
        if (mismatch) throw new Error(mismatch)
      } catch (error) {
        this.releaseLease(id, leasedPath)
        this.set({
          id,
          state: 'corrupt',
          version: status.version,
          target: status.target,
          path: leasedPath,
          error: message(error),
        })
        throw error
      }
      let released = false
      return Object.freeze({
        id,
        path: leasedPath,
        release: () => {
          if (released) return
          released = true
          this.releaseLease(id, leasedPath)
        },
      })
    })
  }

  private releaseLease(id: RuntimeAssetId, leasedPath: string): void {
    const count = (this.leases.get(leasedPath) ?? 1) - 1
    if (count > 0) this.leases.set(leasedPath, count)
    else {
      this.leases.delete(leasedPath)
      this.fullVerifications.delete(this.verificationKey(id, path.basename(leasedPath)))
      void this.withAssetMutation(id, () => this.garbageCollect(id)).catch(() => undefined)
    }
  }

  async remove(id: RuntimeAssetId): Promise<RuntimeAssetStatus> {
    return this.withAssetMutation(id, async () => {
      if (this.flights.has(id) || this.updateLocks.has(id)) {
        throw new Error(`Cannot remove ${id} while installation is active`)
      }
      const prefix = `${this.versionsRoot(id)}${path.sep}`
      if ([...this.leases.keys()].some((leased) => leased.startsWith(prefix)))
        throw new Error(`Cannot remove ${id} while it is leased`)
      this.set({ id, state: 'removing' }, true)
      try {
        await rm(this.assetRoot(id), { recursive: true, force: true })
        this.volatile.delete(id)
        this.invalidateFullVerifications(id)
        return this.set({ id, state: 'not-installed' }, true)
      } catch (error) {
        return this.set({ id, state: 'failed', error: message(error) }, true)
      }
    })
  }

  private async garbageCollect(id: RuntimeAssetId) {
    const current = await readJson<Pointer>(path.join(this.assetRoot(id), CURRENT))
    const previous = await readJson<Pointer>(path.join(this.assetRoot(id), PREVIOUS))
    const keep = new Set([current?.directory, previous?.directory].filter(Boolean))
    let entries: string[] = []
    try {
      entries = await readdir(this.versionsRoot(id))
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(this.versionsRoot(id), entry)
      if (!keep.has(entry) && !this.leases.has(absolute)) await rm(absolute, { recursive: true, force: true })
    }
  }
}
