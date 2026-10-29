/** The folder inside a job's folder that holds its temporary files (`TMPDIR`); it is the runner's, never an output. */
export const RUNNER_SCRATCH_DIR = '.tmp'

/** One job as an executor runs it. */
export type RunnerExecutorJob = {
  jobId: string
  serverId: string
  botId: string
  /** The bot's scope in the runner's storage. */
  scope: string
  /** The job folder's absolute path in the bot environment: a container mounts the folder there. */
  folder: string
  /** The assembled folder on this computer. */
  workDir: string
  command: string
  /** The job's own environment variables; they are the only ones besides the runner's few that the command sees. */
  env: Record<string, string>
  /** Named caches: `path` is relative to the folder, `dir` is the local folder the runner keeps for the bot. */
  caches: Array<{ name: string; path: string; dir: string }>
  image?: string
  timeoutMs: number
  /** Receives the command's stdout and stderr as they come. */
  onOutput(chunk: Buffer): void
  /** Aborted when the job is cancelled. */
  signal: AbortSignal
}

/**
 * How a run ended. `exitCode` is null when the command was stopped by a signal or never ran. `error` is set only when
 * the executor itself failed, as opposed to the command: the job then ends with that code.
 */
export type RunnerExecutorResult = {
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  error?: { code: 'executor_unavailable' | 'runner_disk_full'; message: string }
}

/** Runs a job's command: natively as the signed-in user, or in a container. */
export interface RunnerExecutor {
  readonly kind: 'native' | 'container'
  run(job: RunnerExecutorJob): Promise<RunnerExecutorResult>
}
