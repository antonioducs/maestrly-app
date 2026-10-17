import { z } from 'zod'

/** Moving files between a paired computer and its workspaces host, through the gateway. */
export const FLEET_HOST_FILE_LIMITS = {
  /** Bytes of one download range. */
  downloadRangeBytes: 64 * 1024 * 1024,
  /** Bytes of one upload chunk: a request must reach the host within Node's 300 s request timeout on a slow uplink. */
  uploadChunkBytes: 16 * 1024 * 1024,
  /** A chunk is only sent compressed when it shrinks; this bounds what its body may still carry. */
  chunkBodySlackBytes: 1024 * 1024,
  /** The largest file a transfer moves (1 TiB). */
  maxFileBytes: 2 ** 40,
  /** Upload sessions untouched for this long are removed with their partial file. */
  uploadTtlMs: 7 * 24 * 60 * 60 * 1_000,
  /**
   * A folder's archive nobody read for this long is removed: it is a whole copy of the folder, so it does not wait
   * as long as an upload session.
   */
  archiveTtlMs: 24 * 60 * 60 * 1_000,
} as const

/** Headers of the transfer routes, lowercase as Node reads them; the gateway passes them through untouched. */
export const FLEET_HOST_FILE_HEADERS = {
  /** `size:mtimeMs:inode` of the file a download reads; the host refuses a range of a file that changed. */
  identity: 'x-maestrly-file-identity',
  /** SHA-256 (hex) of a range or chunk before compression. */
  sha256: 'x-maestrly-sha256',
  /** Bytes of a range or chunk before compression. */
  length: 'x-maestrly-length',
  /** `zstd` when the body is compressed. */
  encoding: 'x-maestrly-encoding',
  /** `zstd` when the client takes compressed ranges. */
  acceptEncoding: 'x-maestrly-accept-encoding',
} as const

/** The host's refusals. HTTP and IPC carry only a message, so each reason has a fixed one. */
export const FLEET_HOST_FILE_ERRORS = {
  'outside-roots': 'This path is outside the folders Maestrly can use on the host.',
  'not-found': 'This file does not exist on the host.',
  'not-a-file': 'This path is not a file.',
  'not-a-directory': 'This path is not a folder.',
  changed: 'The file changed on the host during the transfer.',
  exists: 'A file with this name already exists on the host.',
  'invalid-name': 'This file name cannot be used.',
  'chunk-mismatch': 'The chunk does not match its checksum.',
  'digest-mismatch': 'The uploaded file does not match its checksum.',
  'unknown-upload': 'This upload does not exist on the host.',
  'unsafe-archive': 'The folder archive holds an entry that cannot be extracted safely.',
  'archive-expired': 'This folder archive is no longer on the host.',
  'no-space': 'The host does not have enough free space for this.',
} as const
export type FleetHostFileErrorReason = keyof typeof FLEET_HOST_FILE_ERRORS

/** The gateway's own refusals of a host-file route. */
export const FLEET_HOST_FILE_GATEWAY_ERRORS = {
  notRunning: 'The workspaces environment is not running.',
  updateHost: 'Update the workspaces environment to move files.',
} as const

export function fleetHostFileErrorReason(message: unknown): FleetHostFileErrorReason | null {
  for (const [reason, text] of Object.entries(FLEET_HOST_FILE_ERRORS) as Array<[FleetHostFileErrorReason, string]>)
    if (message === text) return reason
  return null
}

export const fleetHostFilePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/') && !value.includes('\0'), 'Absolute path required')
export const fleetHostFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[/\\\0]/.test(value) && value !== '.' && value !== '..', 'Plain file name required')
export const fleetHostFileSha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
export const fleetHostFileIdentitySchema = z.string().regex(/^\d{1,16}:\d{1,16}:\d{1,24}$/)
export const fleetHostFileUploadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/)
export const fleetHostFileArchiveIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/)
/** What an upload carries: a file, or a folder packed as a zstd-compressed tar that the host extracts on commit. */
export const fleetHostFileKindSchema = z.enum(['file', 'folder'])
const fileSize = z.number().int().nonnegative().max(FLEET_HOST_FILE_LIMITS.maxFileBytes)

