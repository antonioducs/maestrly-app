import path from 'node:path'
import {
  FLEET_RUNNER_JOB_FINAL_STATES,
  type FleetRunnerJob,
  type FleetRunnerJobSpec,
  fleetRunnerJobIdSchema,
  fleetRunnerJobSchema,
  fleetRunnerJobSpecSchema,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { realFs } from '../../../real-fs'
import { errno, KeyedSerial, RUNNER_JOB_FILES, unknownJob, writeFileAtomically } from './shared'

const fs = realFs.promises

/** The conversation that submitted a job, which the job's result continues. */
export type RunnerJobConversation =
  | { kind: 'primary' }
  | { kind: 'run'; runId: string }
  | { kind: 'thread'; threadId: string; title: string }

/** What a bot's environment keeps of one job: where it came from, what was asked, where it stands and what came back. */
export type RunnerJobRecord = {
  jobId: string
  /** The conversation that submitted the job. */
  conversationId: string
  conversation: RunnerJobConversation
  /** The absolute real path of the job folder in this environment. */
  folder: string
  /** As submitted. */
  spec: FleetRunnerJobSpec
  createdAt: string
  /** The latest state the gateway sent. */
  job: FleetRunnerJob | null
  /** Once the runner's outputs are committed. */
  outputs: { files: Array<{ path: string; size: number }>; bytes: number; sha256: string } | null
  /** The conversation was told of the final state. */
  continued: boolean
}

const recordSchema = z.object({
  jobId: fleetRunnerJobIdSchema,
  conversationId: z.string().min(1),
  conversation: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('primary') }),
    z.object({ kind: z.literal('run'), runId: z.string().min(1) }),
    z.object({ kind: z.literal('thread'), threadId: z.string().min(1), title: z.string() }),
  ]),
  folder: z.string().min(1),
  spec: fleetRunnerJobSpecSchema,
  createdAt: z.string().min(1),
  job: fleetRunnerJobSchema.nullable(),
  outputs: z
    .object({
      files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() })),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable(),
  continued: z.boolean(),
})

const isFinal = (job: FleetRunnerJob | null): boolean => !!job && FLEET_RUNNER_JOB_FINAL_STATES.includes(job.state)

/**
 * A bot's runner jobs on disk, `<folder>/<jobId>/record.json` beside the files the job keeps (its manifest, log and
 * received outputs). Writes are atomic and one job's are serialized.
 */
export class RunnerJobRecords {
  private readonly serial = new KeyedSerial()

  /** `folder` is the bot's `runner-jobs` folder. */
  constructor(private readonly folder: string) {}

  /** The folder of a job's files; throws for an id that is not a job id. */
  dir(jobId: string): string {
    if (!fleetRunnerJobIdSchema.safeParse(jobId).success)
      throw new TypeError(`Invalid job id ${JSON.stringify(jobId)}.`)
    return path.join(this.folder, jobId)
  }

  /** Stores a new record; a job id is minted once, so an existing record is an error. */
  async create(record: RunnerJobRecord): Promise<void> {
    const parsed = recordSchema.parse(record)
    await this.serial.run(parsed.jobId, async () => {
      if (await this.read(parsed.jobId)) throw new Error(`Runner job ${parsed.jobId} already has a record.`)
      await this.write(parsed)
    })
  }

  /** The record of a job, or null when there is none (or it is unreadable, or the id is not a job id). */
  async get(jobId: string): Promise<RunnerJobRecord | null> {
    if (!fleetRunnerJobIdSchema.safeParse(jobId).success) return null
    return await this.read(jobId)
  }

  /**
   * Changes a record. `change` gets the stored one and answers the new one, or the same object to leave it as it is;
   * calls on one job run one after another. Throws when the job has no record.
   */
  async update(jobId: string, change: (record: RunnerJobRecord) => RunnerJobRecord): Promise<RunnerJobRecord> {
    this.dir(jobId)
    return await this.serial.run(jobId, async () => {
      const current = await this.read(jobId)
      if (!current) throw unknownJob()
      const next = change(current)
      if (next === current) return current
      const parsed = recordSchema.parse({ ...next, jobId })
      await this.write(parsed)
      return parsed
    })
  }

  /** Every record, newest first. */
  async list(): Promise<RunnerJobRecord[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.folder)
    } catch (error) {
      if (errno(error) === 'ENOENT') return []
      throw error
    }
    const records = await Promise.all(names.map((name) => this.get(name)))
    return records
      .filter((record): record is RunnerJobRecord => !!record)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId))
  }

  /** Deletes a job's record with everything it kept. */
  async remove(jobId: string): Promise<void> {
    const dir = this.dir(jobId)
    await this.serial.run(jobId, () => fs.rm(dir, { recursive: true, force: true }))
  }

  /**
   * Deletes the records of jobs that ended, or never got a state from the gateway, more than `retentionMs` ago, with
   * the files they kept. The gateway forgets such jobs after as long.
   */
  async sweep(now: number, retentionMs: number): Promise<void> {
    for (const record of await this.list()) {
      const ended = isFinal(record.job)
      if (!ended && record.job) continue
      const since = Date.parse((ended ? record.job?.endedAt : null) ?? record.createdAt)
      if (Number.isFinite(since) && now - since > retentionMs) await this.remove(record.jobId)
    }
  }

  private async read(jobId: string): Promise<RunnerJobRecord | null> {
    let text: string
    try {
      text = await fs.readFile(path.join(this.folder, jobId, RUNNER_JOB_FILES.record), 'utf8')
    } catch (error) {
      if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') return null
      throw error
    }
    try {
      const record = recordSchema.parse(JSON.parse(text))
      return record.jobId === jobId ? record : null
    } catch {
      return null
    }
  }

  private async write(record: RunnerJobRecord): Promise<void> {
    await writeFileAtomically(path.join(this.folder, record.jobId, RUNNER_JOB_FILES.record), JSON.stringify(record))
  }
}
