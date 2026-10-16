import { FLEET_MOBILE_HOST_FEATURE, type FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import type { KeyValueStore } from '../servers/registry'
import { chatOutboxKey, legacyChatOutboxKey } from './controller'

/** The environments that host workspaces and chats, in the server's order. */
export const workspacesEnvironments = (environments: FleetEnvironment[]) =>
  environments.filter((environment) => environment.kind === 'workspaces')

/**
 * Which workspaces environment the phone shows: the one the person chose while it exists; otherwise the first that
 * runs and speaks to phones, the first that runs, or the first. Null when the server hosts no workspaces.
 */
export function chooseEnvironment(environments: FleetEnvironment[], saved: string | null): string | null {
  const hosts = workspacesEnvironments(environments)
  const chosen =
    hosts.find((item) => item.id === saved) ??
    hosts.find((item) => item.lifecycle === 'running' && item.capabilities.includes(FLEET_MOBILE_HOST_FEATURE)) ??
    hosts.find((item) => item.lifecycle === 'running') ??
    hosts[0]
  return chosen?.id ?? null
}

/** Where the phone keeps the environment the person chose, per server. */
export const environmentChoiceKey = (serverId: string) => `chats.environment.${serverId}`
/** The environments whose chats this phone opened on a server, so forgetting the server forgets all of them. */
const knownEnvironmentsKey = (serverId: string) => `chats.environments.${serverId}`

async function knownEnvironments(kv: KeyValueStore, serverId: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse((await kv.get(knownEnvironmentsKey(serverId))) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/**
 * Readies the outbox of the environment the phone is about to open: it remembers the environment, and gives it the
 * messages kept before the phone told a server's environments apart, unless it already has its own.
 */
export async function prepareEnvironmentOutbox(kv: KeyValueStore, serverId: string, environmentId: string) {
  const known = await knownEnvironments(kv, serverId)
  if (!known.includes(environmentId))
    await kv.set(knownEnvironmentsKey(serverId), JSON.stringify([...known, environmentId])).catch(() => {})
  const legacy = await kv.get(legacyChatOutboxKey(serverId)).catch(() => null)
  if (!legacy) return
  const key = chatOutboxKey(serverId, environmentId)
  if (!(await kv.get(key).catch(() => null))) await kv.set(key, legacy)
  await kv.delete(legacyChatOutboxKey(serverId)).catch(() => {})
}

/** Forgets what the phone kept of a server's chats: the environment it chose and each environment's outbox. */
export async function forgetServerChats(kv: KeyValueStore, serverId: string) {
  const keys = [
    environmentChoiceKey(serverId),
    knownEnvironmentsKey(serverId),
    legacyChatOutboxKey(serverId),
    ...(await knownEnvironments(kv, serverId)).map((id) => chatOutboxKey(serverId, id)),
  ]
  await Promise.all(keys.map((key) => kv.delete(key).catch(() => {})))
}