export const fleetHostFileStatRequestSchema = z.object({ path: fleetHostFilePathSchema }).strict()
export const fleetHostFileStatSchema = z
  .object({
    path: fleetHostFilePathSchema,
    name: fleetHostFileNameSchema,
    size: fileSize,
    modifiedAt: z.number().int().nonnegative(),
    identity: fleetHostFileIdentitySchema,
  })
  .strict()
export const fleetHostFileDigestRequestSchema = z
  .object({ path: fleetHostFilePathSchema, identity: fleetHostFileIdentitySchema })
  .strict()
export const fleetHostFileDigestSchema = z.object({ sha256: fleetHostFileSha256Schema }).strict()
/**
 * `kind: 'folder'` extracts the uploaded archive into a new folder named `name`, or `name (2)` and so on when the
 * name is taken: a folder never replaces another, so `overwrite` must stay false.
 */
export const fleetHostFileUploadBeginSchema = z
  .object({
    directory: fleetHostFilePathSchema,
    name: fleetHostFileNameSchema,
    size: fileSize,
    overwrite: z.boolean(),
    kind: fleetHostFileKindSchema.optional(),
  })
  .strict()
  .refine((value) => value.kind !== 'folder' || !value.overwrite, 'A folder upload never overwrites')
export const fleetHostFileUploadSchema = z
  .object({ uploadId: fleetHostFileUploadIdSchema, path: fleetHostFilePathSchema, size: fileSize })
  .strict()
/** `overwrite` replaces a file that appeared under the name while the upload ran. */
export const fleetHostFileUploadCommitSchema = z
  .object({ sha256: fleetHostFileSha256Schema, overwrite: z.boolean().optional() })
  .strict()
/** `path` is where the file landed, or the folder an upload of a folder was extracted into. */
export const fleetHostFileUploadResultSchema = z
  .object({ path: fleetHostFilePathSchema, size: fileSize, sha256: fleetHostFileSha256Schema })
  .strict()
/**
 * Starts packing a folder of the host into an archive, which the download routes then read like any file. Packing a
 * large folder outlasts what a request may wait for its answer, so the answer names the archive at once and its
 * status is asked for until it is ready.
 */
export const fleetHostFileArchiveRequestSchema = z.object({ path: fleetHostFilePathSchema }).strict()
export const fleetHostFileArchiveBeginSchema = z.object({ archiveId: fleetHostFileArchiveIdSchema }).strict()
const count = z.number().int().nonnegative()
/**
 * An archive being packed (`totalBytes` is 0 until the folder has been read through), or ready: `name` is the
 * folder's, `path` and `size` the archive's, and `entries` what it holds.
 */
export const fleetHostFileArchiveSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('packing'),
      archiveId: fleetHostFileArchiveIdSchema,
      bytes: count,
      totalBytes: count,
    })
    .strict(),
  z
    .object({
      state: z.literal('ready'),
      archiveId: fleetHostFileArchiveIdSchema,
      name: fleetHostFileNameSchema,
      path: fleetHostFilePathSchema,
      size: fileSize,
      identity: fleetHostFileIdentitySchema,
      entries: count,
    })
    .strict(),
])

export type FleetHostFileStatRequest = z.infer<typeof fleetHostFileStatRequestSchema>
export type FleetHostFileStat = z.infer<typeof fleetHostFileStatSchema>
export type FleetHostFileDigestRequest = z.infer<typeof fleetHostFileDigestRequestSchema>
export type FleetHostFileDigest = z.infer<typeof fleetHostFileDigestSchema>
export type FleetHostFileUploadBegin = z.infer<typeof fleetHostFileUploadBeginSchema>
export type FleetHostFileUpload = z.infer<typeof fleetHostFileUploadSchema>
export type FleetHostFileUploadCommit = z.infer<typeof fleetHostFileUploadCommitSchema>
export type FleetHostFileUploadResult = z.infer<typeof fleetHostFileUploadResultSchema>
export type FleetHostFileKind = z.infer<typeof fleetHostFileKindSchema>
export type FleetHostFileArchiveRequest = z.infer<typeof fleetHostFileArchiveRequestSchema>
export type FleetHostFileArchiveBegin = z.infer<typeof fleetHostFileArchiveBeginSchema>
export type FleetHostFileArchive = z.infer<typeof fleetHostFileArchiveSchema>
