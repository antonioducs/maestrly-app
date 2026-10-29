import { z } from 'zod'
import { FLEET_RUNNER_LIMITS } from './constants.js'

/**
 * How a job's files move between the bot's environment and the runner, through the gateway's relay
 * (`FLEET_RUNNER_TRANSFER_ROUTE_KEYS`). The environment builds a manifest of the job folder, the runner asks for the
 * blobs it lacks, and the runner sends back an archive of the outputs in chunks; every byte is checked by SHA-256.
 */

/** Folders left out of a job's inputs when the job names no `exclude`; `exclude` replaces them. */
export const FLEET_RUNNER_DEFAULT_EXCLUDES = ['.git/', 'node_modules/', '.venv/', '__pycache__/'] as const

/** Headers of the transfer routes, lowercase as Node reads them; the gateway passes them through untouched. */
export const FLEET_RUNNER_HEADERS = {
  /** SHA-256 (hex) of an output chunk. */
  sha256: 'x-maestrly-sha256',
} as const

/** Bounds of a job's transfers that are not part of what the gateway enforces. */
export const FLEET_RUNNER_TRANSFER_LIMITS = {
  /** Blobs asked for in one request: a failed stream resends little. */
  blobBatchDigestsMax: 2_000,
  /** Bytes of the blobs asked for in one request. */
  blobBatchBytesMax: 512 * 1024 * 1024,
  /** Times one batch of blobs is asked for again after a digest mismatch, before the job fails. */
  blobBatchAttempts: 3,
  /** Lines and bytes of the log tail a job's result carries. */
  logTailLines: 200,
  logTailBytes: 16 * 1024,
  /** How long a runner keeps retrying to deliver a job's outputs to an environment that does not answer. */
  outputDeliveryMs: 24 * 60 * 60 * 1_000,
} as const

const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
/** A path relative to the job folder, with `/` separators, that never leaves it. */
export const fleetRunnerEntryPathSchema = z
  .string()
  .min(1)
  .max(FLEET_RUNNER_LIMITS.pathMax)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Must be a relative path inside the job folder'
  )

/**
 * One entry of a job folder: a directory, a file named by its content's digest, or a link whose target stays inside
 * the folder. Modes carry only permission bits.
 */
export const fleetRunnerManifestEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('directory'),
      path: fleetRunnerEntryPathSchema,
      mode: z.number().int().min(0).max(0o7777),
    })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      path: fleetRunnerEntryPathSchema,
      mode: z.number().int().min(0).max(0o7777),
      size: z.number().int().nonnegative(),
      sha256,
    })
    .strict(),
  z
    .object({
      kind: z.literal('symlink'),
      path: fleetRunnerEntryPathSchema,
      target: z.string().min(1).max(FLEET_RUNNER_LIMITS.pathMax),
    })
    .strict(),
])
export type FleetRunnerManifestEntry = z.infer<typeof fleetRunnerManifestEntrySchema>

/**
 * A job folder as its environment read it, parents before children. `skipped` counts what was left out because it
 * cannot travel: links that leave the folder, devices, sockets and pipes.
 */
export const fleetRunnerManifestSchema = z
  .object({
    jobId: z.string().regex(/^job_[A-Za-z0-9_-]{16,64}$/),
    entries: z.array(fleetRunnerManifestEntrySchema).max(FLEET_RUNNER_LIMITS.inputFilesMax),
    bytes: z.number().int().nonnegative().max(FLEET_RUNNER_LIMITS.inputBytesMax),
    skipped: z.number().int().nonnegative(),
  })
  .strict()
export type FleetRunnerManifest = z.infer<typeof fleetRunnerManifestSchema>

/**
 * The blobs route answers a tar stream compressed with zstd whose entries are regular files named by their SHA-256,
 * one per digest asked for, in the order asked. The output archive is a tar compressed with zstd of the output files at
 * their paths relative to the job folder; links inside the folder may travel, nothing else but files and directories.
 */
export const FLEET_RUNNER_ARCHIVE_ENCODING = 'zstd' as const

/** The log route takes the bytes of the job log at `?offset=<n>`: a batch sent again lands where it did the first time. */
export const FLEET_RUNNER_LOG_OFFSET_QUERY = 'offset'
