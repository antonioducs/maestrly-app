import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import type {
  FleetRunnerJobFinishRequest,
  FleetRunnerJobUsageRequest,
  FleetRunnerManifest,
  FleetRunnerOutputCommit,
  FleetRunnerStateRequest,
  FleetRunnerStateResponse,
} from '@maestrly/bot-fleet-protocol'
import tar from 'tar-stream'
import { scanFolder } from '../../src/main/folder-archive'
import { RunnerApiError, type RunnerJobApi } from '../../src/main/runner/api'

/** Shared by the tests of the runner core. */

/**
 * Each test file gets ids of its own: a native job's processes are found by the id in their environment, and test
 * files that run at the same time must not find each other's.
 */
const UNIQUE = randomBytes(5).toString('hex')
export const JOB_ID = `job_RunnerCoreTest${UNIQUE}1`
export const SECOND_JOB_ID = `job_RunnerCoreTest${UNIQUE}2`
export const sha256Hex = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

const roots: string[] = []
/** A fresh real temp folder, removed by `cleanTempDirs`. */
export function tempDir(prefix = 'runner-core-'): string {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))
  roots.push(folder)
  return folder
}
export function cleanTempDirs(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export type TarEntry = Partial<tar.Header> & Pick<tar.Header, 'name'> & { content?: string | Buffer }

/** A tar compressed with zstd, written entry by entry. */
export async function zstdTar(entries: TarEntry[]): Promise<Buffer> {
  const pack = tar.pack()
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', (chunk: Buffer) => chunks.push(chunk))
  const written = pipeline(pack, createZstdCompress(), out)
  for (const { content, ...header } of entries)
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null) => (error ? reject(error) : resolve())
      if (content !== undefined) pack.entry(header, content, done)
      else pack.entry(header, done)
    })
  pack.finalize()
  await written
  return Buffer.concat(chunks)
}

/** The entries of a tar compressed with zstd, read back. */
export async function readZstdTar(
  bytes: Buffer
): Promise<Array<{ name: string; type: string; mode: number; linkname: string | null; content: Buffer }>> {
  const extract = tar.extract()
  const found: Array<{ name: string; type: string; mode: number; linkname: string | null; content: Buffer }> = []
  extract.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: unknown) => chunks.push(chunk as Buffer))
    stream.on('end', () => {
      found.push({
        name: header.name,
        type: header.type ?? 'file',
        mode: header.mode ?? 0,
        linkname: header.linkname ?? null,
        content: Buffer.concat(chunks),
      })
      next()
    })
    stream.resume()
  })
  await pipeline(Readable.from([bytes]), createZstdDecompress(), extract as unknown as NodeJS.WritableStream)
  return found
}

/** What a bot's environment would serve for a folder: its manifest and the content of each file by digest. */
export async function environmentOfFolder(
  folder: string,
  jobId = JOB_ID
): Promise<{ manifest: FleetRunnerManifest; blobs: Map<string, Buffer> }> {
  const scan = await scanFolder(folder)
  const blobs = new Map<string, Buffer>()
  let bytes = 0
  const entries: FleetRunnerManifest['entries'] = scan.entries.map((entry) => {
    if (entry.kind === 'directory') return { kind: 'directory', path: entry.relative, mode: entry.mode }
    if (entry.kind === 'symlink') return { kind: 'symlink', path: entry.relative, target: entry.target! }
    const content = readFileSync(path.join(folder, ...entry.relative.split('/')))
    const sha256 = sha256Hex(content)
    blobs.set(sha256, content)
    bytes += content.length
    return { kind: 'file', path: entry.relative, mode: entry.mode, size: content.length, sha256 }
  })
  return { manifest: { jobId, entries, bytes, skipped: scan.skipped }, blobs }
}

export const archiveOfBlobs = (digests: readonly string[], blobs: ReadonlyMap<string, Buffer>): Promise<Buffer> =>
  zstdTar(digests.map((digest) => ({ name: digest, content: blobs.get(digest) ?? Buffer.alloc(0) })))

type Method = keyof RunnerJobApi
export type ApiFault = (call: { method: Method; args: unknown[] }) => Error | undefined | Promise<Error | undefined>

/**
 * A runner's gateway and a bot's environment in memory: it serves a job's manifest and blobs, and keeps what the runner
 * sends back (log, output archive, commit, result) with the same offset rules as the real routes.
 */
