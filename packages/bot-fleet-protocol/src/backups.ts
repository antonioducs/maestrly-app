import { z } from 'zod'
import {
  fleetBackupErrorSchema,
  fleetBackupRetentionSchema,
  fleetBackupRunSchema,
  fleetBackupScheduleSchema,
  fleetBackupSelectionSchema,
  fleetBackupStatusSchema,
  fleetBotIdSchema,
  fleetEnvironmentIdSchema,
  fleetIdempotencyKeySchema,
  fleetTimestampSchema,
} from './domain.js'

const folderPath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine((value) => !value.split('/').some((part) => part === '.' || part === '..'), 'no relative segments')
/** A restic snapshot's full id. */
export const fleetBackupSnapshotIdSchema = z.string().regex(/^[0-9a-f]{64}$/)

export const fleetBackupS3DestinationSchema = z
  .object({
    provider: z.literal('s3'),
    /** An S3-compatible service (R2, B2, MinIO); null: Amazon S3 in `region`. */
    endpoint: z
      .url({ protocol: /^https?$/ })
      .max(300)
      .nullable(),
    region: z.string().regex(/^[a-z0-9-]{2,64}$/),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    prefix: folderPath,
    accessKeyId: z.string().min(1).max(128).regex(/^\S+$/),
    secretAccessKey: z.string().min(1).max(256).regex(/^\S+$/),
  })
  .strict()
export const fleetBackupGcsDestinationSchema = z
  .object({
    provider: z.literal('gcs'),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/),
    prefix: folderPath,
    /** A service account key file's JSON. */
    serviceAccountJson: z.string().min(2).max(16_384),
  })
  .strict()
export const fleetBackupDriveDestinationSchema = z
  .object({
    provider: z.literal('drive'),
    folder: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^/\\\u0000-\u001f]+$/),
    account: z.string().max(320).nullable(),
    clientId: z.string().min(1).max(256),
    clientSecret: z.string().min(1).max(256),
    token: z
      .object({
        accessToken: z.string().min(1).max(4096),
        refreshToken: z.string().min(1).max(1024),
        expiry: fleetTimestampSchema,
      })
      .strict(),
  })
  .strict()
export const fleetBackupDestinationSchema = z.discriminatedUnion('provider', [
  fleetBackupS3DestinationSchema,
  fleetBackupGcsDestinationSchema,
  fleetBackupDriveDestinationSchema,
])
export type FleetBackupDestination = z.infer<typeof fleetBackupDestinationSchema>

/** How the app and the gateway name a destination: the same for the same place, with no secret in it. */
export function fleetBackupDestinationLabel(destination: FleetBackupDestination): string {
  if (destination.provider === 's3')
    return (
      `s3://${destination.bucket}/${destination.prefix}` +
      (destination.endpoint ? ` (${new URL(destination.endpoint).host})` : '')
    )
  if (destination.provider === 'gcs') return `gs://${destination.bucket}/${destination.prefix}`
  return `drive://${destination.folder}`
}

export const fleetBackupProbeRequestSchema = z.object({ destination: fleetBackupDestinationSchema }).strict()
export type FleetBackupProbeRequest = z.infer<typeof fleetBackupProbeRequestSchema>
export const fleetBackupProbeResponseSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('empty') }),
  z.object({ state: z.literal('existing') }),
  z.object({ state: z.literal('error'), error: fleetBackupErrorSchema }),
])
export type FleetBackupProbeResponse = z.infer<typeof fleetBackupProbeResponseSchema>
export const fleetBackupConnectRequestSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('create'),
      destination: fleetBackupDestinationSchema,
      idempotencyKey: fleetIdempotencyKeySchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('connect'),
      destination: fleetBackupDestinationSchema,
      recoveryKey: z.string().min(1).max(100),
      idempotencyKey: fleetIdempotencyKeySchema,
    })
    .strict(),
])
export type FleetBackupConnectRequest = z.infer<typeof fleetBackupConnectRequestSchema>
export const fleetBackupConnectResponseSchema = z.discriminatedUnion('ok', [
  /** `recoveryKey`: only when it created the repository, formatted in groups of four. */
  z.object({ ok: z.literal(true), status: fleetBackupStatusSchema, recoveryKey: z.string().nullable() }),
  z.object({ ok: z.literal(false), error: fleetBackupErrorSchema }),
])
export type FleetBackupConnectResponse = z.infer<typeof fleetBackupConnectResponseSchema>
export const fleetBackupUpdateRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    schedule: fleetBackupScheduleSchema.optional(),
    retention: fleetBackupRetentionSchema.optional(),
    selection: fleetBackupSelectionSchema.optional(),
  })
  .strict()
