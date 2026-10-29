import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import {
  type FleetRunnerJob,
  type FleetRunnerJobSpec,
  type FleetRunnerJobState,
  fleetRunnerJobSpecSchema,
} from '@maestrly/bot-fleet-protocol'
import tar from 'tar-stream'
import type { RunnerJobRecord } from '../../src/main/fleet/instance/runner-jobs/records'

/** Shared by the tests of the bot environment's runner job files. */

export const JOB_ID = 'job_AAAAAAAAAAAAAAAA0001'
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

const roots: string[] = []
/** A fresh real temp folder, removed by `cleanTemps`. */
export function tempFolder(prefix = 'runner-jobs-'): string {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))
  roots.push(folder)
  return folder
}
export function cleanTemps(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export function jobSpec(
  folder: string,
  extra: Partial<Record<keyof FleetRunnerJobSpec, unknown>> = {}
): FleetRunnerJobSpec {
  return fleetRunnerJobSpecSchema.parse({ folder, command: 'true', outputs: ['out/**'], ...extra })
}

export function runnerJob(
  jobId: string,
  state: FleetRunnerJobState,
  extra: Partial<FleetRunnerJob> = {}
): FleetRunnerJob {
  const ended = !['queued', 'assigned', 'running', 'finishing'].includes(state)
  return {
    jobId,
    botId: 'alpha',
    runnerId: 'rnr_AAAAAAAAAAAAAAAA0001',
    runnerName: 'Studio',
    state,
    requires: {},
    cancelRequested: false,
    createdAt: '2026-10-29T10:00:00.000Z',
    queueDeadline: '2026-10-29T11:00:00.000Z',
    assignedAt: null,
    startedAt: null,
    endedAt: ended ? '2026-10-29T10:30:00.000Z' : null,
    exitCode: state === 'succeeded' ? 0 : null,
    error: null,
    ...extra,
  }
}

export function runnerRecord(folder: string, extra: Partial<RunnerJobRecord> = {}): RunnerJobRecord {
  return {
    jobId: JOB_ID,
    conversationId: 'conversation-1',
    conversation: { kind: 'primary' },
    folder,
    spec: jobSpec(folder),
    createdAt: '2026-10-29T10:00:00.000Z',
    job: null,
    outputs: null,
    continued: false,
    ...extra,
  }
}

export type CraftedEntry = Partial<tar.Header> & Pick<tar.Header, 'name'> & { content?: string | Buffer }

/** A zstd tar written entry by entry, as the runner (or an attacker posing as one) could write it. */
export async function craftArchive(file: string, entries: CraftedEntry[]): Promise<void> {
  const pack = tar.pack()
  const written = pipeline(pack, createZstdCompress(), createWriteStream(file))
  for (const { content, ...header } of entries)
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null) => (error ? reject(error) : resolve())
      if (content !== undefined) pack.entry(header, content, done)
      else pack.entry(header, done)
    })
  pack.finalize()
  await written
}

/** A writable that keeps what it receives. */
export function collector(): { sink: Writable; bytes: () => Buffer; done: Promise<void> } {
  const sink = new PassThrough()
  const chunks: Buffer[] = []
  sink.on('data', (chunk: Buffer) => chunks.push(chunk))
  const done = new Promise<void>((resolve, reject) => {
    sink.on('end', resolve)
    sink.on('error', reject)
  })
  return { sink, bytes: () => Buffer.concat(chunks), done }
}

/** The entries of a zstd tar, in order. */
export async function untar(
  archive: Buffer
): Promise<Array<{ name: string; type: string | null | undefined; content: Buffer }>> {
  const extract = tar.extract()
  const entries: Array<{ name: string; type: string | null | undefined; content: Buffer }> = []
  extract.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: unknown) => chunks.push(chunk as Buffer))
    stream.on('end', () => {
      entries.push({ name: header.name, type: header.type, content: Buffer.concat(chunks) })
      next()
    })
    stream.resume()
  })
  await pipeline(Readable.from([archive]), createZstdDecompress(), extract as unknown as Writable)
  return entries
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split('/'))
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
}
