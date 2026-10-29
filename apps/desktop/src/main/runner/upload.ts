import { FLEET_RUNNER_LIMITS, FLEET_RUNNER_TRANSFER_LIMITS } from '@maestrly/bot-fleet-protocol'
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { readAt } from '../transfer-io'
import { isTransientApiError, RunnerApiError, type RunnerJobApi } from './api'
import { RunnerJobError } from './errors'
import { abortableSleep } from './sleep'

export interface RunnerUploadOptions {
  /** Aborts the upload, for example when the job is cancelled. */
  signal: AbortSignal
  /** Bytes per chunk. */
  chunkBytes?: number
  /** How long to keep trying while the environment does not answer. */
  deadlineMs?: number
  /** Milliseconds to wait before retry number `attempt` (0 for the first). */
  backoff?: (attempt: number) => number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Conflicts in a row, with no chunk accepted between, before the upload gives up. */
const CONFLICTS_MAX = 5

const defaultBackoff = (attempt: number): number => Math.min(60_000, 1_000 * 2 ** attempt)

/**
 * Sends the output archive `file` (its `bytes` and `sha256`) to the job's environment and commits it. It asks the
 * environment how much it holds and goes on from there, so an interrupted upload resumes; each chunk travels with its
 * SHA-256 at an explicit offset. A 409 means the offsets disagree: the status is read again. When the environment does
 * not answer, it waits with growing pauses and tries again until `deadlineMs` has passed since the first failure, then
 * fails with code `outputs_undelivered`.
 */
export async function uploadRunnerOutputs(
  api: RunnerJobApi,
  jobId: string,
  file: string,
  archive: { bytes: number; sha256: string },
  options: RunnerUploadOptions
): Promise<void> {
  const { signal } = options
  const chunkBytes = options.chunkBytes ?? FLEET_RUNNER_LIMITS.outputChunkBytes
  const deadlineMs = options.deadlineMs ?? FLEET_RUNNER_TRANSFER_LIMITS.outputDeliveryMs
  const backoff = options.backoff ?? defaultBackoff
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? abortableSleep
  const handle = await open(file, 'r')
  try {
    let received: number | null = null
    let failingSince: number | null = null
    let retries = 0
    let conflicts = 0
    for (;;) {
      signal.throwIfAborted()
      try {
        if (received === null) {
          received = (await api.outputsStatus(jobId, signal)).received
          // More than there is to send: what the environment holds is not this archive. Start over.
          if (received > archive.bytes) received = 0
        }
        while (received < archive.bytes) {
          const chunk = await readAt(handle, Math.min(chunkBytes, archive.bytes - received), received)
          await api.outputChunk(jobId, received, chunk, createHash('sha256').update(chunk).digest('hex'), signal)
          received += chunk.length
          failingSince = null
          retries = 0
          conflicts = 0
        }
        await api.outputCommit(jobId, { bytes: archive.bytes, sha256: archive.sha256 }, signal)
        return
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof RunnerApiError && error.status === 409) {
          if (++conflicts > CONFLICTS_MAX)
            throw new RunnerJobError('transfer_failed', `The environment refused the job's outputs: ${error.message}`)
          received = null
          continue
        }
        if (!isTransientApiError(error)) throw error
        failingSince ??= now()
        const wait = backoff(retries++)
        if (now() + wait - failingSince > deadlineMs)
          throw new RunnerJobError(
            'outputs_undelivered',
            `The job's outputs could not be delivered to its environment: ${(error as Error).message}`
          )
        await sleep(wait, signal)
        received = null
      }
    }
  } finally {
    await handle.close()
  }
}
