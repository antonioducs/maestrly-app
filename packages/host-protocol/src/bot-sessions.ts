import { z } from 'zod'
import { id, revision } from './common.js'

export const BOT_SESSIONS_CAPABILITY = 'bot.sessions.v1'
export const sessionIdSchema = z.string().uuid()
// These bounds protect configuration parsing; actual requirements come from a measured bundle.
export const sessionProfileSchema = z.strictObject({
  cpuQuotaPercent: z.number().int().min(1).max(12800),
  memoryMiB: z.number().int().min(128).max(1048576),
  tasksMax: z.number().int().min(32).max(16384),
  diskMiB: z.number().int().min(128).max(16777216),
})
export type SessionProfile = z.infer<typeof sessionProfileSchema>
export const sessionCapacitySchema = z.strictObject({
  profileId: id,
  // A build measurement reference is required; this is not a universal browser minimum.
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  systemMemoryMiB: z.number().int().min(128),
  systemDiskMiB: z.number().int().min(128),
  maxSessions: z.number().int().min(2).max(32),
  perSession: sessionProfileSchema,
})
export type SessionCapacity = z.infer<typeof sessionCapacitySchema>
export const botSessionSchema = z.strictObject({
  id: sessionIdSchema,
  botId: id,
  vmId: id,
  state: z.enum(['reserved', 'starting', 'ready', 'stopped', 'archived', 'needs_attention']),
  transport: z.enum(['legacy', 'managed']),
  generation: revision,
  revision,
  profile: sessionProfileSchema.optional(),
  issue: z.enum(['LEGACY_BINDING_CONFLICT', 'SESSION_UNREACHABLE', 'SESSION_PREPARATION_UNCERTAIN']).optional(),
  createdAt: z.string().min(20).max(40),
  updatedAt: z.string().min(20).max(40),
})
export type BotSession = z.infer<typeof botSessionSchema>
export const sessionsInventorySchema = z.strictObject({
  vmId: id,
  supported: z.boolean(),
  capabilities: z.array(z.string().min(1).max(60)).max(32).default([]),
  sessions: z.array(botSessionSchema).max(100),
  capacity: sessionCapacitySchema.optional(),
  available: z.number().int().nonnegative(),
  reason: z.string().max(500).optional(),
})
export type SessionsInventory = z.infer<typeof sessionsInventorySchema>
