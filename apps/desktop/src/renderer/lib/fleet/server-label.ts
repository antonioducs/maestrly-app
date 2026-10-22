import type { FleetConnectionView } from '../../../shared/fleet-servers'

type Named = Pick<FleetConnectionView, 'hostname' | 'url'>

/** A paired server's address without its scheme: its host and port. */
export function fleetServerAddress(connection: Named): string {
  if (!connection.url) return ''
  try {
    return new URL(connection.url).host
  } catch {
    return connection.url
  }
}

/** How a paired server is named: the host name it reports, else its address. */
export function fleetServerName(connection: Named): string {
  return connection.hostname || fleetServerAddress(connection)
}