export type FleetBackupUpdateRequest = z.infer<typeof fleetBackupUpdateRequestSchema>
export const fleetBackupRecoveryKeyResponseSchema = z.object({ recoveryKey: z.string() })
export const fleetBackupRunRequestSchema = z
  .object({ environmentId: fleetEnvironmentIdSchema, idempotencyKey: fleetIdempotencyKeySchema })
  .strict()
export type FleetBackupRunRequest = z.infer<typeof fleetBackupRunRequestSchema>
export const fleetBackupRunsResponseSchema = z.object({ runs: z.array(fleetBackupRunSchema) })
export const fleetBackupSnapshotSchema = z.object({
  id: fleetBackupSnapshotIdSchema,
  at: fleetTimestampSchema,
  format: z.number().int().positive(),
})
export type FleetBackupSnapshot = z.infer<typeof fleetBackupSnapshotSchema>
export const fleetBackupSnapshotGroupSchema = z.object({
  environmentId: fleetEnvironmentIdSchema,
  name: z.string().max(200),
  kind: z.enum(['bots', 'workspaces']),
  serverId: z.string().max(200),
  serverName: z.string().max(200),
  thisServer: z.boolean(),
  /** An environment of that id is on this server, active or archived: restoring needs it deleted first. */
  taken: z.boolean(),
  snapshots: z.array(fleetBackupSnapshotSchema),
})
export type FleetBackupSnapshotGroup = z.infer<typeof fleetBackupSnapshotGroupSchema>
export const fleetBackupSnapshotsResponseSchema = z.object({ environments: z.array(fleetBackupSnapshotGroupSchema) })
export type FleetBackupSnapshotsResponse = z.infer<typeof fleetBackupSnapshotsResponseSchema>
export const fleetBackupRestoreProblemSchema = z.enum([
  'environment-taken',
  'bot-taken',
  'format-newer',
  'workspaces-root-missing',
  'workspaces-root-different',
  'workspaces-limit',
])
export type FleetBackupRestoreProblem = z.infer<typeof fleetBackupRestoreProblemSchema>
export const fleetBackupRestorePreviewRequestSchema = z.object({ snapshotId: fleetBackupSnapshotIdSchema }).strict()
export const fleetBackupRestorePreviewSchema = z.object({
  snapshotId: fleetBackupSnapshotIdSchema,
  at: fleetTimestampSchema,
  environment: z.object({ id: fleetEnvironmentIdSchema, name: z.string(), kind: z.enum(['bots', 'workspaces']) }),
  bots: z.array(z.object({ id: fleetBotIdSchema, name: z.string(), taken: z.boolean() })),
  projects: z.object({ path: z.string(), state: z.enum(['absent', 'empty', 'not-empty']) }).nullable(),
  problems: z.array(fleetBackupRestoreProblemSchema),
})
export type FleetBackupRestorePreview = z.infer<typeof fleetBackupRestorePreviewSchema>
export const fleetBackupRestoreRequestSchema = z
  .object({
    snapshotId: fleetBackupSnapshotIdSchema,
    keepExistingProjects: z.boolean(),
    idempotencyKey: fleetIdempotencyKeySchema,
  })
  .strict()
export type FleetBackupRestoreRequest = z.infer<typeof fleetBackupRestoreRequestSchema>
/** The environment's copy of its database for a backup; paths are relative to its home folder. */
export const fleetInstanceBackupSnapshotSchema = z.object({
  snapshot: z.string().min(1).max(1024),
  database: z.string().min(1).max(1024),
  bytes: z.number().int().nonnegative(),
})
export type FleetInstanceBackupSnapshot = z.infer<typeof fleetInstanceBackupSnapshotSchema>
