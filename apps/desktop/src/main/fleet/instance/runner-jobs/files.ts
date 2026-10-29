import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  FLEET_RUNNER_JOB_FINAL_STATES,
  FLEET_RUNNER_LIMITS,
  type FleetRunnerJob,
  type FleetRunnerManifest,
  fleetRunnerManifestSchema,
  fleetRunnerJobIdSchema,
} from '@maestrly/bot-fleet-protocol'
import { realFs } from '../../../real-fs'
import { packRunnerBlobs } from './blobs'
import { writeRunnerLog } from './log'
import { buildRunnerManifest, loadRunnerManifest, type RunnerBlobs, saveRunnerManifest } from './manifest'
import { RunnerOutputs } from './outputs'
import type { RunnerJobRecord, RunnerJobRecords } from './records'
import { conflict, ensureRunnerStateFolder, invalid, RUNNER_JOB_FILES, unknownJob } from './shared'

const fs = realFs.promises
/** Manifests kept in memory for the blobs requests that follow them. */
const MANIFESTS_KEPT = 8

const isFinal = (job: FleetRunnerJob): boolean => FLEET_RUNNER_JOB_FINAL_STATES.includes(job.state)

/**
 * A bot's runner jobs as the bot's environment serves them to the gateway: it builds a job folder's manifest, packs the
 * blobs a runner asks for, receives the job's log and outputs, and keeps the state the gateway reports. Every call
 * names a job by its id and answers `InstanceHttpError` for what the caller got wrong.
 */
export class RunnerJobFiles {
  private readonly records: RunnerJobRecords
  private readonly botFolder: string
  private onState: ((record: RunnerJobRecord) => Promise<void> | void) | undefined
  private readonly receivers = new Map<string, RunnerOutputs>()
  private readonly manifests = new Map<string, RunnerBlobs>()

  constructor(deps: {
    records: RunnerJobRecords
    /** The bot's own folder, where the digest index of each job folder is kept. */
    botFolder: string
    onState?: (record: RunnerJobRecord) => Promise<void> | void
  }) {
    this.records = deps.records
    this.botFolder = deps.botFolder
    this.onState = deps.onState
  }

  /** Sets what runs after a job's state is stored, so the bot's runtime can tell the conversation. */
  setOnState(hook: (record: RunnerJobRecord) => Promise<void> | void): void {
    this.onState = hook
  }

  /** Deletes the records of jobs that ended a week ago (`FLEET_RUNNER_LIMITS.endedRetentionMs`). */
  async sweep(now: number = Date.now()): Promise<void> {
    await this.records.sweep(now, FLEET_RUNNER_LIMITS.endedRetentionMs)
  }

  private async record(jobId: string): Promise<RunnerJobRecord> {
    if (!fleetRunnerJobIdSchema.safeParse(jobId).success) throw unknownJob()
    const record = await this.records.get(jobId)
    if (!record) throw unknownJob()
    return record
  }

  private receiver(jobId: string): RunnerOutputs {
    let receiver = this.receivers.get(jobId)
    if (!receiver) {
      receiver = new RunnerOutputs(jobId, this.records.dir(jobId))
      this.receivers.set(jobId, receiver)
    }
    return receiver
  }

  private remember(jobId: string, blobs: RunnerBlobs): void {
    this.manifests.delete(jobId)
    this.manifests.set(jobId, blobs)
    for (const [id] of this.manifests) {
      if (this.manifests.size <= MANIFESTS_KEPT) break
      this.manifests.delete(id)
    }
  }

  /**
   * Stores the state the gateway reports for a job. A job that ended stays ended: a later report of a state it left
   * is ignored. When a job ends, the log received so far is copied into its folder at
   * `.maestrly/runner-jobs/<jobId>.log` (best effort); then the `onState` hook runs, and its failure fails the call so
   * the gateway sends the state again.
   */
  async state(jobId: string, job: FleetRunnerJob): Promise<void> {
    if (job.jobId !== jobId) throw invalid('The job does not match its path.')
    await this.record(jobId)
    let ignored = false
    const record = await this.records.update(jobId, (current) => {
      if (current.job && isFinal(current.job) && !isFinal(job)) {
        ignored = true
        return current
      }
      return { ...current, job }
    })
    if (ignored) return
    if (isFinal(job)) {
      await this.copyLog(record).catch((error: unknown) =>
        console.warn(`[fleet] could not copy the log of runner job ${jobId} into its folder`, error)
      )
      await this.release(jobId).catch((error: unknown) =>
        console.warn(`[fleet] could not clear the transfer files of runner job ${jobId}`, error)
      )
    }
    await this.onState?.(record)
  }

