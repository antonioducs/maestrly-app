import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
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
  type FleetHostFileDigest,
  type FleetHostFileDigestRequest,
  type FleetHostFileErrorReason,
  type FleetHostFileStat,
  type FleetHostFileStatRequest,
  type FleetHostFileUpload,
  type FleetHostFileUploadBegin,
  type FleetHostFileUploadCommit,
  type FleetHostFileUploadResult,
  fleetHostFileSha256Schema,
  fleetHostFileUploadIdSchema,
} from '@maestrly/bot-fleet-protocol'
import { InstanceHttpError } from '../../fleet/instance/server'
import { fileIdentity, hashFile, readAt, writeAt } from '../../transfer-io'
import { resolveInside } from '../host-fs'

const zstd = promisify(zstdCompress)
const SAMPLE_BYTES = 128 * 1024
const MIN_COMPRESSED_BYTES = 64 * 1024
// A range is only compressed when its sample shrinks well; zstd on incompressible bytes costs CPU for nothing.
const COMPRESSION_WORTH = 0.8

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
 * its record survives a restart of the host.
 */
export class HostFiles {
  private readonly now: () => number
  private readonly token: () => string

  constructor(private readonly deps: HostFilesDeps) {
    this.now = deps.now ?? Date.now
    this.token = deps.token ?? (() => randomBytes(24).toString('base64url'))
  }

  private async file(target: string) {
    const found = await inside(target, [...this.deps.roots(), ...this.deps.readRoots()])
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
    const target = path.join(directory.real, input.name)
    const existing = await lstat(target).catch(() => null)
    if (existing && !existing.isFile()) throw refuse('not-a-file')
    if (existing && !input.overwrite) throw refuse('exists')
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
      overwrite: input.overwrite,
      touchedAt: this.now(),
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

  async commitUpload(uploadId: string, input: FleetHostFileUploadCommit): Promise<FleetHostFileUploadResult> {
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

  /** Removes upload sessions nobody touched within the upload TTL; returns how many. */
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
    return removed
  }

  private manifest(uploadId: string): string {
    return path.join(this.deps.uploadsDir, `${uploadId}.json`)
  }
  private async save(record: UploadRecord): Promise<void> {
    await mkdir(this.deps.uploadsDir, { recursive: true, mode: 0o700 })
    // The chunks of one upload land in parallel, each recording the session again. Writing in place truncates the
    // manifest first, and a chunk that read it then found no session: the record is replaced whole instead.
    const manifest = this.manifest(record.uploadId)
    const temporary = `${manifest}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
      await rename(temporary, manifest)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
  private async record(uploadId: string): Promise<UploadRecord> {
    if (!fleetHostFileUploadIdSchema.safeParse(uploadId).success) throw refuse('unknown-upload')
    const text = await readFile(this.manifest(uploadId), 'utf8').catch(() => null)
    if (!text) throw refuse('unknown-upload')
    return JSON.parse(text) as UploadRecord
  }
  private async drop(record: UploadRecord): Promise<void> {
    await rm(record.partPath, { force: true })
    await rm(this.manifest(record.uploadId), { force: true })
  }
}
