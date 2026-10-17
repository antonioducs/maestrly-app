import { createHash, randomUUID } from 'node:crypto'
import { type FileHandle, mkdir, open, realpath, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createZstdDecompress, zstdCompress } from 'node:zlib'
import { FLEET_HOST_FILE_HEADERS as H, FLEET_HOST_FILE_LIMITS } from '@maestrly/bot-fleet-protocol'
import type { HostId } from '../../shared/host-key'
import {
  HOST_TRANSFER_FINAL_STATES,
  type HostTransferError,
  type HostTransferUploadResult,
  type HostTransferView,
} from '../../shared/host-transfers'
import { sanitizeFleetFilename } from '../fleet/client/downloads'
import { extractArchive, packFolder, publishFolderExclusive, scanFolder, UnsafeArchiveError } from '../folder-archive'
import { fileIdentity, hashFile, publishExclusive, readAt, writeAt } from '../transfer-io'
import {
  classifyTransferError,
  type HostFilesEndpoint,
  HostFilesHttpError,
  TransferFailure,
  TransientFailure,
} from './endpoint'
import { type HostTransferRange, planRanges } from './ranges'
import * as store from './store'
import type { HostTransferRecord } from './store'

const zstd = promisify(zstdCompress)
const DEFAULT_LIMITS = {
  activeTransfers: 2,
  rangesPerTransfer: 4,
  rangeBytes: FLEET_HOST_FILE_LIMITS.downloadRangeBytes,
  chunkBytes: FLEET_HOST_FILE_LIMITS.uploadChunkBytes,
  rangeAttempts: 3,
  /** How often the host is asked how packing a folder goes. */
  archivePollMs: 1_000,
}
const SPEED_WINDOW_MS = 5_000
const EMIT_EVERY_MS = 250
const MIN_COMPRESSED_BYTES = 64 * 1024
const COMPRESSION_WORTH = 0.8
// Hashing a whole file on the host takes minutes per hundred gigabytes.
const WHOLE_FILE_MS = 6 * 60 * 60 * 1_000
// A folder whose archive these stopped is packed again: the archive went away, or what it holds was not as expected.
const REPACK_ERRORS: ReadonlySet<HostTransferError | null> = new Set([
  'changed',
  'verification-failed',
  'unsafe-archive',
  'archive-expired',
])
const ARCHIVE_SUFFIX = '.tar.zst'

const archiveGone = (error: unknown): boolean =>
  error instanceof HostFilesHttpError && error.reason === 'archive-expired'

export interface HostTransferEngineDeps {
  endpoint: (hostId: HostId) => HostFilesEndpoint
  downloadsDir: () => string
  openDir: () => string
  openPath: (file: string) => Promise<unknown>
  emit: (transfers: HostTransferView[]) => void
  /** Where folders are packed before they are uploaded; the system's temporary folder by default. */
  packDir?: () => string
  /** Whether a host takes whole folders (`HostView.folderTransfers`); all do by default. */
  folderTransfers?: (hostId: HostId) => boolean
  now?: () => number
  backoffMs?: (attempt: number) => number
  limits?: Partial<typeof DEFAULT_LIMITS>
}

interface SettleWaiter {
  resolve: (view: HostTransferView) => void
  reject: (error: Error) => void
  onProgress?: (view: HostTransferView) => void
}

