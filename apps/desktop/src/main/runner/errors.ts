import type { FleetRunnerErrorCode } from '@maestrly/bot-fleet-protocol'

/** A step of a job failed for a reason the gateway has a code for: the job ends with this code and message. */
export class RunnerJobError extends Error {
  constructor(
    readonly code: FleetRunnerErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RunnerJobError'
  }
}

/** The errno code of a file system error, if it is one. */
export const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

/** Whether an error means the disk is full. */
export const isDiskFull = (error: unknown): boolean => errnoOf(error) === 'ENOSPC' || errnoOf(error) === 'EDQUOT'
