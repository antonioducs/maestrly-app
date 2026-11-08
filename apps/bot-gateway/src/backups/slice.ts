import { z } from 'zod'
import {
  FLEET_BACKUP_LIMITS,
  FLEET_ENVIRONMENT_LIMITS,
  fleetBotSchema,
  fleetCompactionConfigSchema,
  fleetEnvironmentIdSchema,
  fleetOwnerMemoryEntrySchema,
  fleetRoutineSchema,
  fleetTimestampSchema,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from '../errors.js'
import type { Store } from '../store.js'

/** A path inside the home folder, as the helper mounts it: relative, with no part that climbs out. */
const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => !value.startsWith('/') && !value.split('/').some((part) => part === '' || part === '.' || part === '..'),
    'a path inside the home folder'
  )

/**
 * The gateway's part of an environment's backup, written into the same snapshot as its files: what the environment
 * needs from the gateway's records to come back on another server with the same ids.
 */
export const backupSliceSchema = z.object({
  format: z.literal(FLEET_BACKUP_LIMITS.sliceFormat),
  gatewayVersion: z.string().max(100),
  createdAt: fleetTimestampSchema,
  server: z.object({ id: z.string().min(1).max(200), name: z.string().max(200) }),
  environment: z.object({
    id: fleetEnvironmentIdSchema,
    name: z.string().min(1).max(200),
    kind: z.enum(['bots', 'workspaces']),
    memoryLimitBytes: z.number().int().positive().nullable(),
    cpuLimit: z.number().positive().nullable(),
    idleStopMinutes: z.number().int().positive().nullable(),
    tint: z.string().max(32).nullable(),
    compaction: fleetCompactionConfigSchema.nullable(),
    createdAt: fleetTimestampSchema,
  }),
  /** The only secret the volume needs back: its keyring is encrypted with it. Tokens are issued anew on restore. */
  keyringPassword: z.string().min(16).max(512),
  bots: z
    .array(z.object({ bot: fleetBotSchema, slot: z.number().int().min(1).max(FLEET_ENVIRONMENT_LIMITS.botsMax) }))
    .max(FLEET_ENVIRONMENT_LIMITS.botsMax),
  routines: z.array(fleetRoutineSchema).max(1000),
  /** The environment's own entries and the server's global ones its bots see. */
  ownerMemories: z.array(fleetOwnerMemoryEntrySchema).max(10_000),
  files: z.object({
    database: z.object({ snapshot: relativePath, live: relativePath }).nullable(),
    projects: z
      .string()
      .regex(/^\/(?:[^/\0]+\/)*[^/\0]+$/)
      .nullable(),
  }),
})
export type BackupSlice = z.infer<typeof backupSliceSchema>

/** The gateway's records of an active environment, for its backup; its tokens stay out. */
export function buildBackupSlice(input: {
  store: Store
  environmentId: string
  server: { id: string; name: string }
  gatewayVersion: string
  now: string
  database: { snapshot: string; live: string } | null
  projects: string | null
}): BackupSlice {
  const { store } = input
  const environment = store.getEnvironment(input.environmentId)
  const secrets = store.environmentSecrets(input.environmentId)
  if (!environment || environment.archivedAt || !secrets) throw new GatewayError('NOT_FOUND', 'Environment not found')
  const bots = store.botsOfEnvironment(environment.id)
  const botIds = new Set(bots.map((bot) => bot.id))
  return backupSliceSchema.parse({
    format: FLEET_BACKUP_LIMITS.sliceFormat,
    gatewayVersion: input.gatewayVersion.slice(0, 100),
    createdAt: input.now,
    server: { id: input.server.id, name: input.server.name.slice(0, 200) },
    environment: {
      id: environment.id,
      name: environment.name,
      kind: environment.kind,
      memoryLimitBytes: environment.memoryLimitBytes,
      cpuLimit: environment.cpuLimit,
      idleStopMinutes: environment.idleStopMinutes,
      tint: environment.tint,
      compaction: environment.compaction,
      createdAt: environment.createdAt,
    },
    keyringPassword: secrets.keyringPassword,
    bots: bots.map((bot) => ({ bot, slot: store.botSlot(bot.id) ?? 1 })),
    routines: store.routines().filter((routine) => botIds.has(routine.botId)),
    ownerMemories: store.ownerMemories(undefined, environment.id),
    files: { database: input.database, projects: input.projects },
  })
}

/** The gateway's part of a backup as read back from its snapshot. */
export function readBackupSlice(
  text: string
): { ok: true; slice: BackupSlice } | { ok: false; problem: 'format-newer' | 'invalid' } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'invalid' }
  }
  const format = (raw as { format?: unknown } | null)?.format
  if (typeof format === 'number' && Number.isInteger(format) && format > FLEET_BACKUP_LIMITS.sliceFormat)
    return { ok: false, problem: 'format-newer' }
  const parsed = backupSliceSchema.safeParse(raw)
  return parsed.success ? { ok: true, slice: parsed.data } : { ok: false, problem: 'invalid' }
}
