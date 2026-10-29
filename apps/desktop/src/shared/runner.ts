import {
  FLEET_RUNNER_LIMITS,
  type FleetRunnerCapabilities,
  type FleetRunnerJob,
  type FleetRunnerLinkView,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import type { FleetServerId } from './fleet-servers'

/**
 * What the owner chooses for this computer as a runner (Settings → Runner): whether it runs bots' jobs, how, and how
 * many at once. Stored in the app settings under `runner.*`.
 */

export const RUNNER_EXECUTORS = ['native', 'container'] as const
export type RunnerExecutorKind = (typeof RUNNER_EXECUTORS)[number]

export const RUNNER_SLOTS_MIN = 1
export const RUNNER_SLOTS_MAX = FLEET_RUNNER_LIMITS.slotsMax
export const GIB = 1024 ** 3
/** The most blobs a runner keeps across jobs unless the owner picks another size. */
export const RUNNER_BLOB_CAP_DEFAULT_BYTES = 50 * GIB
export const RUNNER_BLOB_CAP_MIN_BYTES = GIB
export const RUNNER_BLOB_CAP_MAX_BYTES = 100_000 * GIB
export const RUNNER_JOB_CPUS_MAX = 1024
export const RUNNER_JOB_MEMORY_MIN_BYTES = 256 * 1024 ** 2
export const RUNNER_JOB_MEMORY_MAX_BYTES = 1024 ** 5

export const runnerConfigSchema = z
  .object({
    enabled: z.boolean(),
    executor: z.enum(RUNNER_EXECUTORS),
    slots: z.number().int().min(RUNNER_SLOTS_MIN).max(RUNNER_SLOTS_MAX),
    /** Per job, Container only; null leaves it to Docker. */
    jobCpus: z.number().positive().max(RUNNER_JOB_CPUS_MAX).nullable(),
    jobMemoryBytes: z.number().int().min(RUNNER_JOB_MEMORY_MIN_BYTES).max(RUNNER_JOB_MEMORY_MAX_BYTES).nullable(),
    gpu: z.boolean(),
    /** Where the runner keeps blobs, caches and job folders; null is a folder of the app's data. */
    storageDir: z.string().trim().min(1).max(4096).nullable(),
    blobCapBytes: z.number().int().min(RUNNER_BLOB_CAP_MIN_BYTES).max(RUNNER_BLOB_CAP_MAX_BYTES),
  })
  .strict()
export type RunnerConfig = z.infer<typeof runnerConfigSchema>

/** The settings a change names; the rest stay as they are. */
export const runnerConfigPatchSchema = runnerConfigSchema.partial().strict()
export type RunnerConfigPatch = z.infer<typeof runnerConfigPatchSchema>

/** A bot's scope of blobs and caches on this computer, or all of them (`undefined`). */
export const runnerScopeSchema = z
  .object({ serverId: z.string().min(1).max(64), botId: z.string().min(1).max(191) })
  .strict()
export type RunnerScopeInput = z.infer<typeof runnerScopeSchema>

export const runnerCancelInputSchema = z
  .object({ serverId: z.string().min(1).max(64), jobId: z.string().min(1).max(128) })
  .strict()
export type RunnerCancelInput = z.infer<typeof runnerCancelInputSchema>

/** What Docker said when asked, for Container: the installer's states, so its guidance reads the same. */
export interface RunnerDockerView {
  state: 'missing' | 'stopped' | 'no-permission' | 'no-compose' | 'ready'
  engine: string | null
  version: string | null
}

export type RunnerJobPhase = 'preparing' | 'running' | 'uploading' | 'finishing'

/** A job this computer holds, named for the list in the settings. */
export interface RunnerJobItem {
  serverId: FleetServerId
  serverName: string
  botId: string
  botName: string | null
  jobId: string
  /** The first line of the command. */
  command: string
  phase: RunnerJobPhase
  /** When this computer took the job, in milliseconds since the epoch. */
  startedAt: number
}

/** What this computer keeps for one bot. */
export interface RunnerStorageItem {
  serverId: FleetServerId | null
  serverName: string | null
  botId: string | null
  botName: string | null
  scope: string
  blobBytes: number
  cacheBytes: number
}

export interface RunnerStorageView {
  /** The folder in use now; a changed `config.storageDir` is used after the app restarts. */
  dir: string
  bots: RunnerStorageItem[]
  blobBytes: number
  cacheBytes: number
}

/** One paired server, as Settings → Runner lists what this computer does for it. */
export interface RunnerServerItem {
  serverId: FleetServerId
  name: string
  connected: boolean
  /** The server has jobs for runners. */
  supported: boolean
}

/** Everything Settings → Runner shows. */
export interface RunnerStatus {
  /** The runner exists in this app: bot containers have none. */
  available: boolean
  config: RunnerConfig
  /** Native jobs cannot run on this system. */
  nativeAllowed: boolean
  /** What this computer tells the servers it is; null while it cannot tell. Its GPU is none unless jobs may use it. */
  capabilities: FleetRunnerCapabilities | null
  /** The GPU this computer has, whether or not jobs may use it. */
  detectedGpu: FleetRunnerCapabilities['gpu']
  /** Docker's state, asked only for Container. */
  docker: RunnerDockerView | null
  storage: RunnerStorageView
  servers: RunnerServerItem[]
  jobs: RunnerJobItem[]
}

/** This computer's part in one bot's runners, and every computer that runs jobs for the bot. */
export interface RunnerAccessView {
  /** The server has jobs for runners. */
  supported: boolean
  connected: boolean
  /** The bot's environment can send jobs (its image has `runner-jobs`); a bot that cannot yet may still be linked. */
  botSupported: boolean
  /** This computer runs bots' jobs (Settings → Runner is on). */
  runnerEnabled: boolean
  /** How this computer would run them. */
  executor: RunnerExecutorKind
  /** This computer's link to the bot, if it has one. */
  self: FleetRunnerLinkView | null
  /** Every computer linked to the bot, this one marked `self`; null when the server could not be asked. */
  links: FleetRunnerLinkView[] | null
  /** The bot's newest jobs; null when the server could not be asked. */
  jobs: FleetRunnerJob[] | null
  /** The name this computer shows the bot unless the owner picks another. */
  defaultName: string
}

export const RUNNER_ACCESS_NAME_MAX = FLEET_RUNNER_LIMITS.nameMax