export class FakeRunnerApi implements RunnerJobApi {
  readonly reports: FleetRunnerStateRequest[] = []
  readonly calls: Array<{ method: Method; jobId?: string }> = []
  readonly accepted: string[] = []
  readonly progressed: string[] = []
  readonly finished: Array<{ jobId: string; result: FleetRunnerJobFinishRequest }> = []
  readonly usages: Array<{ jobId: string; sample: FleetRunnerJobUsageRequest }> = []
  readonly blobRequests: string[][] = []
  readonly logBatches: Array<{ offset: number; length: number }> = []
  logBytes = Buffer.alloc(0)
  outputBytes = Buffer.alloc(0)
  commit: FleetRunnerOutputCommit | null = null
  /** The jobs the answer to a state report tells the runner to stop. */
  stop: string[] = []
  /** Called before every method; returns an error to fail the call with. */
  fault: ApiFault | undefined
  /** How many of the next blob answers get their first blob corrupted. */
  corruptBlobAnswers = 0
  private readonly environments = new Map<string, { manifest: FleetRunnerManifest; blobs: Map<string, Buffer> }>()

  serve(jobId: string, environment: { manifest: FleetRunnerManifest; blobs: Map<string, Buffer> }): void {
    this.environments.set(jobId, environment)
  }

  private async enter(method: Method, jobId: string | undefined, args: unknown[]): Promise<void> {
    this.calls.push({ method, jobId })
    const error = await this.fault?.({ method, args })
    if (error) throw error
  }
  private environment(jobId: string) {
    const environment = this.environments.get(jobId)
    if (!environment) throw new RunnerApiError(404, 'NOT_FOUND', 'No such job', false)
    return environment
  }

  async report(state: FleetRunnerStateRequest): Promise<FleetRunnerStateResponse> {
    await this.enter('report', undefined, [state])
    this.reports.push(structuredClone(state))
    return { stop: [...this.stop] }
  }
  async accept(jobId: string): Promise<void> {
    await this.enter('accept', jobId, [])
    this.accepted.push(jobId)
  }
  async progress(jobId: string): Promise<void> {
    await this.enter('progress', jobId, [])
    this.progressed.push(jobId)
  }
  async finish(jobId: string, result: FleetRunnerJobFinishRequest): Promise<void> {
    await this.enter('finish', jobId, [result])
    this.finished.push({ jobId, result })
  }
  async usage(jobId: string, sample: FleetRunnerJobUsageRequest): Promise<void> {
    await this.enter('usage', jobId, [sample])
    this.usages.push({ jobId, sample: structuredClone(sample) })
  }
  async manifest(jobId: string): Promise<FleetRunnerManifest> {
    await this.enter('manifest', jobId, [])
    return this.environment(jobId).manifest
  }
  async blobs(jobId: string, digests: readonly string[]): Promise<Readable> {
    await this.enter('blobs', jobId, [digests])
    this.blobRequests.push([...digests])
    const { blobs } = this.environment(jobId)
    const corrupt = this.corruptBlobAnswers > 0
    if (corrupt) this.corruptBlobAnswers--
    const served = new Map(blobs)
    if (corrupt && digests[0]) served.set(digests[0], Buffer.from(`corrupt ${served.get(digests[0])?.length ?? 0}`))
    return Readable.from([await archiveOfBlobs(digests, served)])
  }
  async log(jobId: string, offset: number, bytes: Buffer): Promise<void> {
    await this.enter('log', jobId, [offset, bytes])
    if (offset > this.logBytes.length) throw new RunnerApiError(409, 'CONFLICT', 'Offset past the log', false)
    this.logBatches.push({ offset, length: bytes.length })
    this.logBytes = Buffer.concat([this.logBytes.subarray(0, offset), bytes])
  }
  async outputsStatus(jobId: string): Promise<{ received: number }> {
    await this.enter('outputsStatus', jobId, [])
    return { received: this.outputBytes.length }
  }
  async outputChunk(jobId: string, offset: number, bytes: Buffer, sha256: string): Promise<void> {
    await this.enter('outputChunk', jobId, [offset, bytes, sha256])
    if (offset > this.outputBytes.length) throw new RunnerApiError(409, 'CONFLICT', 'Offset past the upload', false)
    if (sha256Hex(bytes) !== sha256) throw new RunnerApiError(400, 'INVALID_REQUEST', 'Chunk digest mismatch', false)
    this.outputBytes = Buffer.concat([this.outputBytes.subarray(0, offset), bytes])
  }
  async outputCommit(jobId: string, commit: FleetRunnerOutputCommit): Promise<void> {
    await this.enter('outputCommit', jobId, [commit])
    if (commit.bytes !== this.outputBytes.length || commit.sha256 !== sha256Hex(this.outputBytes))
      throw new RunnerApiError(409, 'CONFLICT', 'The upload does not match its commit', false)
    this.commit = commit
  }
}

export const transient = (message = 'The environment is unavailable'): RunnerApiError =>
  new RunnerApiError(503, 'INSTANCE_UNAVAILABLE', message, true)

/** Writes files into a folder: `name` may contain folders. */
export function writeFiles(folder: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(folder, ...name.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
}
