import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createZstdCompress, createZstdDecompress, zstdCompress } from 'node:zlib'
import {
  FLEET_HOST_FILE_ERRORS,
  FLEET_HOST_FILE_HEADERS as H,
  FLEET_HOST_FILE_LIMITS,
  type FleetHostFileArchive,
  type FleetHostFileArchiveBegin,
  type FleetHostFileArchiveRequest,
  type FleetHostFileDigest,
  type FleetHostFileDigestRequest,
  type FleetHostFileErrorReason,
  type FleetHostFileKind,
  type FleetHostFileStat,
  type FleetHostFileStatRequest,
  type FleetHostFileUpload,
  type FleetHostFileUploadBegin,
  type FleetHostFileUploadCommit,
  type FleetHostFileUploadResult,
  fleetHostFileArchiveIdSchema,
  fleetHostFileSha256Schema,
  fleetHostFileUploadIdSchema,
} from '@maestrly/bot-fleet-protocol'
import { InstanceHttpError } from '../../fleet/instance/server'
import {
  extractArchive,
  packFolder,
  publishFolderExclusive,
  scanFolder,
  UnsafeArchiveError,
} from '../../folder-archive'
import { fileIdentity, hashFile, readAt, writeAt } from '../../transfer-io'
import { resolveInside } from '../host-fs'

const zstd = promisify(zstdCompress)
const SAMPLE_BYTES = 128 * 1024
const MIN_COMPRESSED_BYTES = 64 * 1024
// A range is only compressed when its sample shrinks well; zstd on incompressible bytes costs CPU for nothing.
const COMPRESSION_WORTH = 0.8
// What a tar adds per entry at most (a header, an extended header for a long name, padding), and room besides.
const TAR_ENTRY_BYTES = 1_536
const ARCHIVE_SLACK_BYTES = 64 * 1024 * 1024
const ARCHIVE_SUFFIX = '.tar.zst'
// A computer whose commit outlasted its request asks again; a commit that finished meanwhile answers the same.
const COMMITTED_MS = 60 * 60 * 1_000

const STATUS: Record<FleetHostFileErrorReason, [number, string]> = {
  'outside-roots': [403, 'FORBIDDEN'],
  'not-found': [404, 'NOT_FOUND'],
  'unknown-upload': [404, 'NOT_FOUND'],
  'not-a-file': [409, 'CONFLICT'],
  'not-a-directory': [409, 'CONFLICT'],
  changed: [409, 'CONFLICT'],
  exists: [409, 'CONFLICT'],
  'digest-mismatch': [409, 'CONFLICT'],
  'chunk-mismatch': [400, 'INVALID_REQUEST'],
  'invalid-name': [400, 'INVALID_REQUEST'],
  'unsafe-archive': [409, 'CONFLICT'],
  'archive-expired': [404, 'NOT_FOUND'],
  'no-space': [409, 'CONFLICT'],
}
const refuse = (reason: FleetHostFileErrorReason): InstanceHttpError =>
  new InstanceHttpError(STATUS[reason][0], STATUS[reason][1], FLEET_HOST_FILE_ERRORS[reason])
const invalid = (message: string): InstanceHttpError => new InstanceHttpError(400, 'INVALID_REQUEST', message)
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

export interface HostFilesDeps {
  /** Folders a computer may read from and write to: the host-fs roots. */
  roots: () => readonly string[]
  /** Folders a computer may only read from: copies the host makes for it, such as PDF attachment previews. */
  readRoots: () => readonly string[]
  /** Where upload sessions are recorded. */
  uploadsDir: string
  /** Where folders are packed for download; computers read the archives here as they read the read-only roots. */
  archivesDir: string
  now?: () => number
  token?: () => string
}

interface UploadRecord {
  uploadId: string
  path: string
  partPath: string
  size: number
  overwrite: boolean
  touchedAt: number
  /** Absent in sessions begun before folders moved: a file. */
  kind?: FleetHostFileKind
}

interface ArchiveRecord {
  archiveId: string
  /** The archive. */
  path: string
  /** The folder it packs. */
  source: string
  touchedAt: number
  /** Set once the archive is complete. */
  ready?: { name: string; entries: number }
}