/** Runs `work` on the items, `width` at a time; the first failure stops the rest and is rethrown. */
async function pool<T>(
  items: T[],
  width: number,
  signal: AbortSignal,
  work: (item: T, signal: AbortSignal) => Promise<void>
): Promise<void> {
  const local = new AbortController()
  const stop = () => local.abort()
  signal.addEventListener('abort', stop, { once: true })
  let next = 0
  let failure: unknown = null
  const worker = async () => {
    while (!local.signal.aborted && next < items.length) {
      const item = items[next++]
      try {
        await work(item, local.signal)
      } catch (error) {
        failure ??= error
        local.abort()
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
  } finally {
    signal.removeEventListener('abort', stop)
  }
  signal.throwIfAborted()
  if (failure) throw failure
}

/**
 * Moves files between this computer and its hosts. A transfer is split into ranges recorded in the app database; a
 * range counts once its bytes are verified against the host's SHA-256 and flushed, so pausing, sleeping, losing the
 * server or quitting resumes from the ranges that remain. A finished file is checked whole on both ends before it is
 * published (downloads) or committed (uploads).
 */
export class HostTransferEngine {
  private readonly limits: typeof DEFAULT_LIMITS
  private readonly now: () => number
  private readonly running = new Map<string, AbortController>()
  private readonly runs = new Set<Promise<void>>()
  private readonly inflight = new Map<string, Map<number, number>>()
  private readonly samples = new Map<string, Array<[number, number]>>()
  private readonly retries = new Map<string, { attempt: number; timer: NodeJS.Timeout | null }>()
  private readonly waiters = new Map<string, Set<SettleWaiter>>()
  /** How far packing or extracting a folder went, from 0 to 1; null while unknown. */
  private readonly stageProgress = new Map<string, number | null>()
  private emitTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(private readonly deps: HostTransferEngineDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits }
    this.now = deps.now ?? Date.now
  }

  start(): void {
    store.recoverInterruptedHostTransfers()
    this.changed()
    this.schedule()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const retry of this.retries.values()) if (retry.timer) clearTimeout(retry.timer)
    for (const controller of this.running.values()) controller.abort()
    await Promise.allSettled([...this.runs])
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    const stopped = new Error('The transfer engine stopped.')
    for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.reject(stopped)
    this.waiters.clear()
  }

  /** Queues a download; `directory` publishes it there instead of the downloads folder. */
  async download(
    hostId: HostId,
    remotePath: string,
    purpose: 'save' | 'open' = 'save',
    options: { directory?: string } = {}
  ): Promise<string> {
    const file = await this.deps.endpoint(hostId).json('hostFileStat', { body: { path: remotePath } })
    const id = randomUUID()
    const directory =
      options.directory ?? (purpose === 'open' ? path.join(this.deps.openDir(), id) : this.deps.downloadsDir())
    store.insertHostTransfer(
      {
        id,
        hostId,
        direction: 'download',
        purpose,
        name: file.name,
        remotePath: file.path,
        remoteDirectory: null,
        localPath: null,
        localDirectory: directory,
        partialPath: path.join(directory, `.maestrly-${id}.download`),
        size: file.size,
        identity: file.identity,
        overwrite: false,
        createdAt: this.now(),
      },
      planRanges(file.size, this.limits.rangeBytes)
    )
    this.changed()
    this.schedule()
    return id
  }

  /**
   * Queues a folder's download into the downloads folder: the host packs it, the archive moves like a file, and it is
   * extracted here under the folder's name, or `name (2)` when that is taken.
   */
  async downloadFolder(hostId: HostId, remotePath: string): Promise<string> {
    if (!this.foldersOf(hostId)) throw new TransferFailure('host-update-required')
    const id = randomUUID()
    const directory = this.deps.downloadsDir()
    store.insertHostTransfer(
      {
        id,
        hostId,
        direction: 'download',
        purpose: 'save',
        kind: 'folder',
        stage: 'packing',
        name: path.posix.basename(remotePath) || remotePath,
        remotePath,
        remoteDirectory: null,
        localPath: null,
        localDirectory: directory,
        partialPath: path.join(directory, `.maestrly-${id}.download`),
        size: 0,
        identity: '',
        overwrite: false,
        createdAt: this.now(),
      },
      []
    )
    this.changed()
    this.schedule()
    return id
  }

  async upload(
    hostId: HostId,
    localPaths: string[],
    remoteDirectory: string,
    overwrite = false
  ): Promise<HostTransferUploadResult> {
    const result: HostTransferUploadResult = { queued: [], skipped: [] }
    const folders = this.foldersOf(hostId)
    for (const localPath of localPaths) {
      const info = path.isAbsolute(localPath) ? await stat(localPath).catch(() => null) : null
      const name = path.basename(localPath)
      if (info?.isDirectory() && folders) {
        // Packed when its turn comes: the size and version it moves with are its archive's.
        const id = randomUUID()
        store.insertHostTransfer(
          {
            id,
            hostId,
            direction: 'upload',
            purpose: 'save',
            kind: 'folder',
            stage: 'packing',
            name,
            remotePath: path.posix.join(remoteDirectory, name),
            remoteDirectory,
            localPath,
            localDirectory: null,
            partialPath: null,
            size: 0,
            identity: '',
            overwrite: false,
            createdAt: this.now(),
          },
          []
        )
        result.queued.push(id)
        continue
      }
      if (!info?.isFile() || info.size > FLEET_HOST_FILE_LIMITS.maxFileBytes) {
        result.skipped.push(name)
        continue
      }
      const id = randomUUID()
      store.insertHostTransfer(
        {
          id,
          hostId,
          direction: 'upload',
          purpose: 'save',
          name,
          remotePath: path.posix.join(remoteDirectory, name),
          remoteDirectory,
          localPath,
          localDirectory: null,
          partialPath: null,
          size: info.size,
          identity: fileIdentity(info),
          overwrite,
          createdAt: this.now(),
        },
        planRanges(info.size, this.limits.chunkBytes)
      )
      result.queued.push(id)
    }
    this.changed()
    this.schedule()
    return result
  }

  pause(id: string): void {
    const record = store.getHostTransfer(id)
    if (!record || !['queued', 'running', 'waiting'].includes(record.state)) return
    store.updateHostTransfer(id, { state: 'paused' })
    this.clearRetry(id)
    this.running.get(id)?.abort()
    this.changed()
  }

  resume(id: string): void {
    if (store.getHostTransfer(id)?.state !== 'paused') return
    store.updateHostTransfer(id, { state: 'queued' })
    this.changed()
    this.schedule()
  }

  async cancel(id: string): Promise<void> {
    const record = store.getHostTransfer(id)
    if (!record || HOST_TRANSFER_FINAL_STATES.has(record.state)) return
    store.updateHostTransfer(id, { state: 'canceled', finishedAt: this.now() })
    this.clearRetry(id)
    this.running.get(id)?.abort()
    await this.discard(record)
    this.changed()
  }

  async retry(id: string, options: { overwrite?: boolean } = {}): Promise<void> {
    const record = store.getHostTransfer(id)
    if (record?.state !== 'failed') return
    if (record.kind === 'folder') {
      if (REPACK_ERRORS.has(record.error)) await this.repack(record)
    } else if (record.error === 'changed' || record.error === 'verification-failed') {
      if (record.direction === 'download') {
        const file = await this.deps.endpoint(record.hostId).json('hostFileStat', { body: { path: record.remotePath } })
        if (record.partialPath) await rm(record.partialPath, { force: true })
        store.restartHostTransfer(id, file, planRanges(file.size, this.limits.rangeBytes))
      } else {
        await this.discard(record)
        const info = await stat(record.localPath!)
        store.restartHostTransfer(
          id,
          { size: info.size, identity: fileIdentity(info) },
          planRanges(info.size, this.limits.chunkBytes)
        )
      }
    }
    store.updateHostTransfer(id, {
      state: 'queued',
      error: null,
      errorMessage: null,
      finishedAt: null,
      ...(options.overwrite ? { overwrite: true } : {}),
    })
    this.changed()
    this.schedule()
  }

  async remove(id: string): Promise<void> {
    const record = store.getHostTransfer(id)
    if (!record || !HOST_TRANSFER_FINAL_STATES.has(record.state)) return
    if (record.state !== 'done') await this.discard(record)
    store.deleteHostTransfer(id)
    this.changed()
  }

  /** The file a finished download published; never a path the window names. */
  revealPath(id: string): string | null {
    const record = store.getHostTransfer(id)
    return record?.state === 'done' && record.direction === 'download' ? record.localPath : null
  }

  /** The machine woke up or a host came back: transfers waiting for their server try again now. */
  wake(): void {
    for (const [id, retry] of this.retries) {
      if (retry.timer) clearTimeout(retry.timer)
      this.retries.set(id, { attempt: retry.attempt, timer: null })
      if (store.getHostTransfer(id)?.state === 'waiting') store.updateHostTransfer(id, { state: 'queued' })
    }
    this.changed()
    this.schedule()
  }

  list(): HostTransferView[] {
    return store.listHostTransfers().map((record) => this.view(record))
  }

  /**
   * Resolves with the transfer once it is done, failed or canceled, reporting its progress meanwhile; rejects when the
   * transfer is unknown or the engine stops.
   */
  whenSettled(id: string, onProgress?: (view: HostTransferView) => void): Promise<HostTransferView> {
    const record = store.getHostTransfer(id)
    if (!record) return Promise.reject(new Error('Unknown transfer.'))
    const view = this.view(record)
    if (HOST_TRANSFER_FINAL_STATES.has(view.state)) return Promise.resolve(view)
    if (this.stopped) return Promise.reject(new Error('The transfer engine stopped.'))
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(id) ?? new Set<SettleWaiter>()
      waiters.add({ resolve, reject, onProgress })
      this.waiters.set(id, waiters)
    })
  }

  private notifyWaiters(views: HostTransferView[]): void {
    if (this.waiters.size === 0) return
    const byId = new Map(views.map((view) => [view.id, view]))
    for (const [id, waiters] of [...this.waiters]) {
      const view = byId.get(id)
      for (const waiter of waiters) {
        if (!view) waiter.reject(new Error('The transfer was removed.'))
        else if (HOST_TRANSFER_FINAL_STATES.has(view.state)) waiter.resolve(view)
        else waiter.onProgress?.(view)
      }
      if (!view || HOST_TRANSFER_FINAL_STATES.has(view.state)) this.waiters.delete(id)
    }
  }

  private schedule(): void {
    if (this.stopped) return
    for (const record of store.listHostTransfers({ states: ['queued'] })) {
      if (this.running.size >= this.limits.activeTransfers) return
      if (!this.running.has(record.id)) this.launch(record.id)
    }
  }

  private launch(id: string): void {
    const controller = new AbortController()
    this.running.set(id, controller)
    store.updateHostTransfer(id, { state: 'running' })
    this.changed()
    const run: Promise<void> = this.run(id, controller.signal).finally(() => {
      this.running.delete(id)
      this.inflight.delete(id)
      this.stageProgress.delete(id)
      this.runs.delete(run)
      this.changed()
      this.schedule()
    })
    this.runs.add(run)
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const record = store.getHostTransfer(id)!
    try {
      if (record.direction === 'download') await this.runDownload(record, signal)
      else await this.runUpload(record, signal)
      this.retries.delete(id)
    } catch (error) {
      // Pausing, canceling or quitting aborted it, and already recorded its state.
      if (signal.aborted) return
      const failure = classifyTransferError(error)
      if (failure.transient) return this.wait(id)
      store.updateHostTransfer(id, {
        state: 'failed',
        error: failure.reason,
        errorMessage: failure.message,
        finishedAt: this.now(),
      })
    }
  }

  private wait(id: string): void {
    const attempt = (this.retries.get(id)?.attempt ?? 0) + 1
    store.updateHostTransfer(id, { state: 'waiting' })
    const delay = this.deps.backoffMs?.(attempt) ?? Math.min(30_000, 1_000 * 2 ** (attempt - 1))
    const timer = setTimeout(() => {
      this.retries.set(id, { attempt, timer: null })
      if (store.getHostTransfer(id)?.state !== 'waiting') return
      store.updateHostTransfer(id, { state: 'queued' })
      this.changed()
      this.schedule()
    }, delay)
    timer.unref?.()
    this.retries.set(id, { attempt, timer })
  }

  private async runDownload(record: HostTransferRecord, signal: AbortSignal): Promise<void> {
    if (record.kind === 'folder') return this.runFolderDownload(record, signal)
    const local = await this.fetchDownload(record, record.remotePath, signal)
    const published = await publishExclusive(
      record.partialPath!,
      record.localDirectory!,
      sanitizeFleetFilename(record.name),
      signal
    )
    store.updateHostTransfer(record.id, {
      state: 'done',
      localPath: published,
      localSha256: local,
      finishedAt: this.now(),
    })
    if (record.purpose === 'open') void this.deps.openPath(published)
  }

  /** Fetches the ranges left of the host's file `source` into the partial file, checks it whole and returns its hash. */
  private async fetchDownload(record: HostTransferRecord, source: string, signal: AbortSignal): Promise<string> {
    const endpoint = this.deps.endpoint(record.hostId)
    await mkdir(record.localDirectory!, { recursive: true })
    const partial = record.partialPath!
    let handle = await open(partial, 'r+').catch(() => null)
    if (!handle) {
      // The partial file went away: what it held must be fetched again.
      store.restartHostTransfer(record.id, record, planRanges(record.size, this.limits.rangeBytes))
      handle = await open(partial, 'wx', 0o600)
      await handle.truncate(record.size)
    }
    try {
      const remote = record.remoteSha256
        ? Promise.resolve(record.remoteSha256)
        : endpoint
            .json('hostFileDigest', {
              body: { path: source, identity: record.identity },
              signal,
              timeoutMs: WHOLE_FILE_MS,
            })
            .then(({ sha256 }) => {
              store.updateHostTransfer(record.id, { remoteSha256: sha256 })
              return sha256
            })
      remote.catch(() => undefined)
      const file = handle
      await pool(
        store.pendingHostTransferRanges(record.id),
        this.limits.rangesPerTransfer,
        signal,
        (range, rangeSignal) => this.downloadRange(endpoint, record, source, range, file, rangeSignal)
      )
      store.updateHostTransfer(record.id, { state: 'verifying' })
      this.changed()
      const [local, expected] = await Promise.all([hashFile(partial, 0, undefined, signal), remote])
      if (local !== expected) {
        store.restartHostTransfer(record.id, record, planRanges(record.size, this.limits.rangeBytes))
        throw new TransferFailure('verification-failed')
      }
      return local
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /**
   * A folder's download: the host packs it, its archive is fetched like a file, then extracted here. An archive that
   * went away meanwhile (the host restarted, or nobody read it for a day) is packed again, once a run.
   */
  private async runFolderDownload(initial: HostTransferRecord, signal: AbortSignal): Promise<void> {
    let record = initial
    for (let repacked = false; ; repacked = true) {
      try {
        if (record.stage === 'packing') record = await this.packOnHost(record, signal)
        if (record.stage === 'extracting' && !(await stat(record.partialPath!).catch(() => null))) {
          store.updateHostTransfer(record.id, { stage: 'transferring' })
          record = store.getHostTransfer(record.id)!
        }
        if (record.stage === 'transferring') {
          const local = await this.fetchDownload(record, record.archivePath!, signal)
          store.updateHostTransfer(record.id, { state: 'running', stage: 'extracting', localSha256: local })
          record = store.getHostTransfer(record.id)!
        }
        return await this.extractDownload(record, signal)
      } catch (error) {
        if (repacked || signal.aborted || !archiveGone(error)) throw error
        record = await this.repack(record)
      }
    }
  }

  /** Asks the host to pack the folder, unless it already does, and waits until the archive is ready. */
  private async packOnHost(record: HostTransferRecord, signal: AbortSignal): Promise<HostTransferRecord> {
    const endpoint = this.deps.endpoint(record.hostId)
    let archiveId = record.archiveId
    if (!archiveId) {
      archiveId = (await endpoint.json('hostFileArchiveBegin', { body: { path: record.remotePath }, signal })).archiveId
      store.updateHostTransfer(record.id, { archiveId })
    }
    for (;;) {
      const status = await endpoint.json('hostFileArchiveStatus', { params: { archiveId }, signal })
      if (status.state === 'ready') {
        store.restartHostTransfer(record.id, status, planRanges(status.size, this.limits.rangeBytes))
        store.updateHostTransfer(record.id, { archivePath: status.path, stage: 'transferring' })
        this.stageProgress.delete(record.id)
        this.changed()
        return store.getHostTransfer(record.id)!
      }
      this.progress(record.id, status.totalBytes ? Math.min(1, status.bytes / status.totalBytes) : null)
      await delay(this.limits.archivePollMs, undefined, { signal })
    }
  }

  private async extractDownload(record: HostTransferRecord, signal: AbortSignal): Promise<void> {
    this.changed()
    const staging = this.stagingPath(record)
    await rm(staging, { recursive: true, force: true })
    try {
      await extractArchive(record.partialPath!, staging, {
        signal,
        onProgress: (bytes) => this.progress(record.id, record.size ? Math.min(1, bytes / record.size) : null),
      })
    } catch (error) {
      if (error instanceof UnsafeArchiveError) throw new TransferFailure('unsafe-archive', error.message)
      throw error
    }
    let published: string
    try {
      published = await publishFolderExclusive(
        staging,
        record.localDirectory!,
        sanitizeFleetFilename(record.name),
        signal
      )
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
    await rm(record.partialPath!, { force: true })
    this.stageProgress.delete(record.id)
    store.updateHostTransfer(record.id, { state: 'done', localPath: published, finishedAt: this.now() })
    await this.releaseArchive(record)
  }

  private async downloadRange(
    endpoint: HostFilesEndpoint,
    record: HostTransferRecord,
    source: string,
    range: HostTransferRange,
    handle: FileHandle,
    signal: AbortSignal
  ): Promise<void> {
    const end = range.start + range.length - 1
    for (let attempt = 1; ; attempt++) {
      const response = await endpoint.raw('hostFileContent', {
        query: { path: source },
        headers: { range: `bytes=${range.start}-${end}`, [H.identity]: record.identity, [H.acceptEncoding]: 'zstd' },
        signal,
      })
      if (
        response.status !== 206 ||
        !response.body ||
        response.headers.get('content-range') !== `bytes ${range.start}-${end}/${record.size}` ||
        Number(response.headers.get(H.length)) !== range.length
      ) {
        await response.body?.cancel().catch(() => undefined)
        throw new TransferFailure('verification-failed', 'Unexpected range response')
      }
      const hash = createHash('sha256')
      let written = 0
      let overflow = false
      const progress = (bytes: number) => this.rangeProgress(record.id, range.index, bytes)
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (overflow || written + chunk.length > range.length) {
            overflow = true
            return callback()
          }
          hash.update(chunk)
          writeAt(handle, chunk, range.start + written).then(() => {
            written += chunk.length
            progress(written)
            callback()
          }, callback)
        },
      })
      const body = Readable.fromWeb(response.body as never)
      await (response.headers.get(H.encoding) === 'zstd'
        ? pipeline(body, createZstdDecompress(), sink, { signal })
        : pipeline(body, sink, { signal }))
      if (!overflow && written === range.length && hash.digest('hex') === response.headers.get(H.sha256)) {
        await handle.datasync()
        store.finishHostTransferRange(record.id, range.index)
        this.rangeDone(record.id, range.index)
        return
      }
      this.rangeDone(record.id, range.index)
      if (attempt >= this.limits.rangeAttempts) throw new TransferFailure('verification-failed')
    }
  }

  private async runUpload(initial: HostTransferRecord, signal: AbortSignal): Promise<void> {
    const endpoint = this.deps.endpoint(initial.hostId)
    let record = initial
    if (record.kind === 'folder') {
      // The archive went away (the system cleans its temporary folder): the folder is packed again.
      if (record.stage !== 'packing' && !(await stat(record.archivePath ?? '').catch(() => null)))
        record = await this.repack(record)
      if (record.stage === 'packing') record = await this.packLocal(record, signal)
    }
    const source = this.uploadSource(record)
    const info = await stat(source).catch(() => null)
    if (!info?.isFile()) throw new TransferFailure('local-missing')
    if (fileIdentity(info) !== record.identity) throw new TransferFailure('changed')
    try {
      if (!record.uploadId) {
        const session = await endpoint.json('hostFileUploadBegin', {
          body: {
            directory: record.remoteDirectory!,
            name: record.name,
            size: record.size,
            overwrite: record.overwrite,
            ...(record.kind === 'folder' ? { kind: 'folder' as const } : {}),
          },
          signal,
        })
        store.updateHostTransfer(record.id, { uploadId: session.uploadId, remotePath: session.path })
        record = store.getHostTransfer(record.id)!
      }
      const current = record
      const local = current.localSha256
        ? Promise.resolve(current.localSha256)
        : hashFile(source, 0, undefined, signal).then((sha256) => {
            store.updateHostTransfer(current.id, { localSha256: sha256 })
            return sha256
          })
      local.catch(() => undefined)
      const handle = await open(source, 'r')
      try {
        await pool(
          store.pendingHostTransferRanges(current.id),
          this.limits.rangesPerTransfer,
          signal,
          (range, rangeSignal) => this.uploadChunk(endpoint, current, range, handle, rangeSignal)
        )
      } finally {
        await handle.close()
      }
      store.updateHostTransfer(current.id, { state: 'verifying' })
      this.changed()
      const sha256 = await local
      const after = await stat(source)
      if (fileIdentity(after) !== current.identity) throw new TransferFailure('changed')
      const result = await endpoint.json('hostFileUploadCommit', {
        params: { uploadId: current.uploadId! },
        body: { sha256, ...(current.overwrite ? { overwrite: true } : {}) },
        signal,
        timeoutMs: WHOLE_FILE_MS,
      })
      store.updateHostTransfer(current.id, {
        state: 'done',
        remotePath: result.path,
        remoteSha256: result.sha256,
        finishedAt: this.now(),
      })
      if (current.kind === 'folder') await rm(source, { force: true })
    } catch (error) {
      // The host lost the session (it was swept, or its folder was reset): the upload starts over by itself.
      if (error instanceof HostFilesHttpError && error.reason === 'unknown-upload') {
        store.restartHostTransfer(record.id, record, planRanges(record.size, this.limits.chunkBytes))
        throw new TransientFailure(error.message)
      }
      throw error
    }
  }

  /** What an upload reads: the file itself, or a folder's archive. */
  private uploadSource(record: HostTransferRecord): string {
    return record.kind === 'folder' ? record.archivePath! : record.localPath!
  }

  /** Packs a folder to upload into this computer's temporary folder; the upload then moves the archive. */
  private async packLocal(record: HostTransferRecord, signal: AbortSignal): Promise<HostTransferRecord> {
    const directory = this.deps.packDir?.() ?? path.join(os.tmpdir(), 'maestrly-folder-uploads')
    await mkdir(directory, { recursive: true })
    const archive = path.join(directory, record.id + ARCHIVE_SUFFIX)
    await rm(archive, { force: true })
    const folder = await realpath(record.localPath!).catch(() => null)
    if (!folder || !(await stat(folder).catch(() => null))?.isDirectory()) throw new TransferFailure('local-missing')
    // A folder that holds the temporary folder would otherwise pack its own archive.
    const scan = await scanFolder(folder, { signal, exclude: [await realpath(directory)] })
    await packFolder(folder, archive, {
      signal,
      scan,
      onProgress: ({ bytes }) => this.progress(record.id, scan.bytes ? Math.min(1, bytes / scan.bytes) : null),
    })
    const packed = await stat(archive)
    store.restartHostTransfer(
      record.id,
      { size: packed.size, identity: fileIdentity(packed) },
      planRanges(packed.size, this.limits.chunkBytes)
    )
    store.updateHostTransfer(record.id, { archivePath: archive, stage: 'transferring' })
    this.stageProgress.delete(record.id)
    this.changed()
    return store.getHostTransfer(record.id)!
  }

  /** Starts a folder's transfer over from packing, leaving nothing of its archive on either side. */
  private async repack(record: HostTransferRecord): Promise<HostTransferRecord> {
    await this.discard(record)
    store.restartHostTransfer(record.id, { size: 0, identity: '' }, [])
    store.updateHostTransfer(record.id, { stage: 'packing', archiveId: null, archivePath: null })
    return store.getHostTransfer(record.id)!
  }

  private stagingPath(record: HostTransferRecord): string {
    return path.join(record.localDirectory!, `.maestrly-${record.id}.extract`)
  }

  /** The host's archive of a downloaded folder is of no more use; an unreachable host removes it within a day. */
  private async releaseArchive(record: HostTransferRecord): Promise<void> {
    if (!record.archiveId) return
    try {
      await this.deps
        .endpoint(record.hostId)
        .json('hostFileArchiveRelease', { params: { archiveId: record.archiveId } })
    } catch {
      // Swept by the host once nobody reads it.
    }
  }

  private async uploadChunk(
    endpoint: HostFilesEndpoint,
    record: HostTransferRecord,
    range: HostTransferRange,
    handle: FileHandle,
    signal: AbortSignal
  ): Promise<void> {
    const bytes = await readAt(handle, range.length, range.start)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const packed = range.length >= MIN_COMPRESSED_BYTES ? await zstd(bytes) : null
    const compressed = packed !== null && packed.length < bytes.length * COMPRESSION_WORTH
    for (let attempt = 1; ; attempt++) {
      try {
        await endpoint.raw('hostFileUploadChunk', {
          params: { uploadId: record.uploadId! },
          query: { offset: range.start },
          headers: {
            'content-type': 'application/octet-stream',
            [H.sha256]: sha256,
            [H.length]: String(range.length),
            ...(compressed ? { [H.encoding]: 'zstd' } : {}),
          },
          body: compressed ? packed! : bytes,
          signal,
        })
        store.finishHostTransferRange(record.id, range.index)
        this.rangeDone(record.id, range.index)
        return
      } catch (error) {
        const retry =
          error instanceof HostFilesHttpError &&
          error.reason === 'chunk-mismatch' &&
          attempt < this.limits.rangeAttempts
        if (!retry) throw error
      }
    }
  }

  private async discard(record: HostTransferRecord): Promise<void> {
    if (record.direction === 'download') {
      if (record.partialPath) await rm(record.partialPath, { force: true })
      if (record.kind === 'folder') {
        await rm(this.stagingPath(record), { recursive: true, force: true })
        await this.releaseArchive(record)
      }
      if (record.purpose === 'open' && record.localDirectory && !record.localPath)
        await rm(record.localDirectory, { recursive: true, force: true })
      return
    }
    if (record.kind === 'folder' && record.archivePath) await rm(record.archivePath, { force: true })
    if (!record.uploadId) return
    try {
      await this.deps.endpoint(record.hostId).json('hostFileUploadAbort', { params: { uploadId: record.uploadId } })
    } catch {
      // The host removes sessions nobody touches; an unreachable host keeps it until then.
    }
  }

  private foldersOf(hostId: HostId): boolean {
    return this.deps.folderTransfers?.(hostId) ?? true
  }
  private progress(id: string, value: number | null): void {
    this.stageProgress.set(id, value)
    this.changed()
  }
  private clearRetry(id: string): void {
    const retry = this.retries.get(id)
    if (retry?.timer) clearTimeout(retry.timer)
    this.retries.delete(id)
  }
  private rangeProgress(id: string, index: number, bytes: number): void {
    const ranges = this.inflight.get(id) ?? new Map<number, number>()
    ranges.set(index, bytes)
    this.inflight.set(id, ranges)
    this.changed()
  }
  private rangeDone(id: string, index: number): void {
    this.inflight.get(id)?.delete(index)
    this.changed()
  }
  private changed(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      const views = this.list()
      this.deps.emit(views)
      this.notifyWaiters(views)
    }, EMIT_EVERY_MS)
    this.emitTimer.unref?.()
  }
  private view(record: HostTransferRecord): HostTransferView {
    const inflight = [...(this.inflight.get(record.id)?.values() ?? [])].reduce((sum, bytes) => sum + bytes, 0)
    const doneBytes = Math.min(record.size, record.doneBytes + inflight)
    const speed = this.speed(record.id, doneBytes, record.size, record.state === 'running')
    return {
      id: record.id,
      hostId: record.hostId,
      direction: record.direction,
      purpose: record.purpose,
      kind: record.kind,
      stage: record.kind === 'folder' ? record.stage : null,
      stageProgress: this.stageProgress.get(record.id) ?? null,
      name: record.name,
      remotePath: record.remotePath,
      localPath: record.localPath,
      size: record.size,
      doneBytes,
      state: record.state,
      error: record.error,
      errorMessage: record.errorMessage,
      ...speed,
      sha256: record.localSha256 ?? record.remoteSha256,
      createdAt: record.createdAt,
      finishedAt: record.finishedAt,
    }
  }
  private speed(id: string, done: number, size: number, running: boolean) {
    if (!running) {
      this.samples.delete(id)
      return { bytesPerSecond: null, remainingMs: null }
    }
    const now = this.now()
    const samples = this.samples.get(id) ?? []
    samples.push([now, done])
    while (samples.length > 1 && now - samples[0][0] > SPEED_WINDOW_MS) samples.shift()
    this.samples.set(id, samples)
    const [since, from] = samples[0]
    if (now - since < 500) return { bytesPerSecond: null, remainingMs: null }
    const bytesPerSecond = ((done - from) * 1_000) / (now - since)
    return { bytesPerSecond, remainingMs: bytesPerSecond > 0 ? ((size - done) / bytesPerSecond) * 1_000 : null }
  }
}
