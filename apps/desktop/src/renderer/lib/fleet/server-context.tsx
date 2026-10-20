import { createContext, type ReactNode, useContext } from 'react'
import { type FleetServerId, NO_FLEET_SERVER } from '../../../shared/fleet-servers'

const FleetServerContext = createContext<FleetServerId>(NO_FLEET_SERVER)

/** The server whose bots and environments this part of the window shows. */
export function FleetServerProvider({ serverId, children }: { serverId: FleetServerId; children: ReactNode }) {
  return <FleetServerContext.Provider value={serverId}>{children}</FleetServerContext.Provider>
}

export const useFleetServerId = (): FleetServerId => useContext(FleetServerContext)
