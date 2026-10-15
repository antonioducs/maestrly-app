import { z } from 'zod'

/**
 * Push notifications to phones. A phone registers its push token with each server it paired; the gateway sends a
 * notification when something waits on the owner, a turn finishes or a bot fails, as the phone's preferences allow.
 * A notification carries only the bot's or chat's name, a fixed phrase and the ids to open: never message content.
 */
export const fleetPushCategorySchema = z.enum(['waiting', 'replies', 'routines', 'errors'])
export type FleetPushCategory = z.infer<typeof fleetPushCategorySchema>

export const fleetPushPreferencesSchema = z
  .object({ waiting: z.boolean(), replies: z.boolean(), routines: z.boolean(), errors: z.boolean() })
  .strict()
export type FleetPushPreferences = z.infer<typeof fleetPushPreferencesSchema>
export const FLEET_PUSH_DEFAULTS: FleetPushPreferences = { waiting: true, replies: true, routines: true, errors: true }

/** An Expo push token, as `getExpoPushTokenAsync` returns it. */
export const fleetExpoPushTokenSchema = z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/)

export const fleetPushRegistrationRequestSchema = z
  .object({
    provider: z.literal('expo'),
    token: fleetExpoPushTokenSchema,
    platform: z.enum(['ios', 'android']),
    /** The language notifications are written in; English for anything the gateway does not know. */
    locale: z.string().min(2).max(16),
    preferences: fleetPushPreferencesSchema,
  })
  .strict()
export type FleetPushRegistrationRequest = z.infer<typeof fleetPushRegistrationRequestSchema>

export const fleetPushRegistrationSchema = fleetPushRegistrationRequestSchema.extend({ updatedAt: z.iso.datetime() })
export type FleetPushRegistration = z.infer<typeof fleetPushRegistrationSchema>

/** What a notification tells the phone, to open the right conversation on the right server. */
export const fleetPushDataSchema = z.object({
  v: z.literal(1),
  /** The phone's device id on the server that sent it: the phone knows that server by it. */
  device: z.string().min(1),
  kind: z.enum(['bot', 'chat', 'test']),
  id: z.string().min(1).nullable(),
  category: fleetPushCategorySchema.nullable(),
  /**
   * A chat's workspaces environment: a server may host several, each with its own chats. Absent from bots, tests and
   * gateways that predate it; apps that predate it ignore it.
   */
  env: z.string().min(1).max(64).nullable().optional(),
})
export type FleetPushData = z.infer<typeof fleetPushDataSchema>

/** A chat of a workspaces host that needs the owner's attention: it waits on them, or its turn ended. */
export const fleetChatAttentionKindSchema = z.enum(['waiting', 'question', 'plan', 'finished', 'failed'])
export type FleetChatAttentionKind = z.infer<typeof fleetChatAttentionKindSchema>
