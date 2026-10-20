/**
 * The bot servers this computer is paired with. Each has an id this computer gives it: the first part of its hosts'
 * ids (`<serverId>/<environmentId>`), and the first argument of every `fleet:*` call that reaches it.
 */

declare const fleetServerBrand: unique symbol
/** This computer's id for one paired server; branded so that a bot's or an environment's id cannot stand in for it. */
export type FleetServerId = string & { readonly [fleetServerBrand]: true }

/** No server, before any is paired: every fleet call refuses it. */
export const NO_FLEET_SERVER = '' as FleetServerId
export const FLEET_SERVER_UNKNOWN = 'FLEET_SERVER_UNKNOWN'
export const FLEET_SERVER_ALREADY_PAIRED = 'FLEET_SERVER_ALREADY_PAIRED'

// The first part of a remote `HostId` (shared/host-key.ts), which every UUID satisfies.
const SERVER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export const isFleetServerId = (value: unknown): value is FleetServerId =>
  typeof value === 'string' && SERVER_ID_RE.test(value)

export function parseFleetServerId(value: unknown): FleetServerId {
  if (!isFleetServerId(value)) throw new Error(FLEET_SERVER_UNKNOWN)
  return value
}

export type FleetConnectionState =
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unauthorized'
  | 'incompatible'

export type FleetConnectionView = {
  features: string[]
  state: FleetConnectionState
  deviceId: string | null
  url: string | null
  hostname: string | null
  error: string | null
  tokenPersistence: 'secure' | 'memory'
}

export type FleetServerView = { id: FleetServerId; installed: boolean; connection: FleetConnectionView }

/** A bot's or an environment's id made unique across servers, for what this computer keeps of several of them. */
export const fleetKey = (serverId: FleetServerId, id: string): string => `${serverId}/${id}`

/** The installed server when it is paired, else the first server paired. */
export function defaultFleetServer<T extends Pick<FleetServerView, 'id' | 'installed'>>(
  servers: readonly T[]
): T | null {
  return servers.find((server) => server.installed) ?? servers[0] ?? null
}

/** An API whose every method names the server first, as the preload exposes the environment settings. */
export type FleetServerScoped<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (fleetServerId: FleetServerId, ...args: A) => R : T[K]
}
