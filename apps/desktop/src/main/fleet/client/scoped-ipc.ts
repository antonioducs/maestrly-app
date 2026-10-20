import type { IpcMainInvokeEvent } from 'electron'
import type { IpcRegistrar } from '../../ipc-registrar'
import { type FleetServerId, parseFleetServerId } from '../../../shared/fleet-servers'
import type { FleetClientService } from './service'

/** The client of a paired server; throws FLEET_SERVER_UNKNOWN for any other id. */
export type FleetServerResolver = (serverId: FleetServerId) => FleetClientService
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScopedHandler = (fleet: FleetClientService, event: IpcMainInvokeEvent, ...args: any[]) => unknown

/** Registers channels whose first argument names the server they reach. */
export interface FleetIpcRegistrar {
  handle: (channel: string, fn: ScopedHandler) => void
  mhandle: (channel: string, fn: ScopedHandler) => void
}

export function fleetIpcRegistrar(reg: IpcRegistrar, resolve: FleetServerResolver): FleetIpcRegistrar {
  const scoped =
    (fn: ScopedHandler) =>
    (event: IpcMainInvokeEvent, serverId: unknown, ...args: unknown[]) =>
      fn(resolve(parseFleetServerId(serverId)), event, ...args)
  return {
    handle: (channel, fn) => reg.handle(channel, scoped(fn)),
    mhandle: (channel, fn) => reg.mhandle(channel, scoped(fn)),
  }
}