/** A folder being packed by this process. */
interface ArchiveJob {
  controller: AbortController
  bytes: number
  totalBytes: number
  /** Why packing stopped, until a status reports it. */
  failure: InstanceHttpError | null
  done: Promise<void>
}

/** A single `bytes=a-b` range, inclusive; null without a Range header; `invalid` when it cannot be served. */
export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null | 'invalid' {
  if (header === undefined) return size <= FLEET_HOST_FILE_LIMITS.downloadRangeBytes ? null : 'invalid'
  const match = /^bytes=(\d{1,16})-(\d{0,16})$/.exec(header)
  if (!match) return 'invalid'
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (start > end || end >= size || end - start + 1 > FLEET_HOST_FILE_LIMITS.downloadRangeBytes) return 'invalid'
  return { start, end }
}

async function inside(target: string, roots: readonly string[]): Promise<{ real: string; info: Stats }> {
  try {
    const { real } = await resolveInside(target, roots)
    return { real, info: await stat(real) }
  } catch (error) {
    throw refuse(errno(error) === 'not-found' ? 'not-found' : 'outside-roots')
  }
}

async function compresses(file: string, start: number, length: number): Promise<boolean> {
  const handle = await open(file, 'r')
  try {
    const sample = await readAt(handle, length, start)
    return (await zstd(sample)).length < sample.length * COMPRESSION_WORTH
  } finally {
    await handle.close()
  }
}

/**
 * The files of a workspaces host, as a paired computer moves them through the gateway. Reads are confined to the
 * host-fs roots and the read-only roots, writes to the host-fs roots; links are resolved before either is checked.
 * An upload is a session: its partial file sits hidden beside its destination, so publishing it is a rename, and
 * its record survives a restart of the host. A folder moves as one archive: one the host packs in the background and
 * computers then download like a file, or one a computer uploads and the host extracts into a new folder on commit.
 */
export class HostFiles {
  private readonly now: () => number
  private readonly token: () => string
  private readonly jobs = new Map<string, ArchiveJob>()
  private readonly commits = new Map<string, Promise<FleetHostFileUploadResult>>()
  private readonly committed = new Map<string, { result: FleetHostFileUploadResult; at: number }>()

  constructor(private readonly deps: HostFilesDeps) {
    this.now = deps.now ?? Date.now
    this.token = deps.token ?? (() => randomBytes(24).toString('base64url'))
  }

  private async file(target: string) {
    const found = await inside(target, [...this.deps.roots(), ...this.deps.readRoots(), this.deps.archivesDir]).catch(
      async (error: unknown) => {
        // An archive that was released or swept says so: the computer packs the folder again.
        throw (await this.archiveIdOf(target)) ? refuse('archive-expired') : error
      }
    )
    if (!found.info.isFile()) throw refuse('not-a-file')
    return found
  }

  async stat({ path: target }: FleetHostFileStatRequest): Promise<FleetHostFileStat> {
    const { real, info } = await this.file(target)
    return {
      path: real,
      name: path.basename(real),
      size: info.size,
      modifiedAt: Math.floor(info.mtimeMs),
      identity: fileIdentity(info),
    }
  }

  async digest({ path: target, identity }: FleetHostFileDigestRequest): Promise<FleetHostFileDigest> {
    const { real, info } = await this.file(target)
    if (fileIdentity(info) !== identity) throw refuse('changed')
    return { sha256: await hashFile(real, 0, info.size) }
  }

