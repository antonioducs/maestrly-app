import { z } from 'zod'
import { FLEET_ATTENTION_LIMITS } from './constants.js'
import { fleetBotIdSchema, fleetEnvironmentIdSchema, fleetIdSchema, fleetTimestampSchema } from './domain.js'

/** Where an attention item originates on the server: a workspaces-host chat, a bot turn, or a pending bot request. */
export const fleetAttentionSourceSchema = z.enum(['chat', 'bot', 'request'])
export type FleetAttentionSource = z.infer<typeof fleetAttentionSourceSchema>

/**
 * What an attention item asks of the owner, or tells them.
 *
 * MUST stay identical to the desktop `InboxKind` union (`apps/desktop/src/shared/inbox-kind.ts`, which a parallel task
 * moves into this package as `src/inbox/kind.ts`).
 */
export const fleetAttentionKindSchema = z.enum([
  'question',
  'approval',
  'plan',
  'help',
  'error',
  'finished',
  'activity',
])
export type FleetAttentionKind = z.infer<typeof fleetAttentionKindSchema>

/**
 * Stable identifier of an attention item on a server, formatted by source:
 * - `chat:<environmentId>/<conversationId>`
 * - `bot:<botId>`
 * - `request:<botId>/<requestId>`
 */
export const fleetAttentionKeySchema = z.string().min(1).max(FLEET_ATTENTION_LIMITS.keyMax)
export type FleetAttentionKey = z.infer<typeof fleetAttentionKeySchema>

export type FleetParsedAttentionKey =
  | { source: 'chat'; environmentId: string; conversationId: string }
  | { source: 'bot'; botId: string }
  | { source: 'request'; botId: string; requestId: string }

/** Pure builders for the stable attention keys shared by the gateway and phones. */
export const fleetAttentionKey = {
  chat: (environmentId: string, conversationId: string): string => `chat:${environmentId}/${conversationId}`,
  bot: (botId: string): string => `bot:${botId}`,
  request: (botId: string, requestId: string): string => `request:${botId}/${requestId}`,
} as const

/** Parses a stable attention key back into its source and identifiers; returns null for malformed or unknown keys. */
export function parseFleetAttentionKey(key: string): FleetParsedAttentionKey | null {
  if (key.startsWith('chat:')) {
    const rest = key.slice('chat:'.length)
    const slash = rest.indexOf('/')
    if (slash <= 0 || slash === rest.length - 1) return null
    return { source: 'chat', environmentId: rest.slice(0, slash), conversationId: rest.slice(slash + 1) }
  }
  if (key.startsWith('bot:')) {
    const botId = key.slice('bot:'.length)
    if (!botId || botId.includes('/')) return null
    return { source: 'bot', botId }
  }
  if (key.startsWith('request:')) {
    const rest = key.slice('request:'.length)
    const slash = rest.indexOf('/')
    if (slash <= 0 || slash === rest.length - 1) return null
    return { source: 'request', botId: rest.slice(0, slash), requestId: rest.slice(slash + 1) }
  }
  return null
}

/** One item in a server's attention store, shown in the phone's notifications center. */
export const fleetAttentionEntrySchema = z.object({
  key: fleetAttentionKeySchema,
  source: fleetAttentionSourceSchema,
  kind: fleetAttentionKindSchema,
  /** ISO-8601 UTC timestamp of the event that created or updated this item. */
  at: fleetTimestampSchema,
  /** Conversation or bot name. */
  title: z.string().max(FLEET_ATTENTION_LIMITS.titleMax),
  environmentId: fleetEnvironmentIdSchema.nullable().optional(),
  botId: fleetBotIdSchema.nullable().optional(),
  conversationId: fleetIdSchema.nullable().optional(),
  requestId: fleetIdSchema.nullable().optional(),
  /** Routine run id when a bot or request entry belongs to a routine run lane (`routine-conversations`). */
  runId: fleetIdSchema.nullable().optional(),
  /** Peer thread id when a bot entry belongs to a peer thread lane (`peer-conversations`). */
  threadId: fleetIdSchema.nullable().optional(),
})
export type FleetAttentionEntry = z.infer<typeof fleetAttentionEntrySchema>

/** Full snapshot returned by `GET /v1/attention`. */
export const fleetAttentionSnapshotSchema = z.object({
  entries: z.array(fleetAttentionEntrySchema).max(FLEET_ATTENTION_LIMITS.entriesMax),
  at: fleetTimestampSchema,
})
export type FleetAttentionSnapshot = z.infer<typeof fleetAttentionSnapshotSchema>

/**
 * Incremental attention update sent over the gateway SSE stream (`GET /v1/events?attention=1`) ONLY to subscribers
 * where `fleetReaderWantsAttention(url.searchParams)` is true.
 *
 * SSE wire framing (matches all other `/v1/events` frames in `apps/bot-gateway/src/events.ts` and
 * `apps/mobile/src/gateway/event-stream.ts`):
 * ```
 * event: fleet
 * data: {"type":"attention.updated","upsert":[...],"remove":[...]}
 *
 * ```
 *
 * Intentionally NOT added to `fleetGatewayEventSchema` (a closed discriminated union parsed by older clients).
 * Readers that opt in with `?attention=1` parse `attention.updated` frames with this schema alongside
 * `fleetGatewayEventSchema`.
 */
export const fleetAttentionUpdatedEventSchema = z.object({
  type: z.literal('attention.updated'),
  upsert: z.array(fleetAttentionEntrySchema).max(FLEET_ATTENTION_LIMITS.entriesMax),
  remove: z.array(fleetAttentionKeySchema).max(FLEET_ATTENTION_LIMITS.entriesMax),
})
export type FleetAttentionUpdatedEvent = z.infer<typeof fleetAttentionUpdatedEventSchema>

/** Body of `POST /v1/attention/seen`: marks the named attention entries seen on this server. */
export const fleetAttentionSeenRequestSchema = z
  .object({
    keys: z.array(fleetAttentionKeySchema).min(1).max(FLEET_ATTENTION_LIMITS.seenKeysMax),
  })
  .strict()
export type FleetAttentionSeenRequest = z.infer<typeof fleetAttentionSeenRequestSchema>

/** Response of `POST /v1/attention/seen`: keys whose attention mark was cleared. */
export const fleetAttentionSeenResponseSchema = z.object({
  cleared: z.array(fleetAttentionKeySchema),
})
export type FleetAttentionSeenResponse = z.infer<typeof fleetAttentionSeenResponseSchema>