  /** What a job that ended no longer needs: its manifest, and an output archive that never got whole. */
  private async release(jobId: string): Promise<void> {
    this.manifests.delete(jobId)
    await this.receiver(jobId).discardPart()
    this.receivers.delete(jobId)
    await fs.rm(path.join(this.records.dir(jobId), RUNNER_JOB_FILES.manifest), { force: true })
  }

  private async copyLog(record: RunnerJobRecord): Promise<void> {
    const source = path.join(this.records.dir(record.jobId), RUNNER_JOB_FILES.log)
    if (!(await fs.stat(source).catch(() => null))) return
    const root = await fs.realpath(record.folder)
    const target = path.join(await ensureRunnerStateFolder(root), `${record.jobId}.log`)
    // The runner's own copy, which came with its outputs, is whole when ours is not.
    const [ours, theirs] = await Promise.all([fs.stat(source), fs.stat(target).catch(() => null)])
    if (theirs?.isFile() && theirs.size >= ours.size) return
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await fs.copyFile(source, temporary)
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.rm(temporary, { force: true })
      throw error
    }
  }

  /** Walks the job's folder again and describes it; the blobs of this manifest are the ones that can be asked for. */
  async manifest(jobId: string, signal?: AbortSignal): Promise<FleetRunnerManifest> {
    const record = await this.record(jobId)
    const indexFile = path.join(
      this.botFolder,
      'runner-digests',
      `${createHash('sha1').update(record.folder).digest('hex')}.json`
    )
    const built = await buildRunnerManifest({ jobId, folder: record.folder, spec: record.spec, indexFile, signal })
    const manifest = fleetRunnerManifestSchema.parse(built.manifest)
    await saveRunnerManifest(path.join(this.records.dir(jobId), RUNNER_JOB_FILES.manifest), manifest)
    this.remember(jobId, built.blobs)
    return manifest
  }

  /** Packs the blobs of the job's manifest into `output`; see `packRunnerBlobs` for what is refused. */
  async blobs(jobId: string, digests: string[], output: Writable, signal?: AbortSignal): Promise<void> {
    const record = await this.record(jobId)
    let blobs = this.manifests.get(jobId)
    if (!blobs) {
      const saved = await loadRunnerManifest(path.join(this.records.dir(jobId), RUNNER_JOB_FILES.manifest))
      if (!saved) throw conflict('Ask for the job manifest first.')
      blobs = saved.blobs
      this.remember(jobId, blobs)
    }
    await packRunnerBlobs({ folder: record.folder, blobs, digests, output, ...(signal ? { signal } : {}) })
  }

  /** Writes a batch of the job's log at `offset`. */
  async log(jobId: string, offset: number, body: Readable): Promise<void> {
    await this.record(jobId)
    await writeRunnerLog(
      path.join(this.records.dir(jobId), RUNNER_JOB_FILES.log),
      offset,
      body,
      FLEET_RUNNER_LIMITS.logBatchBytesMax
    )
  }

  /** How much of the job's output archive is here. */
  async outputs(jobId: string): Promise<{ received: number }> {
    await this.record(jobId)
    return await this.receiver(jobId).status()
  }

  /** Stores a chunk of the output archive at `offset`. */
  async outputChunk(jobId: string, offset: number, body: Readable, sha256: string, length: number): Promise<void> {
    await this.record(jobId)
    await this.receiver(jobId).chunk(offset, body, sha256, length)
  }

  /** Puts the output archive's files into the job folder and records what arrived. */
  async outputCommit(jobId: string, commit: { bytes: number; sha256: string }): Promise<void> {
    const record = await this.record(jobId)
    const result = await this.receiver(jobId).commit(commit, record.folder)
    await this.records.update(jobId, (current) => ({
      ...current,
      outputs: { files: result.files, bytes: result.bytes, sha256: result.sha256 },
    }))
  }
}
