import {
  FLEET_PUSH_DEFAULTS,
  FLEET_PUSH_FEATURE,
  fleetPushDataSchema,
  fleetPushPreferencesSchema,
  type FleetPushPreferences,
} from '@maestrly/bot-fleet-protocol'
import type { GatewayClient } from '../gateway/client'
import { GatewayError } from '../gateway/client'
import type { KeyValueStore, PairedServer } from '../servers/registry'

const PREFS_KEY = 'prefs.notifications'

/** What the phone wants to hear about, the same for every server it paired. */
export async function loadPushPreferences(kv: KeyValueStore): Promise<FleetPushPreferences> {
  try {
    const raw = await kv.get(PREFS_KEY)
    const parsed = raw ? fleetPushPreferencesSchema.safeParse(JSON.parse(raw)) : null
    return parsed?.success ? parsed.data : FLEET_PUSH_DEFAULTS
  } catch {
    return FLEET_PUSH_DEFAULTS
  }
}
export const savePushPreferences = (kv: KeyValueStore, preferences: FleetPushPreferences) =>
  kv.set(PREFS_KEY, JSON.stringify(preferences)).catch(() => {})

/** What a tapped notification opens: a bot or a chat of a paired server, or nothing it can open. */
export type PushTarget = { serverId: string; kind: 'bot' | 'chat'; id: string }
export function pushTarget(data: unknown, servers: PairedServer[]): PushTarget | null {
  const parsed = fleetPushDataSchema.safeParse(data)
  if (!parsed.success || parsed.data.kind === 'test' || !parsed.data.id) return null
  // A server knows this phone by the device id it gave it, which is the id the phone keeps for that server.
  const server = servers.find((item) => item.id === parsed.data.device)
  return server ? { serverId: server.id, kind: parsed.data.kind, id: parsed.data.id } : null
}

/** A link that opens what a notification is about, on its server. */
export const pushLink = (target: PushTarget) =>
  `/${target.kind}/${encodeURIComponent(target.id)}?server=${encodeURIComponent(target.serverId)}`

export type PushRegistrationResult = 'registered' | 'unsupported' | 'off' | 'failed'

/**
 * Tells each paired server where to send this phone's notifications, and what about. A server that predates push,
 * or sends none, is left out; the demo server is not a real server.
 */
export async function registerWithServers(input: {
  servers: PairedServer[]
  token: string
  platform: 'ios' | 'android'
  locale: string
  preferences: FleetPushPreferences
  clientFor: (server: PairedServer) => Promise<Pick<GatewayClient, 'call'> | null>
  skip?: (server: PairedServer) => boolean
}): Promise<Record<string, PushRegistrationResult>> {
  const results: Record<string, PushRegistrationResult> = {}
  await Promise.all(
    input.servers.map(async (server) => {
      if (input.skip?.(server)) return
      if (!server.features.includes(FLEET_PUSH_FEATURE)) {
        results[server.id] = 'unsupported'
        return
      }
      const client = await input.clientFor(server)
      if (!client) {
        results[server.id] = 'failed'
        return
      }
      try {
        await client.call('devicePushSet', {
          body: {
            provider: 'expo',
            token: input.token,
            platform: input.platform,
            locale: input.locale,
            preferences: input.preferences,
          },
        })
        results[server.id] = 'registered'
      } catch (error) {
        results[server.id] = error instanceof GatewayError && error.code === 'CONFLICT' ? 'off' : 'failed'
      }
    })
  )
  return results
}