  async content(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const { real, info } = await this.file(url.searchParams.get('path') ?? '')
    if (request.headers[H.identity] !== fileIdentity(info)) throw refuse('changed')
    // An archive being read is in use: it outlives its time to live as long as it is.
    const archiveId = await this.archiveIdOf(real)
    if (archiveId) await this.touchArchive(archiveId)
    const range = parseRange(request.headers.range, info.size)
    if (range === 'invalid') {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    const start = range?.start ?? 0
    const length = range ? range.end - range.start + 1 : info.size
    // The hash goes in a header, before the body: a client that resumes needs it whatever proxy sits in between.
    const sha256 = await hashFile(real, start, length)
    const zstdBody =
      request.headers[H.acceptEncoding] === 'zstd' &&
      length >= MIN_COMPRESSED_BYTES &&
      (await compresses(real, start, Math.min(length, SAMPLE_BYTES)))
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` } : {}),
      ...(zstdBody ? { [H.encoding]: 'zstd' } : { 'Content-Length': length }),
      [H.sha256]: sha256,
      [H.length]: length,
    })
    if (!length) return void response.end()
    const source = createReadStream(real, { start, end: start + length - 1 })
    await (zstdBody ? pipeline(source, createZstdCompress(), response) : pipeline(source, response))
  }

  async beginUpload(input: FleetHostFileUploadBegin): Promise<FleetHostFileUpload> {
    const directory = await inside(input.directory, this.deps.roots())
    if (!directory.info.isDirectory()) throw refuse('not-a-directory')
    const kind = input.kind ?? 'file'
    const target = path.join(directory.real, input.name)
    // A folder takes the first free name when it is committed: a taken name is no reason to refuse it.
    if (kind === 'file') {
      const existing = await lstat(target).catch(() => null)
      if (existing && !existing.isFile()) throw refuse('not-a-file')
      if (existing && !input.overwrite) throw refuse('exists')
    }
    const uploadId = this.token()
    const partPath = path.join(directory.real, `.maestrly-upload-${uploadId}.part`)
    const handle = await open(partPath, 'wx', 0o644)
    try {
      await handle.truncate(input.size)
    } finally {
      await handle.close()
    }
    await this.save({
      uploadId,
      path: target,
      partPath,
      size: input.size,
      overwrite: kind === 'file' && input.overwrite,
      touchedAt: this.now(),
      kind,
    })
    return { uploadId, path: target, size: input.size }
  }

  async uploadChunk(request: IncomingMessage, response: ServerResponse, uploadId: string, url: URL): Promise<void> {
    const record = await this.record(uploadId)
    const offset = Number(url.searchParams.get('offset') ?? Number.NaN)
    const length = Number(request.headers[H.length] ?? Number.NaN)
    const expected = request.headers[H.sha256]
    const encoding = request.headers[H.encoding]
    const declared = Number(request.headers['content-length'] ?? Number.NaN)
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > FLEET_HOST_FILE_LIMITS.uploadChunkBytes ||
      offset + length > record.size
    )
      throw invalid('Invalid chunk range.')
    if (!fleetHostFileSha256Schema.safeParse(expected).success || (encoding !== undefined && encoding !== 'zstd'))
      throw invalid('Invalid chunk headers.')
    if (!Number.isSafeInteger(declared) || declared > length + FLEET_HOST_FILE_LIMITS.chunkBodySlackBytes)
      throw invalid('Invalid chunk size.')
    const handle = await open(record.partPath, 'r+').catch(async (error: unknown) => {
      if (errno(error) !== 'ENOENT') throw error
      await this.drop(record)
      throw refuse('unknown-upload')
    })
    try {
      const hash = createHash('sha256')
      let written = 0
      let overflow = false
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (overflow || written + chunk.length > length) {
            overflow = true
            return callback()
          }
          hash.update(chunk)
          writeAt(handle, chunk, offset + written).then(() => {
            written += chunk.length
            callback()
          }, callback)
        },
      })
      await (encoding === 'zstd' ? pipeline(request, createZstdDecompress(), sink) : pipeline(request, sink))
      if (overflow || written !== length || hash.digest('hex') !== expected) throw refuse('chunk-mismatch')
      await handle.datasync()
    } finally {
      await handle.close()
    }
    await this.save({ ...record, touchedAt: this.now() })
    response.writeHead(204)
    response.end()
  }

  /**
   * A commit asked for again, as a computer that lost the answer does, waits for the one that runs, or gets the answer
   * of the one that finished: never a second file or folder.
   */
  commitUpload(uploadId: string, input: FleetHostFileUploadCommit): Promise<FleetHostFileUploadResult> {
    const done = this.committed.get(uploadId)
    if (done && done.result.sha256 === input.sha256) return Promise.resolve(done.result)
    const running = this.commits.get(uploadId)
    if (running) return running
    const commit = this.commitOnce(uploadId, input)
      .then((result) => {
        for (const [id, entry] of this.committed) if (this.now() - entry.at > COMMITTED_MS) this.committed.delete(id)
        this.committed.set(uploadId, { result, at: this.now() })
        return result
      })
      .finally(() => this.commits.delete(uploadId))
    this.commits.set(uploadId, commit)
    return commit
  }

  private async commitOnce(uploadId: string, input: FleetHostFileUploadCommit): Promise<FleetHostFileUploadResult> {
    const record = await this.record(uploadId)
    const part = await stat(record.partPath).catch(() => null)
    if (!part || part.size !== record.size) {
      await this.drop(record)
      throw refuse('unknown-upload')
    }
    const sha256 = await hashFile(record.partPath, 0, record.size)
    if (sha256 !== input.sha256) {
      await this.drop(record)
      throw refuse('digest-mismatch')
    }
    if (record.kind === 'folder') return this.commitFolder(record, sha256)
    if (record.overwrite || input.overwrite === true) {
      const existing = await lstat(record.path).catch(() => null)
      if (existing && !existing.isFile()) throw refuse('not-a-file')
      await rename(record.partPath, record.path)
    } else {
      try {
        await link(record.partPath, record.path)
      } catch (error) {
        if (errno(error) !== 'EEXIST') throw error
        // The session stays: the person may choose to replace the file without sending it again.
        await this.save({ ...record, touchedAt: this.now() })
        throw refuse('exists')
      }
      await unlink(record.partPath)
    }
    await rm(this.manifest(uploadId), { force: true })
    return { path: record.path, size: record.size, sha256 }
  }

  async abortUpload(uploadId: string): Promise<void> {
    const record = await this.record(uploadId).catch(() => null)
    if (record) await this.drop(record)
  }

  /**
   * Extracts an uploaded folder beside its destination, then moves it to the first free name: a folder never
   * replaces another. An archive that cannot be extracted safely ends the session; a host out of space keeps it, so
   * the commit may be asked for again once there is room.
   */
  private async commitFolder(record: UploadRecord, sha256: string): Promise<FleetHostFileUploadResult> {
    const staging = this.extractPath(record)
    await rm(staging, { recursive: true, force: true })
    try {
      await extractArchive(record.partPath, staging)
    } catch (error) {
      if (error instanceof UnsafeArchiveError) {
        await this.drop(record)
        throw refuse('unsafe-archive')
      }
      await this.save({ ...record, touchedAt: this.now() })
      if (errno(error) === 'ENOSPC') throw refuse('no-space')
      throw error
    }
    let published: string
    try {
      published = await publishFolderExclusive(staging, path.dirname(record.path), path.basename(record.path))
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
    await this.drop(record)
    return { path: published, size: record.size, sha256 }
  }

  /**
   * Starts packing a folder of the roots; the archive is ready once its status says so. Packing runs apart from the
   * request: a computer that pauses finds it further along, and one that cancels releases it.
   */
  async beginArchive({ path: target }: FleetHostFileArchiveRequest): Promise<FleetHostFileArchiveBegin> {
    const folder = await inside(target, this.deps.roots())
    if (!folder.info.isDirectory()) throw refuse('not-a-directory')
    const archives = await this.archivesReal()
    const archiveId = this.token()
    const record: ArchiveRecord = {
      archiveId,
      path: path.join(archives, archiveId + ARCHIVE_SUFFIX),
      source: folder.real,
      touchedAt: this.now(),
    }
    // Known as running before its record exists: a sweep meanwhile must not take the record for a dead one.
    const job: ArchiveJob = {
      controller: new AbortController(),
      bytes: 0,
      totalBytes: 0,
      failure: null,
      done: Promise.resolve(),
    }
    this.jobs.set(archiveId, job)
    try {
      await this.saveArchive(record)
    } catch (error) {
      this.jobs.delete(archiveId)
      throw error
    }
    job.done = this.pack(record, job)
    return { archiveId }
  }

  /** How packing goes, or the archive once it is ready; a refusal once packing failed or the archive is gone. */
  async archiveStatus(archiveId: string): Promise<FleetHostFileArchive> {
    if (!fleetHostFileArchiveIdSchema.safeParse(archiveId).success) throw refuse('archive-expired')
    const job = this.jobs.get(archiveId)
    if (job?.failure) {
      this.jobs.delete(archiveId)
      throw job.failure
    }
    if (job) return { state: 'packing', archiveId, bytes: job.bytes, totalBytes: job.totalBytes }
    const record = await this.archiveRecord(archiveId)
    const info = record?.ready ? await stat(record.path).catch(() => null) : null
    if (!record?.ready || !info?.isFile()) {
      // Packing by a process that is gone: what it left is of no use.
      await this.dropArchive(archiveId)
      throw refuse('archive-expired')
    }
    await this.saveArchive({ ...record, touchedAt: this.now() })
    return {
      state: 'ready',
      archiveId,
      name: record.ready.name,
      path: record.path,
      size: info.size,
      identity: fileIdentity(info),
      entries: record.ready.entries,
    }
  }

  /** Stops packing and removes the archive; an unknown archive is already gone. */
  async releaseArchive(archiveId: string): Promise<void> {
    if (!fleetHostFileArchiveIdSchema.safeParse(archiveId).success) return
    const job = this.jobs.get(archiveId)
    if (job) {
      job.controller.abort()
      await job.done
      this.jobs.delete(archiveId)
    }
    await this.dropArchive(archiveId)
  }

  private async pack(record: ArchiveRecord, job: ArchiveJob): Promise<void> {
    const { signal } = job.controller
    try {
      const uploads = await realpath(this.deps.uploadsDir).catch(() => path.resolve(this.deps.uploadsDir))
      // A folder that holds the host's own archives would otherwise pack the archive being written.
      const scan = await scanFolder(record.source, { signal, exclude: [path.dirname(record.path), uploads] })
      job.totalBytes = scan.bytes
      const space = await statfs(path.dirname(record.path))
      const needed = scan.bytes + scan.entries.length * TAR_ENTRY_BYTES + ARCHIVE_SLACK_BYTES
      if (space.bavail * space.bsize < needed) throw refuse('no-space')
      const packed = await packFolder(record.source, record.path, {
        signal,
        scan,
        onProgress: (progress) => {
          job.bytes = progress.bytes
        },
      })
      const name = path.basename(record.source).replaceAll('\\', '_') || 'folder'
      await this.saveArchive({ ...record, touchedAt: this.now(), ready: { name, entries: packed.entries } })
      this.jobs.delete(record.archiveId)
    } catch (error) {
      await this.dropArchive(record.archiveId)
      if (signal.aborted) {
        this.jobs.delete(record.archiveId)
        return
      }
      job.failure =
        error instanceof InstanceHttpError
          ? error
          : errno(error) === 'ENOSPC'
            ? refuse('no-space')
            : new InstanceHttpError(
                409,
                'CONFLICT',
                `The host could not pack this folder: ${error instanceof Error ? error.message : String(error)}`
              )
    }
  }

  /**
   * Removes upload sessions nobody touched within the upload TTL, archives nobody read within the archive TTL, and
   * what packing or extracting left behind when the host stopped; returns how many.
   */
  async sweep(): Promise<number> {
    const names = await readdir(this.deps.uploadsDir).catch(() => [] as string[])
    let removed = 0
    for (const name of names) {
      const record = name.endsWith('.json') ? await this.record(name.slice(0, -5)).catch(() => null) : null
      if (record && this.now() - record.touchedAt > FLEET_HOST_FILE_LIMITS.uploadTtlMs) {
        await this.drop(record)
        removed++
      }
    }
    const archives = await readdir(this.deps.archivesDir).catch(() => [] as string[])
    for (const name of archives) {
      const archiveId = name.endsWith('.json')
        ? name.slice(0, -5)
        : name.endsWith(ARCHIVE_SUFFIX)
          ? name.slice(0, -ARCHIVE_SUFFIX.length)
          : null
      if (!archiveId || this.jobs.has(archiveId)) continue
      if (name.endsWith(ARCHIVE_SUFFIX)) {
        if (!archives.includes(`${archiveId}.json`)) {
          await rm(path.join(this.deps.archivesDir, name), { force: true })
          removed++
        }
        continue
      }
      const record = await this.archiveRecord(archiveId)
      if (!record?.ready || this.now() - record.touchedAt > FLEET_HOST_FILE_LIMITS.archiveTtlMs) {
        await this.dropArchive(archiveId)
        removed++
      }
    }
    for (const [archiveId, job] of this.jobs) if (job.failure) this.jobs.delete(archiveId)
    return removed
  }

  private manifest(uploadId: string): string {
    return path.join(this.deps.uploadsDir, `${uploadId}.json`)
  }
  private extractPath(record: UploadRecord): string {
    return path.join(path.dirname(record.partPath), `.maestrly-upload-${record.uploadId}.extract`)
  }
  private async save(record: UploadRecord): Promise<void> {
    await mkdir(this.deps.uploadsDir, { recursive: true, mode: 0o700 })
    // The chunks of one upload land in parallel, each recording the session again. Writing in place truncates the
    // manifest first, and a chunk that read it then found no session: the record is replaced whole instead.
    await replaceFile(this.manifest(record.uploadId), JSON.stringify(record))
  }
  private async record(uploadId: string): Promise<UploadRecord> {
    if (!fleetHostFileUploadIdSchema.safeParse(uploadId).success) throw refuse('unknown-upload')
    const text = await readFile(this.manifest(uploadId), 'utf8').catch(() => null)
    if (!text) throw refuse('unknown-upload')
    return JSON.parse(text) as UploadRecord
  }
  private async drop(record: UploadRecord): Promise<void> {
    await rm(record.partPath, { force: true })
    if (record.kind === 'folder') await rm(this.extractPath(record), { recursive: true, force: true })
    await rm(this.manifest(record.uploadId), { force: true })
  }

  private async archivesReal(): Promise<string> {
    await mkdir(this.deps.archivesDir, { recursive: true, mode: 0o700 })
    return realpath(this.deps.archivesDir)
  }
  private archiveManifest(archiveId: string): string {
    return path.join(this.deps.archivesDir, `${archiveId}.json`)
  }
  /** The archive a path names, read through the archives folder as written or as resolved; null for other paths. */
  private async archiveIdOf(target: string): Promise<string | null> {
    if (typeof target !== 'string' || !path.isAbsolute(target)) return null
    const name = path.basename(target)
    if (!name.endsWith(ARCHIVE_SUFFIX)) return null
    const archiveId = name.slice(0, -ARCHIVE_SUFFIX.length)
    if (!fleetHostFileArchiveIdSchema.safeParse(archiveId).success) return null
    const folder = path.dirname(path.resolve(target))
    const archives = path.resolve(this.deps.archivesDir)
    if (folder === archives) return archiveId
    return folder === (await realpath(archives).catch(() => null)) ? archiveId : null
  }
  private async saveArchive(record: ArchiveRecord): Promise<void> {
    await mkdir(this.deps.archivesDir, { recursive: true, mode: 0o700 })
    await replaceFile(this.archiveManifest(record.archiveId), JSON.stringify(record))
  }
  private async archiveRecord(archiveId: string): Promise<ArchiveRecord | null> {
    const text = await readFile(this.archiveManifest(archiveId), 'utf8').catch(() => null)
    if (!text) return null
    try {
      return JSON.parse(text) as ArchiveRecord
    } catch {
      return null
    }
  }
  private async touchArchive(archiveId: string): Promise<void> {
    const record = await this.archiveRecord(archiveId)
    if (record) await this.saveArchive({ ...record, touchedAt: this.now() })
  }
  private async dropArchive(archiveId: string): Promise<void> {
    await rm(path.join(this.deps.archivesDir, archiveId + ARCHIVE_SUFFIX), { force: true })
    await rm(this.archiveManifest(archiveId), { force: true })
  }
}

/** Replaces a small file whole, so a reader finds either version and never an empty one. */
async function replaceFile(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
