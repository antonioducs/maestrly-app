import { createContext, type ReactNode, useContext } from 'react'
import { type FleetServerId, NO_FLEET_SERVER } from '../../../shared/fleet-servers'

const FleetServerContext = createContext<FleetServerId>(NO_FLEET_SERVER)

/** The server whose bots and environments this part of the window shows. */
export function FleetServerProvider({ serverId, children }: { serverId: FleetServerId; children: ReactNode }) {
  return <FleetServerContext.Provider value={serverId}>{children}</FleetServerContext.Provider>
}

export const useFleetServerId = (): FleetServerId => useContext(FleetServerContext)

/** A server-scoped API's methods without their first argument, the server. */
export type FleetServerBound<S> = {
  [K in keyof S]: S[K] extends (serverId: FleetServerId, ...args: infer A) => infer R ? (...args: A) => R : S[K]
}

/** The methods of a server-scoped API with the server already given. */
export function bindFleetServer<S extends object>(api: S, serverId: FleetServerId): FleetServerBound<S> {
  return Object.fromEntries(
    Object.entries(api).map(([key, value]) => [
      key,
      typeof value === 'function' ? (...args: unknown[]) => value(serverId, ...args) : value,
    ])
  ) as FleetServerBound<S>
}
